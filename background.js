// YTS Remote — background service worker
// Owns the WebSocket to the local bridge server and forwards phone commands
// to the active YouTube tab. Robust reconnect, heartbeat, status reporting.

const SERVER_WS = (self.YTS_SERVER_WS) || 'ws://127.0.0.1:3000/ws';
const PING_INTERVAL_MS = 25000;
const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

// In-memory state (survives only while SW is alive; that's fine for our needs)
const state = {
  ws: null,
  readyState: 'idle', // idle | connecting | open | closing
  retryDelay: RECONNECT_MIN_MS,
  reconnectTimer: null,
  pingTimer: null,
  helloAcked: false,
  lastError: '',
  lastCommand: '',
  lastCommandAt: 0,
  lastCommandOk: null,
  // diagnostics
  serverReachable: null, // null=unknown, true/false after check
  serverCheckAt: 0,
  ytTabs: [],            // last known list of YouTube tab IDs
  logs: [],              // ring buffer of recent log lines for popup
};

function log(line) {
  const ts = new Date().toISOString().slice(11, 19);
  const msg = '[' + ts + '] ' + line;
  console.log('[YTS-bg] ' + msg);
  state.logs.push(msg);
  if (state.logs.length > 80) state.logs.shift();
}

function clearTimers() {
  if (state.reconnectTimer) { clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
  if (state.pingTimer) { clearInterval(state.pingTimer); state.pingTimer = null; }
}

function connect() {
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
    return;
  }
  state.readyState = 'connecting';
  state.helloAcked = false;
  log('connecting to ' + SERVER_WS);
  let ws;
  try {
    ws = new WebSocket(SERVER_WS);
  } catch (e) {
    state.lastError = 'WS construct failed: ' + e.message;
    log(state.lastError);
    scheduleReconnect();
    return;
  }
  state.ws = ws;

  const connectTimeout = setTimeout(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      log('connect timeout');
      try { ws.close(); } catch (_) {}
    }
  }, 6000);

  ws.onopen = () => {
    clearTimeout(connectTimeout);
    state.readyState = 'open';
    state.retryDelay = RECONNECT_MIN_MS;
    state.serverReachable = true;
    state.serverCheckAt = Date.now();
    log('WS open');
    // Identify as extension
    try {
      ws.send(JSON.stringify({ action: '__hello', role: 'extension' }));
    } catch (_) {}
    state.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ action: '__ping' })); } catch (_) {}
      }
    }, PING_INTERVAL_MS);
  };

  ws.onmessage = (ev) => {
    let data;
    try { data = JSON.parse(ev.data); } catch (e) { return; }
    if (data.action === '__hello') {
      state.helloAcked = true;
      log('hello ack (extension=' + !!data.extension + ' phones=' + (data.phones || 0) + ')');
      // Tell server our current YT tab list
      refreshYtTabs().then(() => sendStatus());
      return;
    }
    if (data.action === '__presence') {
      log('presence phones=' + (data.phones || 0));
      return;
    }
    if (data.action === '__pong') return;
    if (data.action === '__ping') { try { ws.send(JSON.stringify({ action: '__pong' })); } catch (_) {} return; }

    // Real commands from phone
    if (data.action === 'shift' || data.action === 'apply-gap' || data.action === 'reset-gap') {
      handleCommand(data).catch((e) => {
        log('handleCommand error: ' + (e && e.message || e));
        state.lastCommandOk = false;
      });
    }
  };

  ws.onclose = (ev) => {
    clearTimeout(connectTimeout);
    state.readyState = 'closing';
    state.helloAcked = false;
    state.ws = null;
    clearTimers();
    log('WS closed (code=' + ev.code + ' reason=' + (ev.reason || '') + ')');
    scheduleReconnect();
  };

  ws.onerror = (ev) => {
    state.lastError = 'WS error';
    state.serverReachable = false;
    state.serverCheckAt = Date.now();
    log('WS error');
    try { ws.close(); } catch (_) {}
  };
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  const d = state.retryDelay;
  log('reconnect in ' + d + 'ms');
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, d);
  state.retryDelay = Math.min(Math.floor(state.retryDelay * 1.6), RECONNECT_MAX_MS);
}

async function refreshYtTabs() {
  try {
    const tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' });
    state.ytTabs = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));
    log('YT tabs: ' + state.ytTabs.length);
  } catch (e) {
    log('refreshYtTabs failed: ' + e.message);
  }
}

function sendStatus() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try {
    state.ws.send(JSON.stringify({
      action: '__status',
      status: {
        helloAcked: state.helloAcked,
        ytTabs: state.ytTabs.map((t) => ({ id: t.id, title: t.title, active: !!t.active })),
        lastCommand: state.lastCommand,
        lastCommandAt: state.lastCommandAt,
        lastCommandOk: state.lastCommandOk,
      }
    }));
  } catch (_) {}
}

async function handleCommand(cmd) {
  state.lastCommand = JSON.stringify(cmd);
  state.lastCommandAt = Date.now();
  log('cmd: ' + state.lastCommand);

  // Prefer the active YouTube tab; otherwise any YouTube tab.
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: '*://*.youtube.com/*' }); } catch (e) {}
  state.ytTabs = tabs.map((t) => ({ id: t.id, title: t.title, url: t.url, active: t.active }));

  let target = tabs.find((t) => t.active) || tabs[0];
  if (!target) {
    log('no YouTube tab open — dropping');
    state.lastCommandOk = false;
    sendStatus();
    return;
  }

  log('target tab ' + target.id + ' ' + (target.url || ''));

  // Ensure content script is loaded; if not, inject it
  const ensured = await ensureContentScript(target.id);
  if (!ensured) {
    log('could not ensure content script in tab ' + target.id);
    state.lastCommandOk = false;
    sendStatus();
    return;
  }

  let msg;
  if (cmd.action === 'shift') {
    msg = { action: 'remote-shift', delta: (cmd.ms || 0) / 1000 };
  } else if (cmd.action === 'apply-gap') {
    msg = { action: 'remote-apply-gap' };
  } else if (cmd.action === 'reset-gap') {
    msg = { action: 'reset-gap' };
  }
  if (!msg) return;

  try {
    const resp = await chrome.tabs.sendMessage(target.id, msg);
    state.lastCommandOk = !!(resp && resp.ok);
    log('cmd ok: ' + JSON.stringify(resp || {}));
  } catch (e) {
    log('sendMessage failed: ' + (e && e.message || e));
    state.lastCommandOk = false;
  }
  sendStatus();
}

async function ensureContentScript(tabId) {
  // Try a benign ping first; if it fails, inject content.js + css.
  try {
    const pong = await Promise.race([
      chrome.tabs.sendMessage(tabId, { action: '__ping_cs' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('cs ping timeout')), 800))
    ]);
    if (pong && pong.ok) return true;
  } catch (e) {
    log('content script not present, injecting: ' + (e && e.message || e));
  }
  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    // Give it a tick to register listeners
    await new Promise((r) => setTimeout(r, 250));
    return true;
  } catch (e) {
    log('inject failed: ' + (e && e.message || e));
    return false;
  }
}

// --------- Lifecycle & message routing ---------

self.addEventListener('install', () => {
  // SW stays alive as long as WS is open; rely on keepalive ping
  log('SW install');
});

chrome.runtime.onInstalled.addListener(() => { log('onInstalled'); connect(); });
chrome.runtime.onStartup.addListener(() => { log('onStartup'); connect(); });

// First activation
connect();

// Refresh tab list periodically; helps status
setInterval(() => { refreshYtTabs().then(sendStatus); }, 5000);

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tab && tab.url && tab.url.includes('youtube.com')) {
    refreshYtTabs();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  state.ytTabs = state.ytTabs.filter((t) => t.id !== tabId);
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  if (msg.action === 'popup-status') {
    sendResponse({
      readyState: state.readyState,
      serverReachable: state.serverReachable,
      helloAcked: state.helloAcked,
      ytTabs: state.ytTabs,
      lastCommand: state.lastCommand,
      lastCommandAt: state.lastCommandAt,
      lastCommandOk: state.lastCommandOk,
      logs: state.logs.slice(-30),
      serverWs: SERVER_WS,
      lastError: state.lastError,
    });
    return true;
  }

  if (msg.action === 'popup-reconnect') {
    log('popup requested reconnect');
    if (state.ws) { try { state.ws.close(); } catch (_) {} }
    state.retryDelay = RECONNECT_MIN_MS;
    connect();
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'popup-test') {
    log('popup requested test shift +200');
    handleCommand({ action: 'shift', ms: 200 }).catch(() => {});
    sendResponse({ ok: true });
    return true;
  }

  if (msg.action === 'wake') {
    connect();
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (!tab) return;
  if (command === 'toggle-shift-overlay') {
    chrome.tabs.sendMessage(tab.id, { action: 'toggle-overlay' }).catch(() => {});
  } else if (command === 'apply-gap') {
    chrome.tabs.sendMessage(tab.id, { action: 'show-gap-apply' }).catch(() => {});
  }
});
