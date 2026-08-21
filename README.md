<img src="https://capsule-render.vercel.app/api?type=waving&color=0:0d1117,50:1f6feb,100:39c5cf&height=140&section=header&text=N2%20Mesh&fontSize=38&fontColor=fff&desc=serverless%20P2P%20chat%20%C2%B7%20WebRTC%20%C2%B7%20zero%20dependencies&descSize=15&descAlignY=72" width="100%" />

<div align="center">

[![npm](https://img.shields.io/npm/v/n2-mesh?style=for-the-badge&logo=nodedotjs)](https://www.npmjs.com/package/n2-mesh)
[![GHCR](https://img.shields.io/badge/GHCR-image-2496ED?style=for-the-badge&logo=docker)](https://github.com/BartoszOsiej/n2-mesh/pkgs/container/n2-mesh)
[![Live](https://img.shields.io/badge/live-GitHub_Pages-2ea043?style=for-the-badge&logo=githubpages)](https://bartoszosiej.github.io/n2-mesh/)
[![License](https://img.shields.io/badge/license-MIT-green?style=for-the-badge)](LICENSE)

**Serverless peer-to-peer chat that runs on static hosting.**
No server, no database, no accounts — just WebRTC and a public MQTT broker
used only for signaling.

**→ [Open the live app](https://bartoszosiej.github.io/n2-mesh/)**

</div>

## How it works

```mermaid
flowchart LR
    A["Peer A<br/>your tab"] <--> |"WebRTC data channel<br/>direct P2P"| B["Peer B<br/>their tab"]
    A <-.-> |"SDP offer / answer / ICE"| M["public MQTT broker<br/>per-room topic<br/>signaling only"]
    B <-.-> M
```

1. **Peers announce presence** on a per-room MQTT topic (no account)
2. Two peers see each other → exchange **WebRTC offer/answer/ICE candidates** through that topic — the broker only *introduces* peers, it never sees message payloads
3. Once connected, messages travel over the **WebRTC data channel** directly between browsers — real peer-to-peer
4. On networks that block WebRTC (mobile CGNAT), messages flow through MQTT as automatic fallback; recipients deduplicate by message id

> [!NOTE]
> **Why not WebTorrent trackers?** The original build used public WebTorrent
> WebSocket trackers. Verified live: those trackers accept announces and see
> the swarm (`complete=2`) but **no longer relay WebRTC offers** between peers.
> Since browser WebTorrent can only use WebSocket trackers, P2P was dead.
> MQTT signaling keeps the app fully serverless and matches how real messengers do it.

## Features

- 🔗 **Rooms** — same room name = same signaling topic = same peer group
- 💬 **True P2P messages** — over WebRTC data channels, with MQTT fallback
- 🏷️ Nicknames, peer counter, connection status
- 🔗 Shareable room links (`#/room-name`)
- 🌙 Dark UI, keyboard accessible, zero dependencies (no CDN, no build step)

<details>
<summary><b>📁 Files & running locally</b></summary>

| File | Purpose |
|---|---|
| `index.html` | Single-page shell |
| `app.js` | Networking (WebRTC + MQTT signaling) — zero dependencies |
| `style.css` | Dark aurora theme |

```bash
python3 -m http.server 8080
# open http://localhost:8080 (and a second tab to chat with yourself)
```

Push to `main` — GitHub Actions publishes to GitHub Pages automatically.

</details>

> [!CAUTION]
> Demo-grade mesh: peers must be online simultaneously. No history — when you
> leave, the room is gone.

---

<div align="center">

**Part of [BartoszOsiej](https://github.com/BartoszOsiej)'s portfolio** · [Docs](https://bartoszosiej.github.io/Docs/projects/n2-mesh/)

MIT © 2026 Bartosz Osiej

</div>
