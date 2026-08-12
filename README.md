# 🌐 N2 Mesh — P2P Chat (torrent-principle)

**Serverless peer-to-peer chat that runs on static hosting (GitHub Pages).**
No server, no database, no accounts — just WebTorrent.

**Live: https://bartoszosiej.github.io/N2-Mesh/**

## How it works (the torrent principle)

```
  ┌─────────────┐   room = infohash   ┌─────────────┐
  │  Peer A     │◄───────────────────►│  Peer B     │
  │ (your tab)  │   WebTorrent swarm  │ (their tab) │
  └──────┬──────┘                     └──────┬──────┘
         │   WebRTC signaling via public     │
         │   WebSocket tracker (only)        │
         ▼                                   ▼
   ┌────────────────────────────────────────────┐
   │   Public WebSocket trackers (announce)     │
   └────────────────────────────────────────────┘
```

1. **Every peer in a room seeds the SAME tiny blob.** Identical content →
   identical **infohash** → they all join the same WebTorrent swarm
   (exactly like a torrent).
2. A public WebSocket tracker performs **WebRTC signaling** between swarm
   members — the tracker is only a *meeting point*, it never sees messages.
3. Once two peers are connected, chat messages ride the established
   connection as **BitTorrent extended-protocol** messages — i.e. messages
   literally travel on torrent peer connections, peer-to-peer.

## Features

- 🔗 **Rooms as torrents** — same room name = same infohash = same swarm
- 💬 **True P2P messages** — via BitTorrent extended protocol, queued until
  the extended handshake completes (nothing lost)
- 🏷️ Nicknames, peer counter, connection status
- 🔗 Shareable room links (`#/room-name`)
- 🌙 Dark UI, keyboard accessible, works offline-adjacent (vendored lib)

## Files

| File | Purpose |
|---|---|
| `index.html` | Single-page shell |
| `app.js` | Networking (WebTorrent swarm + extended-protocol chat) |
| `style.css` | Dark aurora theme |
| `webtorrent.min.js` | **Vendored** WebTorrent (no CDN dependency) |

## Run locally

```bash
python3 -m http.server 8080
# open http://localhost:8080
```

## Deploy

Push to `main` — GitHub Actions (`deploy.yml`) publishes the static files to
GitHub Pages automatically.

## Security note

- Messages travel **peer-to-peer only**; the tracker performs signaling and
  never receives message payloads.
- This is a demo-grade mesh: peers must be online simultaneously. There is no
  history — when you leave, the swarm is gone.
