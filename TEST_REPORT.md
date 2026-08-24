# N2 Mesh (P2P Chat) — Test Report & QA

> Generated: 2026-08-14 · Node 22 · Linux
> Re-run:
> ```bash
> npm test    # unit tests (node --test tests/*.test.js)
> npm run check   # syntax checks for app.js + core.js
> ```

## Whole project

**✅ 49/49 unit tests pass** (`tests/core.test.js` + `tests/core.rigorous.test.js`,
`node:test`) · syntax checks clean for `app.js` + `core.js`.

The pure logic was extracted from `app.js` into `core.js` (bytes, message
ids, dedup, room parsing, the full MQTT 3.1.1 packet layer) so it can be
tested headlessly without a browser or network. The second suite is
**rigorous**: fuzz, property-based and malformed-input tests driven by a
deterministic PRNG (mulberry32, seed `0xC0FFEE`) — every run is reproducible.

## What the tests cover

### Functional suite (`core.test.js` — 22 tests)
- **Bytes** — utf8 round-trips (`toBytes` / `fromBytes`), plain arrays
- **Message ids** — uniqueness of `newMid`; dedup (`isNewMid`) returns true
  only on first sight, expires entries after the TTL and caps the seen map
- **Room parsing** — hash normalisation (`#/`, casing), 48-char cap, `lobby`
  fallback
- **MQTT packets** — remaining-length encoding (single/multi byte),
  PINGREQ, PUBLISH round-trips (incl. QoS > 0 packet-id skipping), CONNECT
  variable header, SUBSCRIBE/UNSUBSCRIBE structure

### Rigorous suite (`core.rigorous.test.js` — 27 tests)
- **Remaining length** — every spec boundary (0, 127, 128, 16 383, 16 384,
  2 097 151, 2 097 152, 268 435 455) byte-for-byte; 5000 random
  encode→decode round-trips; rejects out-of-range, truncated, >4-byte and
  overflowed encodings; rejects payloads above the MQTT maximum
- **mqttEncode invariants** — for every body size 0..4096: correct type
  byte, minimal length bytes, exact packet length
- **PUBLISH parse** — QoS 0/1/2 × DUP set/clear matrix; payload sizes across
  every remaining-length boundary up to 65 535 bytes; legal edge packets
  (empty topic, zero-length payload); **malformed packets → `null`** (empty,
  truncated length, body shorter than declared, topic-length overflow,
  QoS-1 missing packet id, 5-byte remaining length)
- **Fuzz** — 2000 random topic/payload round-trips (topics include unicode,
  empty, `#/`, 200-char, whitespace); 5000 garbage buffers never throw;
  5000 random remaining-length byte strings decode deterministically
- **parseRoom** — code-point-safe truncation (astral chars never split into
  lone surrogates), 48-code-point cap, `null`/`undefined`/fallback handling
- **isNewMid** — `max=0` and `ttl=0` edge cases, dedup within a window, map
  stays bounded under 3000 bulk inserts, expired entries pruned before check
- **nickColor** — determinism, empty/unicode/500-char names, hue distribution
  (no clumping; palette saturation over 10k names)
- **newMid** — 200 000 ids: format regex + zero duplicates
- **Bytes** — astral chars, NUL bytes, 10k-char strings; invalid UTF-8 decodes
  to U+FFFD; plain arrays accepted

## Bugs found & fixed by the tests

1. **`mqttParsePublish` used the DUP flag instead of the QoS level** to
   decide whether to skip a packet id. QoS-1 messages with DUP clear were
   misparsed. Fixed to `d[0] & 0x06`.
2. **`mqttParsePublish` assumed ≤ 2-byte remaining length** and never
   validated the packet bounds. It now decodes the full MQTT 3.1.1
   remaining length (up to 4 bytes, max 268 435 455), rejects malformed
   packets with `null`, and bounds the payload by the decoded length so
   trailing bytes can never leak into a message. `app.js` guards the result.
3. **`parseRoom(null)` crashed** (`hash.replace` on null). Now null-safe.
4. **`parseRoom` could split a surrogate pair** when capping at 48 chars,
   producing a lone surrogate in the room name. Now truncates per code point
   (`Array.from(...)`), so astral chars survive intact.

## Notes

- Static, dependency-free WebRTC messenger — no build step; the test suite
  runs on Node's built-in `node:test` (no extra dependencies).
- Browser behaviour (WebRTC dialing, MQTT relay connection) is exercised by
  the Docs-site live demo.
