// Kerbside relay: holds one connection to F1 live timing and fans it out to viewers.
import { DurableObject } from 'cloudflare:workers';

const RS = '\x1e';
const F1_BASE = 'https://livetiming.formula1.com/signalrcore';
const TOPICS = [
  'Heartbeat', 'Position.z', 'TimingData', 'TimingAppData', 'DriverList',
  'SessionInfo', 'SessionStatus', 'TrackStatus', 'LapCount',
  'RaceControlMessages', 'ExtrapolatedClock', 'WeatherData'
];
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (env.RELAY_KEY && url.searchParams.get('key') !== env.RELAY_KEY) {
      return new Response('Wrong or missing relay key', { status: 401, headers: CORS });
    }
    const stub = env.RELAY.get(env.RELAY.idFromName('live'));
    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected a WebSocket upgrade', { status: 426, headers: CORS });
      }
      return stub.fetch(request);
    }
    if (url.pathname === '/status') {
      const r = await stub.fetch(new Request(url.origin + '/status'));
      return new Response(r.body, { headers: { ...CORS, 'content-type': 'application/json' } });
    }
    return new Response('Kerbside relay is running. Connect to /ws or check /status.', { headers: CORS });
  }
};

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

export class F1Relay extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
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

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/status') return Response.json(this.statusObj());

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
