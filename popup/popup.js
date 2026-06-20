// popup.js — drive the popup UI, fetch status from the background,
// and pull a QR PNG from the local bridge server.

(function () {
  'use strict';

  var qrWrap = document.getElementById('qrWrap');
  var qrEmpty = document.getElementById('qrEmpty');
  var phoneUrl = document.getElementById('phoneUrl');
  var copyBtn = document.getElementById('copyBtn');
  var openBtn = document.getElementById('openBtn');
  var reconnectBtn = document.getElementById('reconnectBtn');
  var testBtn = document.getElementById('testBtn');
  var serverDot = document.getElementById('serverDot');
  var serverText = document.getElementById('serverText');
  var extDot = document.getElementById('extDot');
  var extText = document.getElementById('extText');
  var ytTabsEl = document.getElementById('ytTabs');
  var logsEl = document.getElementById('logs');
  var hintEl = document.getElementById('hint');

  // Cached state
  var lastServerOrigin = null;
  var lastPhoneUrl = null;

  function setDot(el, cls, text, hintCls) {
    el.className = 'dot ' + (cls || '');
    if (text !== undefined) {
      // pair element is the sibling <span>
      var sib = el.nextElementSibling;
      if (sib) sib.textContent = text;
    }
    if (hintCls) {
      hintEl.className = 'hint ' + hintCls;
    }
  }

  function setHint(msg, cls) {
    hintEl.textContent = msg;
    hintEl.className = 'hint ' + (cls || '');
  }

  function detectServerOrigin() {
    // We assume the popup's host extension can hit localhost:3000.
    // If you want to override, set window.YTS_SERVER before opening the popup.
    if (window.YTS_SERVER) return Promise.resolve(window.YTS_SERVER);
    // Probe a list of likely origins in order
    var candidates = ['http://127.0.0.1:3000', 'http://localhost:3000'];
    return probe(candidates);
  }

  function probe(origins) {
    return new Promise(function (resolve) {
      var i = 0;
      function next() {
        if (i >= origins.length) return resolve(null);
        var o = origins[i++];
        fetch(o + '/healthz', { cache: 'no-store', mode: 'cors' })
          .then(function (r) {
            if (!r.ok) throw new Error('not ok');
            return r.json();
          })
          .then(function (j) {
            if (j && j.ok) resolve(o);
            else next();
          })
          .catch(function () { next(); });
      }
      next();
    });
  }

  function showQR(origin) {
    // Pick the URL the server reported (or fallback)
    var target = origin + '/';
    var img = new Image();
    img.alt = 'QR code';
    img.src = origin + '/qr?u=' + encodeURIComponent(target) + '&t=' + Date.now();
    img.onload = function () {
      qrEmpty.style.display = 'none';
      // remove old img if any
      var old = qrWrap.querySelector('img');
      if (old) qrWrap.removeChild(old);
      qrWrap.appendChild(img);
    };
    img.onerror = function () {
      qrEmpty.textContent = 'QR generation failed';
      qrEmpty.style.display = 'flex';
    };
    lastServerOrigin = origin;
    lastPhoneUrl = target;
    phoneUrl.textContent = target;
    phoneUrl.href = target;
    openBtn.disabled = false;
    openBtn.onclick = function () {
      chrome.tabs.create({ url: target });
    };
    copyBtn.onclick = function () {
      navigator.clipboard.writeText(target).then(function () {
        copyBtn.textContent = 'Copied';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1000);
      }).catch(function () {
        copyBtn.textContent = 'Failed';
        setTimeout(function () { copyBtn.textContent = 'Copy'; }, 1000);
      });
    };
  }

  function renderLogs(logs) {
    if (!logs || !logs.length) {
      logsEl.textContent = '(no entries yet)';
      return;
    }
    logsEl.textContent = logs.join('\n');
    logsEl.scrollTop = logsEl.scrollHeight;
  }

  function renderYtTabs(tabs) {
    if (!tabs || !tabs.length) {
      ytTabsEl.textContent = 'No YouTube tabs open — open one first.';
      return;
    }
    ytTabsEl.innerHTML = '';
    tabs.forEach(function (t) {
      var d = document.createElement('div');
      d.className = 'yt-tab' + (t.active ? ' active' : '');
      d.textContent = (t.active ? '● ' : '○ ') + (t.title || '(untitled)');
      ytTabsEl.appendChild(d);
    });
  }

  function refresh() {
    chrome.runtime.sendMessage({ action: 'popup-status' }, function (resp) {
      if (chrome.runtime.lastError) {
        setDot(serverDot, 'red', 'BG: ' + chrome.runtime.lastError.message);
        return;
      }
      if (!resp) return;

      // Server reachability from BG
      if (resp.serverReachable === true) {
        setDot(serverDot, 'green', 'Server: reachable (' + (resp.serverWs || '') + ')');
      } else if (resp.serverReachable === false) {
        setDot(serverDot, 'red', 'Server: NOT reachable — is "npm start" running?');
        setHint('Run "npm install && npm start" in the extension folder, then reopen this popup.', 'err');
      } else {
        setDot(serverDot, 'amber', 'Server: probing…');
      }

      // Extension WS state
      var map = { idle: 'amber', connecting: 'amber', open: 'green', closing: 'red' };
      var cls = map[resp.readyState] || 'amber';
      var txt = 'Extension WS: ' + resp.readyState + (resp.helloAcked ? ' (hello✓)' : '');
      setDot(extDot, cls, txt);

      // YT tabs
      renderYtTabs(resp.ytTabs);

      // Last command
      if (resp.lastCommand) {
        var ago = Math.round((Date.now() - resp.lastCommandAt) / 100) / 10;
        var okTxt = resp.lastCommandOk === true ? '✓' : (resp.lastCommandOk === false ? '✗' : '?');
        var lc = document.createElement('div');
        lc.className = 'hint';
        lc.textContent = 'Last cmd ' + okTxt + ' (' + ago + 's ago): ' + resp.lastCommand;
        // We won't replace logs, just print below as transient
        var existing = document.getElementById('lastCmd');
        if (existing) existing.remove();
        lc.id = 'lastCmd';
        document.body.insertBefore(lc, hintEl);
      }

      // Logs
      renderLogs(resp.logs);
    });
  }

  detectServerOrigin().then(function (origin) {
    if (origin) {
      showQR(origin);
      setHint('Scan the QR code with your phone (same WiFi). The page will auto-connect.', 'ok');
    } else {
      qrEmpty.textContent = 'Server not reachable on localhost:3000.\nStart it with: npm start';
      qrEmpty.style.display = 'flex';
      setHint('Server not reachable. Run "npm install && npm start" first.', 'err');
    }
  });

  reconnectBtn.addEventListener('click', function () {
    reconnectBtn.disabled = true;
    chrome.runtime.sendMessage({ action: 'popup-reconnect' }, function () {
      reconnectBtn.disabled = false;
      setTimeout(refresh, 800);
    });
  });

  testBtn.addEventListener('click', function () {
    testBtn.disabled = true;
    chrome.runtime.sendMessage({ action: 'popup-test' }, function () {
      testBtn.disabled = false;
      setTimeout(refresh, 1000);
    });
  });

  refresh();
  setInterval(refresh, 2000);
})();
