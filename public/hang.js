// Kerbside hangout: watch together with friends, with voice chat. Loaded on demand by index.html.
// Everyone sees the same race around their own table; people show up as avatars where they stand
// (headset) or in a seat (iPad and phone). Voice goes device to device, through TURN when needed.
(function () {
'use strict';
const KB = window.KB, THREE = KB.THREE, App = KB.App, $ = KB.$, store = KB.store, toast = KB.toast;
const renderer = KB.renderer;
const HANG_BUILD = 6;
const COLORS = ['#D2342B', '#F28A1E', '#E8C33A', '#2F8F4E', '#2BB5A0', '#2E6FD9', '#8E5BD6', '#E66BB0', '#C9CED3', '#F2F2EF'];

const me = Object.assign({ name: '', color: COLORS[Math.floor(Math.random() * COLORS.length)], follow: true }, store.get('hang:me', {}));
const saveMe = () => store.set('hang:me', { name: me.name, color: me.color, follow: me.follow });
const H = {
  ws: null, code: '', id: null, host: null, peers: [], watch: null, joined: false, muted: false,
  pcs: new Map(), audio: new Map(), avatars: new Map(), poses: new Map(), mic: null, micErr: '', ice: null,
  lastPose: 0, lastWatch: 0, watchSig: '', needTap: false
};
const isHost = () => H.id != null && H.id === H.host;
// A random id that stays on this device: it keeps your poker chips between races.
const pid = (() => { let p = store.get('kb:pid', ''); if (!/^[\w-]{8,40}$/.test(p)) { p = 'p-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); store.set('kb:pid', p); } return p; })();
const myName = () => (me.name || '').trim().slice(0, 16) || 'Friend';
const device = () => renderer.xr.isPresenting ? 'xr' : 'screen';

/* ---------------- Connection to the room ---------------- */
function roomUrl(code) {
  const r = KB.relayInfo(); if (!r) return null;
  return r.base.replace(/^http/, 'ws') + '/hang?code=' + encodeURIComponent(code) + '&key=' + encodeURIComponent(r.key);
}
async function getIce() {
  if (H.ice) return H.ice;
  const r = KB.relayInfo();
  try {
    const res = await fetch(`${r.base}/ice?key=${encodeURIComponent(r.key)}`, { cache: 'no-store' });
    H.ice = res.ok ? await res.json() : null;
  } catch (e) { H.ice = null; }
  if (!H.ice) H.ice = { iceServers: [{ urls: ['stun:stun.cloudflare.com:3478'] }], turn: false };
  return H.ice;
}
async function join(code) {
  code = String(code || '').toUpperCase().replace(/[^A-Z]/g, '');
  if (code.length !== 4) { toast('Room codes are 4 letters.'); return; }
  const url = roomUrl(code);
  if (!url) { toast('Hangouts use your relay. Enter the relay key under Live first, or open a friend’s invite link.', 8000); return; }
  leave(true);
  H.code = code; H.joined = true; UI.render('Connecting…');
  store.set('hang:last', code);
  // Ask for the microphone now: this runs from a tap, which iPad and Quest need, and the
  // permission prompt can't appear once you're inside the headset view.
  await startMic();
  await getIce();
  unlockAudio();
  const ws = H.ws = new WebSocket(url);
  ws.onopen = () => {
    sendHello();
    clearInterval(H.pingT); H.pingT = setInterval(() => send({ t: 'ping', c: Date.now() }), 15000);
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onMsg(m); };
  ws.onclose = () => {
    if (H.ws !== ws) return;
    H.ws = null; clearInterval(H.pingT);
    if (H.joined) { UI.render('Connection lost. Reconnecting…'); setTimeout(() => { if (H.joined && !H.ws) join(H.code); }, 3000); }
  };
}
function leave(quiet) {
  H.joined = false;
  const ws = H.ws; H.ws = null; clearInterval(H.pingT);
  if (ws) try { ws.close(); } catch (e) {}
  for (const id of [...H.pcs.keys()]) dropPeer(id);
  if (H.mic) { H.mic.getTracks().forEach(t => t.stop()); H.mic = null; }
  H.id = null; H.host = null; H.peers = []; H.watch = null; H.code = '';
  if (!quiet) UI.render();
}
function send(m) { if (H.ws && H.ws.readyState === 1) H.ws.send(JSON.stringify(m)); }
function sendHello() { if (window.KBGarage) KBGarage.setTeamColor(me.color); send({ t: 'hello', name: myName(), color: me.color, device: device(), muted: H.muted || !H.mic, pid }); }

function onMsg(m) {
  if (m.t === 'welcome') {
    H.id = m.you; H.host = m.host; H.peers = m.peers || [];
    if (m.watch) applyWatch(m.watch);
    if (m.env && !isHost()) KB.setEnv(m.env, { fromHost: true });
    if (m.look && !isHost()) KB.setLook(m.look, { fromHost: true });
    if (window.KBLoadPoker) KBLoadPoker();
    syncPeers(); UI.render();
    if (isHost()) { publishWatch(true); publishEnv(App.env); }
  } else if (m.t === 'roster') {
    const wasHost = isHost();
    H.host = m.host; H.peers = m.peers || [];
    syncPeers(); UI.render();
    if (!wasHost && isHost()) toast('You’re the host now. Friends follow what you watch.', 6000);
    if (isHost()) { publishWatch(true); publishEnv(App.env); } // someone joined or left: make sure everyone has the host's choices
  } else if (m.t === 'left') {
    dropPeer(m.id);
  } else if (m.t === 'pose') {
    const prev = H.poses.get(m.id);
    H.poses.set(m.id, { p: m.p, at: performance.now(), prev: prev ? prev.p : m.p, prevAt: prev ? prev.at : performance.now() });
  } else if (m.t === 'sig') {
    onSignal(m.from, m.data);
  } else if (m.t === 'watch') {
    applyWatch(m.w);
  } else if (m.t === 'env') {
    if (!isHost() && m.env) {
      const was = App.env, wasLook = App.garageLook;
      KB.setEnv(m.env, { fromHost: true }); if (m.look) KB.setLook(m.look, { fromHost: true });
      if (was !== App.env) toast(m.env === 'garage' ? 'The host moved everyone into the pit garage.' : 'The host switched everyone to their own rooms.', 4000);
      else if (wasLook !== App.garageLook) toast(App.garageLook === 'casino' ? 'The host opened the casino.' : 'The host switched back to the team garage.', 4000);
    }
  } else if (m.t === 'pk') {
    if (window.KBPoker) KBPoker.onMsg(m);
  } else if (m.t === 'full') {
    toast('That room is full (10 people).', 6000); leave();
  }
}

/* ---------------- Voice ---------------- */
async function startMic() {
  if (H.mic) return;
  H.micErr = '';
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { H.micErr = 'This browser can’t use a microphone here.'; return; }
  try {
    H.mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    H.mic.getAudioTracks().forEach(t => { t.enabled = !H.muted; });
    H.micLevel = levelMeter(H.mic);
  } catch (e) {
    H.mic = null;
    H.micErr = e && e.name === 'NotAllowedError' ? 'Microphone blocked. You can listen; allow the mic in the browser’s site settings to talk.' : 'No microphone available. You can still listen.';
  }
}
let actx = null;
function audioCtx() {
  const C = window.AudioContext || window.webkitAudioContext; if (!C) return null;
  if (!actx) actx = new C();
  if (actx.state === 'suspended') actx.resume().catch(() => {});
  return actx;
}
function levelMeter(stream) {
  const ctx = audioCtx(); if (!ctx) return () => 0;
  try {
    const src = ctx.createMediaStreamSource(stream), an = ctx.createAnalyser(); an.fftSize = 512;
    src.connect(an); const buf = new Uint8Array(an.fftSize); let lvl = 0;
    return () => { an.getByteTimeDomainData(buf); let s = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; s += v * v; } lvl = Math.max(Math.sqrt(s / buf.length) * 5, lvl * 0.85); return Math.min(1, lvl); };
  } catch (e) { return () => 0; }
}
function unlockAudio() {
  audioCtx();
  for (const a of H.audio.values()) a.el.play().then(() => { H.needTap = false; UI.render(); }).catch(() => { H.needTap = true; UI.render(); });
}
function setMuted(v) {
  H.muted = v;
  if (H.mic) H.mic.getAudioTracks().forEach(t => { t.enabled = !v; });
  sendHello(); UI.render(); drawXrPanel();
}

// One connection per pair of people ("perfect negotiation": either side may start, the higher id yields).
function syncPeers() {
  const ids = new Set(H.peers.map(p => p.id));
  for (const p of H.peers) if (p.id !== H.id && !H.pcs.has(p.id)) makePeer(p.id);
  for (const id of [...H.pcs.keys()]) if (!ids.has(id)) dropPeer(id);
  for (const id of [...H.avatars.keys()]) if (!ids.has(id) || id === H.id) dropAvatar(id);
}
function makePeer(id) {
  const pc = new RTCPeerConnection({ iceServers: (H.ice && H.ice.iceServers) || [] });
  const st = { pc, polite: H.id > id, making: false, ignore: false, id };
  H.pcs.set(id, st);
  if (H.mic) H.mic.getTracks().forEach(t => pc.addTrack(t, H.mic));
  else pc.addTransceiver('audio', { direction: 'recvonly' });
  pc.onnegotiationneeded = async () => {
    try { st.making = true; await pc.setLocalDescription(); send({ t: 'sig', to: id, data: { desc: pc.localDescription } }); }
    catch (e) {} finally { st.making = false; }
  };
  pc.onicecandidate = e => { if (e.candidate) send({ t: 'sig', to: id, data: { cand: e.candidate } }); };
  pc.ontrack = e => {
    const stream = e.streams && e.streams[0] ? e.streams[0] : new MediaStream([e.track]);
    attachAudio(id, stream);
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch (err) {} }
    UI.render();
  };
  return st;
}
async function onSignal(from, data) {
  let st = H.pcs.get(from);
  if (!st) st = makePeer(from);
  const pc = st.pc;
  try {
    if (data.desc) {
      const collision = data.desc.type === 'offer' && (st.making || pc.signalingState !== 'stable');
      st.ignore = !st.polite && collision;
      if (st.ignore) return;
      await pc.setRemoteDescription(data.desc);
      if (data.desc.type === 'offer') { await pc.setLocalDescription(); send({ t: 'sig', to: from, data: { desc: pc.localDescription } }); }
    } else if (data.cand) {
      try { await pc.addIceCandidate(data.cand); } catch (e) { if (!st.ignore) throw e; }
    }
  } catch (e) { /* a bad message from one peer shouldn't break the room */ }
}
function attachAudio(id, stream) {
  let a = H.audio.get(id);
  if (!a) {
    const el = document.createElement('audio'); el.autoplay = true; el.playsInline = true; el.setAttribute('playsinline', '');
    el.style.display = 'none'; document.body.appendChild(el);
    a = { el, level: () => 0 }; H.audio.set(id, a);
  }
  if (a.el.srcObject !== stream) {
    a.el.srcObject = stream;
    a.level = levelMeter(stream);
    a.el.play().then(() => { H.needTap = false; UI.render(); }).catch(() => { H.needTap = true; UI.render(); });
  }
}
function dropPeer(id) {
  const st = H.pcs.get(id); if (st) { try { st.pc.close(); } catch (e) {} H.pcs.delete(id); }
  const a = H.audio.get(id); if (a) { a.el.srcObject = null; a.el.remove(); H.audio.delete(id); }
  dropAvatar(id); H.poses.delete(id);
}
function peerState(id) {
  const st = H.pcs.get(id); if (!st) return 'none';
  const s = st.pc.connectionState || st.pc.iceConnectionState;
  return s === 'connected' || s === 'completed' ? 'ok' : s === 'failed' ? 'failed' : 'connecting';
}

/* ---------------- Watching together ---------------- */
// The host says what they're watching; everyone else follows (with their own broadcast delay for live).
function currentWatch() {
  if (App.source === 'live') return { src: 'live' };
  const R = KB.Replay;
  if (App.source === 'replay' && R.sk && R.sess) {
    const s = R.sess;
    return { src: 'replay', sess: { session_key: s.session_key, session_type: s.session_type, session_name: s.session_name, circuit_short_name: s.circuit_short_name, location: s.location, circuit_key: s.circuit_key, date_start: s.date_start, date_end: s.date_end },
      t: R.t, playing: !!R.playing, speed: R.speed || 1, at: Date.now() };
  }
  return null;
}
function publishWatch(force) {
  if (!isHost()) return;
  const w = currentWatch(); if (!w) return;
  const sig = w.src + (w.sess ? w.sess.session_key + ':' + w.playing + ':' + w.speed : '');
  const now = performance.now();
  if (!force && sig === H.watchSig && now - H.lastWatch < 2000) return;
  H.watchSig = sig; H.lastWatch = now;
  send({ t: 'watch', w });
}
async function applyWatch(w) {
  H.watch = w; UI.render();
  if (!me.follow || isHost() || !w) return;
  if (w.src === 'live') {
    if (App.source !== 'live' && !H.followBusy) { H.followBusy = true; KB.showSource('live'); KB.Live.connect(); H.followBusy = false; toast('Following the host: live timing.', 4000); }
    return;
  }
  const R = KB.Replay;
  if (w.src === 'replay' && w.sess) {
    if (R.sk !== w.sess.session_key) {
      if (H.followBusy) return;
      H.followBusy = true; KB.showSource('replay');
      toast('Following the host: ' + (w.sess.circuit_short_name || w.sess.location) + ', ' + w.sess.session_name + '.', 5000);
      try { await R.load(w.sess); } finally { H.followBusy = false; }
      if (H.watch) applyWatch(H.watch);
      return;
    }
    if (!R.start) return;
    const target = w.t + (w.playing ? (Date.now() - w.at) * w.speed : 0);
    if (Math.abs(R.t - target) > 2500) R.seek(target);
    R.speed = w.speed; R.playing = w.playing;
    const tp = $('#tPlay'); if (tp) tp.textContent = R.playing ? 'Pause' : 'Play';
    const ts = $('#tSpeed'); if (ts) ts.value = R.speed;
  }
}

function publishEnv(env) { if (isHost()) send({ t: 'env', env, look: App.garageLook || 'team' }); }

/* ---------------- Avatars ---------------- */
// Positions are shared relative to each person's table (metres from its centre, turned with it),
// so everyone appears around your table wherever you placed it.
// Race-driver avatars: helmet with a dark visor and a stripe in the person's colour, a suit in their colour
// with white side stripes, collar, chest panel, cuffs and boot tops. No logos or badges.
const AG = (() => {
  const S = (r, ws, hs, ...a) => new THREE.SphereGeometry(r, ws, hs, ...a);
  const C = (rt, rb, h, seg) => new THREE.CylinderGeometry(rt, rb, h, seg || 14);
  const unit = g => { g.translate(0, 0.5, 0); return g; }; // limbs run from y = 0 to y = 1, then get stretched
  const front = 1.5 * Math.PI; // the avatar faces -z
  return {
    helmet: S(0.135, 22, 16),
    visor: S(0.139, 20, 6, front - 0.95, 1.9, 1.12, 0.42),
    stripeTop: S(0.138, 4, 10, Math.PI / 2 - 0.16, 0.32, 0.05, 1.5),
    stripeFront: S(0.138, 4, 8, front - 0.16, 0.32, 0.12, 0.95),
    chin: S(0.137, 16, 4, front - 1.0, 2.0, 1.55, 0.5),
    collar: C(0.07, 0.08, 0.07),
    torso: C(0.165, 0.14, 0.42, 18),
    chest: new THREE.BoxGeometry(0.17, 0.11, 0.02),
    sideStripe: new THREE.BoxGeometry(0.03, 0.39, 0.07),
    hips: C(0.14, 0.15, 0.15, 16),
    upper: unit(C(0.05, 0.056, 1, 12)),
    fore: unit(C(0.043, 0.05, 1, 12)),
    thigh: unit(C(0.062, 0.078, 1, 12)),
    shin: unit(C(0.05, 0.062, 1, 12)),
    legStripe: unit(new THREE.BoxGeometry(0.022, 1, 0.045)),
    glove: S(0.05, 12, 10),
    cuff: C(0.052, 0.052, 0.035, 12),
    boot: new THREE.BoxGeometry(0.105, 0.1, 0.26),
    bootTop: new THREE.BoxGeometry(0.11, 0.035, 0.12),
    ring: new THREE.TorusGeometry(0.19, 0.012, 8, 32)
  };
})();
const visorMat = KBMat({ color: 0x15191c }, 'glass');
const whiteMat = KBMat({ color: 0xf2f2ee }, 'paint');
function nameSprite(name, color, muted) {
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 128; const x = cv.getContext('2d');
  x.font = '700 64px "Barlow Condensed", sans-serif';
  const w = Math.min(500, x.measureText(name).width + (muted ? 120 : 64));
  x.fillStyle = 'rgba(32,38,43,0.9)'; KB.rr(x, (512 - w) / 2, 12, w, 104, 22); x.fill();
  x.fillStyle = color; x.fillRect((512 - w) / 2 + 14, 34, 10, 60);
  x.fillStyle = '#E9E6DF'; x.textBaseline = 'middle'; x.fillText(name, (512 - w) / 2 + 40, 66);
  if (muted) { x.fillStyle = '#D2342B'; x.font = '700 44px "Barlow", sans-serif'; x.fillText('✕', (512 + w) / 2 - 56, 66); }
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthWrite: false }));
  sp.scale.set(0.4, 0.1, 1); return sp;
}
function getAvatar(id) {
  let a = H.avatars.get(id);
  const peer = H.peers.find(p => p.id === id) || {};
  const key = (peer.name || '') + '|' + (peer.color || '') + '|' + !!peer.muted;
  if (a && a.key === key) return a;
  if (a) dropAvatar(id);
  const suit = KBMat({ color: new THREE.Color(peer.color || '#9aa5ab') }, 'satin');
  const M = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); if (x !== undefined) m.position.set(x, y, z); return m; };
  const g = new THREE.Group();
  // head: helmet, visor, stripe over the top
  const head = new THREE.Group();
  head.add(M(AG.helmet, whiteMat), M(AG.visor, visorMat), M(AG.stripeTop, suit), M(AG.stripeFront, suit), M(AG.chin, suit));
  const ring = M(AG.ring, new THREE.MeshBasicMaterial({ color: 0xE9E6DF, transparent: true, opacity: 0 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.02; head.add(ring);
  // torso, built facing -z: suit, white collar, chest panel and side stripes
  const torso = new THREE.Group();
  const tb = M(AG.torso, suit, 0, -0.21, 0); tb.scale.z = 0.72; torso.add(tb);
  torso.add(M(AG.collar, whiteMat, 0, 0.025, 0), M(AG.chest, whiteMat, 0, -0.09, -0.118));
  for (const sx of [-1, 1]) torso.add(M(AG.sideStripe, whiteMat, sx * 0.15, -0.22, 0));
  const hp = M(AG.hips, suit, 0, -0.47, 0); hp.scale.z = 0.75; torso.add(hp);
  // limbs: suit colour, white stripe down the outside of each leg, white cuffs and boot tops
  const limb = (geo) => M(geo, suit);
  const L = {}, R = {};
  for (const [side, o] of [[-1, L], [1, R]]) {
    o.upper = limb(AG.upper); o.fore = limb(AG.fore);
    o.glove = new THREE.Group(); const gl = M(AG.glove, suit); gl.scale.set(1, 1.35, 0.75); o.glove.add(gl, M(AG.cuff, whiteMat, 0, -0.05, 0)); // cuff on the wrist side
    o.thigh = limb(AG.thigh); o.shin = limb(AG.shin);
    o.thigh.add(M(AG.legStripe, whiteMat, 0.068, 0, 0)); o.shin.add(M(AG.legStripe, whiteMat, 0.056, 0, 0));
    o.boot = new THREE.Group(); o.boot.add(M(AG.boot, suit, 0, 0.05, -0.04), M(AG.bootTop, whiteMat, 0, 0.11, 0.02));
    o.side = side; o.hand = null; o.foot = null;
    g.add(o.upper, o.fore, o.glove, o.thigh, o.shin, o.boot);
  }
  const label = nameSprite(peer.name || 'Friend', peer.color || '#9aa5ab', !!peer.muted);
  g.add(head, torso, label);
  KB.scene.add(g);
  a = { g, head, torso, L, R, ring, label, key, cur: null };
  H.avatars.set(id, a);
  return a;
}
function dropAvatar(id) {
  const a = H.avatars.get(id); if (!a) return;
  KB.scene.remove(a.g); H.avatars.delete(id);
}
function tableFrame() { // where the table is in this room, and which way it faces
  if (renderer.xr.isPresenting) return App.placed ? { pos: App.anchor.clone(), yaw: App.tableYaw } : null;
  return { pos: new THREE.Vector3(0, 0, 0), yaw: App.tableYaw };
}
const rotY = (x, z, a) => [x * Math.cos(a) + z * Math.sin(a), -x * Math.sin(a) + z * Math.cos(a)];
function toLocal(T, v) { const [x, z] = rotY(v.x - T.pos.x, v.z - T.pos.z, -T.yaw); return [+x.toFixed(3), +(v.y - T.pos.y).toFixed(3), +z.toFixed(3)]; }
function toWorld(T, l, out) { const [x, z] = rotY(l[0], l[2], T.yaw); return out.set(T.pos.x + x, T.pos.y + l[1], T.pos.z + z); }
function seatFor(id) { // seats around the table for people on an iPad or phone
  const a = id * 2.399963 + 0.6;
  return { h: [Math.sin(a) * 0.95, 0.42, Math.cos(a) * 0.95], f: [-Math.sin(a), -0.25, -Math.cos(a)] };
}
const gripPos = { left: null, right: null };
function sendPose(frame) {
  const now = performance.now(), xr = renderer.xr.isPresenting;
  if (now - H.lastPose < (xr ? 90 : 2000)) return; H.lastPose = now; // screens only need to say "I'm seated"
  const T = tableFrame();
  if (!T || !xr) { send({ t: 'pose', p: { xr: false } }); return; }
  const cam = renderer.xr.getCamera(KB.camera);
  const head = new THREE.Vector3().setFromMatrixPosition(cam.matrixWorld);
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion().setFromRotationMatrix(cam.matrixWorld));
  const [fx, fz] = rotY(fwd.x, fwd.z, -T.yaw);
  const p = { xr: true, h: toLocal(T, head), f: [+fx.toFixed(3), +fwd.y.toFixed(3), +fz.toFixed(3)] };
  const session = renderer.xr.getSession(), ref = renderer.xr.getReferenceSpace();
  if (session && frame && ref) {
    for (const src of session.inputSources) {
      const side = src.handedness; if (side !== 'left' && side !== 'right') continue;
      let pose = null;
      if (src.hand && frame.getJointPose) { const j = src.hand.get('wrist'); pose = j && frame.getJointPose(j, ref); }
      else if (src.gripSpace) pose = frame.getPose(src.gripSpace, ref);
      if (pose) { const q = pose.transform.position; p[side === 'left' ? 'l' : 'r'] = toLocal(T, q); }
    }
  }
  send({ t: 'pose', p });
}
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3();
// Two-bone reach (shoulder to hand, hip to foot): returns the elbow or knee, bent towards "pole".
const _d = new THREE.Vector3(), _p = new THREE.Vector3();
function reach(A, T, l1, l2, pole, joint, end) {
  _d.copy(T).sub(A); let d = _d.length() || 1e-4; _d.multiplyScalar(1 / d);
  d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(l1 + l2 - 1e-3, d));
  const a = (l1 * l1 + d * d - l2 * l2) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
  _p.copy(pole).addScaledVector(_d, -pole.dot(_d)); if (_p.lengthSq() < 1e-6) _p.set(0, -1, 0); _p.normalize();
  joint.copy(A).addScaledVector(_d, a).addScaledVector(_p, h);
  end.copy(A).addScaledVector(_d, d);
}
// Point a unit limb from A to B, keeping its outside face (for the leg stripe) towards "out".
const _m = new THREE.Matrix4(), _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3();
function setLimb(mesh, A, B, out) {
  _y.copy(B).sub(A); const len = _y.length() || 1e-4; _y.multiplyScalar(1 / len);
  _x.copy(out).addScaledVector(_y, -out.dot(_y)); if (_x.lengthSq() < 1e-6) _x.set(1, 0, 0); _x.normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z); mesh.quaternion.setFromRotationMatrix(_m);
  mesh.position.copy(A); mesh.scale.set(1, len, 1);
}
const V = () => new THREE.Vector3();
const P = { fwd: V(), right: V(), neck: V(), sh: V(), hip: V(), el: V(), hand: V(), kn: V(), foot: V(), tgt: V(), pole: V(), out: V(), down: new THREE.Vector3(0, -1, 0) };
function poseBody(a, d, T, fx, fz, dt) {
  const floorY = renderer.xr.isPresenting ? 0 : -0.78; // the real floor in the headset; under the table on screens
  P.fwd.set(fx, 0, fz); if (P.fwd.lengthSq() < 1e-6) P.fwd.set(0, 0, -1); P.fwd.normalize();
  P.right.set(-P.fwd.z, 0, P.fwd.x);
  const yaw = Math.atan2(-P.fwd.x, -P.fwd.z);
  P.neck.copy(a.cur).addScaledVector(P.fwd, -0.03); P.neck.y -= 0.15;
  a.torso.position.copy(P.neck); a.torso.rotation.set(0, yaw, 0);
  P.hip.copy(P.neck); P.hip.y -= 0.48;
  for (const o of [a.L, a.R]) {
    const sd = o.side;
    // arm: shoulder to the tracked hand, or resting in front at table height
    P.sh.copy(P.neck).addScaledVector(P.right, sd * 0.2); P.sh.y -= 0.06;
    const loc = d && (sd < 0 ? d.l : d.r);
    if (loc) toWorld(T, loc, P.tgt);
    else { P.tgt.copy(P.sh).addScaledVector(P.fwd, 0.32).addScaledVector(P.right, -sd * 0.08); P.tgt.y = T.pos.y + 0.05; } // resting on the table edge
    if (!o.hand) o.hand = P.tgt.clone(); else o.hand.lerp(P.tgt, Math.min(1, dt * 14));
    P.pole.copy(P.down).addScaledVector(P.right, sd * 0.7).addScaledVector(P.fwd, -0.3);
    reach(P.sh, o.hand, 0.29, 0.27, P.pole, P.el, P.hand);
    P.out.copy(P.right).multiplyScalar(sd);
    setLimb(o.upper, P.sh, P.el, P.out); setLimb(o.fore, P.el, P.hand, P.out);
    o.glove.position.copy(P.hand); o.glove.quaternion.copy(o.fore.quaternion); o.glove.translateY(0.03);
    // leg: stands straight when the hips are high enough, otherwise sits with knees forward
    const hipJ = P.tgt.copy(P.hip).addScaledVector(P.right, sd * 0.09); hipJ.y -= 0.04;
    const LEG = 0.84, hipH = hipJ.y - floorY - 0.07, k = Math.sqrt(Math.max(0, LEG * LEG - Math.min(LEG * LEG, hipH * hipH))) * 0.9;
    const foot = tv2.copy(hipJ).addScaledVector(P.fwd, k).addScaledVector(P.right, sd * 0.03); foot.y = floorY + 0.07;
    if (!o.foot) o.foot = foot.clone(); else o.foot.lerp(foot, Math.min(1, dt * 10));
    reach(hipJ, o.foot, 0.42, 0.42, P.fwd, P.kn, P.foot);
    setLimb(o.thigh, hipJ, P.kn, P.out); setLimb(o.shin, P.kn, P.foot, P.out);
    o.boot.position.set(P.foot.x, P.foot.y - 0.07, P.foot.z); o.boot.rotation.set(0, yaw, 0);
  }
}
function updateAvatars(dt) {
  const T = tableFrame(), driving = window.KBDrive && KBDrive.active;
  const show = T && App.view === 'tabletop' && !driving && App.track;
  for (const p of H.peers) {
    if (p.id === H.id) continue;
    const a = getAvatar(p.id); a.g.visible = !!show;
    if (!show) continue;
    const ps = H.poses.get(p.id), d = ps && ps.p && ps.p.xr ? ps.p : null;
    const seat = seatFor(p.id);
    const hLoc = d ? d.h : seat.h, fLoc = d ? d.f : seat.f;
    toWorld(T, hLoc, tv);
    if (!a.cur) a.cur = tv.clone(); else a.cur.lerp(tv, Math.min(1, dt * 12));
    const [fx, fz] = rotY(fLoc[0], fLoc[2], T.yaw);
    a.head.position.copy(a.cur);
    a.head.rotation.set(Math.asin(Math.max(-0.9, Math.min(0.9, fLoc[1] || 0))) * 0.8, Math.atan2(-fx, -fz), 0, 'YXZ');
    poseBody(a, d, T, fx, fz, dt);
    a.label.position.set(a.cur.x, a.cur.y + 0.26, a.cur.z);
    const au = H.audio.get(p.id), lvl = au && !p.muted ? au.level() : 0;
    a.ring.material.opacity = Math.min(0.9, lvl * 1.6);
    a.ring.scale.setScalar(1 + lvl * 0.35);
  }
}

/* ---------------- Headset panel ---------------- */
const PW = 640, PH = 360;
const pc = document.createElement('canvas'); pc.width = PW; pc.height = PH;
const ptex = new THREE.CanvasTexture(pc);
const panel = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.38 * PH / PW), new THREE.MeshBasicMaterial({ map: ptex, transparent: true }));
panel.visible = false; KB.scene.add(panel);
let pHits = [], pHover = null;
function drawXrPanel() {
  if (!panel.visible && !(renderer.xr.isPresenting && H.joined)) return;
  const c = pc.getContext('2d'), hits = [];
  c.clearRect(0, 0, PW, PH);
  KB.rr(c, 0, 0, PW, PH, 22); c.fillStyle = 'rgba(32,38,43,0.95)'; c.fill();
  c.fillStyle = '#E9E6DF'; c.font = '700 40px "Barlow Condensed", sans-serif'; c.textBaseline = 'alphabetic';
  c.fillText('Room ' + H.code, 24, 52);
  c.font = '500 22px Barlow, sans-serif'; c.fillStyle = '#94A1A8';
  c.fillText(isHost() ? 'You’re the host' : (me.follow ? 'Following the host' : 'Watching on your own'), 220, 48);
  H.peers.slice(0, 6).forEach((p, i) => {
    const y = 78 + i * 34, mine = p.id === H.id;
    c.fillStyle = p.color; c.fillRect(24, y + 4, 8, 24);
    c.fillStyle = '#E9E6DF'; c.font = '600 26px "Barlow Condensed"';
    c.fillText(p.name + (mine ? ' (you)' : '') + (p.id === H.host ? ' · host' : ''), 42, y + 26);
    const muted = mine ? (H.muted || !H.mic) : p.muted;
    const lvl = mine ? (H.micLevel && !H.muted ? H.micLevel() : 0) : (H.audio.get(p.id) ? H.audio.get(p.id).level() : 0);
    c.fillStyle = muted ? '#D2342B' : lvl > 0.12 ? '#4F7D45' : '#3A454C';
    c.beginPath(); c.arc(300, y + 17, 9, 0, Math.PI * 2); c.fill();
    if (!mine && peerState(p.id) !== 'ok') { c.fillStyle = '#F2B233'; c.font = '500 18px Barlow'; c.fillText(peerState(p.id) === 'failed' ? 'no voice link' : 'connecting', 318, y + 24); }
  });
  const btn = (x, y, w, label, on, fn) => {
    const hv = pHover && pHover.x >= x && pHover.x <= x + w && pHover.y >= y && pHover.y <= y + 56;
    KB.rr(c, x, y, w, 56, 12); c.fillStyle = on ? '#D2342B' : hv ? '#46525A' : '#2F383E'; c.fill();
    c.fillStyle = '#E9E6DF'; c.font = '600 26px "Barlow Condensed"'; c.textAlign = 'center'; c.fillText(label, x + w / 2, y + 37); c.textAlign = 'left';
    hits.push({ x, y, w, h: 56, fn });
  };
  btn(400, 74, 216, H.muted ? 'Unmute' : 'Mute', H.muted, () => setMuted(!H.muted));
  if (!isHost()) btn(400, 140, 216, me.follow ? 'Following' : 'Follow host', me.follow, () => { me.follow = !me.follow; saveMe(); if (me.follow && H.watch) applyWatch(H.watch); });
  btn(400, 206, 216, 'Leave room', false, () => leave());
  c.font = '400 18px Barlow'; c.fillStyle = '#94A1A8';
  c.fillText('X button: mute or unmute', 24, PH - 18);
  pHits = hits; ptex.needsUpdate = true;
}
function placePanel() {
  const ui = KB.uiMesh;
  panel.position.copy(ui.position); panel.quaternion.copy(ui.quaternion);
  // sits just under the menu, whatever the menu's height: overlapping it hides and blocks its bottom buttons
  const uiH = (ui.geometry.parameters && ui.geometry.parameters.height) || 0.7, pH = 0.38 * PH / PW;
  panel.translateY(-(uiH / 2 + pH / 2 + 0.015)); panel.translateZ(0.01);
}
const ray = new THREE.Raycaster(), rm = new THREE.Matrix4();
function pointerHit(ctl) {
  rm.identity().extractRotation(ctl.matrixWorld);
  ray.ray.origin.setFromMatrixPosition(ctl.matrixWorld); ray.ray.direction.set(0, 0, -1).applyMatrix4(rm);
  const hit = ray.intersectObject(panel, false)[0];
  return hit && hit.uv ? { x: hit.uv.x * PW, y: (1 - hit.uv.y) * PH, d: hit.distance } : null;
}
function onSelect(e) {
  if (!panel.visible) return false;
  const h = pointerHit(e.target); if (!h) return false;
  const b = pHits.find(b => h.x >= b.x && h.x <= b.x + b.w && h.y >= b.y && h.y <= b.y + b.h);
  if (b) { b.fn(); drawXrPanel(); }
  return true;
}

/* ---------------- Page UI ---------------- */
const UI = {
  built: false,
  build() {
    if (this.built) return; this.built = true;
    const css = document.createElement('style');
    css.textContent = `
#hang { position: fixed; left: calc(12px + env(safe-area-inset-left, 0px)); bottom: calc(76px + env(safe-area-inset-bottom, 0px)); z-index: 7; width: min(300px, calc(100% - 24px)); background: rgba(32,38,43,.95); border: 1px solid var(--tarmac-3); border-radius: 10px; padding: 12px; font: 400 14px/1.4 var(--body); color: var(--chalk); }
#hang[hidden] { display: none; }
#hang h3 { margin: 0 0 6px; font: 600 19px/1.1 var(--cond); display: flex; justify-content: space-between; align-items: center; }
#hang h3 button { border: 0; background: none; color: var(--muted); font: 600 15px/1 var(--cond); cursor: pointer; padding: 4px; }
#hang .code { font: 700 34px/1 var(--cond); letter-spacing: .1em; }
#hang .sub { color: var(--muted); font-size: 13px; margin: 4px 0; }
#hang input[type=text] { width: 100%; background: var(--tarmac-2); border: 1px solid var(--tarmac-3); border-radius: 6px; padding: 8px; color: var(--chalk); font: inherit; font-size: 15px; }
#hang .row { display: flex; gap: 6px; margin-top: 8px; }
#hang .row > * { flex: 1; }
#hang button.b { border: 1px solid var(--tarmac-3); background: var(--tarmac-2); color: var(--chalk); border-radius: 7px; padding: 9px 6px; font: 600 16px/1 var(--cond); cursor: pointer; }
#hang button.b.on { background: var(--kerb); border-color: var(--kerb); }
#hang ul { list-style: none; margin: 8px 0; padding: 0; }
#hang li { display: grid; grid-template-columns: 6px 1fr auto; gap: 8px; align-items: center; padding: 3px 0; }
#hang li .sw { height: 18px; border-radius: 2px; }
#hang li .st { font-size: 12px; color: var(--muted); }
#hang li .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: var(--tarmac-3); margin-left: 6px; vertical-align: middle; }
#hang li .dot.talk { background: #4F7D45; } #hang li .dot.mute { background: var(--kerb); }
#hang .sw2 { display: flex; gap: 5px; flex-wrap: wrap; margin-top: 6px; }
#hang .sw2 button { width: 26px; height: 26px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; }
#hang .sw2 button.on { border-color: var(--chalk); }
#hang .chk { display: flex; gap: 6px; align-items: center; font-size: 14px; margin-top: 6px; }
#hang .warn { color: var(--flag); font-size: 13px; margin: 6px 0; }
@media (min-width: 761px) { body.dock-open #hang { left: calc(314px + env(safe-area-inset-left, 0px)); } } /* beside the menu, not over it */
@media (max-width: 760px) { #hang { bottom: calc(130px + env(safe-area-inset-bottom, 0px)); } }
`;
    document.head.appendChild(css);
    const el = document.createElement('div'); el.id = 'hang'; el.hidden = true; document.body.appendChild(el);
    el.addEventListener('click', e => { const b = e.target.closest('[data-act]'); if (b) this.act(b.dataset.act, b); });
  },
  show(v) { this.build(); $('#hang').hidden = !v; if (v) this.render(); },
  render(note) {
    if (!this.built) return;
    if (note !== undefined) this.note = note;
    const el = $('#hang'); if (el.hidden) return;
    let h = `<h3>Watch with friends <button data-act="close" aria-label="Close">Close</button></h3>`;
    if (!H.joined) {
      h += `<label class="sub">Your name<input type="text" id="hName" maxlength="16" value="${myName() === 'Friend' && !me.name ? '' : myName().replace(/"/g, '')}" placeholder="Shown above your avatar"></label>`;
      h += `<div class="sw2">${COLORS.map(c => `<button data-act="color" data-c="${c}" style="background:${c}" class="${me.color === c ? 'on' : ''}" aria-label="Colour"></button>`).join('')}</div>`;
      h += `<div class="row"><button class="b on" data-act="create">Start a room</button></div>`;
      h += `<div class="row"><input type="text" id="hCode" maxlength="4" placeholder="Code" style="text-transform:uppercase" value="${H.pending || ''}"><button class="b" data-act="join">Join</button></div>`;
      h += `<p class="sub">Join before entering the headset: the microphone prompt can’t appear inside it. Use headphones so your TV doesn’t echo.</p>`;
    } else {
      h += `<div class="code">${H.code || '····'}</div>`;
      h += `<p class="sub">${this.note || (isHost() ? 'You’re the host. Friends follow what you watch.' : me.follow ? 'Following the host.' : 'Watching on your own.')}</p>`;
      if (H.micErr) h += `<p class="warn">${H.micErr}</p>`;
      if (H.needTap) h += `<div class="row"><button class="b on" data-act="sound">Tap to hear friends</button></div>`;
      if (H.ice && !H.ice.turn) h += `<p class="sub">Voice uses direct connections only, so it may not reach friends on some networks.</p>`;
      h += `<ul>${H.peers.map(p => {
        const mine = p.id === H.id, st = mine ? '' : peerState(p.id);
        const muted = mine ? (H.muted || !H.mic) : p.muted;
        return `<li><span class="sw" style="background:${p.color}"></span><span>${escapeHtml(p.name)}${mine ? ' (you)' : ''}${p.id === H.host ? ' · host' : ''}<span class="dot ${muted ? 'mute' : ''}" data-dot="${p.id}"></span></span><span class="st">${p.device === 'xr' ? 'headset' : 'screen'}${st === 'connecting' ? ' · connecting' : st === 'failed' ? ' · no voice' : ''}</span></li>`;
      }).join('')}</ul>`;
      h += `<div class="row"><button class="b ${H.muted ? 'on' : ''}" data-act="mute">${H.muted ? 'Unmute' : 'Mute'}</button><button class="b" data-act="invite">Invite</button><button class="b" data-act="leave">Leave</button></div>`;
      h += `<div class="row"><button class="b" data-act="poker">♠ Poker and race bets</button></div>`;
      if (!isHost()) h += `<label class="chk"><input type="checkbox" data-act="follow" ${me.follow ? 'checked' : ''}> Follow what the host watches</label>`;
    }
    h += `<p class="sub" style="margin-top:8px">Hangout build ${HANG_BUILD}</p>`;
    el.innerHTML = h;
    const nm = $('#hName'); if (nm) nm.onchange = () => { me.name = nm.value.trim(); saveMe(); };
  },
  async act(a, b) {
    if (a === 'close') this.show(false);
    else if (a === 'poker') { if (window.KBLoadPoker) KBLoadPoker().then(() => KBPoker.open()).catch(e => toast('Poker: ' + e.message + '.', 6000)); }
    else if (a === 'color') { me.color = b.dataset.c; saveMe(); this.render(); }
    else if (a === 'create') {
      const nm = $('#hName'); if (nm) { me.name = nm.value.trim(); saveMe(); }
      const A = 'ABCDEFGHJKMNPQRSTUVWXYZ'; let c = ''; for (let i = 0; i < 4; i++) c += A[Math.floor(Math.random() * A.length)];
      await join(c);
    } else if (a === 'join') {
      const nm = $('#hName'); if (nm) { me.name = nm.value.trim(); saveMe(); }
      await join(($('#hCode') || {}).value);
    } else if (a === 'mute') setMuted(!H.muted);
    else if (a === 'leave') leave();
    else if (a === 'sound') unlockAudio();
    else if (a === 'follow') { me.follow = b.checked; saveMe(); if (me.follow && H.watch) applyWatch(H.watch); this.render(); }
    else if (a === 'invite') {
      const link = inviteLink(); if (!link) return;
      try {
        if (navigator.share) { await navigator.share({ title: 'Kerbside', text: 'Watch the race with me in room ' + H.code, url: link }); return; }
        await navigator.clipboard.writeText(link); toast('Invite link copied. It includes your relay key.');
      } catch (e) { if (e && e.name !== 'AbortError') prompt('Copy this invite link:', link); }
    }
  },
  dots() { // update speaking dots without rebuilding the panel
    if (!this.built || $('#hang').hidden || !H.joined) return;
    for (const p of H.peers) {
      const d = document.querySelector(`[data-dot="${p.id}"]`); if (!d) continue;
      const mine = p.id === H.id, muted = mine ? (H.muted || !H.mic) : p.muted;
      const lvl = mine ? (H.micLevel && !H.muted ? H.micLevel() : 0) : (H.audio.get(p.id) ? H.audio.get(p.id).level() : 0);
      d.className = 'dot' + (muted ? ' mute' : lvl > 0.12 ? ' talk' : '');
    }
  }
};
const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

/* ---------------- Per-frame ---------------- */
let wasXR = false, uiT = 0, xBtn = false;
function frame(dt, xrFrame) {
  if (!H.joined) { panel.visible = false; for (const a of H.avatars.values()) a.g.visible = false; return; }
  const xr = renderer.xr.isPresenting;
  if (xr !== wasXR) { wasXR = xr; sendHello(); }
  sendPose(xrFrame);
  publishWatch(false);
  if (!isHost() && me.follow && H.watch && H.watch.src === 'replay' && performance.now() - (H.lastFollow || 0) > 3000) { H.lastFollow = performance.now(); applyWatch(H.watch); }
  updateAvatars(dt);
  const driving = window.KBDrive && KBDrive.active;
  panel.visible = xr && !driving && KB.uiMesh.visible;
  if (panel.visible) {
    placePanel();
    let hp = null;
    for (const ctl of KB.controllers) { const h = pointerHit(ctl); if (h) { hp = h; ctl.userData.line.scale.z = h.d; } }
    const k = hp ? pHits.findIndex(b => hp.x >= b.x && hp.x <= b.x + b.w && hp.y >= b.y && hp.y <= b.y + b.h) : -2;
    pHover = hp; if (k !== H.hoverK) { H.hoverK = k; drawXrPanel(); }
  }
  if (xr) { // X on the left controller mutes and unmutes, in any view (drive mode included)
    const session = renderer.xr.getSession(); let pressed = false;
    if (session) for (const src of session.inputSources) if (src.handedness === 'left' && src.gamepad && src.gamepad.buttons[4] && src.gamepad.buttons[4].pressed) pressed = true;
    if (pressed && !xBtn) { setMuted(!H.muted); toast(H.muted ? 'Microphone muted.' : 'Microphone on.', 2000); }
    xBtn = pressed;
  }
  const now = performance.now();
  if (now - uiT > 200) { uiT = now; UI.dots(); if (panel.visible) drawXrPanel(); }
}

/* ---------------- Public ---------------- */
function inviteLink() {
  const r = KB.relayInfo(); if (!r || !H.code) return null;
  const typed = (store.get('relayUrl', '') || '').replace(/\/+$/, '');
  return location.origin + location.pathname + '#key=' + encodeURIComponent(r.key) + '&hang=' + H.code + (typed && typed !== location.origin ? '&relay=' + encodeURIComponent(typed) : '');
}
// From the headset menu: open a room if you aren't in one, and copy the invite link. The share sheet
// can't open inside the headset view, so the room code is what friends need; the link is on the clipboard.
async function inviteFromHeadset() {
  if (!H.joined) {
    UI.build();
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; let code = ''; for (let i = 0; i < 4; i++) code += A[Math.floor(Math.random() * A.length)];
    await join(code); if (!H.joined) return;
  }
  let copied = false; const link = inviteLink();
  try { if (link) { await navigator.clipboard.writeText(link); copied = true; } } catch (e) {}
  toast(`Room ${H.code}. Friends choose Watch with friends and enter ${H.code}.` + (copied ? ' The invite link is copied: paste it in a message.' : ''), 12000);
}
const Hang = {
  open(prefill) { UI.build(); if (prefill) H.pending = String(prefill).toUpperCase(); UI.show(true); },
  join, leave, frame, onSelect, publishEnv, send, pid: () => pid, myId: () => H.id, invite: inviteFromHeadset, code: () => (H.joined ? H.code : ''), name: () => myName(),
  active() { return H.joined; },
  isHost,
  _H: H
};
window.KBHang = Hang;
})();
