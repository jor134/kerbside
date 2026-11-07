// Kerbside circuit weather: forecasts for the next Grand Prix and push alerts to anyone who turns them on.
// Runs inside the relay Durable Object every 15 minutes (see [triggers] in wrangler.toml).
// Weather: Open-Meteo (free, no key). Schedule: OpenF1. Alerts: standard Web Push, signed with keys
// the Worker makes for itself on first use (VAPID), so there's nothing to set up in Cloudflare.

const OPENF1 = 'https://api.openf1.org/v1';
const enc = new TextEncoder();
const isoMs = s => { if (!s) return NaN; s = String(s).replace(/(\.\d{3})\d+/, '$1'); if (!/(Z|[+-]\d\d:?\d\d)$/i.test(s)) s += 'Z'; return Date.parse(s); };
async function getJSON(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'kerbside-relay' } });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + new URL(url).host);
  return r.json();
}

/* ======================= Web Push (RFC 8291 + VAPID) ======================= */
const b64u = {
  enc(buf) { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
  dec(str) { str = String(str).replace(/-/g, '+').replace(/_/g, '/'); while (str.length % 4) str += '='; const s = atob(str), b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
};
const cat = (...arrs) => { const n = arrs.reduce((a, b) => a + b.length, 0), out = new Uint8Array(n); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; } return out; };
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
export async function vapidKeys(storage) {
  let v = await storage.get('vapid');
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    v = { pub: b64u.enc(await crypto.subtle.exportKey('raw', kp.publicKey)), jwk: await crypto.subtle.exportKey('jwk', kp.privateKey) };
    await storage.put('vapid', v);
  }
  return v;
}
async function vapidAuth(v, endpoint, subject) {
  const aud = new URL(endpoint).origin;
  const head = b64u.enc(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u.enc(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', v.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return `vapid t=${head}.${body}.${b64u.enc(sig)}, k=${v.pub}`;
}
// Encrypts one push message for one subscription (aes128gcm, a single record).
export async function encryptPush(sub, payload) {
  const uaPub = b64u.dec(sub.keys.p256dh), auth = b64u.dec(sub.keys.auth);
  const as = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', as.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(auth, shared);
  const ikm = (await hmac(prkKey, cat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPub.length);
  header.set(salt, 0); new DataView(header.buffer).setUint32(16, 4096); header[20] = asPub.length; header.set(asPub, 21);
  return cat(header, ct);
}
// Sends one message. Returns 'ok', 'gone' (subscription expired: delete it) or an error text.
async function sendPush(v, sub, msg, subject) {
  try {
    const body = await encryptPush(sub, JSON.stringify(msg));
    const r = await fetch(sub.endpoint, { method: 'POST', body, headers: {
      Authorization: await vapidAuth(v, sub.endpoint, subject), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(msg.ttl || 3600), Urgency: msg.urgent ? 'high' : 'normal', ...(msg.tag ? { Topic: msg.tag.replace(/[^\w-]/g, '').slice(0, 32) } : {}) } });
    if (r.status === 404 || r.status === 410) return 'gone';
    return r.ok ? 'ok' : 'HTTP ' + r.status;
  } catch (e) { return String(e.message || e); }
}

/* ======================= Schedule and forecast ======================= */
const WX = { 0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast', 45: 'Fog', 48: 'Fog', 51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
  56: 'Freezing drizzle', 57: 'Freezing drizzle', 61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains', 80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
  85: 'Snow showers', 86: 'Snow showers', 95: 'Thunderstorms', 96: 'Thunderstorms with hail', 99: 'Thunderstorms with hail' };
export const wxText = c => WX[c] || 'Unknown';
const CAT_TEXT = { dry: 'dry', showers: 'showers possible', wet: 'rain likely', storm: 'thunderstorms likely' };

// F1's own season index lists every weekend of the year with session times, including ones not raced yet.
// "StartDate" there is local time at the circuit; GmtOffset turns it into UTC.
// Jolpica (the Ergast successor): free, no key, whole season with every session time in UTC and the
// circuit's coordinates. One request per season, so it's the main schedule source.
const JOLPICA_SESSIONS = [['FirstPractice', 'Practice 1', 60], ['SecondPractice', 'Practice 2', 60], ['ThirdPractice', 'Practice 3', 60],
  ['SprintQualifying', 'Sprint Qualifying', 45], ['SprintShootout', 'Sprint Qualifying', 45], ['Sprint', 'Sprint', 60], ['Qualifying', 'Qualifying', 60]];
async function jolpicaSchedule(year) {
  const r = await fetch(`https://api.jolpi.ca/ergast/f1/${year}/races/?limit=100`, { headers: { 'User-Agent': 'kerbside-relay' } });
  if (!r.ok) throw new Error('Jolpica ' + year + ' HTTP ' + r.status);
  const j = await r.json(), out = [];
  for (const race of (j.MRData && j.MRData.RaceTable && j.MRData.RaceTable.Races) || []) {
    const c = race.Circuit || {}, L = c.Location || {}, mk = 'j' + race.season + '-' + race.round;
    const base = { mk, location: L.locality, country: L.country, circuit: c.circuitName, ck: c.circuitId,
      lat: L.lat != null ? +L.lat : undefined, lon: L.long != null ? +L.long : undefined };
    const add = (key, name, mins, d) => {
      if (!d || !d.date || !d.time) return; // a time not announced yet can't be forecast
      const start = isoMs(d.date + 'T' + d.time);
      if (isFinite(start)) out.push({ ...base, sk: mk + '-' + key, name, start, end: start + mins * 60e3 });
    };
    for (const [key, name, mins] of JOLPICA_SESSIONS) add(key, name, mins, race[key]);
    add('Race', 'Race', 120, { date: race.date, time: race.time });
  }
  return out;
}
async function f1Schedule(year) {
  const r = await fetch(`https://livetiming.formula1.com/static/${year}/Index.json`, { headers: { 'User-Agent': 'BestHTTP' } });
  if (!r.ok) throw new Error('F1 season index HTTP ' + r.status);
  const j = JSON.parse((await r.text()).replace(/^\uFEFF/, ''));
  const off = o => { const m = String(o || '00:00:00').match(/^(-)?(\d+):(\d+)/); return m ? (m[1] ? -1 : 1) * (+m[2] * 60 + +m[3]) * 60e3 : 0; };
  const out = [];
  for (const m of j.Meetings || []) for (const s of m.Sessions || []) {
    const o = off(s.GmtOffset);
    out.push({ sk: 'f1-' + s.Key, mk: 'f1-' + m.Key, name: s.Name, start: isoMs(s.StartDate) - o, end: isoMs(s.EndDate) - o,
      location: m.Location, country: m.Country && m.Country.Name, circuit: m.Circuit && m.Circuit.ShortName, ck: m.Circuit && m.Circuit.Key });
  }
  return out;
}
async function openf1Schedule(y) {
  const s = await getJSON(`${OPENF1}/sessions?year=${y}`);
  return (Array.isArray(s) ? s : []).map(s => ({ sk: s.session_key, mk: s.meeting_key, name: s.session_name,
    start: isoMs(s.date_start), end: isoMs(s.date_end), location: s.location, country: s.country_name, circuit: s.circuit_short_name, ck: s.circuit_key }));
}
async function nextMeeting(storage, now) {
  let cache = await storage.get('wx:schedule');
  const hasFuture = c => c && c.list.some(s => s.end > now);
  if (!cache || now - cache.at > 6 * 3600e3 || !hasFuture(cache)) {
    const year = new Date(now).getUTCFullYear(), errors = [];
    const future = l => l.some(s => s.end > now);
    let list = [];
    // Try each source in turn and stop at the first one with an upcoming session, so a run costs
    // one or two requests. OpenF1 (30 requests a minute on the free tier) is only a fallback.
    const sources = [['Jolpica', jolpicaSchedule], ['OpenF1', openf1Schedule], ['F1 index', f1Schedule]];
    for (const [name, fn] of sources) {
      const got = [];
      for (const y of [year, year + 1]) {
        try { got.push(...await fn(y)); } catch (e) { errors.push(e.message.startsWith(name) ? e.message : name + ' ' + y + ': ' + e.message); }
        if (future(got)) break; // next season only needed after the last race of this one
      }
      if (future(got)) { list = got; break; }
      if (!list.length) list = got;
    }
    if (list.length) { cache = { at: now, list }; await storage.put('wx:schedule', cache); }
    else if (!cache) throw new Error('Couldn’t get the race schedule (' + errors.join('; ') + ')');
  }
  const upcoming = cache.list.filter(s => s.end > now).sort((a, b) => a.start - b.start);
  if (!upcoming.length) return null;
  const mk = upcoming[0].mk, sessions = cache.list.filter(s => s.mk === mk).sort((a, b) => a.start - b.start);
  const f = sessions[0];
  return { mk, location: f.location, country: f.country, circuit: f.circuit, ck: f.ck, lat: f.lat, lon: f.lon, sessions };
}
async function locate(storage, m) {
  const key = 'wx:loc:' + m.mk, saved = await storage.get(key);
  if (saved) return saved;
  if (isFinite(m.lat) && isFinite(m.lon)) { // the schedule already gave the circuit's coordinates
    const loc = { lat: m.lat, lon: m.lon, place: [m.location, m.country].filter(Boolean).join(', ') };
    await storage.put(key, loc); return loc;
  }
  const r = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(m.location)}&count=10&language=en&format=json`);
  const res = (r && r.results) || [];
  const country = String(m.country || '').toLowerCase();
  const pick = res.find(x => String(x.country || '').toLowerCase() === country) || res.find(x => country.includes(String(x.country || '~').toLowerCase())) || res[0];
  if (!pick) throw new Error('Could not find ' + m.location + ' on the map');
  const loc = { lat: pick.latitude, lon: pick.longitude, place: [pick.name, pick.country].filter(Boolean).join(', '), tz: pick.timezone };
  await storage.put(key, loc);
  return loc;
}
async function forecast(loc) {
  const q = `latitude=${loc.lat}&longitude=${loc.lon}&timezone=GMT&forecast_days=10&wind_speed_unit=kmh` +
    '&hourly=temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m' +
    '&minutely_15=precipitation&current=temperature_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m';
  const f = await getJSON('https://api.open-meteo.com/v1/forecast?' + q);
  const h = f.hourly || {}, times = (h.time || []).map(t => isoMs(t));
  const m15 = f.minutely_15 || {};
  return { times, h, m15: { times: (m15.time || []).map(t => isoMs(t)), p: m15.precipitation || [] }, current: f.current || null };
}
// Sums up the forecast for one session window (from 30 minutes before the start).
export function summarize(fc, start, end) {
  const { times, h } = fc; let prob = 0, precip = 0, temp = -99, tmin = 99, gust = 0, wind = 0, code = 0, n = 0, storm = false;
  for (let i = 0; i < times.length; i++) {
    if (times[i] + 3600e3 <= start - 1800e3 || times[i] >= end) continue;
    n++;
    prob = Math.max(prob, h.precipitation_probability ? h.precipitation_probability[i] || 0 : 0);
    precip += h.precipitation ? h.precipitation[i] || 0 : 0;
    temp = Math.max(temp, h.temperature_2m[i]); tmin = Math.min(tmin, h.temperature_2m[i]);
    gust = Math.max(gust, h.wind_gusts_10m ? h.wind_gusts_10m[i] || 0 : 0); wind = Math.max(wind, h.wind_speed_10m[i] || 0);
    const c = h.weather_code[i] || 0; if (c >= 95) storm = true;
    if (rank(c) > rank(code)) code = c;
  }
  if (!n) return null;
  const category = storm ? 'storm' : prob >= 60 && precip >= 0.5 ? 'wet' : prob >= 30 || precip >= 0.3 ? 'showers' : 'dry';
  return { prob: Math.round(prob), precip: Math.round(precip * 10) / 10, temp: Math.round(temp), tmin: Math.round(tmin), gust: Math.round(gust), wind: Math.round(wind), code, text: wxText(code), cat: category };
}
const rank = c => c >= 95 ? 9 : c >= 80 ? 7 : c >= 61 ? 6 : c >= 51 ? 4 : c >= 45 ? 3 : c; // which code describes the window best

/* ======================= Alert rules ======================= */
// Works out what changed since the last run. Returns alerts (each with a type for subscriber preferences)
// and the new state. Pure, so it can be tested without the network.
export function evaluate(prev, meeting, sums, fc, now) {
  const st = { mk: meeting.mk, sessions: {}, rainSoonAt: prev && prev.mk === meeting.mk ? prev.rainSoonAt || 0 : 0 };
  const old = prev && prev.mk === meeting.mk ? prev.sessions || {} : {};
  const alerts = [], where = meeting.location;
  for (const s of meeting.sessions) {
    const w = sums[s.sk], o = old[s.sk] || {};
    const ns = { cat: o.cat, severe: { ...(o.severe || {}) } };
    st.sessions[s.sk] = ns;
    if (!w || s.end < now) continue;
    const soon = s.start - now < 72 * 3600e3;
    ns.cat = w.cat;
    if (soon && o.cat !== w.cat) {
      const wetNow = w.cat === 'wet' || w.cat === 'storm', wetBefore = o.cat === 'wet' || o.cat === 'storm';
      const body = `${w.text}, ${w.prob}% chance of rain, ${w.temp}°C, gusts to ${w.gust} km/h.`;
      if (wetNow && !wetBefore) alerts.push({ type: 'rainSession', also: 'change', title: `${where}: rain likely for ${s.name}`, body, tag: 'wx-' + s.sk, session: s });
      else if (!wetNow && wetBefore) alerts.push({ type: 'rainSession', also: 'change', title: `${where}: ${s.name} now looks ${CAT_TEXT[w.cat]}`, body, tag: 'wx-' + s.sk, session: s });
      else if (o.cat) alerts.push({ type: 'change', title: `${where}: ${s.name} forecast changed`, body: `Was ${CAT_TEXT[o.cat]}, now ${CAT_TEXT[w.cat]}. ${body}`, tag: 'wx-' + s.sk, session: s });
    }
    if (soon) {
      const sev = [];
      if (w.gust >= 60 && !ns.severe.wind) { ns.severe.wind = 1; sev.push(`gusts up to ${w.gust} km/h`); }
      if (w.temp >= 35 && !ns.severe.heat) { ns.severe.heat = 1; sev.push(`heat up to ${w.temp}°C`); }
      if (w.cat === 'storm' && !ns.severe.storm) { ns.severe.storm = 1; sev.push('thunderstorms'); }
      if (sev.length) alerts.push({ type: 'severe', title: `${where}: severe weather for ${s.name}`, body: 'Expect ' + sev.join(', ') + '.', tag: 'wxs-' + s.sk, urgent: true, session: s });
    }
  }
  // rain at the circuit within the hour, during the race weekend (from the day before the first session)
  const first = meeting.sessions[0].start, last = meeting.sessions[meeting.sessions.length - 1].end;
  if (now > first - 24 * 3600e3 && now < last && now - st.rainSoonAt > 3 * 3600e3 && fc.m15.times.length) {
    let nowP = 0, next = 0;
    for (let i = 0; i < fc.m15.times.length; i++) {
      const t = fc.m15.times[i];
      if (t <= now && t > now - 15 * 60e3) nowP = fc.m15.p[i] || 0;
      if (t > now && t <= now + 60 * 60e3) next += fc.m15.p[i] || 0;
    }
    if (nowP < 0.1 && next >= 0.3) {
      st.rainSoonAt = now;
      alerts.push({ type: 'rainSoon', title: `${where}: rain within the hour`, body: `About ${Math.round(next * 10) / 10} mm expected at the circuit in the next hour.`, tag: 'wx-soon', urgent: true });
    }
  }
  return { alerts, state: st };
}
export function dailyMessage(meeting, sums, tz, now) {
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const lines = [];
  for (const s of meeting.sessions) {
    if (s.end < now || s.start - now > 48 * 3600e3) continue;
    const w = sums[s.sk]; if (!w) continue;
    lines.push(`${s.name} (${fmt.format(new Date(s.start))}): ${w.text}, ${w.temp}°C, rain ${w.prob}%`);
  }
  if (!lines.length) return null;
  return { type: 'daily', title: `${meeting.location} weather`, body: lines.join('\n'), tag: 'wx-daily' };
}
const localParts = (tz, t) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(t)).map(x => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour };
};

/* ======================= The 15-minute run ======================= */
export async function weatherRun(storage, now = Date.now()) {
  const meeting = await nextMeeting(storage, now);
  if (!meeting) { await storage.put('wx:last', { at: now, meeting: null, error: 'No upcoming sessions in the schedule' }); return { note: 'No upcoming sessions found' }; }
  const first = meeting.sessions[0].start;
  const base = { at: now, meeting: { mk: meeting.mk, location: meeting.location, country: meeting.country, circuit: meeting.circuit, first, last: meeting.sessions[meeting.sessions.length - 1].end } };
  if (first - now > 9.5 * 24 * 3600e3) { // too far ahead to forecast
    await storage.put('wx:last', { ...base, sessions: meeting.sessions.map(s => ({ sk: s.sk, name: s.name, start: s.start, end: s.end })) });
    return { note: 'Next race weekend is more than 9 days away' };
  }
  const loc = await locate(storage, meeting), fc = await forecast(loc), sums = {};
  for (const s of meeting.sessions) sums[s.sk] = summarize(fc, s.start, s.end);
  const prev = await storage.get('wx:state');
  const { alerts, state } = evaluate(prev, meeting, sums, fc, now);
  await storage.put('wx:state', state);
  const cur = fc.current ? { temp: Math.round(fc.current.temperature_2m), text: wxText(fc.current.weather_code), precip: fc.current.precipitation, wind: Math.round(fc.current.wind_speed_10m), gust: Math.round(fc.current.wind_gusts_10m) } : null;
  await storage.put('wx:last', { ...base, place: loc.place, lat: loc.lat, lon: loc.lon, now: cur,
    sessions: meeting.sessions.map(s => ({ sk: s.sk, name: s.name, start: s.start, end: s.end, w: sums[s.sk] })) });
  // deliver
  const subs = await storage.list({ prefix: 'sub:' });
  if (!subs.size) return { alerts: alerts.length, sent: 0 };
  const v = await vapidKeys(storage), subject = (await storage.get('wx:origin')) || 'mailto:kerbside@invalid.example';
  let sent = 0, gone = 0;
  for (const [k, rec] of subs) {
    const p = rec.prefs || {}, mine = alerts.filter(a => p[a.type] || (a.also && p[a.also]));
    if (p.daily && now > first - 2 * 24 * 3600e3) {
      const lp = localParts(rec.tz || 'UTC', now);
      if (lp.hour === 8 && rec.dailySent !== lp.day) { const d = dailyMessage(meeting, sums, rec.tz || 'UTC', now); if (d) mine.unshift(d); rec.dailySent = lp.day; await storage.put(k, rec); }
    }
    const batch = mine.length > 3 ? [{ title: `${meeting.location}: ${mine.length} weather updates`, body: mine.map(a => a.title.replace(meeting.location + ': ', '')).join('\n'), tag: 'wx-many' }] : mine;
    for (const a of batch) {
      const r = await sendPush(v, rec.sub, { title: a.title, body: a.body, tag: a.tag, url: '/?weather=1', urgent: !!a.urgent }, subject);
      if (r === 'gone') { await storage.delete(k); gone++; break; }
      if (r === 'ok') sent++;
    }
  }
  return { alerts: alerts.map(a => a.title), sent, removed: gone };
}

/* ======================= HTTP endpoints (called from the Durable Object) ======================= */
async function subKey(endpoint) { return 'sub:' + b64u.enc(await crypto.subtle.digest('SHA-256', enc.encode(endpoint))).slice(0, 24); }
export async function weatherRequest(storage, request, url) {
  const p = url.pathname;
  if (p === '/weather') {
    let last = await storage.get('wx:last');
    if (!last || !last.at || Date.now() - last.at > 30 * 60e3) {
      try { await weatherRun(storage); } catch (e) { await storage.put('wx:last', { ...(last || {}), at: Date.now(), error: String(e.message || e) }); }
      last = await storage.get('wx:last');
    }
    return Response.json(last || { at: null });
  }
  if (p === '/push/key') return Response.json({ key: (await vapidKeys(storage)).pub });
  if (p === '/push/subscribe' && request.method === 'POST') {
    let b; try { b = await request.json(); } catch (e) { return Response.json({ error: 'bad json' }, { status: 400 }); }
    const sub = b && b.sub;
    if (!sub || !/^https:\/\//.test(sub.endpoint || '') || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return Response.json({ error: 'bad subscription' }, { status: 400 });
    const prefs = {}; for (const k of ['rainSession', 'daily', 'rainSoon', 'severe', 'change']) prefs[k] = !!(b.prefs && b.prefs[k]);
    const k = await subKey(sub.endpoint), old = await storage.get(k);
    let tz = 'UTC'; try { new Intl.DateTimeFormat('en', { timeZone: b.tz }); tz = b.tz || 'UTC'; } catch (e) {}
    await storage.put(k, { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, prefs, tz, dailySent: old && old.dailySent, since: (old && old.since) || Date.now() });
    if (b.origin && /^https:\/\//.test(b.origin)) await storage.put('wx:origin', b.origin);
    if (b.test) {
      const v = await vapidKeys(storage), r = await sendPush(v, (await storage.get(k)).sub, { title: 'Kerbside weather alerts are on', body: 'You’ll get the alerts you picked for each Grand Prix weekend.', tag: 'wx-test', url: '/?weather=1' }, (await storage.get('wx:origin')) || 'mailto:kerbside@invalid.example');
      return Response.json({ ok: true, test: r });
    }
    return Response.json({ ok: true });
  }
  if (p === '/push/unsubscribe' && request.method === 'POST') {
    let b; try { b = await request.json(); } catch (e) { b = {}; }
    if (b.endpoint) await storage.delete(await subKey(b.endpoint));
    return Response.json({ ok: true });
  }
  return null;
}
