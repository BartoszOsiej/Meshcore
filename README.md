# 🌐 N2 Mesh — P2P Chat

**Serverless peer-to-peer chat that runs on static hosting (GitHub Pages).**
No server, no database, no accounts — just WebRTC and a public MQTT broker
used only for signaling.

**Live: https://bartoszosiej.github.io/n2-mesh/**

## How it works

```
  ┌─────────────┐   WebRTC data channel   ┌─────────────┐
  │  Peer A     │◄───────────────────────►│  Peer B     │
  │ (your tab)  │    (direct, P2P)        │ (their tab) │
  └──────┬──────┘                         └──────┬──────┘
         │    SDP offer/answer/ICE via          │
         │    public MQTT topic (signaling only) │
         ▼                                       ▼
   ┌─────────────────────────────────────────────────┐
   │   Public MQTT broker (per-room topic)           │
   │   presence + signaling + fallback for messages  │
   └─────────────────────────────────────────────────┘
```

1. **Peers announce their presence** on a per-room MQTT topic (no account,
   public broker — the same way messengers discover each other).
2. When two peers see each other, they exchange **WebRTC offer/answer/ICE
   candidates** through that topic (the classic signaling-server pattern used
   by PeerJS & co.). The broker only *introduces* peers — it never sees
   message payloads.
3. Once connected, chat messages travel over the **WebRTC data channel**
   directly between browsers — real peer-to-peer.
4. On networks that block WebRTC (mobile carrier CGNAT), messages still flow
   through the MQTT topic as an automatic fallback. Recipients deduplicate by
   message id, so P2P stays primary and nothing is lost.

### Why not WebTorrent trackers?

The original build found peers through public WebTorrent WebSocket trackers
(`tracker.webtorrent.dev`, `tracker.openwebtorrent.com`). Those trackers now
accept announces and see the swarm, but **no longer relay WebRTC offers**
between peers — verified live: two peers registered in the same swarm
(`complete=2`) and zero offers ever came back. Since the browser build of
WebTorrent can only use WebSocket trackers (no UDP/DHT in the browser), peers
could never find each other and P2P was dead. Signaling over the MQTT relay
keeps the app fully serverless, works today, and matches how real messengers
do it.

## Features

- 🔗 **Rooms** — same room name = same signaling topic = same peer group
- 💬 **True P2P messages** — over WebRTC data channels, with MQTT fallback
- 🏷️ Nicknames, peer counter, connection status
- 🔗 Shareable room links (`#/room-name`)
- 🌙 Dark UI, keyboard accessible, zero dependencies (no CDN, no build step)

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-page shell |
| `app.js` | Networking (WebRTC + MQTT signaling) — zero dependencies |
| `style.css` | Dark aurora theme |

## Run locally

```bash
python3 -m http.server 8080
# open http://localhost:8080 (and a second tab to chat with yourself)
```

## Deploy

Push to `main` — GitHub Actions (`deploy.yml`) publishes the static files to
GitHub Pages automatically.

## Security note

- Messages travel **peer-to-peer** over WebRTC data channels whenever
  possible; the MQTT broker performs signaling and is used as a fallback
  transport on restrictive networks.
- This is a demo-grade mesh: peers must be online simultaneously. There is no
  history — when you leave, the room is gone.
