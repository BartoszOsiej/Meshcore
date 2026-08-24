'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

/* Deterministic PRNG (mulberry32) so every fuzz run is reproducible. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(0xC0FFEE);

function randInt(min, max) {
  return min + Math.floor(rng() * (max - min + 1));
}
function randBytes(n) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = randInt(0, 255);
  return out;
}
const TRICKY_TOPICS = [
  '', 'a', 'lobby', 'my room!', 'My Room', 'n2mesh/lobby',
  '#/x', '#', 'a/b/c/d/e', 'x'.repeat(200),
  'under_score-and-dash', 'sp ace', '\t\n',
];

/* ── remaining length: encoder ───────────────────────────────── */
test('remaining-length bytes: all spec boundaries', () => {
  const cases = [
    [0, [0x00]],
    [1, [0x01]],
    [127, [0x7f]],
    [128, [0x80, 0x01]],
    [255, [0xff, 0x01]],
    [16383, [0xff, 0x7f]],
    [16384, [0x80, 0x80, 0x01]],
    [2097151, [0xff, 0xff, 0x7f]],
    [2097152, [0x80, 0x80, 0x80, 0x01]],
    [268435455, [0xff, 0xff, 0xff, 0x7f]],
  ];
  for (const [len, want] of cases) {
    assert.deepStrictEqual(C.mqttRemainingLengthBytes(len), want, `len=${len}`);
  }
});

test('remaining-length encode rejects out-of-range', () => {
  assert.throws(() => C.mqttRemainingLengthBytes(-1), RangeError);
  assert.throws(() => C.mqttRemainingLengthBytes(268435456), RangeError);
  assert.throws(() => C.mqttRemainingLengthBytes(1.5), RangeError);
  assert.throws(() => C.mqttRemainingLengthBytes(NaN), RangeError);
});

/* ── remaining length: decoder ───────────────────────────────── */
test('remaining-length decode round-trips encoder for random values', () => {
  for (let i = 0; i < 5000; i++) {
    const len = randInt(0, 268435455);
    const bytes = C.mqttRemainingLengthBytes(len);
    const dec = C.mqttRemainingLength(bytes, 0);
    assert.ok(dec, `decode failed for len=${len}`);
    assert.strictEqual(dec.length, len);
    assert.strictEqual(dec.consumed, bytes.length);
  }
});

test('remaining-length decoder rejects malformed input', () => {
  assert.strictEqual(C.mqttRemainingLength(new Uint8Array([]), 0), null);
  assert.strictEqual(C.mqttRemainingLength(new Uint8Array([0x80]), 0), null);
  // 5 continuation bytes -> malformed (spec caps at 4)
  assert.strictEqual(
    C.mqttRemainingLength(new Uint8Array([0x80, 0x80, 0x80, 0x80, 0x01]), 0), null
  );
  // 4 continuation bytes, 4th still has the continuation bit -> malformed
  assert.strictEqual(
    C.mqttRemainingLength(new Uint8Array([0x80, 0x80, 0x80, 0x80]), 0), null
  );
  // 0xff 0xff 0xff 0x7f is exactly the spec max -> valid
  const max = C.mqttRemainingLength(new Uint8Array([0xff, 0xff, 0xff, 0x7f]), 0);
  assert.ok(max);
  assert.strictEqual(max.length, 268435455);
});

/* ── mqttEncode ──────────────────────────────────────────────── */
test('mqttEncode invariants: type byte, minimal length bytes', () => {
  for (let n = 0; n <= 4096; n++) {
    const body = randBytes(n);
    const pkt = C.mqttEncode(0x30, body);
    assert.strictEqual(pkt[0], 0x30);
    const dec = C.mqttRemainingLength(pkt, 1);
    assert.ok(dec, `decode failed n=${n}`);
    assert.strictEqual(dec.length, n);
    assert.strictEqual(1 + dec.consumed + n, pkt.length);
  }
});

test('mqttEncode rejects payloads above the MQTT max', () => {
  assert.throws(
    () => C.mqttEncode(0x30, new Uint8Array(268435456)),
    RangeError
  );
});

test('mqttPubPkt->mqttParsePublish round-trips across remaining-length boundaries', () => {
  const sizes = [0, 1, 2, 126, 127, 128, 129, 255, 16382, 16383, 16384, 16385, 65535];
  for (const size of sizes) {
    const topic = 'n2mesh/boundary';
    const payload = randBytes(size);
    const parsed = C.mqttParsePublish(C.mqttPubPkt(topic, payload));
    assert.ok(parsed, `parse failed size=${size}`);
    assert.strictEqual(parsed.topic, topic, `topic size=${size}`);
    assert.strictEqual(parsed.payload.length, size, `payload size=${size}`);
    assert.deepStrictEqual(Array.from(parsed.payload), Array.from(payload), `bytes size=${size}`);
  }
});

/* ── mqttParsePublish: QoS and DUP matrix ────────────────────── */
test('QoS 0/1/2 x DUP set/clear all parse correctly', () => {
  const topic = 'n2mesh/qos';
  const payload = C.toBytes('payload-xyz');
  for (const qos of [0, 1, 2]) {
    for (const dup of [0, 1]) {
      const type = 0x30 | (dup << 3) | (qos << 1);
      const t = C.toBytes(topic);
      const body = [0x00, t.length, ...t];
      if (qos > 0) body.push(0x12, 0x34); // packet id
      body.push(...payload);
      const pkt = C.mqttEncode(type, body);
      const parsed = C.mqttParsePublish(pkt);
      assert.ok(parsed, `parse failed qos=${qos} dup=${dup}`);
      assert.strictEqual(parsed.topic, topic, `topic qos=${qos} dup=${dup}`);
      assert.deepStrictEqual(
        Array.from(parsed.payload), Array.from(payload),
        `payload qos=${qos} dup=${dup}`
      );
    }
  }
});

test('mqttParsePublish returns null on malformed packets', () => {
  const malformed = [
    new Uint8Array([]),                  // empty
    new Uint8Array([0x30]),              // header, no remaining length
    new Uint8Array([0x30, 0x80]),        // truncated remaining length
    new Uint8Array([0x30, 0x05, 0x00]),  // declares 5 body bytes, has 1
    new Uint8Array([0x30, 0x02, 0x10, 0x00, 0x41, 0x41]), // tlen 0x1000 >> body
    new Uint8Array([0x32, 0x04, 0x00, 0x01, 0x74, 0x41]), // QoS1 missing packet id
    new Uint8Array([0x30, 0xff, 0xff, 0xff, 0xff, 0x7f, 0x00]), // 5-byte remaining length
    new Uint8Array([0x30, 0xff, 0xff, 0xff, 0x80]),       // continuation on 4th byte
    new Uint8Array([0x30, 0x05, 0x00, 0x02, 0x74, 0x69]), // body shorter than declared
  ];
  for (const d of malformed) {
    assert.strictEqual(C.mqttParsePublish(d), null, `expected null for ${Array.from(d)}`);
  }
});

test('mqttParsePublish accepts legal edge packets', () => {
  // Empty topic, empty payload: remaining=2 (just the 00 00 topic length).
  const emptyTopic = C.mqttParsePublish(new Uint8Array([0x30, 0x02, 0x00, 0x00]));
  assert.ok(emptyTopic);
  assert.strictEqual(emptyTopic.topic, '');
  assert.strictEqual(emptyTopic.payload.length, 0);
  // QoS0 with 2-byte topic and zero-length payload (remaining = 4).
  const short = C.mqttParsePublish(new Uint8Array([0x30, 0x04, 0x00, 0x02, 0x74, 0x69]));
  assert.ok(short);
  assert.strictEqual(short.topic, 'ti');
  assert.strictEqual(short.payload.length, 0);
});

test('fuzz: random topics and payloads round-trip exactly', () => {
  for (let i = 0; i < 2000; i++) {
    const topic = TRICKY_TOPICS[randInt(0, TRICKY_TOPICS.length - 1)] + 'x'.repeat(randInt(0, 10));
    const payload = randBytes(randInt(0, 30000)); // exercises 1-3 byte remaining length
    const parsed = C.mqttParsePublish(C.mqttPubPkt(topic, payload));
    assert.ok(parsed, `parse failed topic=${JSON.stringify(topic)}`);
    assert.strictEqual(parsed.topic, topic, `topic mismatch: ${JSON.stringify(topic)}`);
    assert.strictEqual(parsed.payload.length, payload.length);
    assert.deepStrictEqual(Array.from(parsed.payload), Array.from(payload));
  }
});

test('fuzz: garbage bytes never throw', () => {
  for (let i = 0; i < 5000; i++) {
    const d = randBytes(randInt(0, 40));
    const r = C.mqttParsePublish(d);
    if (r !== null) {
      assert.strictEqual(typeof r.topic, 'string');
      assert.ok(r.payload instanceof Uint8Array);
    }
  }
});

test('fuzz: random remaining-length byte strings decode deterministically', () => {
  for (let i = 0; i < 5000; i++) {
    const bytes = randBytes(randInt(0, 8));
    const r = C.mqttRemainingLength(bytes, 0);
    if (r !== null) {
      assert.ok(r.length >= 0 && r.length <= 268435455);
      assert.ok(r.consumed >= 1 && r.consumed <= 4);
    }
  }
});

/* ── parseRoom ───────────────────────────────────────────────── */
test('parseRoom is code-point safe (never splits astral chars)', () => {
  const room = C.parseRoom('#/' + '🚀'.repeat(60));
  assert.strictEqual(Array.from(room).length, 48);
  // No LONE surrogates may survive truncation — a valid pair is fine.
  assert.ok(!/(?:[\uD800-\uDBFF](?![\uDC00-\uDFFF]))|(?:(?<![\uD800-\uDBFF])[\uDC00-\uDFFF])/.test(room),
    `lone surrogate in ${JSON.stringify(room)}`);
  // The first 48 code points are preserved exactly (no double-counting).
  assert.strictEqual(room, '🚀'.repeat(48));
});

test('parseRoom never exceeds 48 code points, even with astral unicode', () => {
  const inputs = [
    '#/' + '🚀'.repeat(80),
    '#/' + 'z'.repeat(100),
    '#/' + 'a'.repeat(80),
  ];
  for (const inp of inputs) {
    const room = C.parseRoom(inp);
    assert.ok(Array.from(room).length <= 48, `${inp} -> ${room}`);
  }
});

test('parseRoom handles weird hashes, null and fallbacks', () => {
  assert.strictEqual(C.parseRoom(null), 'lobby');
  assert.strictEqual(C.parseRoom(undefined), 'lobby');
  assert.strictEqual(C.parseRoom('#/'), 'lobby');
  assert.strictEqual(C.parseRoom('', 'backup'), 'backup');
  assert.strictEqual(C.parseRoom('#/', 'backup'), 'backup');
  assert.strictEqual(C.parseRoom('###/x'), '##/x');
  assert.strictEqual(C.parseRoom('A/B/C'), 'a/b/c');
});

/* ── isNewMid ────────────────────────────────────────────────── */
test('isNewMid with max=0 still dedupes the first occurrence', () => {
  const seen = new Map();
  assert.strictEqual(C.isNewMid(seen, 'm', 30000, 0), true);
  assert.strictEqual(C.isNewMid(seen, 'm', 30000, 0), false);
});

test('isNewMid with ttl=0 expires instantly on the next clock tick', () => {
  const seen = new Map();
  assert.strictEqual(C.isNewMid(seen, 'x', 0, 500), true);
  for (const [k] of seen) seen.set(k, Date.now() - 1);
  assert.strictEqual(C.isNewMid(seen, 'x', 0, 500), true);
});

test('isNewMid dedupes within a window and caps the map', () => {
  const seen = new Map();
  for (let i = 0; i < 499; i++) {
    assert.strictEqual(C.isNewMid(seen, 'id-' + i, 30000, 500), true);
  }
  assert.strictEqual(C.isNewMid(seen, 'id-0', 30000, 500), false); // dedup holds
  // Push far past the cap: memory stays bounded and old ids get forgotten
  // (the cap clears the map once it exceeds `max`).
  for (let i = 0; i < 3000; i++) {
    assert.strictEqual(C.isNewMid(seen, 'bulk-' + i, 30000, 500), true);
  }
  assert.ok(seen.size <= 501, `map grew to ${seen.size}`);
  assert.strictEqual(C.isNewMid(seen, 'id-0', 30000, 500), true); // forgotten after clears
});

test('isNewMid prunes expired entries before checking', () => {
  const seen = new Map();
  C.isNewMid(seen, 'old', 100, 500);
  for (const [k] of seen) seen.set(k, Date.now() - 5000);
  C.isNewMid(seen, 'fresh', 100, 500);
  assert.ok(!seen.has('old'));
});

/* ── nickColor ───────────────────────────────────────────────── */
test('nickColor is deterministic and stable across runs', () => {
  const names = ['', 'buffy', 'a'.repeat(500), 'Zażółć gęślą jaźń'];
  for (const n of names) {
    assert.strictEqual(C.nickColor(n), C.nickColor(n), `name=${JSON.stringify(n)}`);
    assert.match(C.nickColor(n), /^hsl\(\d+ 70% 62%\)$/);
  }
});

test('nickColor hashes distinct names to distinct hues (no clumping)', () => {
  // 500 draws into 360 hue buckets: perfect uniformity gives ~270 unique hues.
  const hues = new Set();
  for (let i = 0; i < 500; i++) hues.add(C.nickColor('user' + i));
  assert.ok(hues.size > 180, `hues clumped badly: ${hues.size}/500 unique`);
  // Saturating the palette: 10k draws must cover nearly all 360 buckets.
  const all = new Set();
  for (let i = 0; i < 10000; i++) all.add(C.nickColor('n' + i));
  assert.ok(all.size >= 300, `hue coverage too poor: ${all.size}/360`);
});

/* ── newMid ──────────────────────────────────────────────────── */
test('newMid format and uniqueness under load', () => {
  const seen = new Set();
  for (let i = 0; i < 200000; i++) {
    const mid = C.newMid();
    assert.match(mid, /^[0-9a-z]+-[0-9a-z]+$/);
    assert.ok(!seen.has(mid), `duplicate mid ${mid}`);
    seen.add(mid);
  }
});

/* ── bytes ───────────────────────────────────────────────────── */
test('toBytes/fromBytes round-trip astral chars and NULs', () => {
  const samples = ['', '\0\0\0', 'héllo ⚡ wörld', '\u0000\uFFFF', 'a'.repeat(10000)];
  for (const s of samples) {
    assert.strictEqual(C.fromBytes(C.toBytes(s)), s, `round-trip ${JSON.stringify(s.slice(0, 20))}`);
  }
});

test('fromBytes decodes invalid UTF-8 to U+FFFD (replacement char)', () => {
  const bad = new Uint8Array([0x41, 0xff, 0xfe, 0x42]); // lone continuation bytes
  assert.strictEqual(C.fromBytes(bad), 'A\uFFFD\uFFFDB');
});

test('fromBytes accepts plain arrays and Uint8Array', () => {
  assert.strictEqual(C.fromBytes([0x68, 0x69]), 'hi');
  assert.strictEqual(C.fromBytes(new Uint8Array([0x68, 0x69])), 'hi');
});

/* ── mqttConnectPkt ──────────────────────────────────────────── */
test('mqttConnectPkt accepts empty and unicode client ids', () => {
  for (const cid of ['', 'x', 'n2-abc123']) {
    const pkt = C.mqttConnectPkt(cid);
    assert.strictEqual(pkt[0], 0x10);
    const dec = C.mqttRemainingLength(pkt, 1);
    assert.ok(dec);
    assert.strictEqual(1 + dec.consumed + dec.length, pkt.length);
  }
});
