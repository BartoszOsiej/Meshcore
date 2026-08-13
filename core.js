/* n2-mesh core — pure logic shared by the browser app and the Node test
 * suite. No DOM, no WebSocket, no global state: everything here is a pure
 * function of its inputs, so it can be unit-tested headlessly. */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.NV2MeshCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── bytes ─────────────────────────────────────────────────── */
  function toBytes(str) {
    if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8');
    return new TextEncoder().encode(str);
  }
  function fromBytes(data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return new TextDecoder().decode(bytes);
  }

  /* ── nicks & ids ───────────────────────────────────────────── */
  function nickColor(name) {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    return `hsl(${h % 360} 70% 62%)`;
  }
  function newMid() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  /* Dedup: returns true if the id is new (should be displayed).
   * `seen` is the caller's Map (persisted across calls); expired entries
   * are pruned and the map is capped so memory stays bounded. */
  function isNewMid(seen, mid, ttlMs, max) {
    if (!mid) return true;
    const now = Date.now();
    for (const [k, t] of seen) {
      if (now - t > ttlMs) seen.delete(k);
    }
    if (seen.has(mid)) return false;
    if (seen.size > max) seen.clear();
    seen.set(mid, now);
    return true;
  }

  /* Normalise a location hash into a room name: strip `#/`, lowercase,
   * cap at 48 chars, default to 'lobby'. */
  function parseRoom(hash, fallback) {
    const room = (hash.replace(/^#\/?/, '') || fallback || 'lobby')
      .toLowerCase()
      .slice(0, 48);
    return room || 'lobby';
  }

  /* ── MQTT 3.1.1 packet layer ───────────────────────────────── */
  function mqttEncode(type, body) {
    const b = toBytes(body);
    let len = b.length;
    const rem = [];
    do {
      let d = len % 128;
      len = Math.floor(len / 128);
      if (len > 0) d |= 0x80;
      rem.push(d);
    } while (len > 0);
    return Uint8Array.from([type, ...rem, ...b]);
  }
  function mqttConnectPkt(clientId) {
    const cid = toBytes(clientId);
    /* protocol name "MQTT", level 4, clean session, keepalive 60 */
    const vh = [0x00, 0x04, 0x4d, 0x51, 0x54, 0x54, 0x04, 0x02, 0x00, 0x3c];
    const pl = [0x00, cid.length, ...cid];
    return mqttEncode(0x10, [...vh, ...pl]);
  }
  function mqttSubPkt(topic) {
    const t = toBytes(topic);
    return mqttEncode(0x82, [0x00, 0x01, 0x00, t.length, ...t, 0x00]); // qos 0
  }
  function mqttPubPkt(topic, payload) {
    const t = toBytes(topic);
    return mqttEncode(0x30, [0x00, t.length, ...t, ...payload]);
  }
  function mqttPingPkt() {
    return Uint8Array.from([0xc0, 0x00]);
  }
  function mqttUnsubPkt(topic) {
    const t = toBytes(topic);
    return mqttEncode(0xa2, [0x00, 0x01, 0x00, t.length, ...t]);
  }
  function mqttParsePublish(d) {
    /* skip fixed header (assume 2-byte remaining length or less) */
    let i = 1;
    while (i < d.length && d[i] & 0x80) i++;
    i++;
    const tlen = (d[i] << 8) | d[i + 1];
    i += 2;
    const topic = fromBytes(d.slice(i, i + tlen));
    i += tlen;
    if (d[0] & 0x06) i += 2; // packet id (QoS level > 0)
    return { topic, payload: d.slice(i) };
  }

  return {
    toBytes,
    fromBytes,
    nickColor,
    newMid,
    isNewMid,
    parseRoom,
    mqttEncode,
    mqttConnectPkt,
    mqttSubPkt,
    mqttPubPkt,
    mqttPingPkt,
    mqttUnsubPkt,
    mqttParsePublish,
  };
});
