// YTS Remote Control Bridge
// HTTP serves the phone UI + QR image; WebSocket relays commands between phone and extension.

const http = require('http');
const url = require('url');
const WebSocket = require('ws');
const os = require('os');
const QRCode = require('qrcode');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const LOG_FILE = path.join(__dirname, 'server.log');
const PIN = process.env.YTS_PIN || ''; // optional shared secret

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (_) {}
}

function getLanIPs() {
  const nets = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

function pickPrimaryIP(ips) {
  // Prefer 192.168.x / 10.x / 172.16-31.x — typical LAN ranges
  const prio = ips.filter((i) => i.startsWith('192.168.') || i.startsWith('10.') || /^172\.(1[6-9]|2\d|3[01])\./.test(i));
  return prio[0] || ips[0] || '127.0.0.1';
}

const PHONE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#121212">
<title>YTS Remote</title>
<style>
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent}
html,body{height:100%}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0a0a0a;color:#fff;text-align:center;padding:env(safe-area-inset-top) 16px env(safe-area-inset-bottom);min-height:100dvh;display:flex;flex-direction:column;align-items:center}
h1{color:#e50914;font-size:1.4rem;margin:14px 0 4px;letter-spacing:.5px}
.sub{color:#8e8e93;font-size:.8rem;margin-bottom:14px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:420px;width:100%}
.btn{background:#1c1c1e;border:2px solid #e50914;color:#fff;padding:22px 6px;font-size:1.15rem;font-weight:700;border-radius:14px;cursor:pointer;user-select:none;font-family:inherit}
.btn:active{background:#e50914;transform:scale(.96)}
.btn.gap{border-color:#4caf50;background:#143a17;color:#a5d6a7}
.btn.gap:active{background:#4caf50;color:#0a0a0a}
.btn.reset{border-color:#555;background:#1a1a1a;color:#aaa}
.btn.reset:active{background:#333;color:#fff}
.row{display:flex;gap:8px;max-width:420px;width:100%;margin-top:10px}
.row input{flex:1;background:#1c1c1e;border:1.5px solid #3a3a3c;color:#fff;padding:14px;font-size:1.05rem;border-radius:10px;text-align:center;outline:none;font-family:inherit}
.row input:focus{border-color:#e50914}
.row .send{background:#e50914;border:none;color:#fff;padding:0 22px;border-radius:10px;font-size:1rem;font-weight:700;cursor:pointer}
.status{margin-top:14px;font-size:.85rem;color:#8e8e93;display:flex;align-items:center;gap:6px;justify-content:center}
.dot{width:10px;height:10px;border-radius:50%;display:inline-block}
.dot.on{background:#4caf50;box-shadow:0 0 8px #4caf50aa}
.dot.off{background:#f44336}
.toast{position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#333;color:#fff;padding:10px 18px;border-radius:8px;font-size:.9rem;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.toast.show{opacity:1}
.hint{color:#666;font-size:.75rem;margin-top:8px;max-width:420px;line-height:1.4}
</style>
</head>
<body>
<h1>YTS REMOTE</h1>
<p class="sub" id="connInfo">connecting…</p>

<div class="grid">
  <button class="btn" data-shift="-500">−500 ms</button>
  <button class="btn" data-shift="500">+500 ms</button>
  <button class="btn" data-shift="-100">−100 ms</button>
  <button class="btn" data-shift="100">+100 ms</button>
</div>

<div class="grid" style="margin-top:10px">
  <button class="btn gap" data-act="apply-gap">Apply Gap</button>
  <button class="btn reset" data-act="reset-gap">Reset Gap</button>
</div>

<div class="row">
  <input id="customMs" type="text" inputmode="numeric" placeholder="Custom ms (e.g. -250)" autocomplete="off">
  <button class="send" id="sendBtn">Send</button>
</div>

<div class="status"><span class="dot off" id="dot"></span><span id="statusText">Connecting…</span></div>
<p class="hint" id="hint"></p>

<div class="toast" id="toast"></div>

<script>
(function(){
  var dot = document.getElementById('dot');
  var st = document.getElementById('statusText');
  var ci = document.getElementById('connInfo');
  var hint = document.getElementById('hint');
  var input = document.getElementById('customMs');
  var sendBtn = document.getElementById('sendBtn');
  var toast = document.getElementById('toast');

  var proto = window.location.protocol === 'https:' ? 'wss://' : 'ws://';
  var ws;
  var retryDelay = 500;
  var maxDelay = 8000;
  var pingTimer = null;

  function showToast(msg){
    toast.textContent = msg;
    toast.className = 'toast show';
    setTimeout(function(){ toast.className = 'toast'; }, 1400);
  }

  function connect(){
    ci.textContent = 'host: ' + window.location.host;
    ws = new WebSocket(proto + window.location.host + '/ws');
    ws.onopen = function(){
      dot.className = 'dot on';
      st.textContent = 'Connected';
      retryDelay = 500;
      // ping every 25s to keep alive
      pingTimer = setInterval(function(){
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({action:'__ping'}));
      }, 25000);
    };
    ws.onmessage = function(ev){
      var data;
      try { data = JSON.parse(ev.data); } catch(e){ return; }
      if (data.action === '__hello') {
        hint.textContent = 'Extension: ' + (data.extension ? 'connected ✓' : 'not connected — open YouTube and reload the extension');
      } else if (data.action === '__ack') {
        showToast('Sent ✓');
      } else if (data.action === '__nack') {
        showToast('Failed: ' + (data.reason || 'unknown'));
      } else if (data.action === '__pong') {
        // no-op
      }
    };
    ws.onclose = function(){
      dot.className = 'dot off';
      st.textContent = 'Reconnecting…';
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 1.6, maxDelay);
    };
    ws.onerror = function(){ try { ws.close(); } catch(_){} };
  }

  function send(obj){
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    } else {
      showToast('Not connected');
    }
  }

  document.querySelectorAll('[data-shift]').forEach(function(b){
    b.addEventListener('click', function(){ send({action:'shift', ms: parseInt(b.dataset.shift,10)}); });
  });
  document.querySelectorAll('[data-act]').forEach(function(b){
    b.addEventListener('click', function(){
      var a = b.dataset.act;
      if (a === 'apply-gap') send({action:'apply-gap'});
      else if (a === 'reset-gap') send({action:'reset-gap'});
    });
  });
  function sendCustom(){
    var v = input.value.trim();
    if (!v) return;
    var m = v.match(/^([+-]?)(\d+)$/);
    if (!m) { showToast('Invalid'); input.value=''; return; }
    var sign = m[1] === '-' ? -1 : 1;
    var n = sign * parseInt(m[2],10);
    send({action:'shift', ms: n});
    input.value = '';
  }
  sendBtn.addEventListener('click', sendCustom);
  input.addEventListener('keydown', function(e){
    if (e.key === 'Enter') { e.preventDefault(); sendCustom(); }
  });

  // prevent double-tap zoom on buttons (iOS)
  document.addEventListener('dblclick', function(e){ e.preventDefault(); });

  connect();
})();
</script>
</body>
</html>`;

// ---------- HTTP ----------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS for /api endpoints
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/' || pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(PHONE_HTML);
    return;
  }

  if (pathname === '/qr') {
    const target = (parsed.query && parsed.query.u) ? String(parsed.query.u) : ('http://' + pickPrimaryIP(getLanIPs()) + ':' + PORT + '/');
    try {
      const dataUrl = await QRCode.toDataURL(target, { width: 320, margin: 2, color: { dark: '#000', light: '#fff' } });
      const b64 = dataUrl.split(',')[1];
      const buf = Buffer.from(b64, 'base64');
      res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      res.end(buf);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('QR error: ' + e.message);
    }
    return;
  }

  if (pathname === '/qr.svg') {
    const target = (parsed.query && parsed.query.u) ? String(parsed.query.u) : ('http://' + pickPrimaryIP(getLanIPs()) + ':' + PORT + '/');
    try {
      const svg = await QRCode.toString(target, { type: 'svg', margin: 1, color: { dark: '#000', light: '#fff' } });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(svg);
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('QR error: ' + e.message);
    }
    return;
  }

  if (pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, port: PORT, ips: getLanIPs(), clients: wss ? wss.clients.size : 0 }));
    return;
  }

  if (pathname === '/favicon.ico') {
    res.writeHead(204); res.end(); return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ---------- WebSocket ----------
const wss = new WebSocket.Server({ noServer: true });

let extensionClients = new Set();
let phoneClients = new Set();

server.on('upgrade', (req, socket, head) => {
  const parsed = url.parse(req.url, true);
  if (parsed.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let role = 'unknown';
  let authed = !PIN;

  ws.on('message', (raw) => {
    let data;
    try { data = JSON.parse(raw.toString()); } catch (e) { return; }

    // First message may be a hello with role + pin
    if (data.action === '__hello') {
      if (PIN && data.pin !== PIN) { authed = false; }
      else { authed = true; }
      if (!authed) {
        ws.send(JSON.stringify({ action: '__nack', reason: 'bad pin' }));
        try { ws.close(); } catch (_) {}
        return;
      }
      role = data.role === 'extension' ? 'extension' : 'phone';
      if (role === 'extension') extensionClients.add(ws); else phoneClients.add(ws);
      log((role === 'extension' ? 'Extension' : 'Phone') + ' connected from ' + ip + ' (ext=' + extensionClients.size + ' phone=' + phoneClients.size + ')');
      // tell extension how many phones are connected; tell phones whether extension is online
      ws.send(JSON.stringify({
        action: '__hello',
        role,
        extension: extensionClients.size > 0,
        phones: phoneClients.size
      }));
      // also broadcast updated phone count to extension
      broadcastToExtensions({ action: '__presence', phones: phoneClients.size });
      return;
    }

    if (!authed) {
      ws.send(JSON.stringify({ action: '__nack', reason: 'not authed' }));
      return;
    }

    if (data.action === '__ping' || data.action === '__pong') return;

    // Phone -> Extension
    if (role === 'phone' && (data.action === 'shift' || data.action === 'apply-gap' || data.action === 'reset-gap')) {
      log('Phone cmd: ' + JSON.stringify(data));
      if (extensionClients.size === 0) {
        ws.send(JSON.stringify({ action: '__nack', reason: 'extension not connected' }));
        return;
      }
      broadcastToExtensions(data);
      ws.send(JSON.stringify({ action: '__ack' }));
      return;
    }

    // Extension -> Phone (status, log)
    if (role === 'extension' && data.action === '__status') {
      log('Extension status: ' + JSON.stringify(data.status || {}));
      broadcastToPhones({ action: '__extStatus', status: data.status || {} });
      return;
    }
  });

  ws.on('close', () => {
    if (role === 'extension') extensionClients.delete(ws);
    else if (role === 'phone') phoneClients.delete(ws);
    log((role === 'extension' ? 'Extension' : 'Phone') + ' disconnected (ext=' + extensionClients.size + ' phone=' + phoneClients.size + ')');
    broadcastToExtensions({ action: '__presence', phones: phoneClients.size });
  });

  ws.on('error', () => { try { ws.close(); } catch (_) {} });
});

function broadcastToExtensions(obj) {
  const msg = JSON.stringify(obj);
  for (const c of extensionClients) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(msg); } catch (_) {}
    }
  }
}

function broadcastToPhones(obj) {
  const msg = JSON.stringify(obj);
  for (const c of phoneClients) {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(msg); } catch (_) {}
    }
  }
}

// Keepalive ping every 30s; drop dead sockets
setInterval(() => {
  for (const set of [extensionClients, phoneClients]) {
    for (const ws of set) {
      if (ws.readyState !== WebSocket.OPEN) {
        set.delete(ws);
        continue;
      }
      try { ws.ping(); } catch (_) {}
    }
  }
}, 30000);

server.listen(PORT, HOST, () => {
  const ips = getLanIPs();
  const primary = pickPrimaryIP(ips);
  const url = 'http://' + primary + ':' + PORT + '/';

  log('Server listening on ' + HOST + ':' + PORT);
  log('Phone URL: ' + url);
  log('QR image:  http://' + primary + ':' + PORT + '/qr?u=' + encodeURIComponent(url));

  console.log('');
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║              YTS REMOTE BRIDGE (v2)                      ║');
  console.log('╠════════════════════════════════════════════════════════════╣');
  console.log('║  Phone URL (same WiFi):                                   ║');
  console.log('║    ' + url.padEnd(56) + '║');
  ips.forEach((ip) => {
    if (ip !== primary) {
      console.log('║    ' + ('http://' + ip + ':' + PORT + '/').padEnd(56) + '║');
    }
  });
  console.log('║                                                            ║');
  console.log('║  Click the extension icon to see a QR code.                ║');
  console.log('║  Health check: ' + ('http://' + primary + ':' + PORT + '/healthz').padEnd(39) + '║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
});
