/* N2 Mesh — serverless P2P chat on the torrent principle.
 *
 * How it works:
 *  1. Every peer in a room seeds the SAME tiny blob. Identical content →
 *     identical infohash → they all join the same WebTorrent swarm.
 *  2. A public WebSocket tracker performs WebRTC signaling between swarm
 *     members (the same way torrents find peers). No chat server anywhere.
 *  3. Once two peers are connected, chat messages ride the established
 *     connection as BitTorrent *extended protocol* messages — i.e. the
 *     messages literally travel on torrent peer connections.
 *
 * Only signaling passes through the tracker; message payloads never do.
 *
 * Why there is also a relay (and why the chat works everywhere):
 *  - Pure browser P2P (WebRTC) cannot connect on mobile carrier networks:
 *    operators use CGNAT and drop peer-to-peer hole-punching, and the free
 *    public TURN relays that used to bridge that are dead or account-gated.
 *  - So every message is ALSO published to a per-room topic on a public
 *    MQTT broker (WSS). Recipients deduplicate by message id, so P2P peers
 *    still get messages directly over the torrent connection while devices
 *    that cannot reach each other directly still exchange messages through
 *    the relay. P2P first, relay as automatic fallback — the same pattern
 *    real messengers use.
 *
 * Fixes that make this actually work:
 *  - The custom "N2" extension MUST be registered on every wire via
 *    wire.use() BEFORE the extended handshake is exchanged. Without that,
 *    wire.extended('N2', ...) throws "Unrecognized extension: N2" and no
 *    message ever leaves the tab.
 *  - Same-browser tabs cannot connect to each other over WebRTC (browsers
 *    block loopback WebRTC), so a BroadcastChannel fallback bridges tabs
 *    of the same browser locally. Different browsers/devices still talk
 *    through the WebTorrent swarm and/or the relay.
 *  - webtorrent.min.js is an ES module (export default), so it is loaded
 *    with a dynamic import() — a plain <script> tag never creates the
 *    window.WebTorrent global.
 */
'use strict';

/* Public WebSocket trackers (verified live; fallbacks in case one is down). */
const TRACKERS = [
  'wss://tracker.webtorrent.dev',
  'wss://tracker.openwebtorrent.com',
  'wss://open.ftorrent.com:443',
];

/* Public MQTT brokers over WSS — the relay fallback for networks where
 * WebRTC cannot connect (mobile CGNAT). Both are free, public, no account.
 * broker.hivemq.com verified working; broker.emqx.io is the backup. */
const RELAY_BROKERS = [
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
];
const RELAY_TOPIC = 'n2mesh/'; // + room name

/* Room content prefix — changing this breaks all existing rooms. */
const ROOM_PREFIX = 'N2MESH-ROOM:v1:';
/* Custom BitTorrent extended-protocol extension name (short, per spec). */
const EXT = 'N2';
/* Retry interval for messages waiting on the extended handshake. */
const RETRY_MS = 600;
/* BroadcastChannel name — local bridge between tabs of the same browser. */
const CHANNEL = 'n2mesh';
/* ICE servers for WebRTC. The browser probes all of them and picks
 * whichever works; on networks where none do, the relay takes over. */
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  { urls: ['stun:global.stun.twilio.com:3478'] },
  {
    urls: [
      'turn:openrelay.metered.ca:80',
      'turn:openrelay.metered.ca:80?transport=tcp',
      'turns:openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayproject',
  },
  {
    urls: [
      'turn:staticauth.openrelay.metered.ca:80',
      'turn:staticauth.openrelay.metered.ca:80?transport=tcp',
      'turns:staticauth.openrelay.metered.ca:443?transport=tcp',
    ],
    username: 'openrelayproject',
    credential: 'openrelayprojectsecret',
  },
];

const $ = (id) => document.getElementById(id);

const state = {
  client: null,
  torrent: null,
  peers: new Set(),
  local: new Set(), // BroadcastChannel peers (same browser)
  channel: null,
  room: (location.hash.replace(/^#\/?/, '') || 'lobby').toLowerCase().slice(0, 48),
  nick: localStorage.getItem('n2mesh:nick') || '',
  /* Increments on every room switch; stale async callbacks bail on mismatch. */
  session: 0,
  /* Relay (MQTT) state. */
  relay: { ws: null, connected: false, brokerIdx: 0, retry: 0, queue: [] },
  /* Message ids already seen — dedup across P2P / relay / BroadcastChannel. */
  seen: new Map(),
};

/* ── Tiny helpers ─────────────────────────────────────────── */
function toBytes(str) {
  if (typeof Buffer !== 'undefined') return Buffer.from(str, 'utf8');
  return new TextEncoder().encode(str);
}
function fromBytes(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return new TextDecoder().decode(bytes);
}
function nickColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 70% 62%)`;
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
function newMid() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}
/* Dedup: returns true if the id is new (should be displayed). */
function isNewMid(mid) {
  if (!mid) return true;
  const now = Date.now();
  for (const [k, t] of state.seen) {
    if (now - t > 30000) state.seen.delete(k);
  }
  if (state.seen.has(mid)) return false;
  if (state.seen.size > 500) state.seen.clear();
  state.seen.set(mid, now);
  return true;
}

/* ── UI ───────────────────────────────────────────────────── */
function setStatus(text, kind) {
  $('statusText').textContent = text;
  $('statusDot').className = 'dot' + (kind ? ' ' + kind : '');
}
function setPeers(n) {
  $('peerCount').textContent = n;
}
function addMessage(nick, text, ts, self) {
  const chat = $('chat');
  const welcome = $('welcome');
  if (welcome) welcome.remove();

  const el = document.createElement('div');
  el.className = 'msg' + (self ? ' self' : '');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const n = document.createElement('span');
  n.className = 'nick';
  n.textContent = self ? 'you' : nick;
  n.style.color = self ? '#7dd3fc' : nickColor(nick);
  const t = document.createElement('span');
  t.className = 'time';
  t.textContent = fmtTime(ts);
  meta.append(n, t);
  const b = document.createElement('div');
  b.className = 'body';
  b.textContent = text;
  el.append(meta, b);
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}
function addSystem(text) {
  const chat = $('chat');
  const el = document.createElement('div');
  el.className = 'msg system';
  el.textContent = text;
  chat.appendChild(el);
  chat.scrollTop = chat.scrollHeight;
}
/* Reflect current connectivity: P2P peers, local tabs, relay. */
function refreshStatus() {
  const p2p = state.peers.size + state.local.size;
  if (p2p > 0 && state.relay.connected) {
    setStatus(`connected · P2P + relay · room #${state.room}`, 'ok');
  } else if (p2p > 0) {
    setStatus(`connected · P2P · room #${state.room}`, 'ok');
  } else if (state.relay.connected) {
    setStatus(`connected · relay mode · room #${state.room}`, 'ok');
  } else {
    setStatus('connecting…', 'busy');
  }
}

/* ── Relay (MQTT 3.1.1 over WSS) ────────────────────────────
 * A tiny self-contained MQTT client (no dependency). Every message is
 * published to RELAY_TOPIC + room; each tab subscribes only to its own
 * room topic (rooms are isolated — no cross-room traffic). Works from
 * any static page on any network. */
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
  const topic = new TextDecoder().decode(d.slice(i, i + tlen));
  i += tlen;
  if (d[0] & 0x08) i += 2; // packet id (QoS > 0)
  return { topic, payload: d.slice(i) };
}

function relaySubscribe() {
  const ws = state.relay.ws;
  if (!ws || ws.readyState !== 1) return;
  try { ws.send(mqttSubPkt(RELAY_TOPIC + state.room)); } catch (_) {}
}
function relayConnect() {
  if (!state.relay || state.relay.connected) return;
  const url = RELAY_BROKERS[state.relay.brokerIdx % RELAY_BROKERS.length];
  let ws;
  try {
    ws = new WebSocket(url);
  } catch (e) {
    relayRetry();
    return;
  }
  state.relay.ws = ws;
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    ws.send(mqttConnectPkt('n2-' + Math.random().toString(36).slice(2, 10)));
  };
  ws.onmessage = (ev) => {
    const d = new Uint8Array(ev.data);
    if (!d.length) return;
    const type = d[0] >> 4;
    if (type === 0x2) { // CONNACK
      if (d.length < 4 || d[3] !== 0) return;
      state.relay.connected = true;
      state.relay.retry = 0;
      state.relay.brokerIdx = 0; // reset — current broker works
      relaySubscribe();
    } else if (type === 0x9) { // SUBACK — subscription live, flush queue now
      /* flush anything queued while offline (each entry remembers its room) */
      const q = state.relay.queue;
      state.relay.queue = [];
      for (const item of q) relayPublish(item.payload, item.room);
      refreshStatus();
      addSystem('Relay connected — chat works on any network.');
    } else if (type === 0x3) { // PUBLISH
      const m = mqttParsePublish(d);
      if (m.topic === RELAY_TOPIC + state.room) {
        handlePayload(m.payload);
      }
    } else if (type === 0xb) { // UNSUBACK — ignore
    } else if (type === 0xd) { // PINGRESP
      /* keepalive confirmed */
    }
  };
  ws.onclose = () => {
    if (state.relay.ws === ws) {
      state.relay.connected = false;
      state.relay.ws = null;
      refreshStatus();
      relayRetry();
    }
  };
  ws.onerror = () => {
    try { ws.close(); } catch (_) {}
  };
  /* keepalive every 30s (broker keepalive is 60s) */
  const ping = setInterval(() => {
    if (ws.readyState === 1) {
      try { ws.send(mqttPingPkt()); } catch (_) {}
    }
  }, 30000);
  ws.addEventListener('close', () => clearInterval(ping));
}
function relayRetry() {
  if (!state.relay) return;
  const delay = Math.min(1000 * Math.pow(2, state.relay.retry++), 15000);
  state.relay.retryTimer = setTimeout(() => {
    if (state.relay.retry >= 3) state.relay.brokerIdx = (state.relay.brokerIdx + 1) % RELAY_BROKERS.length;
    relayConnect();
  }, delay);
}
function relayPublish(payload, room) {
  room = room || state.room;
  if (state.relay.connected && state.relay.ws && state.relay.ws.readyState === 1) {
    try { state.relay.ws.send(mqttPubPkt(RELAY_TOPIC + room, payload)); } catch (_) {}
  } else {
    state.relay.queue.push({ payload, room });
    if (state.relay.queue.length > 100) state.relay.queue.shift();
  }
}

/* ── Networking (WebTorrent swarm) ────────────────────────── */

/* webtorrent.min.js is an ES module (export default), so a plain <script>
 * tag never creates a window.WebTorrent global. Load it with a dynamic
 * import() instead — works from a classic script in every modern browser. */
let WebTorrentCtor = null;
let wtLoading = null;
async function loadWebTorrent() {
  if (WebTorrentCtor) return WebTorrentCtor;
  if (!wtLoading) {
    wtLoading = import('./webtorrent.min.js')
      .then((mod) => {
        WebTorrentCtor = mod.default || mod;
        return WebTorrentCtor;
      })
      .catch((err) => {
        wtLoading = null;
        throw err;
      });
  }
  return wtLoading;
}

/**
 * The custom extended-protocol extension. Must be registered via
 * wire.use() on every wire so it is advertised in the extended handshake
 * (the handshake's `m` map is built from registered extensions). Without
 * registration, wire.extended('N2', ...) throws and messages never send.
 */
function N2MeshExtension(wire) {
  this._wire = wire;
}
N2MeshExtension.prototype.name = EXT;
N2MeshExtension.prototype.onExtendedHandshake = function () {};
N2MeshExtension.prototype.onMessage = function () {};

/** Try to send a payload on one wire; false if the extended handshake is
 *  not ready yet (bittorrent-protocol has no ID mapping for our extension). */
function trySend(wire, payload) {
  try {
    wire.extended(EXT, payload);
    return true;
  } catch (_) {
    return false;
  }
}

/** Queue a payload per wire until its extended handshake is negotiated. */
function queueSend(wire, payload) {
  wire.__n2pending = wire.__n2pending || [];
  wire.__n2pending.push(payload);
}
function flushQueue(wire) {
  const q = wire.__n2pending || [];
  wire.__n2pending = [];
  for (const p of q) {
    if (!trySend(wire, p)) queueSend(wire, p); // still not ready — requeue
  }
}

/** Handle an incoming chat payload (from any transport). */
function handlePayload(data) {
  let parsed;
  try {
    parsed = JSON.parse(typeof data === 'string' ? data : fromBytes(data));
  } catch (_) {
    return;
  }
  if (parsed && typeof parsed.t === 'string') {
    if (!isNewMid(parsed.mid)) return; // already seen via another path
    addMessage(String(parsed.u || '?'), parsed.t, parsed.ts || Date.now(), false);
  }
}

/* BroadcastChannel bridge — tabs of the SAME browser can't do WebRTC
 * loopback, so they relay through a same-origin channel. This makes the
 * chat work out of the box when testing in two tabs. */
function initChannel() {
  try {
    state.channel = new BroadcastChannel(CHANNEL);
  } catch (_) {
    return; // not supported — WebTorrent swarm only
  }
  state.channel.onmessage = (ev) => {
    if (!ev.data || ev.data.room !== state.room) return;
    if (ev.data.type === 'hello') {
      // A new same-browser peer appeared — greet it back.
      const uid = ev.data.uid;
      if (uid !== state.localUid) {
        state.local.add(uid);
        updatePeers();
        state.channel.postMessage({
          type: 'hello', room: state.room, uid: state.localUid,
        });
        addSystem('Same-browser peer connected (local bridge).');
      }
      return;
    }
    if (ev.data.type === 'msg') handlePayload(ev.data.payload);
  };
  state.localUid = Math.random().toString(36).slice(2, 10);
  state.channel.postMessage({ type: 'hello', room: state.room, uid: state.localUid });
}

function updatePeers() {
  setPeers(state.peers.size + state.local.size);
  refreshStatus();
}

async function initClient() {
  const WebTorrent = await loadWebTorrent().catch(() => null);
  if (!WebTorrent) {
    /* Even without WebTorrent the relay still works — chat is usable. */
    addSystem('P2P library unavailable — running in relay-only mode.');
    refreshStatus();
    return;
  }

  const session = ++state.session;
  setStatus('joining swarm…', 'busy');
  state.client = new WebTorrent({ tracker: { announce: TRACKERS }, rtcConfig: { iceServers: ICE_SERVERS } });
  state.client.on('error', (err) => {
    console.error('[n2mesh] client error', err);
  });
  state.client.on('warning', (err) => {
    console.warn('[n2mesh] warning', err);
  });

  const content = new Blob([ROOM_PREFIX + state.room]);
  state.client.seed(content, { name: `n2mesh-${state.room}.txt`, announce: TRACKERS }, (torrent) => {
    if (session !== state.session) return; // stale — user switched rooms
    state.torrent = torrent;
    addSystem(`Joined room “${state.room}”. Waiting for P2P peers — sharing the link works even over relay.`);

    torrent.on('wire', (wire) => {
      if (session !== state.session) return;
      /* CRITICAL: register our extension BEFORE the extended handshake is
       * exchanged so it lands in the handshake's `m` map. Without this,
       * wire.extended('N2', ...) throws "Unrecognized extension: N2". */
      wire.use(N2MeshExtension);

      /* Extended-protocol chat channel: receiving also proves the handshake
       * completed, so flush anything queued for this wire. */
      wire.on('extended', (ext, data) => {
        if (ext === EXT) {
          handlePayload(data);
        }
        flushQueue(wire);
      });
      state.peers.add(wire);
      updatePeers();
      wire.on('close', () => {
        state.peers.delete(wire);
        updatePeers();
      });
      addSystem('A peer connected — you are now talking P2P.');
    });

    torrent.on('noPeers', () => {
      if (session === state.session) refreshStatus();
    });
  });
}

/** Periodic retry for messages still waiting on the extended handshake. */
setInterval(() => {
  for (const wire of state.peers) {
    if (wire.__n2pending && wire.__n2pending.length) flushQueue(wire);
  }
}, RETRY_MS);

function currentNick() {
  const v = $('nickInput').value.trim().slice(0, 24);
  return v || state.nick;
}

function sendMessage(text) {
  const msg = text.trim();
  if (!msg) return;
  const nick = currentNick();
  const payload = JSON.stringify({ u: nick, t: msg, ts: Date.now(), mid: newMid() });

  /* P2P — messages travel on torrent peer connections when possible. */
  if (state.peers.size > 0) {
    const bytes = toBytes(payload);
    for (const wire of state.peers) {
      if (!trySend(wire, bytes)) queueSend(wire, bytes);
    }
  }
  /* Local tabs (same browser). */
  if (state.local.size > 0 && state.channel) {
    state.channel.postMessage({ type: 'msg', room: state.room, payload });
  }
  /* Relay — guaranteed delivery on any network (mobile CGNAT included). */
  relayPublish(payload);

  if (state.peers.size === 0 && state.local.size === 0 && !state.relay.connected) {
    addSystem('Not connected yet — message queued for the relay.');
  }
  addMessage(nick, msg, Date.now(), true);
}

/* ── Room switching ───────────────────────────────────────── */
function joinRoom(room) {
  room = (room || 'lobby').toLowerCase().slice(0, 48);
  if (room === state.room && state.torrent) return;
  const oldRoom = state.room;
  state.room = room;
  location.hash = '/' + room;
  addSystem(`Switching to room “${room}” — reloading swarm…`);
  /* Invalidate everything async from the old room. */
  state.session++;
  state.peers.clear();
  state.local.clear();
  setPeers(0);
  state.torrent = null;
  if (state.client) state.client.destroy(() => {});
  state.client = null;
  /* Move the relay subscription: drop the old room, pick up the new one. */
  if (state.relay.ws && state.relay.ws.readyState === 1) {
    try { state.relay.ws.send(mqttUnsubPkt(RELAY_TOPIC + oldRoom)); } catch (_) {}
  }
  relaySubscribe();
  setTimeout(initClient, 250);
}

/* ── Boot ─────────────────────────────────────────────────── */
function boot() {
  if (!state.nick) {
    state.nick = 'guest-' + Math.random().toString(36).slice(2, 7);
  }
  $('nickInput').value = state.nick;
  $('roomInput').value = state.room;

  initChannel();
  relayConnect(); // relay is independent of WebTorrent — always on

  $('sendBtn').addEventListener('click', () => {
    sendMessage($('msgInput').value);
    $('msgInput').value = '';
  });
  $('msgInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      sendMessage($('msgInput').value);
      $('msgInput').value = '';
    }
  });
  $('nickInput').addEventListener('change', (e) => {
    state.nick = e.target.value.trim().slice(0, 24) || state.nick;
    localStorage.setItem('n2mesh:nick', state.nick);
  });
  $('joinBtn').addEventListener('click', () => joinRoom($('roomInput').value));
  $('roomInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinRoom($('roomInput').value);
  });
  $('copyBtn').addEventListener('click', () => {
    const link = location.origin + location.pathname + '#/' + state.room;
    navigator.clipboard
      .writeText(link)
      .then(() => { addSystem('Room link copied to clipboard.'); })
      .catch(() => { addSystem('Could not copy — link: ' + link); });
  });

  window.addEventListener('hashchange', () => {
    const room = (location.hash.replace(/^#\/?/, '') || 'lobby').toLowerCase().slice(0, 48);
    if (room !== state.room) joinRoom(room);
  });

  initClient();
}

boot();
