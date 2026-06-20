# YTS Remote — YouTube Timeline Shifter

A Chrome/Brave extension (Manifest V3) that lets you nudge the currently playing
YouTube video's timeline forward or backward by an exact millisecond amount —
**from your desktop shortcut, the toolbar popup, OR your phone over the local network.**

## Features

1. **In-page overlay** — press **Alt+Shift+W** while watching a video (works in
   fullscreen too). Type `+500` or `-200`, hit **Enter**, the video seeks.
2. **Toolbar popup** — click the extension icon, type the ms, hit Enter.
3. **Phone remote** — click the extension icon, scan the QR code with your
   phone. The phone page connects to your machine over local WiFi and shifts
   the YouTube tab live.

## Install

### 1. Run the bridge server (needed for the phone remote)

```bash
cd mini-sync-extension/      # this folder
npm install                  # one-time, installs ws + qrcode
npm start
```

You should see something like:

```
╔════════════════════════════════════════════════════════════╗
║              YTS REMOTE BRIDGE (v2)                      ║
╠════════════════════════════════════════════════════════════╣
║  Phone URL (same WiFi):                                   ║
║    http://192.168.1.42:3000/                              ║
╚════════════════════════════════════════════════════════════╝
```

Keep that terminal open.

### 2. Install the extension

1. Open `chrome://extensions` (or `brave://extensions`).
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked** and select this folder.
4. Make sure the extension is enabled (toggle on).

### 3. Open YouTube + use it

- Open a YouTube video in Chrome.
- Click the extension icon — you'll see a **QR code** plus the URL.
- Scan the QR with your phone (must be on the **same WiFi**).
- The phone page connects automatically.
- Tap `+500ms` / `-500ms` etc. and watch the desktop YouTube tab respond.

If something doesn't work, click **Reconnect** in the popup, or check the
"Recent log" panel at the bottom of the popup.

## Optional

- **Cross-network access** (4G/5G from your phone): forward port 3000 from
  your router, or run a tunnel like `cloudflared tunnel --url http://localhost:3000`
  and change the URL the popup shows. (The bridge listens on `0.0.0.0:3000`
  by default.)
- **PIN lock**: set the environment variable `YTS_PIN=1234` before
  `npm start`. Both the phone page and the extension will be required to send
  that PIN in their first message.

## File layout

```
yts-remote/
├── manifest.json          # MV3 manifest
├── background.js          # service worker: WS to bridge + dispatch to YT tab
├── content.js             # injected into youtube.com — overlay + seek logic
├── content.css            # overlay styling
├── server.js              # bridge: HTTP (UI + QR) + WebSocket relay
├── package.json
├── popup/
│   ├── popup.html         # QR + status + URL
│   ├── popup.css
│   └── popup.js
└── icons/
    └── icon128.png
```

## How it works

```
Phone browser ──HTTP/WS──▶  bridge server (this folder, port 3000)
                              │
                              │  WebSocket /ws  (role: extension)
                              ▼
Chrome service worker (background.js)
                              │
                              │  chrome.tabs.sendMessage()
                              ▼
YouTube tab content script (content.js)  ──▶  video.currentTime += delta
```

- The bridge does NOT talk to YouTube directly. It only relays commands.
- The extension's WebSocket is the source of truth for "which tab is active".
- If the content script isn't loaded in the active tab (e.g. the extension was
  installed mid-session), the background automatically injects it.

## Troubleshooting

| Symptom | Fix |
|---|---|
| QR shows "Server not reachable" | Run `npm install && npm start` in this folder. |
| Phone shows "Reconnecting…" forever | Phone is on a different WiFi. Move it to the same network. Or the laptop firewall is blocking port 3000. |
| Buttons on phone light up green but nothing happens on the desktop | Make sure a YouTube tab is open and active. Click **Reconnect** in the popup. |
| Service worker is asleep | The popup keeps it awake by polling every 2s. The 25s WS ping also helps. |
| Cross-network (4G) needed | Use a tunnel (`cloudflared`, `ngrok`, `localtunnel`) and override the URL shown in the popup. |
