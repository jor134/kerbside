/* The room screen: a cinema-sized screen on the garage's right wall that everyone in a room sees and hears.
   Anyone in the room can put something on it, two ways:
   - Share a tab (from a computer): the picture and sound of a browser tab go to everyone over the room's own
     voice connections (hang.js does the sending). Copy-protected sites (F1 TV, Netflix...) usually share as black.
   - Play a link: a direct video or live-stream address (.m3u8 or .mp4, not a web page). Everyone's app plays
     it itself, in step; if the site won't let other pages play it, it goes through the Worker (/vproxy).
   The room remembers what's on, so friends who join later get it too. Under the screen: volume, sound on/off,
   play a link you've copied, and stop. Each person's volume is their own. */
(function () {
  const { THREE, App, renderer, toast } = KB;
  const S = { s: null, key: '', video: null, tex: null, hls: null, proxied: false, streams: new Map(), err: '', vol: 0.8, mute: false, mesh: null, strip: null, hits: [], hover: -1, needTap: false };
  try { const v = JSON.parse(localStorage.getItem('kerbside:screen') || '{}'); if (v.vol != null) S.vol = v.vol; S.mute = !!v.mute; } catch (e) {}
  const saveVol = () => { try { localStorage.setItem('kerbside:screen', JSON.stringify({ vol: S.vol, mute: S.mute })); } catch (e) {} };
  const SW = 4.4, SH = SW * 9 / 16; // metres
  const rr = KB.rr;

  /* ---------------- the screen in the garage ---------------- */
  const idleCv = document.createElement('canvas'); idleCv.width = 1024; idleCv.height = 576;
  const idleTex = new THREE.CanvasTexture(idleCv);
  const scrMat = new THREE.MeshBasicMaterial({ map: idleTex, toneMapped: false });
  const stripCv = document.createElement('canvas'); stripCv.width = 1024; stripCv.height = 96;
  const stripTex = new THREE.CanvasTexture(stripCv);
  function drawIdle() {
    const c = idleCv.getContext('2d'), s = S.s;
    c.fillStyle = '#0d1114'; c.fillRect(0, 0, 1024, 576);
    for (let x = 0; x < 1024; x += 64) { c.fillStyle = (x / 64) % 2 ? '#E9E6DF' : '#D2342B'; c.fillRect(x, 0, 64, 10); }
    c.textAlign = 'center'; c.fillStyle = '#E9E6DF'; c.font = '700 60px "Barlow Condensed", sans-serif';
    const msg = S.err ? 'Can’t play that' : !s ? 'Room screen' : s.mode === 'share' ? `Waiting for ${s.name || 'a friend'}’s screen…` : 'Loading…';
    c.fillText(msg, 512, 250);
    c.fillStyle = '#94A1A8'; c.font = '500 30px Barlow, sans-serif';
    const lines = S.err ? [S.err] : !s ? ['Share a browser tab from a computer, or play a stream link,', 'from Watch with friends on the menu. Everyone in the room sees it.'] : [];
    lines.forEach((l, i) => c.fillText(l, 512, 320 + i * 42));
    idleTex.needsUpdate = true;
  }
  function drawStrip() {
    const c = stripCv.getContext('2d'); S.hits = [];
    c.clearRect(0, 0, 1024, 96); rr(c, 0, 0, 1024, 96, 18); c.fillStyle = 'rgba(20,24,27,.92)'; c.fill();
    const on = !!S.s;
    const btn = (x, w, label, fn, hot) => {
      const i = S.hits.length; rr(c, x, 12, w, 72, 12); c.fillStyle = S.hover === i ? '#3a454c' : hot ? '#D2342B' : 'rgba(255,255,255,.08)'; c.fill();
      c.fillStyle = '#E9E6DF'; c.font = '600 30px "Barlow Condensed", sans-serif'; c.textAlign = 'center'; c.fillText(label, x + w / 2, 59); S.hits.push({ x, w, fn });
    };
    btn(14, 120, 'Vol −', () => setVol(S.vol - 0.15));
    c.fillStyle = '#94A1A8'; c.font = '600 26px "Barlow Condensed", sans-serif'; c.textAlign = 'center'; c.fillText(Math.round(S.vol * 100) + '%', 172, 58);
    btn(212, 120, 'Vol +', () => setVol(S.vol + 0.15));
    btn(346, 180, S.mute || S.needTap ? 'Sound: off' : 'Sound: on', toggleSound, S.mute || S.needTap);
    btn(540, 290, 'Play copied link', playCopied);
    if (on) btn(844, 166, 'Stop', stop, false);
    stripTex.needsUpdate = true;
  }
  function attach() {
    const G = window.KBGarage && KBGarage.group && KBGarage.group(); if (!G || S.mesh) return;
    const g = new THREE.Group(); g.position.set(4.3, 2.62, 2.85); g.rotation.y = -Math.PI / 2; // right wall, above the tool chests and beside the car, facing into the garage
    const frame = new THREE.Mesh(new THREE.BoxGeometry(SW + 0.16, SH + 0.16, 0.06), KBMat({ color: 0x111417 }, 'plastic')); frame.position.z = -0.035; g.add(frame);
    S.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), scrMat); g.add(S.mesh);
    S.strip = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4 * 96 / 1024), new THREE.MeshBasicMaterial({ map: stripTex, transparent: true, toneMapped: false }));
    S.strip.position.set(0, -SH / 2 - 0.2, 0.02); g.add(S.strip);
    G.add(g); S.group = g; drawIdle(); drawStrip();
  }

  /* ---------------- playing ---------------- */
  function videoEl() {
    if (S.video) return S.video;
    const v = document.createElement('video'); v.playsInline = true; v.setAttribute('playsinline', ''); v.crossOrigin = 'anonymous'; v.style.display = 'none';
    document.body.appendChild(v);
    v.addEventListener('playing', () => { S.err = ''; scrMat.map = S.tex; scrMat.needsUpdate = true; });
    v.addEventListener('error', () => onFail('video'));
    S.video = v; S.tex = new THREE.VideoTexture(v); return v;
  }
  function teardown() {
    if (S.hls) { try { S.hls.destroy(); } catch (e) {} S.hls = null; }
    const v = S.video; if (v) { v.pause(); v.srcObject = null; v.removeAttribute('src'); try { v.load(); } catch (e) {} }
    scrMat.map = idleTex; scrMat.needsUpdate = true;
  }
  function applySound() {
    const v = S.video; if (!v) return;
    const mine = S.s && S.s.mode === 'share' && S.s.by === (window.KBHang && KBHang.myId());
    const here = App.env === 'garage';
    v.volume = Math.max(0, Math.min(1, S.vol)); v.muted = S.mute || mine || !here || S.needTap; // your own shared tab already plays its sound
  }
  function play() {
    const v = S.video; applySound();
    const p = v.play(); if (p && p.catch) p.catch(() => { S.needTap = true; applySound(); v.play().catch(() => {}); drawStrip(); KB.toast && toast('Room screen: pinch Sound to hear it.', 4000); });
  }
  let loadHls = null;
  function hlsLib() {
    if (window.Hls) return Promise.resolve(window.Hls);
    if (!loadHls) loadHls = new Promise((ok, no) => { const sc = document.createElement('script'); sc.src = 'https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js'; sc.onload = () => ok(window.Hls); sc.onerror = () => no(new Error('couldn’t load the stream player')); document.head.appendChild(sc); });
    return loadHls;
  }
  function proxyUrl(u) { const r = KB.relayInfo && KB.relayInfo(); return r ? `${r.base}/vproxy?key=${encodeURIComponent(r.key)}&u=${encodeURIComponent(u)}` : null; }
  async function startLink(s, viaProxy) {
    const v = videoEl(); teardown(); S.proxied = !!viaProxy; S.err = ''; drawIdle();
    const url = viaProxy ? proxyUrl(s.url) : s.url; if (!url) return onFail('no relay');
    const t0 = performance.now(), pos = s.pos || 0;
    const seek = () => { if (isFinite(v.duration) && v.duration > 0) { const at = pos + (performance.now() - t0) / 1000; if (at < v.duration - 1) v.currentTime = at; } };
    v.addEventListener('loadedmetadata', seek, { once: true });
    if (/\.m3u8(\?|#|$)/i.test(s.url)) {
      let Hls = null; try { Hls = await hlsLib(); } catch (e) {}
      if (Hls && Hls.isSupported()) {
        const h = S.hls = new Hls({ liveSyncDurationCount: 3, enableWorker: true });
        h.on(Hls.Events.ERROR, (ev, d) => { if (d.fatal) onFail(d.type === 'networkError' ? 'network' : 'media'); });
        h.loadSource(url); h.attachMedia(v); h.on(Hls.Events.MANIFEST_PARSED, () => play()); return;
      }
    }
    v.src = url; play();
  }
  function onFail(why) {
    const s = S.s; if (!s || s.mode !== 'link') return;
    if (!S.proxied && proxyUrl(s.url)) { startLink(s, true); return; } // the site may not allow other pages to play it: go through the Worker
    teardown(); S.err = 'That address isn’t a video or stream this player can open (it needs a direct .m3u8 or .mp4 link, not a web page).'; drawIdle();
  }
  function startShare(s) {
    teardown(); S.err = ''; drawIdle();
    const mine = window.KBHang && s.by === KBHang.myId();
    const stream = mine ? KBHang.shareStream() : S.streams.get(s.sid);
    if (!stream) return; // arrives with the friend's connection: remote() picks it up
    const v = videoEl(); v.srcObject = stream; play();
  }
  function set(s) {
    const key = s ? s.mode + '|' + (s.url || s.sid) + '|' + s.by : '';
    if (key === S.key) { S.s = s; return; }
    S.key = key; S.s = s; S.err = '';
    if (!s) { teardown(); drawIdle(); }
    else if (s.mode === 'link') startLink(s, false);
    else if (s.mode === 'share') startShare(s);
    drawStrip();
  }
  function remote(peerId, stream) {
    S.streams.set(stream.id, stream);
    if (S.s && S.s.mode === 'share' && (S.s.sid === stream.id || S.s.by === peerId)) { S.s.sid = stream.id; startShare(S.s); }
  }

  /* ---------------- controls ---------------- */
  function setVol(v) { S.vol = Math.max(0, Math.min(1, Math.round(v * 20) / 20)); S.mute = false; S.needTap = false; saveVol(); applySound(); if (S.video && S.video.paused && S.s) play(); drawStrip(); }
  function toggleSound() { if (S.needTap) { S.needTap = false; S.mute = false; } else S.mute = !S.mute; saveVol(); applySound(); if (S.video && S.s) S.video.play().catch(() => {}); drawStrip(); }
  function sendScreen(m) { if (!window.KBHang || !KBHang.active()) { toast('Start or join a room first (Watch with friends): the screen is shared with everyone in it.', 5000); return false; } KBHang.send(Object.assign({ t: 'screen' }, m)); return true; }
  function playLink(u) {
    u = String(u || '').trim(); if (!u) return;
    if (!/^https?:\/\//i.test(u)) { toast('That doesn’t look like a web address (it should start with https://).', 5000); return; }
    if (window.KBHang && KBHang.sharing()) KBHang.stopShare();
    sendScreen({ a: 'link', url: u });
  }
  async function playCopied() {
    try { const t = await navigator.clipboard.readText(); if (t && /^https?:\/\//i.test(t.trim())) return playLink(t); toast('Copy a stream link first (in the browser, before entering the headset), then pinch Play copied link.', 6000); }
    catch (e) { toast('This browser didn’t let Kerbside read the clipboard. Use Play a link in Watch with friends instead.', 6000); }
  }
  function stop() { if (window.KBHang && KBHang.sharing()) KBHang.stopShare(); sendScreen({ a: 'stop' }); }
  async function share() {
    if (!window.KBHang || !KBHang.active()) { toast('Start or join a room first (Watch with friends).', 5000); return; }
    try { await KBHang.startShare(); } catch (e) { if (e && e.name !== 'NotAllowedError') toast('Couldn’t share: ' + (e.message || e), 6000); }
  }
  const canShare = () => !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia) && !renderer.xr.isPresenting && !/OculusBrowser|Quest/i.test(navigator.userAgent);

  /* ---------------- pointing at the controls in the headset ---------------- */
  function stripAt(c) {
    if (!S.strip || !S.group || !S.group.parent || !S.group.parent.visible || App.env !== 'garage') return null;
    KB.rayFrom(c); const h = KB.raycaster.intersectObject(S.strip, false)[0]; return h && h.uv ? h.uv.x * 1024 : null;
  }
  function onSelect(e) {
    const x = stripAt(e.target); if (x == null) return false;
    const b = S.hits.find(b => x >= b.x && x <= b.x + b.w); if (b) b.fn(); return true;
  }
  let lastSig = '';
  function frame() {
    attach(); if (!S.mesh) return;
    applySound();
    let hv = -1;
    if (renderer.xr.isPresenting) for (const c of KB.controllers) { const x = stripAt(c); if (x != null) { hv = S.hits.findIndex(b => x >= b.x && x <= b.x + b.w); break; } }
    const sig = hv + '|' + !!S.s + '|' + S.mute + '|' + S.needTap;
    if (sig !== lastSig) { lastSig = sig; S.hover = hv; drawStrip(); }
  }
  window.KBScreen = { set, remote, frame, onSelect, playLink, share, stop, canShare, state: () => S.s, mesh: () => S.strip, _S: S };
})();
