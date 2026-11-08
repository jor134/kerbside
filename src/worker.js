// Kerbside relay: holds one connection to F1 live timing and fans it out to viewers.
// Also keeps a shared store of circuit outlines, so every device can draw the track during a live session.
import { DurableObject } from 'cloudflare:workers';
import { weatherRequest, weatherRun } from './forecast-worker.js';
import { PokerTable, SideBets, START, BLINDS } from './poker.js';

const RS = '\x1e';
const F1_BASE = 'https://livetiming.formula1.com/signalrcore';
const TOPICS = [
  'Heartbeat', 'Position.z', 'TimingData', 'TimingAppData', 'DriverList',
  'SessionInfo', 'SessionStatus', 'TrackStatus', 'LapCount',
  'RaceControlMessages', 'ExtrapolatedClock', 'WeatherData'
];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, PUT, POST, OPTIONS' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const keys = String(env.RELAY_KEY || '').split(',').map(k => k.trim()).filter(Boolean);
    // Circuit outlines aren't secret: anyone using the app can read them, so Replay works without a key.
    const open = request.method === 'GET' && ['/track', '/tracks', '/weather', '/push/key'].includes(url.pathname);
    if (!open && keys.length && !keys.includes(url.searchParams.get('key'))) {
      return new Response('Wrong or missing relay key', { status: 401, headers: CORS });
    }
    if (url.pathname === '/hang') { // watch-together rooms with voice, one per 4-letter code
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return new Response('Room codes are 4 letters', { status: 400, headers: CORS });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426, headers: CORS });
      return env.HANG.get(env.HANG.idFromName('hang:' + code)).fetch(request);
    }
    if (url.pathname === '/ice') {
      return new Response(JSON.stringify(await iceServers(env)), { headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/room') { // online drive races, one room per 4-letter code
      const code = String(url.searchParams.get('code') || '').toUpperCase();
      if (!/^[A-Z]{4}$/.test(code)) return new Response('Room codes are 4 letters', { status: 400, headers: CORS });
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket upgrade', { status: 426, headers: CORS });
      return env.ROOMS.get(env.ROOMS.idFromName('room:' + code)).fetch(request);
    }
    const stub = env.RELAY.get(env.RELAY.idFromName('live'));
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426, headers: CORS });
      }
      return stub.fetch(request);
    }
    if (url.pathname === '/weather' || url.pathname.startsWith('/push/') || url.pathname === '/weather/run') {
      const r = await stub.fetch(new Request(url.origin + (url.pathname === '/weather/run' ? '/wx/run' : url.pathname), {
        method: request.method, body: request.method === 'POST' ? await request.text() : undefined, headers: { 'content-type': 'application/json' }
      }));
      return new Response(r.body, { status: r.status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/tracks' || url.pathname === '/tracks/fill') {
      const r = await stub.fetch(new Request(url.origin + (url.pathname === '/tracks' ? '/tracks' : '/fill')));
      return new Response(r.body, { status: r.status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    if (url.pathname === '/status' || url.pathname === '/track') {
      const r = await stub.fetch(new Request(url.origin + url.pathname + url.search, {
        method: request.method, body: request.method === 'PUT' ? await request.text() : undefined
      }));
      return new Response(r.body, { status: r.status, headers: { ...CORS, 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    return new Response('Kerbside relay is running.', { headers: CORS });
  },
  // Every 15 minutes (see [triggers] in wrangler.toml): check the circuit weather and send alerts;
  // once an hour, also save any circuit outlines still missing.
  async scheduled(event, env, ctx) {
    const stub = env.RELAY.get(env.RELAY.idFromName('live'));
    ctx.waitUntil(stub.fetch('https://relay/wx/run').then(r => r.text()).catch(() => {}));
    if (new Date(event.scheduledTime || Date.now()).getUTCMinutes() < 15) ctx.waitUntil(stub.fetch('https://relay/fill').then(r => r.text()).catch(() => {}));
  }
};

/* ---------- Circuit outlines from OpenF1, saved ahead of time ---------- */
const OPENF1 = 'https://api.openf1.org/v1';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const isoMs = s => { if (!s) return NaN; s = String(s).replace(/(\.\d{3})\d+/, '$1'); if (!/(Z|[+-]\d\d:?\d\d)$/i.test(s)) s += 'Z'; return Date.parse(s); };
async function of1(path) {
  const r = await fetch(OPENF1 + path, { headers: { 'User-Agent': 'kerbside-relay' } });
  if (r.status === 404) return [];
  if (!r.ok) throw new Error('OpenF1 HTTP ' + r.status + ' for ' + path.split('?')[0]);
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}
// One lap of car positions turned into an outline: points at least 2 m apart, the loop closed, sane size.
function lapToOutline(loc) {
  const pts = [];
  for (const p of loc) {
    if (!p.x && !p.y) continue;
    const x = p.x / 10, y = p.y / 10, z = (p.z || 0) / 10, l = pts[pts.length - 1];
    if (!l || Math.hypot(x - l[0], y - l[1]) > 2) pts.push([Math.round(x * 10) / 10, Math.round(y * 10) / 10, Math.round(z * 10) / 10]);
  }
  while (pts.length > 60 && Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]) < 10) pts.pop();
  if (pts.length < 60 || pts.length > 8000) return null;
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const gap = Math.hypot(pts[pts.length - 1][0] - pts[0][0], pts[pts.length - 1][1] - pts[0][1]);
  if (len < 2500 || len > 8500 || gap > 250) return null; // not a whole lap of a real circuit
  return pts;
}

// Voice connection servers. With a Cloudflare TURN key set (TURN_KEY_ID and TURN_KEY_API_TOKEN secrets),
// voice also works on networks that block direct connections. Credentials are short-lived and cached.
let iceCache = null;
async function iceServers(env) {
  const stun = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) return { iceServers: stun, turn: false };
  if (iceCache && iceCache.until > Date.now()) return iceCache.value;
  try {
    const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + env.TURN_KEY_API_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: 86400 })
    });
    if (!r.ok) throw new Error('TURN ' + r.status);
    const j = await r.json();
    const list = (Array.isArray(j.iceServers) ? j.iceServers : [j.iceServers]).map(s => ({
      ...s, urls: (Array.isArray(s.urls) ? s.urls : [s.urls]).filter(u => !/:53(\?|$)/.test(u)) // port 53 is blocked by browsers
    })).filter(s => s.urls.length);
    const value = { iceServers: list, turn: true };
    iceCache = { value, until: Date.now() + 12 * 3600e3 };
    return value;
  } catch (e) {
    return { iceServers: stun, turn: false, error: String(e.message || e) };
  }
}

function merge(t, p) {
  if (p === null || typeof p !== 'object') return p;
  if (t === null || typeof t !== 'object') t = Array.isArray(p) ? [] : {};
  for (const k of Object.keys(p)) {
    const v = p[k];
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) t[k] = merge(t[k], v);
    else t[k] = v;
  }
  return t;
}

function tokenFrom(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  try {
    if (s.startsWith('%7B') || s.startsWith('%7b')) s = decodeURIComponent(s);
    if (s.startsWith('{')) {
      const j = JSON.parse(s);
      return (j && j.data && j.data.subscriptionToken) || j.subscriptionToken || null;
    }
  } catch (e) { /* fall through */ }
  return s;
}

function tokenExpiry(tok) {
  try {
    let b = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b.length % 4) b += '=';
    const p = JSON.parse(atob(b));
    return p.exp ? new Date(p.exp * 1000).toISOString() : null;
  } catch (e) { return null; }
}

function cookiesFrom(resp) {
  let list = [];
  if (typeof resp.headers.getSetCookie === 'function') list = resp.headers.getSetCookie();
  else { const one = resp.headers.get('set-cookie'); if (one) list = [one]; }
  return list.map(c => c.split(';')[0]).filter(Boolean).join('; ');
}

function validOutline(a) {
  return Array.isArray(a) && a.length >= 60 && a.length <= 8000 &&
    a.every(p => Array.isArray(p) && p.length === 3 && p.every(n => typeof n === 'number' && isFinite(n) && Math.abs(n) < 1e6));
}

export class F1Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.clients = new Set();
    this.upstream = null;
    this.state = {};
    this.status = 'idle';
    this.detail = 'No viewers connected';
    this.lastMsgAt = 0;
    this.lastPosAt = 0;
    this.retry = 0;
    this.inv = 0;
    this.buf = '';
    this.handshaken = false;
    this.pingTimer = null;
    this.idleTimer = null;
    this.retryTimer = null;
  }

  statusObj() {
    const tok = tokenFrom(this.env.F1TV_TOKEN);
    const si = this.state.SessionInfo;
    return {
      status: this.status,
      detail: this.detail,
      viewers: this.clients.size,
      secondsSinceF1Message: this.lastMsgAt ? Math.round((Date.now() - this.lastMsgAt) / 1000) : null,
      secondsSincePositions: this.lastPosAt ? Math.round((Date.now() - this.lastPosAt) / 1000) : null,
      tokenSet: !!tok,
      tokenExpires: tok ? tokenExpiry(tok) : null,
      session: si ? [si.Meeting && si.Meeting.Name, si.Name].filter(Boolean).join(', ') : null
    };
  }

  setStatus(status, detail) {
    this.status = status;
    this.detail = detail;
    this.broadcast({ type: 'status', ...this.statusObj() });
  }

  broadcast(obj) {
    const msg = JSON.stringify(obj);
    for (const ws of this.clients) {
      try { ws.send(msg); } catch (e) { this.clients.delete(ws); }
    }
  }

  async outlineFromRace(sk, get) {
    // A handful of laps by lap number keeps each download small (one row per driver).
    for (const lapNo of [12, 20, 6, 30]) {
      const laps = (await get(`/laps?session_key=${sk}&lap_number=${lapNo}`)).filter(l => l.lap_duration > 30 && !l.is_pit_out_lap && l.date_start);
      if (laps.length < 3) continue;
      const durs = laps.map(l => l.lap_duration).sort((a, b) => a - b), med = durs[durs.length >> 1];
      const cands = laps.filter(l => l.lap_duration > med * 0.9 && l.lap_duration < med * 1.04).sort((a, b) => a.lap_duration - b.lap_duration);
      for (const lap of cands.slice(0, 2)) {
        const s0 = isoMs(lap.date_start), e0 = s0 + lap.lap_duration * 1000 + 300;
        const loc = await get(`/location?session_key=${sk}&driver_number=${lap.driver_number}&date>=${encodeURIComponent(new Date(s0).toISOString())}&date<=${encodeURIComponent(new Date(e0).toISOString())}`);
        const pts = lapToOutline(loc);
        if (pts) return pts;
      }
    }
    return null;
  }

  // Finds the most recent race at every circuit from the last three seasons and saves its outline,
  // unless one is already saved from that race or newer. Limited per run to stay inside Cloudflare's
  // per-request limits; the hourly schedule finishes the rest.
  async fillTracks() {
    const st = this.ctx.storage, now = Date.now(), year = new Date().getUTCFullYear(), BUDGET = 20; // OpenF1's free tier allows 30 requests a minute
    let calls = 0;
    const get = async p => { if (calls >= BUDGET) throw new Error('budget'); calls++; await sleep(2500); return of1(p); }; // ~24 a minute, leaving room for everything else
    let races = await st.get('races');
    try {
      if (!races || now - races.at > 12 * 3600e3) {
        const list = [];
        for (const y of [year, year - 1, year - 2]) list.push(...await get(`/sessions?year=${y}&session_name=Race`));
        races = { at: now, list: list.filter(s => s.circuit_key != null && isoMs(s.date_end) < now - 3 * 3600e3)
          .map(s => ({ sk: s.session_key, ck: s.circuit_key, name: s.circuit_short_name || s.location || String(s.circuit_key), end: isoMs(s.date_end) })) };
        if (races.list.length) await st.put('races', races);
      }
    } catch (e) {
      if (!races) return { error: 'Could not reach OpenF1: ' + e.message + '. It locks free data during live sessions; the next hourly run will retry.' };
    }
    const latest = new Map();
    for (const r of races.list) { const p = latest.get(r.ck); if (!p || r.end > p.end) latest.set(r.ck, r); }
    const done = [], failed = [];
    for (const [ck, race] of latest) {
      const meta = await st.get('trackmeta:' + ck), have = await st.get('track:' + ck);
      if (have && (!meta || meta.from === 'device' || meta.from >= race.sk)) continue; // up to date
      const fail = await st.get('trackfail:' + ck);
      if (fail && fail.sk === race.sk && now - fail.at < 24 * 3600e3) continue; // tried today
      if (calls > BUDGET - 4) break;
      try {
        const pts = await this.outlineFromRace(race.sk, get);
        if (pts) {
          await st.put('track:' + ck, pts);
          await st.put('trackmeta:' + ck, { from: race.sk, name: race.name, at: now, points: pts.length });
          done.push(race.name);
        } else { await st.put('trackfail:' + ck, { sk: race.sk, at: now }); failed.push(race.name); }
      } catch (e) {
        if (e.message === 'budget' || /HTTP 429/.test(e.message)) break; // rate limited: stop and let the next hourly run carry on
        await st.put('trackfail:' + ck, { sk: race.sk, at: now }); failed.push(race.name + ' (' + e.message + ')');
      }
    }
    const saved = await st.list({ prefix: 'track:' });
    const remaining = Math.max(0, latest.size - saved.size);
    return { savedNow: done, failed, saved: saved.size, circuits: latest.size, openf1Calls: calls, remaining,
      next: !remaining ? 'Every circuit is saved.' : remaining <= failed.length ? remaining + ' circuit(s) have no usable lap data on OpenF1 yet; they are retried daily.' : 'The hourly run saves more; or open this page again.' };
  }

  async listTracks() {
    const st = this.ctx.storage, metas = await st.list({ prefix: 'trackmeta:' }), tracks = await st.list({ prefix: 'track:' });
    const out = [];
    for (const [k] of tracks) {
      const ck = k.slice(6), m = metas.get('trackmeta:' + ck) || {};
      out.push({ circuit: ck, name: m.name || null, source: m.from === 'device' || !m.from ? 'a device' : 'race ' + m.from, saved: m.at ? new Date(m.at).toISOString().slice(0, 10) : null });
    }
    out.sort((a, b) => String(a.name || a.circuit).localeCompare(String(b.name || b.circuit)));
    return { count: out.length, circuits: out };
  }

  async trackRequest(request, url) {
    const circuit = String(url.searchParams.get('circuit') || '').replace(/[^\w-]/g, '').slice(0, 40);
    if (!circuit) return new Response('{"error":"missing circuit"}', { status: 400 });
    const k = 'track:' + circuit;
    if (request.method === 'PUT') {
      let pts;
      try { pts = JSON.parse(await request.text()); } catch (e) { return new Response('{"error":"bad json"}', { status: 400 }); }
      if (!validOutline(pts)) return new Response('{"error":"bad outline"}', { status: 400 });
      // A device only fills a gap, or replaces an outline it found doesn't match the live cars.
      if (url.searchParams.get('replace') !== '1' && await this.ctx.storage.get(k)) return new Response('{"ok":true,"kept":"existing"}');
      await this.ctx.storage.put(k, pts);
      const old = await this.ctx.storage.get('trackmeta:' + circuit);
      await this.ctx.storage.put('trackmeta:' + circuit, { from: 'device', name: old && old.name, at: Date.now(), points: pts.length });
      return new Response('{"ok":true}');
    }
    const pts = await this.ctx.storage.get(k);
    return pts ? new Response(JSON.stringify(pts)) : new Response('{"error":"not found"}', { status: 404 });
  }

  // Poker chip balances, one record per player id, shared by every hangout room on this relay.
  // { get: [pid], set: { pid: { bal, name, rebuys } }, top: n } -> { get: { pid: rec }, top: [rec] }
  async chipsRequest(request) {
    let q; try { q = await request.json(); } catch (e) { return Response.json({ error: 'bad json' }, { status: 400 }); }
    const out = {}, st = this.ctx.storage;
    if (q.set && typeof q.set === 'object') {
      for (const [pid, r] of Object.entries(q.set).slice(0, 50)) {
        if (!/^[\w-]{8,40}$/.test(pid) || !r) continue;
        const old = (await st.get('chip:' + pid)) || { bal: START, rebuys: 0, best: START };
        const bal = Math.max(0, Math.floor(+r.bal || 0));
        await st.put('chip:' + pid, { pid, bal, name: String(r.name || old.name || 'Friend').slice(0, 16), rebuys: Math.max(0, Math.floor(r.rebuys != null ? +r.rebuys : old.rebuys || 0)), best: Math.max(old.best || 0, bal), at: Date.now() });
      }
    }
    if (Array.isArray(q.get)) {
      out.get = {};
      for (const pid of q.get.slice(0, 20)) if (/^[\w-]{8,40}$/.test(pid)) out.get[pid] = (await st.get('chip:' + pid)) || null;
    }
    if (q.top) {
      const all = [...(await st.list({ prefix: 'chip:' })).values()];
      out.top = all.sort((a, b) => b.bal - a.bal).slice(0, Math.min(20, +q.top || 10)).map(r => ({ name: r.name, bal: r.bal, best: r.best, rebuys: r.rebuys }));
    }
    return Response.json(out);
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status') return Response.json(this.statusObj());
    if (url.pathname === '/track') return this.trackRequest(request, url);
    if (url.pathname === '/tracks') return Response.json(await this.listTracks());
    if (url.pathname === '/wx/run') {
      try { return Response.json(await weatherRun(this.ctx.storage)); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    if (url.pathname === '/weather' || url.pathname.startsWith('/push/')) {
      const r = await weatherRequest(this.ctx.storage, request, url); if (r) return r;
    }
    if (url.pathname === '/fill') {
      try { return Response.json(await this.fillTracks()); } catch (e) { return Response.json({ error: String(e.message || e) }, { status: 500 }); }
    }
    if (url.pathname === '/chips' && request.method === 'POST') return this.chipsRequest(request); // poker chips, called by hangout rooms only

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.clients.add(server);
    const drop = () => this.dropClient(server);
    server.addEventListener('close', drop);
    server.addEventListener('error', drop);
    server.addEventListener('message', e => { if (e.data === 'ping') { try { server.send('pong'); } catch (err) {} } });

    server.send(JSON.stringify({ type: 'status', ...this.statusObj() }));
    if (Object.keys(this.state).length) server.send(JSON.stringify({ type: 'init', state: this.state }));

    clearTimeout(this.idleTimer);
    if (!this.upstream && this.status !== 'connecting' && !this.retryTimer) this.connect();
    return new Response(null, { status: 101, webSocket: client });
  }

  dropClient(ws) {
    this.clients.delete(ws);
    if (this.clients.size === 0) {
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (this.clients.size === 0) this.closeUpstream('No viewers connected');
      }, 60000);
    }
  }

  closeUpstream(reason) {
    clearInterval(this.pingTimer);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.upstream;
    this.upstream = null;
    if (ws) { try { ws.close(1000, 'idle'); } catch (e) {} }
    this.status = 'idle';
    this.detail = reason;
  }

  async connect() {
    this.setStatus('connecting', 'Connecting to F1 live timing');
    const tok = tokenFrom(this.env.F1TV_TOKEN);
    const headers = { 'User-Agent': 'BestHTTP', 'Accept-Encoding': 'gzip,identity' };
    if (tok) headers.Authorization = 'Bearer ' + tok;
    try {
      let cookie = '';
      try {
        const o = await fetch(F1_BASE + '/negotiate?negotiateVersion=1', { method: 'OPTIONS', headers });
        cookie = cookiesFrom(o);
      } catch (e) { /* optional step */ }

      const nh = { ...headers };
      if (cookie) nh.Cookie = cookie;
      const n = await fetch(F1_BASE + '/negotiate?negotiateVersion=1', { method: 'POST', headers: nh });
      if (n.status === 401 || n.status === 403) {
        throw new Error('F1 refused the token (HTTP ' + n.status + '). Paste a fresh F1 TV token into the F1TV_TOKEN secret.');
      }
      if (!n.ok) throw new Error('F1 negotiate failed (HTTP ' + n.status + ')');
      const c2 = cookiesFrom(n);
      if (c2) cookie = cookie ? cookie + '; ' + c2 : c2;
      const nj = await n.json();
      const id = nj.connectionToken || nj.connectionId;
      if (!id) throw new Error('F1 negotiate returned no connection id');

      const wh = { ...headers, Upgrade: 'websocket' };
      if (cookie) wh.Cookie = cookie;
      const r = await fetch(F1_BASE + '?id=' + encodeURIComponent(id), { headers: wh });
      const ws = r.webSocket;
      if (!ws) throw new Error('F1 refused the WebSocket (HTTP ' + r.status + ')');
      ws.accept();
      this.upstream = ws;
      this.buf = '';
      this.handshaken = false;
      ws.addEventListener('message', e => this.onUpstream(e.data));
      ws.addEventListener('close', e => { if (this.upstream === ws) this.upstreamLost('F1 closed the connection (' + e.code + ')'); });
      ws.addEventListener('error', () => { if (this.upstream === ws) this.upstreamLost('F1 connection error'); });
      ws.send(JSON.stringify({ protocol: 'json', version: 1 }) + RS);
      this.setStatus('connecting', 'Handshake sent');
    } catch (err) {
      this.upstreamLost(err.message || String(err));
    }
  }

  upstreamLost(reason) {
    clearInterval(this.pingTimer);
    const ws = this.upstream;
    this.upstream = null;
    if (ws) { try { ws.close(); } catch (e) {} }
    if (this.clients.size === 0) { this.status = 'idle'; this.detail = reason; return; }
    const wait = Math.min(60000, 2000 * Math.pow(2, this.retry++));
    this.setStatus('reconnecting', reason + '. Retrying in ' + Math.round(wait / 1000) + ' s');
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, wait);
  }

  subscribe() {
    this.upstream.send(JSON.stringify({
      type: 1, invocationId: String(++this.inv), target: 'Subscribe', arguments: [TOPICS]
    }) + RS);
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (!this.upstream) return;
      try { this.upstream.send(JSON.stringify({ type: 6 }) + RS); } catch (e) {}
      if (this.lastMsgAt && Date.now() - this.lastMsgAt > 90000) this.upstreamLost('No data from F1 for 90 s');
    }, 15000);
  }

  onUpstream(data) {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.lastMsgAt = Date.now();
    const parts = (this.buf + text).split(RS);
    this.buf = parts.pop();
    for (const part of parts) {
      if (!part) continue;
      let m;
      try { m = JSON.parse(part); } catch (e) { continue; }
      if (!this.handshaken) {
        this.handshaken = true;
        if (m.error) { this.upstreamLost('Handshake refused: ' + m.error); return; }
        this.subscribe();
        continue;
      }
      if (m.type === 1 && String(m.target).toLowerCase() === 'feed' && Array.isArray(m.arguments)) {
        const [topic, payload, ts] = m.arguments;
        this.apply(topic, payload);
        this.broadcast({ type: 'feed', topic, data: payload, ts });
      } else if (m.type === 3) {
        if (m.error) { this.setStatus('error', 'Subscribe refused: ' + m.error); continue; }
        if (m.result && typeof m.result === 'object') {
          this.state = {};
          for (const [k, v] of Object.entries(m.result)) this.apply(k, v);
          this.broadcast({ type: 'init', state: this.state });
        }
        this.retry = 0;
        const posNote = this.state['Position.z'] ? 'positions flowing' : 'waiting for positions';
        this.setStatus('live', 'Subscribed to F1 live timing, ' + posNote);
      } else if (m.type === 7) {
        this.upstreamLost('F1 closed the session: ' + (m.error || 'no reason given'));
        return;
      }
    }
  }

  apply(topic, payload) {
    if (topic.endsWith('.z')) {
      this.state[topic] = payload;
      if (topic === 'Position.z') this.lastPosAt = Date.now();
    } else {
      this.state[topic] = merge(this.state[topic], payload);
    }
  }
}

// Online drive races. Relays each player's car to everyone else in the room,
// keeps the host's circuit and settings, and stamps the start time from one clock.
const MAX_PLAYERS = 12;
export class RaceRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.peers = new Map();
    this.nextId = 1;
    this.host = null;
    this.setup = null;
  }
  roster() {
    return { t: 'roster', host: this.host, peers: [...this.peers.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color })) };
  }
  send(ws, m) { try { ws.send(typeof m === 'string' ? m : JSON.stringify(m)); } catch (e) {} }
  broadcast(m, except) {
    const msg = JSON.stringify(m);
    for (const [id, p] of this.peers) if (id !== except) this.send(p.ws, msg);
  }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (this.peers.size >= MAX_PLAYERS) {
      this.send(server, { t: 'full' }); server.close(1008, 'Room is full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const id = this.nextId++;
    this.peers.set(id, { ws: server, name: 'Player ' + id, color: '#9aa5ab' });
    if (this.host == null || !this.peers.has(this.host)) this.host = id;
    this.send(server, { t: 'welcome', you: id, host: this.host, peers: this.roster().peers, setup: this.setup });
    this.broadcast(this.roster(), id);
    server.addEventListener('message', e => this.onMsg(id, e.data));
    const leave = () => this.leave(id);
    server.addEventListener('close', leave);
    server.addEventListener('error', leave);
    return new Response(null, { status: 101, webSocket: client });
  }
  leave(id) {
    if (!this.peers.delete(id)) return;
    if (this.host === id) this.host = this.peers.size ? this.peers.keys().next().value : null;
    if (!this.peers.size) { this.setup = null; return; }
    this.broadcast(this.roster());
  }
  onMsg(id, raw) {
    if (typeof raw !== 'string' || raw.length > 900000) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const p = this.peers.get(id); if (!p) return;
    switch (m.t) {
      case 'hello':
        p.name = String(m.name || p.name).slice(0, 12);
        p.color = /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : p.color;
        this.broadcast(this.roster());
        break;
      case 'ping':
        this.send(p.ws, { t: 'pong', c: m.c, s: Date.now() });
        break;
      case 'setup':
        if (id !== this.host || !m.setup) return;
        this.setup = m.setup;
        this.broadcast({ t: 'setup', setup: this.setup }, id);
        break;
      case 'start':
        if (id !== this.host) return;
        this.broadcast({ t: 'start', at: Date.now() + 4000, grid: [...this.peers.keys()] });
        break;
      case 'lobby':
        if (id !== this.host) return;
        this.broadcast({ t: 'lobby' });
        break;
      case 'state':
        if (m.s && typeof m.s === 'object') this.broadcast({ t: 'state', id, s: m.s }, id);
        break;
      case 'finish':
        this.broadcast({ t: 'finish', id, time: +m.time || 0 });
        break;
    }
  }
}

// Watch-together rooms. Passes along each person's position (for avatars), sets up voice connections
// between devices (the audio itself goes device to device, or through TURN), and keeps what the host is watching.
const HANG_MAX = 10;
export class HangRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.peers = new Map();
    this.nextId = 1;
    this.host = null;
    this.watch = null;
    // poker and race side bets: the room owns the cards and the chips in play
    this.table = new PokerTable(); this.bets = new SideBets();
    this.wallet = new Map(); // pid -> { bal, rebuys, name, loaded }
    this.dirty = new Set(); this.saveT = null; this.tickT = null; this.graceT = new Map();
    this.relayStub = env.RELAY.get(env.RELAY.idFromName('live'));
  }
  async chips(q) { const r = await this.relayStub.fetch('https://relay/chips', { method: 'POST', body: JSON.stringify(q) }); return r.json(); }
  bal(pid) { const i = this.table.seatOf(pid); return i >= 0 ? this.table.seats[i].stack : (this.wallet.get(pid) || {}).bal || 0; }
  credit(pid, amt) {
    const i = this.table.seatOf(pid);
    if (i >= 0) this.table.seats[i].stack += amt; else { const w = this.wallet.get(pid); if (w) w.bal += amt; }
    this.markDirty(pid);
  }
  markDirty(pid) { this.dirty.add(pid); clearTimeout(this.saveT); this.saveT = setTimeout(() => this.flush(), 1500); }
  async flush() {
    if (!this.dirty.size) return;
    const set = {};
    for (const pid of this.dirty) { const w = this.wallet.get(pid); if (w && w.loaded) set[pid] = { bal: this.bal(pid), name: w.name, rebuys: w.rebuys }; }
    this.dirty.clear();
    try { await this.chips({ set }); } catch (e) {}
  }
  async loadWallet(pid, name) {
    let w = this.wallet.get(pid);
    if (!w) { w = { bal: START, rebuys: 0, name, loaded: false }; this.wallet.set(pid, w); }
    w.name = name || w.name;
    if (!w.loaded) {
      if (!w.loading) w.loading = this.chips({ get: [pid] }).then(r => { const rec = r.get && r.get[pid]; if (rec) { w.bal = rec.bal; w.rebuys = rec.rebuys || 0; } else this.markDirty(pid); }).catch(() => {});
      await w.loading; w.loaded = true;
    }
    return w;
  }
  sendMe(pid) {
    const w = this.wallet.get(pid); if (!w) return;
    for (const [, p] of this.peers) if (p.pid === pid) this.send(p.ws, { t: 'pk', a: 'me', bal: this.bal(pid), rebuys: w.rebuys, seat: this.table.seatOf(pid) });
  }
  pokerState() {
    this.drainSaves();
    const msg = JSON.stringify({ t: 'pk', a: 'state', s: this.table.publicState(), bets: this.bets.publicState() });
    for (const [, p] of this.peers) {
      this.send(p.ws, msg);
      if (!p.pid) continue;
      const i = this.table.seatOf(p.pid), seat = i >= 0 && this.table.seats[i];
      this.send(p.ws, { t: 'pk', a: 'hole', hand: this.table.hand, seat: i, hole: seat && seat.inHand ? seat.hole : null, bal: this.bal(p.pid), rebuys: (this.wallet.get(p.pid) || {}).rebuys || 0 });
    }
    this.armTick();
  }
  drainSaves() { while (this.table.saves.length) { const s = this.table.seats[this.table.saves.pop()]; if (s) this.markDirty(s.pid); } }
  armTick() {
    const busy = this.table.active() || this.bets.list.some(m => m.status === 'open' || m.status === 'closed');
    if (busy && !this.tickT) this.tickT = setInterval(() => {
      let changed = this.table.tick();
      for (const [, payouts] of this.bets.tick()) { for (const x of payouts || []) this.credit(x.pid, x.amt); changed = true; }
      if (this.bets.list.some(m => m.status === 'open' && Date.now() >= m.closes)) changed = true;
      if (changed) this.pokerState(); else this.armTick();
    }, 1000);
    if (!busy && this.tickT) { clearInterval(this.tickT); this.tickT = null; }
  }
  async onPoker(id, p, m) {
    const err = e => { if (e) this.send(p.ws, { t: 'pk', a: 'err', msg: e }); return !!e; };
    if (!p.pid) return err('Update Kerbside to play poker.');
    const T = this.table;
    switch (m.a) {
      case 'state': this.sendMe(p.pid); return this.pokerState();
      case 'sit': {
        const w = await this.loadWallet(p.pid, p.name);
        if (T.seatOf(p.pid) >= 0) return err('You’re already at the table.');
        if (w.bal < BLINDS.bb) return err('You’re out of chips: top up first.');
        if (err(T.sit(+m.seat, { pid: p.pid, peer: id, name: p.name, bal: w.bal }))) return;
        return this.pokerState();
      }
      case 'stand': {
        const mine = T.seatOf(p.pid); if (mine < 0) return;
        const left = T.stand(mine), w = this.wallet.get(p.pid); if (w && left != null) w.bal = left;
        this.markDirty(p.pid); this.sendMe(p.pid); return this.pokerState();
      }
      case 'act': { const mine = T.seatOf(p.pid); if (mine < 0) return; if (err(T.act(mine, String(m.act), m.amount))) return; return this.pokerState(); }
      case 'sitout': { const mine = T.seatOf(p.pid); if (mine < 0) return; T.setSitOut(mine, !!m.on); return this.pokerState(); }
      case 'topup': {
        const w = await this.loadWallet(p.pid, p.name), mine = T.seatOf(p.pid);
        if (mine >= 0 && T.seats[mine].inHand && T.betting()) return err('Wait for this hand to finish.');
        if (this.bal(p.pid) >= BLINDS.bb) return err('Top-ups are for when you’re out of chips.');
        w.rebuys++; if (mine >= 0) T.seats[mine].stack = START; else w.bal = START;
        this.markDirty(p.pid); this.sendMe(p.pid); return this.pokerState();
      }
      case 'top': { let top = []; try { await this.flush(); top = (await this.chips({ top: 10 })).top || []; } catch (e) {} return this.send(p.ws, { t: 'pk', a: 'top', top }); }
    }
  }
  async onBet(id, p, m) {
    const err = e => { if (e) this.send(p.ws, { t: 'pk', a: 'err', msg: e }); return !!e; };
    const host = id === this.host;
    switch (m.a) {
      case 'open': if (!host) return err('The host opens race bets.'); if (err(this.bets.open(String(m.kind), m.options, m.info))) return; return this.pokerState();
      case 'place': {
        if (!p.pid) return err('Update Kerbside to bet.');
        await this.loadWallet(p.pid, p.name);
        const amt = Math.floor(+m.amt || 0), T = this.table, i = T.seatOf(p.pid);
        if (amt < 1 || amt > this.bal(p.pid)) return err('You don’t have that many chips.');
        if (err(this.bets.place(m.id, p.pid, p.name, String(m.opt), amt))) return;
        if (i >= 0) T.seats[i].stack -= amt; else this.wallet.get(p.pid).bal -= amt;
        this.markDirty(p.pid); return this.pokerState();
      }
      case 'settle': case 'void': {
        if (!host) return;
        const pays = m.a === 'settle' ? this.bets.settle(m.id, m.winner) : this.bets.void(m.id);
        for (const x of pays || []) this.credit(x.pid, x.amt);
        return this.pokerState();
      }
    }
  }
  roster() {
    return { t: 'roster', host: this.host, peers: [...this.peers.entries()].map(([id, p]) => ({ id, name: p.name, color: p.color, device: p.device, muted: p.muted })) };
  }
  send(ws, m) { try { ws.send(typeof m === 'string' ? m : JSON.stringify(m)); } catch (e) {} }
  broadcast(m, except) {
    const msg = JSON.stringify(m);
    for (const [id, p] of this.peers) if (id !== except) this.send(p.ws, msg);
  }
  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    if (this.peers.size >= HANG_MAX) {
      this.send(server, { t: 'full' }); server.close(1008, 'Room is full');
      return new Response(null, { status: 101, webSocket: client });
    }
    const id = this.nextId++;
    this.peers.set(id, { ws: server, name: 'Friend ' + id, color: '#9aa5ab', device: 'screen', muted: false });
    if (this.host == null || !this.peers.has(this.host)) this.host = id;
    const r = this.roster();
    this.send(server, { t: 'welcome', you: id, host: this.host, peers: r.peers, watch: this.watch, env: this.env || null, look: this.look || 'team' });
    this.broadcast(r, id);
    server.addEventListener('message', e => this.onMsg(id, e.data));
    const leave = () => this.leave(id);
    server.addEventListener('close', leave);
    server.addEventListener('error', leave);
    return new Response(null, { status: 101, webSocket: client });
  }
  leave(id) {
    const gone = this.peers.get(id);
    if (!this.peers.delete(id)) return;
    if (gone && gone.pid && ![...this.peers.values()].some(q => q.pid === gone.pid)) { // give a dropped player 45 s to reconnect before giving up their seat
      const pid = gone.pid; clearTimeout(this.graceT.get(pid));
      this.graceT.set(pid, setTimeout(() => {
        this.graceT.delete(pid);
        if ([...this.peers.values()].some(q => q.pid === pid)) return;
        const i = this.table.seatOf(pid); if (i < 0) return;
        const left = this.table.stand(i), w = this.wallet.get(pid); if (w && left != null) w.bal = left;
        this.markDirty(pid); this.pokerState();
      }, 45000));
    }
    if (this.host === id) this.host = this.peers.size ? this.peers.keys().next().value : null;
    if (!this.peers.size) { this.watch = null; this.env = null; this.flush(); return; }
    this.broadcast({ t: 'left', id });
    this.broadcast(this.roster());
  }
  onMsg(id, raw) {
    if (typeof raw !== 'string' || raw.length > 64000) return;
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    const p = this.peers.get(id); if (!p) return;
    switch (m.t) {
      case 'hello':
        p.name = String(m.name || p.name).slice(0, 16);
        p.color = /^#[0-9a-f]{6}$/i.test(m.color || '') ? m.color : p.color;
        p.device = m.device === 'xr' ? 'xr' : 'screen';
        p.muted = !!m.muted;
        if (typeof m.pid === 'string' && /^[\w-]{8,40}$/.test(m.pid) && !p.pid) {
          p.pid = m.pid; clearTimeout(this.graceT.get(p.pid)); this.graceT.delete(p.pid);
          this.loadWallet(p.pid, p.name).then(() => { this.sendMe(p.pid); this.pokerState(); });
        } else if (p.pid) { const w = this.wallet.get(p.pid); if (w) w.name = p.name; const i = this.table.seatOf(p.pid); if (i >= 0) this.table.seats[i].name = p.name; }
        this.broadcast(this.roster());
        break;
      case 'pose':
        if (m.p && typeof m.p === 'object') this.broadcast({ t: 'pose', id, p: m.p }, id);
        break;
      case 'sig': {
        const to = this.peers.get(+m.to);
        if (to && m.data) this.send(to.ws, { t: 'sig', from: id, data: m.data });
        break;
      }
      case 'watch':
        if (id !== this.host || !m.w) return;
        this.watch = m.w;
        this.broadcast({ t: 'watch', w: m.w }, id);
        break;
      case 'env':
        if (id !== this.host || (m.env !== 'garage' && m.env !== 'passthrough')) return;
        this.env = m.env;
        if (m.look === 'team' || m.look === 'casino') this.look = m.look;
        this.broadcast({ t: 'env', env: m.env, look: this.look || 'team' }, id);
        break;
      case 'pk': this.onPoker(id, p, m); break;
      case 'bet': this.onBet(id, p, m); break;
      case 'ping':
        this.send(p.ws, { t: 'pong', c: m.c, s: Date.now() });
        break;
    }
  }
}
