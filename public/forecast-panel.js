// Kerbside circuit weather: the next Grand Prix forecast in the menu, on a sign at the table and on the
// headset panel, plus push alerts (rain for a session, daily forecast, rain within the hour, severe weather,
// any change). Forecasts and alerts come from the Worker every 15 minutes; this file only shows them.
(function () {
'use strict';
const KB = window.KB, THREE = KB.THREE, App = KB.App, $ = KB.$, store = KB.store, toast = KB.toast, renderer = KB.renderer;
const WEATHER_BUILD = 4;
const TYPES = [
  ['rainSession', 'Rain expected during a session'],
  ['daily', 'Daily forecast on race weekends (8 am)'],
  ['rainSoon', 'Rain starting at the circuit within the hour'],
  ['severe', 'Strong wind, heat or storms'],
  ['change', 'Any change in a session’s forecast']
];
const prefs = Object.assign({ rainSession: true, daily: true, rainSoon: true, severe: true, change: true }, store.get('wx:prefs', {}));
const W = { data: null, at: 0, sign: true };
W.sign = store.get('wx:sign', true);

/* ---------------- Fetching ---------------- */
function base() { return (store.get('relayUrl', '') || location.origin).replace(/\/+$/, ''); }
async function refresh() {
  let why = '';
  try {
    const r = await fetch(base() + '/weather', { cache: 'no-store' });
    const type = r.headers.get('content-type') || '';
    if (!r.ok) why = r.status === 401 ? 'the relay asked for a key, so the Worker is an older version' : 'HTTP ' + r.status;
    else if (!/json/.test(type)) why = 'the Worker doesn’t know /weather yet, so it’s an older version';
    else { W.data = await r.json(); W.err = ''; W.at = Date.now(); render(); drawSign(); return; }
  } catch (e) { why = 'no connection to ' + base(); }
  W.err = 'Couldn’t load the forecast: ' + why + '. Check that src/forecast-worker.js is committed and the latest Cloudflare deploy succeeded.';
  render();
}

/* ---------------- Words and icons ---------------- */
// Same emoji as the push notifications (one per WMO weather code).
const wxEmoji = c => c >= 95 ? '⛈️' : c >= 85 ? '🌨️' : c >= 80 ? '🌦️' : c >= 71 ? '❄️' : c >= 61 ? '🌧️' : c >= 51 ? '🌦️' : c >= 45 ? '🌫️' : c === 3 ? '☁️' : c === 2 ? '⛅' : c === 1 ? '🌤️' : '☀️';
const icon = w => !w ? '·' : wxEmoji(w.code || 0);
const tf = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
const when = t => tf.format(new Date(t));
const nextSession = d => (d && d.sessions || []).find(s => s.end > Date.now());
function headline(d) {
  if (!d) return W.err ? 'Weather: couldn’t load the forecast' : 'Weather: loading…';
  if (!d.meeting) return d.error ? 'Weather unavailable: ' + d.error : 'No upcoming Grand Prix found yet.';
  const s = nextSession(d);
  if (!s) return d.meeting.location;
  if (!s.w) return `${d.meeting.location}: ${s.name} ${when(s.start)} (forecast from 9 days out)`;
  return `${icon(s.w)} ${d.meeting.location} · ${s.name}: ${s.w.text}, ${s.w.temp}°C, 💧${s.w.prob}%`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/* ---------------- Menu section ---------------- */
function render() {
  const el = $('#wxPane'); if (!el) return;
  const d = W.data;
  let h = '<h3>Circuit weather</h3>';
  if (W.err && !d) h += `<p class="hint" style="color:var(--flag)">${esc(W.err)}</p>`;
  else if (!d || !d.meeting) h += `<p class="hint">${!d ? 'Loading the forecast…' : d.error ? 'Forecast unavailable: ' + esc(d.error) + '. It retries every 15 minutes.' : 'No upcoming Grand Prix found yet.'}</p>`;
  else {
    h += `<p class="hint" style="margin-top:0">${esc(d.meeting.location)}${d.place ? ' · forecast for ' + esc(d.place) : ''}</p>`;
    if (d.now) h += `<p class="wxnow">${d.now.code != null ? wxEmoji(d.now.code) + ' ' : ''}Now: ${esc(d.now.text)}, ${d.now.temp}°C, wind ${d.now.wind} km/h</p>`;
    h += '<ul class="wxlist">' + d.sessions.filter(s => s.end > Date.now() - 3600e3).map(s => {
      const w = s.w;
      return `<li><span class="wi">${icon(w)}</span><span><b>${esc(s.name)}</b><br><small>${when(s.start)}</small></span><span class="wv">${w ? `${w.temp}°C · 💧${w.prob}%<br><small>${esc(w.text)}${w.gust >= 40 ? ', gusts ' + w.gust : ''}</small>` : '<small>forecast soon</small>'}</span></li>`;
    }).join('') + '</ul>';
    if (d.at) h += `<p class="hint">Updated ${new Date(d.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}. Times are yours. Rain % is the highest chance during each session.</p>`;
  }
  h += `<label class="check" style="margin-top:8px"><input type="checkbox" id="wxSign" ${W.sign ? 'checked' : ''}> Weather sign at the table</label>`;
  const on = store.get('wx:on', false);
  h += `<h3 style="margin-top:12px">Weather alerts</h3>`;
  h += TYPES.map(([k, l]) => `<label class="check"><input type="checkbox" data-wxp="${k}" ${prefs[k] ? 'checked' : ''}> ${l}</label>`).join('');
  h += `<button id="wxAlerts" class="${on ? 'ghost' : 'primary'}" style="margin-top:8px">${on ? 'Turn alerts off' : 'Turn on alerts'}</button>`;
  h += `<p class="hint" id="wxHint">${hint()}</p><p class="hint">Weather build ${WEATHER_BUILD}</p>`;
  el.innerHTML = h;
  $('#wxSign').onchange = e => { W.sign = e.target.checked; store.set('wx:sign', W.sign); };
  el.querySelectorAll('[data-wxp]').forEach(c => c.onchange = () => { prefs[c.dataset.wxp] = c.checked; store.set('wx:prefs', prefs); if (store.get('wx:on', false)) subscribe(false); });
  $('#wxAlerts').onclick = () => store.get('wx:on', false) ? unsubscribe() : subscribe(true);
}
const isApple = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
function hint() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    if (isApple() && !standalone()) return 'On iPad and iPhone, alerts need the Home Screen app: tap Share, then Add to Home Screen, and open Kerbside from there.';
    return 'This browser can’t receive alerts. The forecast still shows here, on the table and in the headset.';
  }
  if (typeof Notification !== 'undefined' && Notification.permission === 'denied') return 'Notifications are blocked for this site. Allow them in the browser or system settings, then try again.';
  if (!store.get('relayKey', '')) return 'Alerts use your relay. Enter the relay key under Live (or open a share link) first.';
  return store.get('wx:on', false) ? 'Alerts are on for this device. Checked every 15 minutes.' : 'Alerts arrive even when Kerbside is closed. Each device turns them on separately.';
}

/* ---------------- Push subscription ---------------- */
const b64ToBytes = s => { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
async function subscribe(withTest) {
  const key = store.get('relayKey', '');
  if (!key) { toast('Enter the relay key under Live first.', 5000); return; }
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast(hint(), 8000); return; }
  try {
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') { toast('Notifications weren’t allowed, so alerts are off.', 6000); render(); return; }
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const k = await (await fetch(base() + '/push/key', { cache: 'no-store' })).json();
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.key) });
    }
    const res = await fetch(`${base()}/push/subscribe?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sub: sub.toJSON(), prefs, tz: Intl.DateTimeFormat().resolvedOptions().timeZone, origin: location.origin, test: withTest }) });
    if (!res.ok) throw new Error(res.status === 401 ? 'the relay key was refused' : 'HTTP ' + res.status);
    const j = await res.json();
    store.set('wx:on', true);
    if (withTest) toast(j.test === 'ok' ? 'Alerts are on. A test alert is on its way.' : 'Alerts are on, but the test alert failed (' + j.test + ').', 7000);
  } catch (e) { toast('Couldn’t turn on alerts: ' + e.message + '.', 8000); }
  render();
}
async function unsubscribe() {
  try {
    const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
    if (sub) {
      await fetch(`${base()}/push/unsubscribe?key=${encodeURIComponent(store.get('relayKey', ''))}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch (e) {}
  store.set('wx:on', false); toast('Weather alerts are off for this device.'); render();
}

/* ---------------- Sign at the table ---------------- */
const SW = 512, SH = 300;
const cv = document.createElement('canvas'); cv.width = SW; cv.height = SH;
const tex = new THREE.CanvasTexture(cv);
const sign = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthWrite: false }));
sign.scale.set(0.3, 0.3 * SH / SW, 1); sign.visible = false; KB.scene.add(sign);
function drawSign() {
  const c = cv.getContext('2d'), d = W.data;
  c.clearRect(0, 0, SW, SH);
  KB.rr(c, 0, 0, SW, SH, 26); c.fillStyle = 'rgba(32,38,43,0.93)'; c.fill();
  c.fillStyle = '#4F9FD9'; c.fillRect(0, 0, SW, 10);
  c.fillStyle = '#E9E6DF'; c.font = '700 40px "Barlow Condensed", sans-serif'; c.textBaseline = 'alphabetic';
  c.fillText(d && d.meeting ? (d.now && d.now.code != null ? wxEmoji(d.now.code) + ' ' : '') + d.meeting.location : 'Circuit weather', 24, 58);
  const list = d && d.sessions ? d.sessions.filter(s => s.end > Date.now()).slice(0, 4) : [];
  if (!list.length) { c.font = '500 26px Barlow'; c.fillStyle = '#94A1A8'; c.fillText(d ? 'No forecast yet' : 'Loading…', 24, 120); }
  list.forEach((s, i) => {
    const y = 100 + i * 50, w = s.w;
    c.font = '32px sans-serif'; c.fillText(icon(w), 22, y + 8);
    c.font = '600 28px "Barlow Condensed"'; c.fillStyle = '#E9E6DF'; c.fillText(s.name, 70, y + 4);
    c.font = '500 22px Barlow'; c.fillStyle = '#94A1A8'; c.fillText(when(s.start), 70, y + 28);
    c.textAlign = 'right'; c.font = '600 28px "Barlow Condensed"';
    c.fillStyle = w && (w.cat === 'wet' || w.cat === 'storm') ? '#4F9FD9' : '#E9E6DF';
    c.fillText(w ? `${w.temp}°  💧${w.prob}%` : '–', SW - 24, y + 12); c.textAlign = 'left'; c.fillStyle = '#E9E6DF';
  });
  tex.needsUpdate = true;
}
const tv = new THREE.Vector3();
function placeSign() {
  const driving = window.KBDrive && KBDrive.active;
  const show = W.sign && App.view === 'tabletop' && !driving && !!App.track && !!W.data && (!renderer.xr.isPresenting || App.placed);
  sign.visible = show; if (!show) return;
  // just off the far corner of the table, turning with it
  const xr = renderer.xr.isPresenting, s = xr ? App.tableScale : 1;
  const cx = xr ? App.anchor.x : 0, cy = xr ? App.anchor.y : 0, cz = xr ? App.anchor.z : 0, a = App.tableYaw;
  const lx = 0.62 * s, lz = -0.5 * s;
  tv.set(cx + lx * Math.cos(a) + lz * Math.sin(a), cy + 0.2, cz - lx * Math.sin(a) + lz * Math.cos(a));
  sign.position.copy(tv);
}

/* ---------------- Per frame and start-up ---------------- */
let lastFetch = 0;
function frame() {
  placeSign();
  if (Date.now() - lastFetch > 5 * 60e3) { lastFetch = Date.now(); refresh(); }
}
const css = document.createElement('style');
css.textContent = `.wxlist{list-style:none;margin:6px 0;padding:0}.wxlist li{display:grid;grid-template-columns:28px 1fr auto;gap:8px;align-items:center;padding:5px 0;border-top:1px solid var(--tarmac-3)}
.wxlist li:first-child{border-top:0}.wxlist .wi{font-size:20px;text-align:center}.wxlist .wv{text-align:right;font:600 16px/1.2 var(--cond)}.wxlist small{color:var(--muted);font:400 12px/1.2 var(--body)}
.wxnow{margin:4px 0;font-size:14px}`;
document.head.appendChild(css);
render();
if (/[?&]weather=1/.test(location.search)) { document.body.classList.add('dock-open'); setTimeout(() => { const p = $('#wxPane'); p && p.scrollIntoView({ block: 'start' }); }, 300); }

window.KBWeather = { frame, refresh, headline: () => headline(W.data), data: () => W.data, emoji: wxEmoji, build: WEATHER_BUILD };
})();
