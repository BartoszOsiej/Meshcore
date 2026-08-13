'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

/* ── bytes ─────────────────────────────────────────────────── */
test('toBytes/fromBytes round-trip utf8', () => {
  const bytes = C.toBytes('héllo ⚡ wörld');
  assert.ok(bytes instanceof Uint8Array);
  assert.strictEqual(C.fromBytes(bytes), 'héllo ⚡ wörld');
});

test('fromBytes accepts plain arrays', () => {
  assert.strictEqual(C.fromBytes([0x68, 0x69]), 'hi');
});

/* ── ids & dedup ───────────────────────────────────────────── */
test('newMid produces unique ids', () => {
  const ids = new Set(Array.from({ length: 200 }, () => C.newMid()));
  assert.strictEqual(ids.size, 200);
});

test('isNewMid dedups and reports first occurrence', () => {
  const seen = new Map();
  assert.strictEqual(C.isNewMid(seen, 'abc', 30000, 500), true);
  assert.strictEqual(C.isNewMid(seen, 'abc', 30000, 500), false);
  assert.strictEqual(C.isNewMid(seen, 'def', 30000, 500), true);
});

test('isNewMid treats empty ids as new', () => {
  assert.strictEqual(C.isNewMid(new Map(), '', 30000, 500), true);
  assert.strictEqual(C.isNewMid(new Map(), null, 30000, 500), true);
});

test('isNewMid expires old entries after ttl', () => {
  const seen = new Map();
  const ttl = 50;
  assert.strictEqual(C.isNewMid(seen, 'stale', ttl, 500), true);
  // Simulate the passage of time by rewriting the stored timestamp.
  for (const [k] of seen) seen.set(k, Date.now() - 1000);
  assert.strictEqual(C.isNewMid(seen, 'stale', ttl, 500), true);
});

test('isNewMid caps the seen map', () => {
  const seen = new Map();
  for (let i = 0; i < 600; i++) C.isNewMid(seen, 'm' + i, 30000, 500);
  assert.ok(seen.size <= 500, `map capped: ${seen.size}`);
});

/* ── room parsing ──────────────────────────────────────────── */
test('parseRoom normalises hashes', () => {
  assert.strictEqual(C.parseRoom(''), 'lobby');
  assert.strictEqual(C.parseRoom('#'), 'lobby');
  assert.strictEqual(C.parseRoom('#/'), 'lobby');
  assert.strictEqual(C.parseRoom('#/my-room'), 'my-room');
  assert.strictEqual(C.parseRoom('#/My Room!'), 'my room!');
});

test('parseRoom caps at 48 chars and falls back', () => {
  const long = '#/' + 'a'.repeat(80);
  assert.strictEqual(C.parseRoom(long).length, 48);
  assert.strictEqual(C.parseRoom('', 'backup'), 'backup');
  assert.strictEqual(C.parseRoom('#/', 'backup'), 'backup');
});

/* ── nick colors ───────────────────────────────────────────── */
test('nickColor is stable and deterministic', () => {
  assert.strictEqual(C.nickColor('buffy'), C.nickColor('buffy'));
  assert.match(C.nickColor('buffy'), /^hsl\(\d+ 70% 62%\)$/);
});

/* ── MQTT packet layer ─────────────────────────────────────── */
test('mqttEncode encodes single-byte remaining length', () => {
  const pkt = C.mqttEncode(0x30, [0x00, 0x02, 0x61, 0x62]); // body = 4 bytes
  assert.deepStrictEqual(Array.from(pkt), [0x30, 0x04, 0x00, 0x02, 0x61, 0x62]);
});

test('mqttEncode encodes multi-byte remaining length', () => {
  // 200-byte body → remaining length bytes [0xc8, 0x01].
  const body = new Array(200).fill(0x41);
  const pkt = C.mqttEncode(0x30, body);
  assert.strictEqual(pkt[0], 0x30);
  assert.strictEqual(pkt[1], 0xc8);
  assert.strictEqual(pkt[2], 0x01);
  assert.strictEqual(pkt.length, 3 + 200);
});

test('mqttPingPkt is the canonical ping', () => {
  assert.deepStrictEqual(Array.from(C.mqttPingPkt()), [0xc0, 0x00]);
});

test('mqttPubPkt → mqttParsePublish round-trips topic and payload', () => {
  const topic = 'n2mesh/lobby';
  const payload = C.toBytes(JSON.stringify({ u: 'buffy', t: 'hi', ts: 1, mid: 'x-1' }));
  const pkt = C.mqttPubPkt(topic, payload);
  const parsed = C.mqttParsePublish(pkt);
  assert.strictEqual(parsed.topic, topic);
  assert.deepStrictEqual(Array.from(parsed.payload), Array.from(payload));
});

test('mqttParsePublish handles multi-byte remaining length', () => {
  const topic = 'n2mesh/lobby';
  const payload = C.toBytes('p'.repeat(200)); // forces remaining length > 127
  const pkt = C.mqttPubPkt(topic, payload);
  assert.ok(pkt[1] & 0x80, 'expected multi-byte remaining length');
  const parsed = C.mqttParsePublish(pkt);
  assert.strictEqual(parsed.topic, topic);
  assert.strictEqual(C.fromBytes(parsed.payload), 'p'.repeat(200));
});

test('mqttParsePublish skips packet id for QoS > 0', () => {
  // Manually build a QoS 1 PUBLISH: 0x32 + [len, topic_len_hi, topic_len_lo,
  // topic..., packet_id_hi, packet_id_lo, payload...].
  const topic = C.toBytes('t');
  const body = [0x00, 0x01, ...topic, 0x12, 0x34, 0x41, 0x42]; // pid + "AB"
  const pkt = C.mqttEncode(0x32, body);
  const parsed = C.mqttParsePublish(pkt);
  assert.strictEqual(parsed.topic, 't');
  assert.strictEqual(C.fromBytes(parsed.payload), 'AB');
});

test('mqttConnectPkt carries protocol name, level 4, keepalive 60', () => {
  const pkt = C.mqttConnectPkt('client-1');
  const bytes = Array.from(pkt);
  assert.strictEqual(bytes[0], 0x10);
  // Variable header: 00 04 'M' 'Q' 'T' 'T' 04 02 00 3c
  const vh = bytes.slice(2, 2 + 10);
  assert.deepStrictEqual(vh, [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c]);
});

test('mqttSubPkt subscribes one topic at QoS 0', () => {
  const pkt = Array.from(C.mqttSubPkt('n2mesh/lobby'));
  assert.strictEqual(pkt[0], 0x82); // SUBSCRIBE, flags 2
  assert.strictEqual(pkt[2], 0x00); // packet id hi
  assert.strictEqual(pkt[3], 0x01); // packet id lo
  assert.strictEqual(pkt[pkt.length - 1], 0x00); // requested QoS 0
});

test('mqttUnsubPkt structure', () => {
  const pkt = Array.from(C.mqttUnsubPkt('n2mesh/old'));
  assert.strictEqual(pkt[0], 0xa2); // UNSUBSCRIBE, flags 2
});

test('mqttEncode handles empty body', () => {
  assert.deepStrictEqual(Array.from(C.mqttEncode(0xd0, [])), [0xd0, 0x00]);
});

test('mqttPubPkt round-trips a room-sized payload', () => {
  const topic = 'n2mesh/some-long-room-name-here';
  const payload = C.toBytes(JSON.stringify({ u: 'x', t: 'y', ts: 2, mid: 'm-2' }));
  const parsed = C.mqttParsePublish(C.mqttPubPkt(topic, payload));
  assert.strictEqual(parsed.topic, topic);
  const obj = JSON.parse(C.fromBytes(parsed.payload));
  assert.strictEqual(obj.mid, 'm-2');
});

test('parseRoom strips the leading slash and keeps inner ones', () => {
  assert.strictEqual(C.parseRoom('#/a/b'), 'a/b');
  assert.strictEqual(C.parseRoom('a/b'), 'a/b');
  assert.strictEqual(C.parseRoom('#/'), 'lobby');
});
