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
 */
'use strict';

/* Public WebSocket trackers (verified live; fallbacks in case one is down). */
const TRACKERS = [
  'wss://tracker.openwebtorrent.com',
  'wss://tracker.webtorrent.dev',
];

/* Room content prefix — changing this breaks all existing rooms. */
const ROOM_PREFIX = 'N2MESH-ROOM:v1:';
/* Custom BitTorrent extended-protocol extension name (short, per spec). */
const EXT = 'N2';
/* Retry interval for messages waiting on the extended handshake. */
const RETRY_MS = 600;

const $ = (id) => document.getElementById(id);

const state = {
  client: null,
  torrent: null,
  peers: new Set(),
  room: (location.hash.replace(/^#\/?/, '') || 'lobby').toLowerCase().slice(0, 48),
  nick: localStorage.getItem('n2mesh:nick') || '',
  /* Increments on every room switch; stale async callbacks bail on mismatch. */
  session: 0,
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

/* ── Networking ───────────────────────────────────────────── */
function updatePeers() {
  setPeers(state.peers.size);
  if (state.peers.size > 0) {
    setStatus(`connected · room #${state.room}`, 'ok');
  }
}

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

function initClient() {
  if (typeof WebTorrent === 'undefined') {
    setStatus('WebTorrent failed to load (offline?)', 'error');
    addSystem('Could not load the WebTorrent library. Check your connection and reload.');
    return;
  }

  const session = ++state.session;
  setStatus('joining swarm…', 'busy');
  state.client = new WebTorrent({ tracker: { announce: TRACKERS } });
  state.client.on('error', (err) => {
    console.error('[n2mesh] client error', err);
    setStatus('client error — see console', 'error');
  });
  state.client.on('warning', (err) => {
    console.warn('[n2mesh] warning', err);
  });

  const content = new Blob([ROOM_PREFIX + state.room]);
  state.client.seed(content, { name: `n2mesh-${state.room}.txt`, announce: TRACKERS }, (torrent) => {
    if (session !== state.session) return; // stale — user switched rooms
    state.torrent = torrent;
    setStatus(`in swarm · room #${state.room}`, 'busy');
    addSystem(`Joined room “${state.room}”. Waiting for peers — share the link above.`);

    torrent.on('wire', (wire) => {
      if (session !== state.session) return;
      /* Extended-protocol chat channel: receiving also proves the handshake
       * completed, so flush anything queued for this wire. */
      wire.on('extended', (ext, data) => {
        if (ext === EXT) {
          let parsed;
          try {
            parsed = JSON.parse(fromBytes(data));
          } catch (_) {
            return;
          }
          if (parsed && typeof parsed.t === 'string') {
            addMessage(String(parsed.u || '?'), parsed.t, parsed.ts || Date.now(), false);
          }
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
      if (session === state.session) setStatus(`in swarm · waiting for peers`, 'busy');
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
  if (state.peers.size === 0) {
    addSystem('No peers connected yet — messages are P2P, so they cannot be delivered. Share the room link.');
  }
  const payload = toBytes(JSON.stringify({ u: nick, t: msg, ts: Date.now() }));
  for (const wire of state.peers) {
    if (!trySend(wire, payload)) queueSend(wire, payload);
  }
  addMessage(nick, msg, Date.now(), true);
}

/* ── Room switching ───────────────────────────────────────── */
function joinRoom(room) {
  room = (room || 'lobby').toLowerCase().slice(0, 48);
  if (room === state.room && state.torrent) return;
  state.room = room;
  location.hash = '/' + room;
  addSystem(`Switching to room “${room}” — reloading swarm…`);
  /* Invalidate everything async from the old room. */
  state.session++;
  state.peers.clear();
  setPeers(0);
  state.torrent = null;
  if (state.client) state.client.destroy(() => {});
  state.client = null;
  setTimeout(initClient, 250);
}

/* ── Boot ─────────────────────────────────────────────────── */
function boot() {
  if (!state.nick) {
    state.nick = 'guest-' + Math.random().toString(36).slice(2, 7);
  }
  $('nickInput').value = state.nick;
  $('roomInput').value = state.room;

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
