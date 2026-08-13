# N2 Mesh (P2P Chat) — Test Report & QA

> Generated: 2026-08-13 · Node 22 · Linux
> Re-run:
> ```bash
> npm test    # unit tests for core.js (node --test tests/*.test.js)
> npm run check   # syntax checks for app.js + core.js
> ```

## Whole project

**✅ 19/19 unit tests pass** (`tests/core.test.js`, `node:test`) · syntax
checks clean for `app.js` + `core.js`.

The pure logic was extracted from `app.js` into `core.js` (bytes, message
ids, dedup, room parsing, the full MQTT 3.1.1 packet layer) so it can be
tested headlessly without a browser or network.

## What the tests cover

- **Bytes** — utf8 round-trips (`toBytes` / `fromBytes`), plain arrays
- **Message ids** — uniqueness of `newMid`; dedup (`isNewMid`) returns
  true only on first sight, expires entries after the TTL and caps the seen
  map at 500
- **Room parsing** — hash normalisation (`#/`, casing), 48-char cap,
  `lobby` fallback
- **MQTT packets** — single- and multi-byte remaining-length encoding,
  PINGREQ, PUBLISH → `mqttParsePublish` round-trip (incl. QoS > 0 packet-id
  skipping), CONNECT variable header, SUBSCRIBE/UNSUBSCRIBE structure

## Bug found & fixed by the tests

`mqttParsePublish` checked the **DUP flag** (`d[0] & 0x08`) to decide
whether to skip a packet id, instead of the **QoS level** (`d[0] & 0x06`).
QoS-1 messages with the DUP flag clear were misparsed (the packet id leaked
into the payload). The app always published at QoS 0, so it never fired in
practice — the unit test caught it. Fixed to `d[0] & 0x06`.

## Notes

- Static, dependency-free WebRTC messenger — no build step; the test suite
  runs on Node's built-in `node:test` (no extra dependencies).
- Browser behaviour (WebRTC dialing, MQTT relay connection) is exercised by
  the Docs-site live demo.
