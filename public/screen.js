/* The room screen: a cinema-sized screen on the garage's right wall that everyone in a room sees and hears.
   Anyone in the room can put something on it, three ways:
   - Share a tab (from a computer): the picture and sound of a browser tab go to everyone over the room's own
     voice connections (hang.js does the sending). Copy-protected sites (F1 TV, Netflix...) usually share as black.
   - Play a link: a direct video or live-stream address (.m3u8 or .mp4, not a web page). Everyone's app plays
     it itself, in step; if the site won't let other pages play it, it goes through the Worker (/vproxy).
   - Room browser: a cloud Chrome (Hyperbeam, started by the room on the Worker) streamed onto the screen. Point
     and pinch to click, scroll and back buttons under the screen, a floating keyboard with saved sites. One
     person browses at a time: whoever used it last in the past few seconds; anyone can take over after that.
     On a phone or computer, "Use the browser" opens it in a window with mouse and keyboard.
   The room remembers what's on, so friends who join later get it too. Each person's volume is their own. */
(function () {
  const { THREE, App, renderer, toast } = KB;
  const S = { s: null, key: '', video: null, tex: null, hls: null, proxied: false, streams: new Map(), err: '', vol: 0.8, mute: false, mesh: null, strip: null, hits: [], hover: -1, needTap: false,
    hb: null, hbTex: null, hbAudio: null, ctl: null, lastCtlSent: 0, kb: null, kbOpen: false, kbView: 'keys', field: '', shift: false, kbHits: [], kbHover: -1, ov: null, cursor: null, lastMove: 0 };
  try { const v = JSON.parse(localStorage.getItem('kerbside:screen') || '{}'); if (v.vol != null) S.vol = v.vol; S.mute = !!v.mute; } catch (e) {}
  const saveVol = () => { try { localStorage.setItem('kerbside:screen', JSON.stringify({ vol: S.vol, mute: S.mute })); } catch (e) {} };
  let sites = [{ name: 'Google', url: 'https://www.google.com' }, { name: 'YouTube', url: 'https://www.youtube.com' }, { name: 'Twitch', url: 'https://www.twitch.tv' }];
  try { const v = JSON.parse(localStorage.getItem('kerbside:sites') || 'null'); if (Array.isArray(v)) sites = v; } catch (e) {}
  const saveSites = () => { try { localStorage.setItem('kerbside:sites', JSON.stringify(sites)); } catch (e) {} };
  const SW = 4.4, SH = SW * 9 / 16; // metres
  const rr = KB.rr;
  const myId = () => window.KBHang && KBHang.myId();
  const browsing = () => !!(S.s && S.s.mode === 'browser');

  /* ---------------- the screen in the garage ---------------- */
  const idleCv = document.createElement('canvas'); idleCv.width = 1024; idleCv.height = 576;
  const idleTex = new THREE.CanvasTexture(idleCv);
  const scrMat = new THREE.MeshBasicMaterial({ map: idleTex, toneMapped: false });
  const stripCv = document.createElement('canvas'); stripCv.width = 1024; stripCv.height = 184;
  const stripTex = new THREE.CanvasTexture(stripCv);
  const kbCv = document.createElement('canvas'); kbCv.width = 1024; kbCv.height = 440;
  const kbTex = new THREE.CanvasTexture(kbCv);
  function drawIdle() {
    const c = idleCv.getContext('2d'), s = S.s;
    c.fillStyle = '#0d1114'; c.fillRect(0, 0, 1024, 576);
    for (let x = 0; x < 1024; x += 64) { c.fillStyle = (x / 64) % 2 ? '#E9E6DF' : '#D2342B'; c.fillRect(x, 0, 64, 10); }
    c.textAlign = 'center'; c.fillStyle = '#E9E6DF'; c.font = '700 60px "Barlow Condensed", sans-serif';
    const msg = S.err ? 'Can’t play that' : !s ? 'Room screen' : s.mode === 'share' ? `Waiting for ${s.name || 'a friend'}’s screen…` : s.mode === 'browser' ? (S.note || 'Starting the browser…') : 'Loading…';
    c.fillText(msg, 512, 250);
    c.fillStyle = '#94A1A8'; c.font = '500 30px Barlow, sans-serif';
    const lines = S.err ? wrapLines(c, S.err, 900) : !s ? ['Open browser under the screen, or share a tab or play a link', 'from Watch with friends. Everyone in the room sees it.'] : [];
    lines.forEach((l, i) => c.fillText(l, 512, 320 + i * 42));
    c.textAlign = 'left';
    idleTex.needsUpdate = true;
  }
  function wrapLines(c, text, w) { const out = []; let line = ''; for (const word of text.split(' ')) { const t = line ? line + ' ' + word : word; if (c.measureText(t).width > w && line) { out.push(line); line = word; } else line = t; } if (line) out.push(line); return out; }
  function button(c, hits, hover, x, y, w, h, label, fn, hot) {
    const i = hits.length; rr(c, x, y, w, h, 12); c.fillStyle = hover === i ? '#3a454c' : hot ? '#D2342B' : 'rgba(255,255,255,.08)'; c.fill();
    c.fillStyle = '#E9E6DF'; c.font = '600 28px "Barlow Condensed", sans-serif'; c.textAlign = 'center'; c.fillText(label, x + w / 2, y + h / 2 + 10, w - 14); c.textAlign = 'left';
    hits.push({ x, y, w, h, fn });
  }
  function drawStrip() {
    const c = stripCv.getContext('2d'); S.hits = []; const b = (x, y, w, label, fn, hot) => button(c, S.hits, S.hover, x, y, w, 72, label, fn, hot);
    c.clearRect(0, 0, 1024, 184); rr(c, 0, 0, 1024, 184, 18); c.fillStyle = 'rgba(20,24,27,.92)'; c.fill();
    if (browsing()) {
      b(12, 10, 150, '◀ Back', () => hbDo(h => h.tabs.goBack()));
      b(170, 10, 150, 'Forward ▶', () => hbDo(h => h.tabs.goForward()));
      b(328, 10, 140, '⟳ Reload', () => hbDo(h => h.tabs.reload()));
      b(476, 10, 140, '▲ Scroll', () => hbInput({ type: 'wheel', deltaY: -400 }));
      b(624, 10, 140, '▼ Scroll', () => hbInput({ type: 'wheel', deltaY: 400 }));
      b(772, 10, 240, S.kbOpen ? 'Hide keyboard' : '⌨ Keyboard / sites', () => { S.kbOpen = !S.kbOpen; drawStrip(); drawKb(); }, S.kbOpen);
    } else {
      b(12, 10, 300, '🌐 Open browser', openBrowser, true);
      b(324, 10, 300, 'Play copied link', playCopied);
      c.fillStyle = '#94A1A8'; c.font = '500 24px Barlow, sans-serif'; c.fillText('Or share a tab / play a link', 640, 40); c.fillText('from Watch with friends', 640, 70);
    }
    b(12, 100, 120, 'Vol −', () => setVol(S.vol - 0.15));
    c.fillStyle = '#94A1A8'; c.font = '600 26px "Barlow Condensed", sans-serif'; c.textAlign = 'center'; c.fillText(Math.round(S.vol * 100) + '%', 170, 146); c.textAlign = 'left';
    b(210, 100, 120, 'Vol +', () => setVol(S.vol + 0.15));
    b(344, 100, 180, S.mute || S.needTap ? 'Sound: off' : 'Sound: on', toggleSound, S.mute || S.needTap);
    if (S.s) b(860, 100, 152, 'Stop', stop);
    if (browsing()) { const who = busyOther() ? `${S.ctl.name || 'A friend'} is browsing` : 'Point at the screen, pinch to click'; c.fillStyle = '#94A1A8'; c.font = '500 24px Barlow, sans-serif'; c.fillText(who, 540, 146); }
    stripTex.needsUpdate = true;
  }
  const KEYS = [['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-'], ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p', '/'], ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', ':', '.'], ['⇧', 'z', 'x', 'c', 'v', 'b', 'n', 'm', '@', '?', '⌫']];
  function drawKb() {
    if (!S.kb) return;
    S.kb.visible = browsing() && S.kbOpen;
    const c = kbCv.getContext('2d'); S.kbHits = []; const b = (x, y, w, h, label, fn, hot) => button(c, S.kbHits, S.kbHover, x, y, w, h, label, fn, hot);
    c.clearRect(0, 0, 1024, 440); rr(c, 0, 0, 1024, 440, 18); c.fillStyle = 'rgba(20,24,27,.94)'; c.fill();
    rr(c, 12, 10, 1000, 56, 10); c.fillStyle = '#0d1114'; c.fill();
    c.fillStyle = S.field ? '#E9E6DF' : '#6E7A80'; c.font = '500 30px Barlow, sans-serif'; c.fillText((S.field || 'Type an address or a search…') + (S.field ? '▏' : ''), 26, 48);
    if (S.kbView === 'sites') {
      sites.slice(0, 8).forEach((st, i) => {
        const x = 12 + (i % 4) * 252, y = 78 + Math.floor(i / 4) * 84;
        b(x, y, 200, 72, st.name.slice(0, 16), () => go(st.url));
        b(x + 204, y, 44, 72, '✕', () => { sites.splice(i, 1); saveSites(); drawKb(); });
      });
      b(12, 260, 330, 72, '★ Save this page', savePage, true);
      b(354, 260, 330, 72, 'Back to keyboard', () => { S.kbView = 'keys'; drawKb(); });
      c.fillStyle = '#94A1A8'; c.font = '500 22px Barlow, sans-serif'; c.fillText('Saved sites are kept on this device.', 700, 304);
    } else {
      KEYS.forEach((row, r) => row.forEach((k, i) => {
        const label = S.shift && k.length === 1 && /[a-z]/.test(k) ? k.toUpperCase() : k;
        b(12 + i * 91, 74 + r * 74, 85, 66, label, () => key(k), k === '⇧' && S.shift);
      }));
      b(12, 370, 150, 64, 'Sites', () => { S.kbView = 'sites'; drawKb(); });
      b(170, 370, 330, 64, 'space', () => key(' '));
      b(508, 370, 110, 64, '.com', () => { S.field += '.com'; drawKb(); });
      b(626, 370, 200, 64, 'Type on page', typeOnPage);
      b(834, 370, 178, 64, 'Go', () => go(S.field), true);
    }
    kbTex.needsUpdate = true;
  }
  function attach() {
    const G = window.KBGarage && KBGarage.group && KBGarage.group(); if (!G || S.mesh) return;
    const g = new THREE.Group(); g.position.set(4.3, 3.0, 2.85); g.rotation.y = -Math.PI / 2; // right wall, above the tool chests and beside the car, facing into the garage
    const frame = new THREE.Mesh(new THREE.BoxGeometry(SW + 0.16, SH + 0.16, 0.06), KBMat({ color: 0x111417 }, 'plastic')); frame.position.z = -0.035; g.add(frame);
    S.mesh = new THREE.Mesh(new THREE.PlaneGeometry(SW, SH), scrMat); g.add(S.mesh);
    S.strip = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 2.4 * 184 / 1024), new THREE.MeshBasicMaterial({ map: stripTex, transparent: true, toneMapped: false }));
    S.strip.position.set(0, -SH / 2 - 0.25, 0.02); g.add(S.strip); // bottom edge about 1.3 m up: clear of the tool chests (1.05 m)
    // the keyboard stands out from the wall, in front of the tool chests, tilted up towards you
    S.kb = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.6 * 440 / 1024), new THREE.MeshBasicMaterial({ map: kbTex, transparent: true, toneMapped: false }));
    S.kb.position.set(0, -SH / 2 - 1.05, 0.95); S.kb.rotation.x = -0.6; S.kb.visible = false; g.add(S.kb); // out in front of the tool chests, below the controls
    S.cursor = new THREE.Mesh(new THREE.RingGeometry(0.012, 0.022, 20), new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, depthTest: false })); S.cursor.visible = false; S.cursor.renderOrder = 5; g.add(S.cursor);
    G.add(g); S.group = g; drawIdle(); drawStrip(); drawKb();
  }

  /* ---------------- links and shared tabs ---------------- */
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
    if (S.hb) { try { S.hb.destroy(); } catch (e) {} S.hb = null; }
    if (S.hbAudio) { S.hbAudio.srcObject = null; }
    closeOverlay(); S.kbOpen = false; if (S.cursor) S.cursor.visible = false;
    scrMat.map = idleTex; scrMat.needsUpdate = true;
  }
  function applySound() {
    const mine = S.s && S.s.mode === 'share' && S.s.by === myId();
    const here = App.env === 'garage' || !!S.ov;
    const vol = Math.max(0, Math.min(1, S.vol)), muted = S.mute || !here || S.needTap;
    if (S.video) { S.video.volume = vol; S.video.muted = muted || mine; } // your own shared tab already plays its sound
    if (S.hbAudio) { S.hbAudio.volume = vol; S.hbAudio.muted = muted; }
  }
  function play(el) {
    el = el || S.video; applySound();
    const p = el.play(); if (p && p.catch) p.catch(() => { S.needTap = true; applySound(); el.play().catch(() => {}); drawStrip(); toast('Room screen: pinch Sound to hear it.', 4000); });
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
    teardown(); S.err = 'That address isn’t a video or stream this player can open (it needs a direct .m3u8 or .mp4 link, not a web page). For web pages, use Open browser.'; drawIdle();
  }
  function startShare(s) {
    teardown(); S.err = ''; drawIdle();
    const mine = window.KBHang && s.by === myId();
    const stream = mine ? KBHang.shareStream() : S.streams.get(s.sid);
    if (!stream) return; // arrives with the friend's connection: remote() picks it up
    const v = videoEl(); v.srcObject = stream; play();
  }

  /* ---------------- the room browser (Hyperbeam) ---------------- */
  let hbMod = null;
  const hbLib = () => hbMod || (hbMod = import('https://unpkg.com/@hyperbeam/web@latest/dist/index.js').then(m => m.default || m.Hyperbeam));
  async function startBrowser(s) {
    teardown(); S.err = ''; drawIdle();
    let Hyperbeam; try { Hyperbeam = await hbLib(); } catch (e) { S.err = 'Couldn’t load the browser player. Check the internet connection and try again.'; drawIdle(); return; }
    if (S.s !== s) return; // something else went on while it loaded
    const div = S.hbDiv || (S.hbDiv = document.createElement('div'));
    div.style.cssText = 'position:fixed;left:-10000px;top:0;width:1280px;height:720px;'; if (!div.parentNode) document.body.appendChild(div);
    // A brand-new cloud browser takes a few seconds to boot, longer on a phone connection: the player's own
    // limit is 2 seconds, so give it 20, and try a few times before giving up.
    let last = null;
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (S.s !== s) return;
      if (attempt > 1) { S.err = ''; S.note = `Connecting to the room browser… (try ${attempt} of 4)`; drawIdle(); }
      // later tries keep the player's (invisible) frame on the page itself, in case a browser holds back frames placed far off-screen
      if (attempt >= 3) div.style.cssText = 'position:fixed;right:0;bottom:0;width:320px;height:180px;opacity:0.01;pointer-events:none;z-index:-1;overflow:hidden;';
      window.KBLog && KBLog(`room browser: connecting, try ${attempt}`);
      try {
        const hb = await Hyperbeam(div, s.embed, { adminToken: s.admin, delegateKeyboard: false, volume: S.vol, timeout: 20000, frameCb: onFrame, audioTrackCb: onAudio,
          onDisconnect: () => { if (S.hb === hb) { S.err = 'The room browser closed.'; drawIdle(); } } });
        if (S.s !== s) { hb.destroy(); return; }
        S.hb = hb; S.note = ''; drawStrip(); drawKb(); return;
      } catch (e) {
        last = e; window.KBLog && KBLog(`room browser: try ${attempt} failed: ${e && e.name} ${e && e.message}`);
        if (e && e.name === 'SessionTerminatedError') break; // it's gone: no point retrying
        await new Promise(r => setTimeout(r, 1500 * attempt));
      }
    }
    S.note = ''; S.failed = true; S.err = 'Couldn’t connect to the room browser (' + ((last && (last.name || last.message)) || last) + '). Press Stop, then Open browser to start a fresh one. To check the browser itself: Watch with friends, then Test the browser link.'; drawIdle();
    if (window.KBHang && KBHang.refresh) KBHang.refresh();
  }
  function onFrame(f) {
    if (!S.hbTex) S.hbTex = new THREE.Texture();
    const vid = typeof HTMLVideoElement !== 'undefined' && f instanceof HTMLVideoElement, T = S.hbTex;
    T.image = f; T.flipY = vid; // a decoded frame (Chrome, Quest) arrives top-down: flip it with the texture coordinates instead
    if (vid) { T.repeat.set(1, 1); T.offset.set(0, 0); } else { T.repeat.set(1, -1); T.offset.set(0, 1); }
    T.needsUpdate = true;
    if (scrMat.map !== T) { scrMat.map = T; scrMat.needsUpdate = true; }
    if (S.ov) { const c = S.ov.cv.getContext('2d'); try { c.drawImage(f, 0, 0, S.ov.cv.width, S.ov.cv.height); } catch (e) {} }
  }
  function onAudio(track) {
    if (!S.hbAudio) { S.hbAudio = document.createElement('audio'); S.hbAudio.autoplay = true; S.hbAudio.style.display = 'none'; document.body.appendChild(S.hbAudio); }
    S.hbAudio.srcObject = new MediaStream([track]); play(S.hbAudio);
  }
  function busyOther() { return !!(S.ctl && S.ctl.id !== myId() && performance.now() - S.ctl.at < 4000); }
  function claim() { // one person at a time: tell the room you're browsing
    if (busyOther()) { toast(`${S.ctl.name || 'A friend'} is browsing. You can take over when they stop for a few seconds.`, 3000); return false; }
    const now = performance.now(); if (now - S.lastCtlSent > 1500 && window.KBHang) { S.lastCtlSent = now; KBHang.send({ t: 'screen', a: 'ctl' }); }
    return true;
  }
  function hbInput(ev) { if (!S.hb || !claim()) return; try { S.hb.sendEvent(ev); } catch (e) {} }
  function hbDo(fn) { if (!S.hb || !claim()) return; Promise.resolve().then(() => fn(S.hb)).catch(e => toast('Browser: ' + (e.message || e), 4000)); }
  function go(text) {
    text = String(text || '').trim(); if (!text) return;
    const url = /^https?:\/\//i.test(text) ? text : /^[^\s]+\.[^\s]{2,}$/.test(text) ? 'https://' + text : 'https://www.google.com/search?q=' + encodeURIComponent(text);
    hbDo(h => h.tabs.update({ url })); S.field = ''; S.kbOpen = false; drawKb(); drawStrip();
  }
  function key(k) {
    if (k === '⇧') S.shift = !S.shift;
    else if (k === '⌫') S.field = S.field.slice(0, -1);
    else { S.field += S.shift && /[a-z]/.test(k) ? k.toUpperCase() : k; S.shift = false; }
    drawKb();
  }
  function typeOnPage() { // types the field into whatever box is selected on the page, then presses Enter
    const t = S.field; if (!S.hb || !claim()) return;
    for (const ch of t) { S.hb.sendEvent({ type: 'keydown', key: ch }); S.hb.sendEvent({ type: 'keyup', key: ch }); }
    S.hb.sendEvent({ type: 'keydown', key: 'Enter' }); S.hb.sendEvent({ type: 'keyup', key: 'Enter' });
    S.field = ''; drawKb();
  }
  async function savePage() {
    if (!S.hb) return;
    try {
      const tabs = await S.hb.tabs.query({ active: true }); const t = tabs && tabs[0];
      if (!t || !t.url) throw new Error('no page');
      const name = (t.title || new URL(t.url).hostname).replace(/\s+[-|–].*$/, '').slice(0, 16);
      sites = sites.filter(x => x.url !== t.url); sites.unshift({ name, url: t.url }); sites = sites.slice(0, 8); saveSites(); drawKb(); toast('Saved ' + name + '.', 2500);
    } catch (e) { toast('Couldn’t read the page address to save it.', 3000); }
  }
  function openBrowser() {
    if (!window.KBHang || !KBHang.active()) { toast('Start or join a room first (Play poker or Watch with friends): the screen is shared with everyone in it.', 5000); return; }
    if (KBHang.sharing()) KBHang.stopShare();
    sendScreen({ a: 'browser' }); toast('Starting the room browser…', 2500);
  }

  /* a window for using the browser with a mouse and keyboard, on a phone, tablet or computer */
  function openOverlay() {
    if (S.ov || !browsing()) return;
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;inset:0;z-index:15;background:rgba(10,12,14,.92);display:flex;flex-direction:column;padding:10px;gap:8px';
    d.innerHTML = `<div style="display:flex;gap:6px;align-items:center">
      <button class="ghost" data-a="back">◀</button><button class="ghost" data-a="fwd">▶</button><button class="ghost" data-a="reload">⟳</button>
      <input type="text" placeholder="Address or search" style="flex:1;min-width:0;background:#20262b;border:1px solid #3a454c;border-radius:6px;padding:8px;color:#E9E6DF;font:15px Barlow,sans-serif">
      <button class="primary" data-a="go">Go</button><button class="ghost" data-a="close">Close</button></div>
      <canvas width="1280" height="720" tabindex="0" style="flex:1;min-height:0;width:100%;object-fit:contain;background:#000;outline:none;touch-action:none"></canvas>
      <p style="margin:0;color:#94A1A8;font:13px Barlow,sans-serif">Everyone in the room sees this on the garage screen. Click the page to type into it.</p>`;
    document.body.appendChild(d);
    const cv = d.querySelector('canvas'), inp = d.querySelector('input');
    S.ov = { d, cv };
    const pos = e => { const r = cv.getBoundingClientRect(), a = cv.width / cv.height; let w = r.width, h = r.height, ox = 0, oy = 0; if (w / h > a) { w = h * a; ox = (r.width - w) / 2; } else { h = w / a; oy = (r.height - h) / 2; } return { x: Math.max(0, Math.min(1, (e.clientX - r.left - ox) / w)), y: Math.max(0, Math.min(1, (e.clientY - r.top - oy) / h)) }; };
    cv.addEventListener('pointermove', e => { const p = pos(e); if (S.hb && !busyOther()) try { S.hb.sendEvent({ type: 'mousemove', x: p.x, y: p.y }); } catch (er) {} });
    cv.addEventListener('pointerdown', e => { cv.focus(); const p = pos(e); hbInput({ type: 'mousedown', x: p.x, y: p.y, button: e.button }); });
    cv.addEventListener('pointerup', e => { const p = pos(e); hbInput({ type: 'mouseup', x: p.x, y: p.y, button: e.button }); });
    cv.addEventListener('wheel', e => { e.preventDefault(); hbInput({ type: 'wheel', deltaY: e.deltaY }); }, { passive: false });
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('keydown', e => { e.preventDefault(); hbInput({ type: 'keydown', key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey }); });
    cv.addEventListener('keyup', e => { e.preventDefault(); hbInput({ type: 'keyup', key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey }); });
    d.addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (!b) return; const a = b.dataset.a;
      if (a === 'back') hbDo(h => h.tabs.goBack()); else if (a === 'fwd') hbDo(h => h.tabs.goForward()); else if (a === 'reload') hbDo(h => h.tabs.reload());
      else if (a === 'go') { go(inp.value); inp.value = ''; } else if (a === 'close') closeOverlay(); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { go(inp.value); inp.value = ''; } });
    applySound();
  }
  function closeOverlay() { if (S.ov) { S.ov.d.remove(); S.ov = null; applySound(); } }

  /* ---------------- what's on ---------------- */
  function set(s) {
    const key = s ? s.mode + '|' + (s.url || s.sid || s.embed) + '|' + (s.mode === 'browser' ? '' : s.by) : '';
    if (key === S.key) { S.s = s; drawStrip(); return; }
    S.key = key; S.s = s; S.err = ''; S.ctl = null; S.failed = false;
    if (!s) { teardown(); drawIdle(); }
    else if (s.mode === 'link') startLink(s, false);
    else if (s.mode === 'share') startShare(s);
    else if (s.mode === 'browser') startBrowser(s);
    drawStrip(); drawKb();
  }
  function remote(peerId, stream) {
    S.streams.set(stream.id, stream);
    if (S.s && S.s.mode === 'share' && (S.s.sid === stream.id || S.s.by === peerId)) { S.s.sid = stream.id; startShare(S.s); }
  }
  function ctl(m) { S.ctl = { id: m.id, name: m.name, at: performance.now() }; drawStrip(); }

  /* ---------------- controls ---------------- */
  function setVol(v) { S.vol = Math.max(0, Math.min(1, Math.round(v * 20) / 20)); S.mute = false; S.needTap = false; saveVol(); applySound(); if (S.video && S.video.paused && S.s && S.s.mode !== 'browser') play(); drawStrip(); }
  function toggleSound() { if (S.needTap) { S.needTap = false; S.mute = false; } else S.mute = !S.mute; saveVol(); applySound(); for (const el of [S.video, S.hbAudio]) if (el && S.s) el.play().catch(() => {}); drawStrip(); }
  function sendScreen(m) { if (!window.KBHang || !KBHang.active()) { toast('Start or join a room first (Play poker or Watch with friends): the screen is shared with everyone in it.', 5000); return false; } KBHang.send(Object.assign({ t: 'screen' }, m)); return true; }
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

  /* ---------------- pointing in the headset ---------------- */
  const shown = () => !!(S.group && S.group.parent && S.group.parent.visible && App.env === 'garage');
  function hitOn(mesh, c) { if (!mesh || !mesh.visible || !shown()) return null; KB.rayFrom(c); const h = KB.raycaster.intersectObject(mesh, false)[0]; return h && h.uv ? h : null; }
  function pick(hits, W, H, h) { const x = h.uv.x * W, y = (1 - h.uv.y) * H; return hits.findIndex(b => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h); }
  function onSelect(e) {
    let h = hitOn(S.strip, e.target); if (h) { const i = pick(S.hits, 1024, 184, h); if (i >= 0) S.hits[i].fn(); return true; }
    h = hitOn(S.kb, e.target); if (h) { const i = pick(S.kbHits, 1024, 440, h); if (i >= 0) S.kbHits[i].fn(); return true; }
    if (browsing() && S.hb) { h = hitOn(S.mesh, e.target); if (h) { const x = h.uv.x, y = 1 - h.uv.y; hbInput({ type: 'mousemove', x, y }); hbInput({ type: 'mousedown', x, y, button: 0 }); hbInput({ type: 'mouseup', x, y, button: 0 }); return true; } }
    return false;
  }
  let lastSig = '', lastKbSig = '';
  function frame() {
    attach(); if (!S.mesh) return;
    applySound();
    let hv = -1, kv = -1, onScreen = null;
    if (renderer.xr.isPresenting) for (const c of KB.controllers) {
      let h = hitOn(S.strip, c); if (h) { hv = pick(S.hits, 1024, 184, h); break; }
      h = hitOn(S.kb, c); if (h) { kv = pick(S.kbHits, 1024, 440, h); break; }
      if (browsing()) { h = hitOn(S.mesh, c); if (h) { onScreen = h; break; } }
    }
    if (S.cursor) {
      S.cursor.visible = !!onScreen;
      if (onScreen) {
        S.cursor.position.set((onScreen.uv.x - 0.5) * SW, (onScreen.uv.y - 0.5) * SH, 0.01);
        const now = performance.now(); if (S.hb && !busyOther() && now - S.lastMove > 50) { S.lastMove = now; try { S.hb.sendEvent({ type: 'mousemove', x: onScreen.uv.x, y: 1 - onScreen.uv.y }); } catch (e) {} } // hovering shows menus and links without taking over
      }
    }
    const sig = hv + '|' + !!S.s + '|' + S.mute + '|' + S.needTap + '|' + busyOther();
    if (sig !== lastSig) { lastSig = sig; S.hover = hv; drawStrip(); }
    const ks = kv + '|' + S.kbOpen + '|' + browsing();
    if (ks !== lastKbSig) { lastKbSig = ks; S.kbHover = kv; drawKb(); }
  }
  // for checking a browser that won't connect: open the cloud browser's own page in a new tab
  function testLink() { if (browsing() && S.s.embed) window.open(S.s.embed, '_blank', 'noopener'); }
  window.KBScreen = { set, remote, ctl, frame, onSelect, playLink, share, stop, canShare, openBrowser, openOverlay, browsing, testLink, failed: () => !!S.failed, state: () => S.s,
    mesh: () => S.strip, meshes: () => [S.strip, S.kb, browsing() ? S.mesh : null].filter(m => m && m.visible), _S: S };
})();
