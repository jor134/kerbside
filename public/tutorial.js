/* Kerbside tutorial, for someone who has never used the app (or a headset) before.
   - First visit: a short card on the screen explains the headset basics, with Start and Skip.
   - In the headset: a floating card walks through the basics one step at a time. Each step waits until you've
     actually done the thing (pinched a button, moved a window, recentred, teleported, sat down, looked at your
     cards, played your turn), then moves on. Back, Skip step and End tutorial are always on the card.
   - Replay any time: Tutorial on the headset menu, or on the screen menu.
   Other parts of the app report what you did through window.KBTutEv('name'). */
(function () {
  const { THREE, App, renderer, scene, toast, rr } = KB;
  const KEY = 'kerbside:tutorial'; // 'pending' (start it in the headset), 'done' or 'skipped'
  const get = () => { try { return localStorage.getItem(KEY); } catch (e) { return null; } };
  const put = v => { try { localStorage.setItem(KEY, v); } catch (e) {} };
  const T = { on: false, i: 0, ev: new Map(), doneAt: 0, moved: false, startAt: 0, hover: -1, sig: '' };
  window.KBTutEv = name => { if (T.on) T.ev.set(name, (T.ev.get(name) || 0) + 1); };
  const n = name => T.ev.get(name) || 0;
  const usingHands = () => { const s = renderer.xr.getSession(); return !!(s && [...s.inputSources].some(x => x.hand)); };
  const usingPads = () => { const s = renderer.xr.getSession(); return !!(s && [...s.inputSources].some(x => !x.hand && x.gamepad)); };
  const seated = () => !!(window.KBPoker && KBPoker.seat && KBPoker.seat() >= 0);
  const inCasino = () => App.env === 'garage' && App.garageLook === 'casino';
  const pinch = () => (usingHands() ? 'pinch' : 'pull the trigger');

  /* ---------------- the steps ---------------- */
  // need(): true once the step is done (null: an information step, read it and pinch Next)
  // skip(): true if the step doesn't apply right now, so the tour passes over it
  const STEPS = [
    { title: 'Welcome to Kerbside', body: () => [
        'This short tour shows you how to get around in the headset and how to play poker, with practice bots or with friends.',
        usingHands() ? 'Hand tracking is on: point with your hand, and touch your thumb to your index finger (a pinch) to press things.'
          : usingPads() ? 'Tip: hand tracking works best here. Put the controllers down and wait a moment; the headset switches to your hands. (If it doesn’t: Quest Settings → Movement tracking → Hand tracking.) With controllers, the trigger presses things.'
          : 'Point with your hand or controller, and pinch (or pull the trigger) to press things.',
        'Each step waits for you to try it. Point at Next and ' + pinch() + ' to begin.'], need: null },
    { title: 'Place the circuit', body: () => [
        'A ring on the floor or on a real table shows where the race circuit will sit.',
        'Point at a clear spot and ' + pinch() + ' to place it there.'], need: () => !App.placing, skip: () => !App.placing },
    { title: 'The menu', body: () => [
        'The big panel is your menu: races, views, poker and more.',
        'Point at any button on it and ' + pinch() + '. A red line from your hand shows what you’re pointing at.'],
      start: () => { const vr = KB._vr(); if (App.menuHidden) vr.setMenuHidden(false); }, need: () => n('menu') > 0 },
    { title: 'Move a window', body: () => [
        'Any window can be moved. ' + (usingHands() ? 'Pinch' : 'Pull the trigger on') + ' the strip along the top of this card (or the menu’s title) and keep holding while you move your hand. Let go to drop it.',
        'Put this card somewhere comfortable.'], need: () => n('drag') > 0 },
    { title: 'Your left wrist', body: () => [
        'Turn your left palm towards your face: there’s a round MENU button on your wrist.',
        'Point at it with your other hand and ' + pinch() + ' to hide the menu, then do it again to bring it back.'],
      need: () => n('menuToggle') >= 2 },
    { title: 'Recentre', body: () => [
        'If things end up behind you or too far away, press RESET on your right wrist. The table and the menu come back in front of you.',
        'At the poker table, RESET makes the spot where you are now your seat. Try it now.'], need: () => n('reset') > 0 },
    { title: 'To the casino', body: () => [
        'The poker table is in the casino garage. Point at Take me there and ' + pinch() + '.',
        'This also opens your own private room that friends can join later.'],
      action: { label: 'Take me there', fn: () => KB.pokerFromHeadset() }, need: inCasino },
    { title: 'Get around', body: () => [
        'Walk around for real, or teleport: point at the floor, ' + (usingHands() ? 'pinch and hold' : 'hold the trigger') + ' for half a second, aim the ring, then let go.',
        'Try teleporting next to the poker table.'], need: () => n('teleport') > 0 || seated(), skip: () => seated() || !inCasino() },
    { title: 'Sit down to play', body: () => [
        'The chairs at the poker table glow. Point at one and ' + pinch() + ' to sit.',
        'Or point at Sit me down to sit with three practice bots.'],
      action: { label: 'Sit me down', fn: async () => { if (!inCasino()) await KB.pokerFromHeadset(); await window.KBLoadPoker(); KBPoker.practice(); } },
      need: seated, done: () => { // nobody else at the table: bring in practice bots
        const s = window.KBPoker && KBPoker._P.state; if (s && s.seats.filter(Boolean).length < 2) KBPoker.practice(); } },
    { title: 'Your seat', body: () => [
        'The poker panel is on your left. Lower, Fit and Higher change your seat height: sit down first, then pinch Fit to put your eyes at a comfortable height over the table.',
        'Panel: left / on hand / table moves the panel. You can also drag it by the strip along its top.'], need: null },
    { title: 'Look at your cards', body: () => [
        'When a hand is dealt, two cards land in front of you. Reach out and ' + (usingHands() ? 'pinch' : 'squeeze the grip button on') + ' one to lift it and see it.',
        'Pinch the gap between them to lift both, or take one in each hand. Let go anywhere except the middle and they go back.'],
      need: () => n('cards') > 0 },
    { title: 'Your turn', body: () => [
        'When it’s your turn, your seat lights up. Check: knock on the felt in front of you (a quick tap, down and straight back up).',
        'Bet or call: take chips from the trays in front of you, drop them in the gold circle, then knock. Fold: throw your cards into the middle. The panel’s buttons do the same. Play a turn now.'],
      need: () => n('act') > 0 },
    { title: 'Show off', body: () => [
        'Pick up a chip, turn your hand palm-down and hold still for a moment: it rolls across your knuckles. Turn your palm up to stop. Friends see it too.',
        usingHands() ? 'Give it a try, or Skip step.' : 'This needs hand tracking: put the controllers down to try it, or Skip step.'],
      need: () => n('trick') > 0 },
    { title: 'Play with friends', body: () => [
        'Your room has a four-letter code, shown next to Invite on the menu. Pinch Invite to copy a link to send, or just tell friends the code: on their headset, phone or computer they choose Watch with friends and enter it, then pick a glowing chair.',
        'When you’re done, Leave table on the poker panel. Replay this tour any time: Tutorial on the menu.'], need: null, last: true },
  ];

  /* ---------------- the card in the headset ---------------- */
  const W = 1024, H = 660, HANDLE = 46;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const tex = new THREE.CanvasTexture(cv);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.52 * H / W), new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide }));
  mesh.visible = false; mesh.renderOrder = 20; scene.add(mesh);
  let hits = [];
  function wrap(c, text, x, y, maxW, lh) {
    const words = text.split(' '); let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (c.measureText(t).width > maxW && line) { c.fillText(line, x, y); y += lh; line = w; } else line = t; }
    if (line) { c.fillText(line, x, y); y += lh; } return y;
  }
  function draw() {
    const st = STEPS[T.i], done = T.doneAt > 0, c = cv.getContext('2d'); hits = [];
    c.clearRect(0, 0, W, H);
    rr(c, 300, 6, 424, 30, 15); c.fillStyle = 'rgba(32,38,43,.9)'; c.fill();
    c.fillStyle = '#94A1A8'; c.font = '600 21px "Barlow Condensed", sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('⠿  pinch here and move to drag  ⠿', 512, 22);
    c.textAlign = 'left'; c.textBaseline = 'alphabetic';
    rr(c, 4, HANDLE, W - 8, H - HANDLE - 4, 24); c.fillStyle = 'rgba(32,38,43,0.96)'; c.fill(); c.lineWidth = 4; c.strokeStyle = done ? '#2fa36b' : '#D2342B'; c.stroke();
    for (let x = 24; x < W - 24; x += 32) { c.fillStyle = (x / 32) % 2 < 1 ? '#E9E6DF' : '#D2342B'; c.fillRect(x, HANDLE + 4, 32, 8); }
    c.fillStyle = '#E9E6DF'; c.font = '700 50px "Barlow Condensed", sans-serif'; c.fillText(st.title, 40, HANDLE + 74);
    c.fillStyle = '#94A1A8'; c.font = '600 26px "Barlow Condensed", sans-serif'; c.textAlign = 'right'; c.fillText(`Step ${T.i + 1} of ${STEPS.length}`, W - 40, HANDLE + 70); c.textAlign = 'left';
    c.font = '500 29px Barlow, sans-serif'; c.fillStyle = '#E9E6DF'; let y = HANDLE + 128;
    for (const p of st.body()) y = wrap(c, p, 40, y, W - 80, 38) + 12;
    const yb = H - 92;
    c.font = '600 28px "Barlow Condensed", sans-serif';
    if (st.need) { c.fillStyle = done ? '#2fa36b' : '#c9a13b'; c.fillText(done ? '✓ Nice! On to the next step…' : 'Waiting for you to try it…', 40, yb - 20); }
    const btn = (x, w, label, fn, kind) => {
      const i = hits.length, hot = T.hover === i;
      rr(c, x, yb, w, 66, 12); c.fillStyle = kind === 'go' ? (hot ? '#ff4a3d' : '#D2342B') : hot ? '#3a454c' : 'rgba(255,255,255,.07)'; c.fill();
      c.lineWidth = 2; c.strokeStyle = kind === 'go' ? '#D2342B' : '#4b575e'; c.stroke();
      c.fillStyle = '#E9E6DF'; c.font = '600 28px "Barlow Condensed", sans-serif'; c.textAlign = 'center'; c.fillText(label, x + w / 2, yb + 43); c.textAlign = 'left';
      hits.push({ x, y: yb, w, h: 66, fn });
    };
    btn(28, 130, 'Back', () => go(T.i - 1));
    btn(170, 200, 'End tutorial', () => finish(false));
    let xr = W - 28;
    const right = (w, label, fn, kind) => { xr -= w; btn(xr, w, label, fn, kind); xr -= 14; };
    if (st.last) right(200, 'Finish', () => finish(true), 'go');
    else if (!st.need || done) right(180, 'Next', () => go(T.i + 1), 'go');
    else right(180, 'Skip step', () => go(T.i + 1));
    if (st.action && !done) right(230, st.action.label, () => { Promise.resolve().then(st.action.fn).catch(e => toast(e.message || String(e), 4000)); }, 'go');
    tex.needsUpdate = true;
  }
  function place() {
    if (!renderer.xr.isPresenting) return;
    const head = KB.xrHead(), f = KB.xrForward(); f.y = 0; if (f.lengthSq() < 1e-6) f.set(0, 0, -1); f.normalize();
    const right = new THREE.Vector3(-f.z, 0, f.x);
    mesh.position.copy(head).addScaledVector(f, 0.72).addScaledVector(right, 0.32); mesh.position.y = head.y - 0.12;
    mesh.lookAt(head); T.moved = false;
  }
  function go(i) {
    i = Math.max(0, Math.min(STEPS.length - 1, i));
    const back = i < T.i;
    // pass over steps that don't apply (going forward only, so Back always works)
    while (!back && i < STEPS.length - 1 && STEPS[i].skip && STEPS[i].skip()) i++;
    T.i = i; T.doneAt = 0; T.ev.clear(); T.resetSeen = 0; T.sig = '';
    const st = STEPS[i]; if (st.start) try { st.start(); } catch (e) {}
    if (!T.moved) place();
    draw();
  }
  function start() {
    if (!renderer.xr.isPresenting) { put('pending'); toast('The tutorial starts when you put the headset on and press Enter VR.', 6000); return; }
    T.on = true; T.i = 0; T.moved = false; mesh.visible = true; put('pending'); go(0);
  }
  function finish(done) {
    T.on = false; mesh.visible = false; put(done ? 'done' : 'skipped');
    toast(done ? 'Tutorial done. Replay it any time: Tutorial on the menu.' : 'Tutorial closed. Replay it any time: Tutorial on the menu.', 5000);
  }
  function frame(dt) {
    if (!renderer.xr.isPresenting) { if (T.on) { T.on = false; mesh.visible = false; } T.startAt = 0; return; }
    if (!T.on) { // a first-timer who chose the tutorial on the screen: start once they're settled in the headset
      if (get() !== 'pending') return;
      if (!T.startAt) T.startAt = performance.now();
      if (performance.now() - T.startAt > 1500) start();
      return;
    }
    const st = STEPS[T.i];
    if (st.need && !T.doneAt && st.need()) { T.doneAt = performance.now(); if (st.done) try { st.done(); } catch (e) {} draw(); }
    if (T.doneAt && !st.last && performance.now() - T.doneAt > 1600) go(T.i + 1);
    if (n('reset') > (T.resetSeen || 0)) { T.resetSeen = n('reset'); place(); } // RESET on your wrist brings the card back too
    // too far away after a teleport or sitting down: bring the card back
    if (mesh.position.distanceTo(KB.xrHead()) > 2.2) place();
    // hover highlight
    let hv = -1; for (const c of KB.controllers) { const p = hitAt(c); if (p) hv = hits.findIndex(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h); if (hv >= 0) break; }
    const sig = hv + '|' + usingHands() + '|' + T.doneAt;
    if (sig !== T.sig) { T.sig = sig; T.hover = hv; draw(); }
  }
  function hitAt(c) {
    if (!mesh.visible) return null; KB.rayFrom(c);
    const h = KB.raycaster.intersectObject(mesh, false)[0]; return h && h.uv ? { x: h.uv.x * W, y: (1 - h.uv.y) * H } : null;
  }
  function onSelect(e) {
    if (!T.on || !mesh.visible) return false;
    const p = hitAt(e.target); if (!p) return false;
    const b = hits.find(b => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h);
    if (b) b.fn();
    return true;
  }
  // drag support for the page's pinch-to-move
  function dragTarget() { return T.on && mesh.visible ? { mesh, handle: uv => (1 - uv.y) * H < HANDLE, move: p => { mesh.position.copy(p); T.moved = true; } } : null; }

  /* ---------------- first visit, on the screen ---------------- */
  function intro() {
    if (get() || /[?&](notut|skiptut)\b/.test(location.search)) return;
    const d = document.createElement('div'); d.id = 'tutIntro';
    d.style.cssText = 'position:fixed;inset:0;z-index:20;display:flex;align-items:center;justify-content:center;background:rgba(20,24,27,.82);padding:16px';
    const xrOK = () => { const b = document.getElementById('xrBtn'); return b && !b.disabled; };
    d.innerHTML = `<div style="max-width:520px;background:var(--tarmac-2,#2a3136);border:1px solid var(--tarmac-3,#3a454c);border-radius:12px;padding:22px 24px;color:var(--chalk,#E9E6DF);font:15px/1.5 Barlow,sans-serif">
      <div style="height:8px;margin:-22px -24px 16px;border-radius:12px 12px 0 0;background:repeating-linear-gradient(90deg,#E9E6DF 0 32px,#D2342B 32px 64px)"></div>
      <h2 style="font:700 30px/1.1 'Barlow Condensed',sans-serif;margin:0 0 10px">Welcome to Kerbside</h2>
      <p style="margin:0 0 10px">Watch Formula 1 races in 3D on a table in front of you, hang out with friends, and play poker in a casino garage while the race is on.</p>
      <p style="margin:0 0 6px"><b>First time in a headset?</b></p>
      <ol style="margin:0 0 12px;padding-left:20px;color:var(--muted,#94A1A8)">
        <li>Clear a little space around you and sit or stand comfortably.</li>
        <li>On the Quest, open this page in the <b style="color:var(--chalk,#E9E6DF)">Browser</b> and press <b style="color:var(--chalk,#E9E6DF)">Enter VR</b> (top right).</li>
        <li>Put the controllers down: the Quest switches to <b style="color:var(--chalk,#E9E6DF)">hand tracking</b>, and a pinch of your thumb and index finger is a click. (Not switching? Quest Settings → Movement tracking → Hand tracking.)</li>
      </ol>
      <p style="margin:0 0 16px">A short tour in the headset then shows you the menu, how to recentre and move windows, getting around, and poker with practice bots or friends.</p>
      <div style="display:flex;gap:10px;flex-wrap:wrap">
        <button id="tutGo" class="primary" style="flex:1;min-width:180px">${xrOK() ? 'Enter VR and start the tour' : 'Start the tour in VR'}</button>
        <button id="tutSkip" class="ghost" style="flex:1;min-width:140px">Skip tutorial</button>
      </div></div>`;
    document.body.appendChild(d);
    d.querySelector('#tutGo').onclick = () => {
      put('pending'); d.remove();
      if (xrOK()) KB.enterXR(); else toast('Open this page on your Quest and press Enter VR: the tour starts there.', 7000);
    };
    d.querySelector('#tutSkip').onclick = () => { put('skipped'); d.remove(); toast('Skipped. The tour is on the menu (Tutorial) whenever you want it.', 5000); };
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', intro); else intro();
  const sb = document.getElementById('tutBtn'); if (sb) sb.onclick = () => { if (renderer.xr.isPresenting) start(); else { put('pending'); const b = document.getElementById('xrBtn'); if (b && !b.disabled) KB.enterXR(); else toast('Put on your Quest, open this page and press Enter VR: the tour starts there.', 6000); } };

  window.KBTut = { start, finish, frame, onSelect, dragTarget, active: () => T.on, _T: T, _steps: STEPS, _mesh: mesh, _hits: () => hits };
})();
