// Kerbside drive mode. Loaded on demand by index.html, so the viewer stays light.
// Race on the loaded circuit: time trial, the real field's fastest laps as ghosts,
// computer rivals, or friends online with a room code. Works on iPad and in the Quest 3 headset.
(function () {
'use strict';

/* =====================================================================
   Simulation (no page or DOM access, so it can be tested on its own)
   ===================================================================== */
function makeSim(THREE) {
  const HW = 7, KERB = 8.6, LIMIT = 9.5, WALL = 40, WHEELBASE = 3.6, VTOP = 93;
  const PH = {
    eng: v => Math.min(11, 950 / Math.max(v, 4)),     // engine push, m/s²
    drag: v => 0.00115 * v * v + 0.12,                 // air and rolling drag
    brk: v => 16 + 0.0032 * v * v,                     // braking, grows with downforce
    lat: v => 14 + 0.0042 * v * v,                     // cornering grip, grows with downforce
    steerMax: v => 0.38 / (1 + v / 18)                 // front wheel angle, smaller at speed
  };
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const wrapA = a => { a = (a + Math.PI) % (2 * Math.PI); if (a < 0) a += 2 * Math.PI; return a - Math.PI; };
  const wrapD = (d, L) => { d = ((d % L) + L) % L; return d > L / 2 ? d - L : d; };
  const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tan = new THREE.Vector3();

  function trackY(tr, s) {
    const seg = tr.length / tr.N, f = ((s % tr.length) + tr.length) % tr.length / seg;
    const i = Math.floor(f) % tr.N, j = (i + 1) % tr.N, u = f - Math.floor(f);
    return tr.pts[i].y * (1 - u) + tr.pts[j].y * u;
  }
  function poseAt(tr, s, lat, out) { // world position on the track at distance s, lat metres to the left
    const i = tr.at(s / tr.length, out, tan);
    out.x += tr.nrm[i].x * lat; out.z += tr.nrm[i].z * lat;
    return { i, yaw: Math.atan2(tan.x, tan.z) };
  }

  // Speed the circuit allows at each point, and a racing line that cuts to the inside of corners.
  function buildProfile(tr) {
    const N = tr.N, seg = tr.length / N, raw = new Float32Array(N), kap = new Float32Array(N);
    for (let i = 0; i < N; i++) { // turn angle over ±1 point (about 16 m), so short tight corners aren't averaged away
      const a = tr.tan[(i - 1 + N) % N], b = tr.tan[(i + 1) % N];
      raw[i] = Math.abs(Math.atan2(a.z * b.x - a.x * b.z, a.x * b.x + a.z * b.z)) / (2 * seg);
    }
    for (let i = 0; i < N; i++) { let m = 0; for (let k = -2; k <= 2; k++) m = Math.max(m, raw[(i + k + N) % N]); kap[i] = m; } // tightest nearby
    const vmax = new Float32Array(N);
    for (let i = 0; i < N; i++) vmax[i] = kap[i] > 0.0043 ? Math.min(VTOP, Math.sqrt(14 / (kap[i] - 0.0042))) : VTOP;
    for (let k = 2 * N; k > 0; k--) {
      const i = k % N, j = (k + 1) % N, lim = Math.sqrt(vmax[j] * vmax[j] + 2 * PH.brk(vmax[j]) * 0.9 * seg);
      if (vmax[i] > lim) vmax[i] = lim;
    }
    for (let k = 0; k < 2 * N; k++) {
      const i = k % N, j = (k + 1) % N, lim = Math.sqrt(vmax[i] * vmax[i] + 2 * Math.max(0.4, PH.eng(vmax[i]) - PH.drag(vmax[i])) * seg);
      if (vmax[j] > lim) vmax[j] = lim;
    }
    const lineRaw = new Float32Array(N), line = new Float32Array(N);
    for (let i = 0; i < N; i++) lineRaw[i] = Math.sign(tr.curv[i]) * Math.min(4.5, kap[i] * 300);
    for (let i = 0; i < N; i++) { let s = 0; for (let k = -12; k <= 12; k++) s += lineRaw[(i + k + N) % N]; line[i] = s / 25; }
    return { vmax, line, seg, kap };
  }
  const profIdx = (P, tr, s) => Math.floor((((s % tr.length) + tr.length) % tr.length) / P.seg) % tr.N;

  function newCar(tr, s, lat, speed) {
    const p = new THREE.Vector3(), pose = poseAt(tr, s, lat, p);
    return {
      x: p.x, z: p.z, y: p.y, h: pose.yaw, v: speed || 0, steer: 0, yawRate: 0, latAcc: 0, slide: 0,
      hint: pose.i, prevS: ((s % tr.length) + tr.length) % tr.length, dist: s, lat, surf: 1, offT: 0, invalid: false
    };
  }

  // One physics step for a driven car. Steer +1 is right. Heading h: forward is (sin h, 0, cos h).
  function stepCar(c, inp, dt, tr) {
    const pr = tr.project(tmp.set(c.x, 0, c.z), c.hint); c.hint = pr.i;
    const off = Math.abs(pr.lat);
    c.lat = pr.lat;
    c.surf = off <= HW ? 1 : off <= KERB ? 0.92 : 0.5;
    const grass = c.surf < 0.6, v = c.v, av = Math.abs(v);
    let a = 0;
    if (inp.throttle > 0) a += PH.eng(av) * inp.throttle * (grass ? 0.6 : 1); // also stops a car rolling backwards
    if (inp.brake > 0) {
      if (v > 0.3) a -= PH.brk(av) * inp.brake * (grass ? 0.55 : 1);
      else if (inp.throttle < 0.05) a -= 5 * inp.brake; // reverse at walking pace
    }
    a -= Math.sign(v) * (PH.drag(av) + (grass ? 2.5 + 0.004 * v * v : 0));
    let nv = v + a * dt;
    if (v > 0.3 && nv < 0) nv = 0;
    if (v >= 0 && nv < 0 && !(inp.brake > 0)) nv = 0;
    if (v <= 0 && nv > 0 && !(inp.throttle > 0)) nv = 0;
    c.v = clamp(nv, -8, 100);
    c.steer += (clamp(inp.steer, -1, 1) - c.steer) * Math.min(1, dt * 10);
    const delta = c.steer * PH.steerMax(Math.abs(c.v));
    let r = c.v * Math.tan(delta) / WHEELBASE;
    const rMax = PH.lat(Math.abs(c.v)) * c.surf / Math.max(Math.abs(c.v), 1);
    if (Math.abs(r) > rMax) {
      c.v -= Math.sign(c.v) * Math.min(Math.abs(c.v), (Math.abs(r) - rMax) * Math.abs(c.v) * 0.35 * dt);
      r = Math.sign(r) * rMax; c.slide = Math.min(1, c.slide + dt * 4);
    } else c.slide = Math.max(0, c.slide - dt * 3);
    c.h = wrapA(c.h - r * dt);
    c.yawRate = r; c.latAcc = r * c.v;
    c.x += Math.sin(c.h) * c.v * dt; c.z += Math.cos(c.h) * c.v * dt;
    if (off > WALL) { // invisible barrier at the edge of the run-off
      const n = tr.nrm[pr.i], sg = Math.sign(pr.lat), ex = off - WALL;
      c.x -= n.x * sg * ex; c.z -= n.z * sg * ex;
      const ty = Math.atan2(tr.tan[pr.i].x, tr.tan[pr.i].z);
      c.h = wrapA(c.h + wrapA(ty - c.h) * 0.5); c.v *= 0.6;
    }
    if (off > LIMIT) { c.offT += dt; if (c.offT > 0.25) c.invalid = true; } else c.offT = 0;
    let ds = wrapD(pr.s - c.prevS, tr.length);
    if (Math.abs(ds) > 80) ds = 0;
    c.dist += ds; c.prevS = pr.s;
    c.y = trackY(tr, pr.s);
  }

  // Computer rivals: they follow the racing line at the speed the circuit allows, scaled by skill,
  // change lanes to pass slower cars and back off when boxed in.
  function stepAI(ai, dt, tr, P, others) {
    const L = tr.length, i = profIdx(P, tr, ai.dist);
    let vt = P.vmax[i] * ai.skill;
    if (ai.wait > 0) { ai.wait -= dt; vt = 0; }
    let lead = null, gap = 30;
    for (const o of others) {
      if (o === ai) continue;
      const d = wrapD(o.dist - ai.dist, L);
      if (d > 0 && d < gap && Math.abs(o.lat - ai.lat) < 2.6) { gap = d; lead = o; }
    }
    ai.laneT = Math.max(0, (ai.laneT || 0) - dt);
    if (lead && lead.v < ai.v + 1) {
      if (!ai.laneT) {
        const want = clamp(lead.lat + (lead.lat >= P.line[i] ? -3.4 : 3.4), -5.5, 5.5);
        const free = others.every(o => o === ai || Math.abs(wrapD(o.dist - ai.dist, L)) > 9 || Math.abs(o.lat - want) > 2.4);
        if (free) { ai.laneTarget = want; ai.laneT = 3; }
      }
      if (gap < 14 && Math.abs((ai.laneTarget ?? P.line[i]) - lead.lat) < 2.6) vt = Math.min(vt, Math.max(0, lead.v - 0.5));
    }
    if (ai.v < vt) ai.v = Math.min(vt, ai.v + Math.max(0.3, PH.eng(ai.v) - PH.drag(ai.v)) * ai.skill * dt);
    else ai.v = Math.max(vt, ai.v - PH.brk(ai.v) * dt);
    const target = ai.laneT ? ai.laneTarget : P.line[i];
    let dl = clamp(target - ai.lat, -3 * dt, 3 * dt);
    for (const o of others) { // keep a car's width apart when side by side
      if (o === ai || !o.kinematic) continue;
      const d = wrapD(o.dist - ai.dist, L), dlat = ai.lat - o.lat;
      if (Math.abs(d) < 6 && Math.abs(dlat) < 2.3) dl += (dlat >= 0 ? 1 : -1) * (2.3 - Math.abs(dlat)) * 2.5 * dt;
    }
    ai.lat = clamp(ai.lat + dl, -6.5, 6.5);
    ai.dist += ai.v * dt;
    const p = tmp2, pose = poseAt(tr, ai.dist, ai.lat, p);
    ai.x = p.x; ai.z = p.z; ai.y = p.y;
    ai.h = wrapA(pose.yaw - Math.atan2(dl / Math.max(dt, 1e-4), Math.max(ai.v, 3)));
  }

  // Two circles per car (front and rear). Pushes cars apart and trades speed.
  const CR = 1.0, CO = 1.4;
  function collide(a, b, aWeight) {
    let hit = false;
    for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
      const ax = a.x + Math.sin(a.h) * CO * sa, az = a.z + Math.cos(a.h) * CO * sa;
      const bx = b.x + Math.sin(b.h) * CO * sb, bz = b.z + Math.cos(b.h) * CO * sb;
      const dx = ax - bx, dz = az - bz, d = Math.hypot(dx, dz);
      if (d >= 2 * CR || d < 1e-6) continue;
      hit = true;
      const nx = dx / d, nz = dz / d, ov = 2 * CR - d;
      a.x += nx * ov * aWeight; a.z += nz * ov * aWeight;
      if (b.kinematic) b.lat -= (nx * b.nx + nz * b.nz) * ov * (1 - aWeight);
      else if (!b.remote) { b.x -= nx * ov * (1 - aWeight); b.z -= nz * ov * (1 - aWeight); }
      const vax = Math.sin(a.h) * a.v, vaz = Math.cos(a.h) * a.v, vbx = Math.sin(b.h) * b.v, vbz = Math.cos(b.h) * b.v;
      const vrel = (vax - vbx) * nx + (vaz - vbz) * nz;
      if (vrel < 0) {
        a.v += (Math.sin(a.h) * nx + Math.cos(a.h) * nz) * -vrel * 0.6;
        if (!b.remote) b.v = Math.max(0, b.v - (Math.sin(b.h) * nx + Math.cos(b.h) * nz) * -vrel * 0.4);
      }
    }
    return hit;
  }

  // Steering towards a point ahead on the racing line (pure pursuit). Used by the steering assist.
  const ppT = new THREE.Vector3();
  function autoSteer(c, tr, P) {
    const Ld = Math.max(9, Math.abs(c.v) * 0.55), sAhead = c.dist + Ld;
    const i = profIdx(P, tr, sAhead);
    poseAt(tr, sAhead, P.line[i], ppT);
    const dx = ppT.x - c.x, dz = ppT.z - c.z;
    const fwd = dx * Math.sin(c.h) + dz * Math.cos(c.h), left = dx * Math.cos(c.h) - dz * Math.sin(c.h);
    const alpha = Math.atan2(left, Math.max(0.5, fwd)), dist = Math.hypot(dx, dz);
    const delta = Math.atan(2 * WHEELBASE * Math.sin(alpha) / Math.max(1, dist));
    return clamp(-delta / PH.steerMax(Math.abs(c.v)), -1, 1);
  }

  // Braking corners: the slow points of the speed profile that need a real brake from the straight before.
  // Turn-in is where the corner starts to bend; distance boards count down to it.
  function findCorners(tr, P) {
    const N = tr.N, seg = P.seg, L = tr.length, win = Math.max(2, Math.round(80 / seg)), back = Math.round(400 / seg);
    const found = [];
    for (let i = 0; i < N; i++) {
      const v = P.vmax[i];
      let isMin = true;
      for (let k = 1; k <= win && isMin; k++) if (P.vmax[(i + k) % N] < v || P.vmax[(i - k + N) % N] < v) isMin = false;
      if (!isMin) continue;
      let entry = 0; for (let k = 1; k <= back; k++) entry = Math.max(entry, P.vmax[(i - k + N) % N]);
      if (entry - v < 12) continue; // under about 45 km/h of braking: a lift, not a braking zone
      const prev = found[found.length - 1];
      if (prev && (i - prev.i) * seg < 120) { if (v < prev.v) found[found.length - 1] = { i, v, entry }; continue; }
      found.push({ i, v, entry });
    }
    if (found.length > 1) { const a = found[0], z = found[found.length - 1]; if ((a.i + N - z.i) * seg < 120) { if (a.v <= z.v) found.pop(); else found.shift(); } }
    return found.map(c => {
      const th = P.kap[c.i] * 0.3; let j = c.i, steps = 0;
      while (steps < 200 / seg && P.kap[(j - 1 + N) % N] > th) { j--; steps++; }
      return { apexS: c.i * seg, turnS: ((j * seg) % L + L) % L, side: -(Math.sign(tr.curv[c.i]) || 1), entry: c.entry, apexV: c.v };
    });
  }
  function boardSpots(tr, P) {
    const cs = findCorners(tr, P), L = tr.length, out = [];
    cs.forEach((c, k) => {
      const prev = cs[(k - 1 + cs.length) % cs.length];
      const room = cs.length > 1 ? ((c.turnS - prev.apexS) % L + L) % L : L;
      for (const d of [200, 100, 50]) if (d + 40 < room) out.push({ s: c.turnS - d, side: c.side, n: d });
    });
    return { corners: cs, spots: out };
  }

  return { PH, HW, LIMIT, clamp, wrapA, wrapD, trackY, poseAt, buildProfile, profIdx, newCar, stepCar, stepAI, collide, autoSteer, findCorners, boardSpots };
}
window.KBDriveSim = makeSim;
if (!window.KB) return; // loaded for testing only

/* =====================================================================
   Game: everything that touches the page, the 3D scene or the headset
   ===================================================================== */
const DRIVE_BUILD = 5;
const KB = window.KB, THREE = KB.THREE, App = KB.App, $ = KB.$, store = KB.store, toast = KB.toast;
const Sim = makeSim(THREE);
const { clamp, wrapA, wrapD } = Sim;
const renderer = KB.renderer, scene = KB.scene, camera = KB.camera;

const TEAM = [
  ['Red', '#D2342B'], ['Orange', '#F28A1E'], ['Teal', '#2BB5A0'], ['Blue', '#2E6FD9'], ['Navy', '#22336B'],
  ['Silver', '#C9CED3'], ['Green', '#2F8F4E'], ['Pink', '#E66BB0'], ['Yellow', '#E8C33A'], ['White', '#F2F2EF']
];
const AI_NAMES = ['ACE', 'BOX', 'DUX', 'FIN', 'GIL', 'HAL', 'IVO', 'JAX', 'KAI', 'LEX', 'MAX', 'NED', 'ODA', 'PIA', 'REX', 'SOL', 'TAJ', 'UMA', 'VIC'];
const AI_COLORS = ['#2E6FD9', '#F28A1E', '#2BB5A0', '#C9CED3', '#2F8F4E', '#E66BB0', '#E8C33A', '#8E5BD6', '#22336B', '#6B7A85'];

const cfg = Object.assign({
  type: 'tt', laps: 3, pace: 85, rivals: 9, skill: 88, gridPos: 'back', view: 'chase',
  touch: 'tilt', tiltInv: false, quest: 'wheel', autoThrottle: false, brakeAssist: false, steerAssist: false,
  color: '#D2342B', sound: true, ownGhost: true, comfort: 'medium', name: '', drawTrack: true, boards: true
}, store.get('drive:cfg', {}));
const saveCfg = () => store.set('drive:cfg', cfg);

const D = {
  active: false, state: 'menu', track: null, prof: null, player: null, ais: [], ghosts: [], remotes: new Map(),
  raceT: 0, lightsT: 0, goHold: 1, accum: 0, lap: { n: 0, start: 0, best: null, last: null, sectors: [], invalid: false },
  ghostRec: [], ownGhost: null, results: null, finishT: null, menuOpen: true, xrMenu: false, seat: null,
  view: cfg.view
};

/* ---------------- Car meshes ---------------- */
function carGroup(color, opacity) {
  const g = new THREE.Group(), t = opacity < 1;
  g.add(new THREE.Mesh(KB.CarGeo.body, new THREE.MeshToonMaterial({ color, transparent: t, opacity, depthWrite: !t })));
  const darkM = t ? new THREE.MeshToonMaterial({ color: 0x1c1f22, transparent: true, opacity, depthWrite: false }) : KB.darkMat;
  g.add(new THREE.Mesh(KB.CarGeo.dark, darkM));
  const post = new THREE.Mesh(KB.CarGeo.post, darkM); g.add(post); g.userData.post = post;
  return g;
}
function addMeshes(ent, color, tla, opacity) {
  ent.model = carGroup(color, opacity); KB.modelGroup.add(ent.model);
  ent.real = KB.onLayer(carGroup(color, opacity), KB.REAL); KB.realWorld.add(ent.real);
  ent.label = KB.labelSprite(tla, color); KB.modelGroup.add(ent.label);
  ent.color = color; ent.tla = tla;
}
function dropMeshes(ent) {
  if (!ent || !ent.model) return;
  KB.modelGroup.remove(ent.model); KB.realWorld.remove(ent.real); KB.modelGroup.remove(ent.label);
  ent.model = ent.real = ent.label = null;
}
const fullSizeXR = () => renderer.xr.isPresenting && D.view !== 'rc';
function placeMesh(ent, x, y, z, h, visible) {
  if (!ent.model) return;
  ent.model.visible = ent.real.visible = visible;
  const rc = !fullSizeXR();
  const k = rc && D.view === 'rc' ? KB.modelCarLen() / KB.CAR_LEN : 1;
  ent.model.scale.setScalar(rc ? k : 1);
  ent.model.position.set(x, y, z); ent.model.rotation.y = h;
  ent.real.position.set(x, y, z); ent.real.rotation.y = h;
  const showLabel = visible && D.view === 'rc' && !fullSizeXR();
  ent.label.visible = showLabel;
  if (showLabel) {
    const LL = (D.track ? D.track.extent * 0.012 : 5.6) * 2.5;
    ent.label.scale.set(LL * 1.25, LL * 0.55, 1);
    ent.label.position.set(x, y + KB.modelCarLen() * 0.6 + LL * 0.4, z);
  }
}

/* ---------------- Braking distance boards (200, 100, 50 m before each braking corner) ---------------- */
const boardTex = {};
function boardTexture(n) {
  if (boardTex[n]) return boardTex[n];
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 160; const x = cv.getContext('2d');
  x.fillStyle = '#F4F3EE'; x.fillRect(0, 0, 256, 160);
  x.lineWidth = 10; x.strokeStyle = '#1C1F22'; x.strokeRect(5, 5, 246, 150);
  x.fillStyle = '#1C1F22'; x.font = '700 112px "Barlow Condensed", Arial, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
  x.fillText(String(n), 128, 86);
  const t = new THREE.CanvasTexture(cv); t.anisotropy = 4; return (boardTex[n] = t);
}
// Game-sized: about 3 × 1.9 m on two 2.4 m legs, so they read from 200 m away. The number is printed
// on the front of a single block (no separate panel that could flicker into the backing at table scale).
const boardGeo = new THREE.BoxGeometry(3.0, 1.9, 0.12), legGeo = new THREE.BoxGeometry(0.14, 2.4, 0.14);
const boardDarkMat = new THREE.MeshToonMaterial({ color: 0x2a2f33 });
const boardFaceMat = {};
function boardMesh(n) {
  const face = boardFaceMat[n] || (boardFaceMat[n] = new THREE.MeshBasicMaterial({ map: boardTexture(n) }));
  const g = new THREE.Group();
  const panel = new THREE.Mesh(boardGeo, [boardDarkMat, boardDarkMat, boardDarkMat, boardDarkMat, face, boardDarkMat]);
  panel.position.y = 2.4 + 0.95;
  const l1 = new THREE.Mesh(legGeo, boardDarkMat), l2 = new THREE.Mesh(legGeo, boardDarkMat);
  l1.position.set(-1.1, 1.2, -0.03); l2.position.set(1.1, 1.2, -0.03);
  g.add(panel, l1, l2); return g;
}
function buildBoards(tr) {
  if (D.boards) { KB.modelGroup.remove(D.boards.model); KB.realWorld.remove(D.boards.real); }
  const one = Sim.boardSpots(tr, D.prof).spots, spots = [];
  for (const sp of one) { spots.push(sp); spots.push({ s: sp.s, side: -sp.side, n: sp.n }); } // both sides of the track
  D.boardCorners = one.length ? new Set(one.map(sp => Math.round(sp.s + sp.n))).size : 0;
  const model = new THREE.Group(), real = new THREE.Group();
  for (const sp of spots) { model.add(boardMesh(sp.n)); real.add(boardMesh(sp.n)); }
  KB.onLayer(real, KB.REAL);
  KB.modelGroup.add(model); KB.realWorld.add(real);
  D.boards = { spots, model, real, key: null };
  layoutBoards(true);
}
const bPos = new THREE.Vector3();
function layoutBoards(force) {
  const B = D.boards, tr = D.track; if (!B || !tr) return;
  const show = D.active && cfg.boards;
  B.model.visible = B.real.visible = show;
  if (!show) return;
  // In the table view the boards grow with the cars and sit just off the wider model track.
  const full = fullSizeXR() || D.view !== 'rc', k = full ? 1 : KB.modelCarLen() / KB.CAR_LEN;
  const hw = full ? Sim.HW : Sim.HW * (cfg.drawTrack ? (App.latK || 1) : 1);
  const key = k.toFixed(3) + '|' + hw.toFixed(2);
  if (!force && key === B.key) return;
  B.key = key;
  const put = (grp, kk, hww) => B.spots.forEach((sp, i) => {
    const o = grp.children[i], pose = Sim.poseAt(tr, sp.s, sp.side * (hww + 1.5 + 1.6 * kk), bPos);
    o.position.set(bPos.x, Sim.trackY(tr, sp.s), bPos.z);
    o.rotation.set(0, pose.yaw + Math.PI, 0); // face the cars coming towards them
    o.scale.setScalar(kk);
  });
  put(B.model, k, hw); put(B.real, 1, Sim.HW);
}
function setDrawTrack(on) { cfg.drawTrack = on; saveCfg(); App.trackOverride = on; KB.applyTrackVis(); layoutBoards(true); }
function setBoards(on) { cfg.boards = on; saveCfg(); layoutBoards(true); }

/* ---------------- Engine sound ---------------- */
const Snd = {
  ctx: null,
  start() {
    if (!cfg.sound) return;
    const C = window.AudioContext || window.webkitAudioContext; if (!C) return;
    if (!this.ctx) {
      const ctx = this.ctx = new C();
      this.o1 = ctx.createOscillator(); this.o1.type = 'sawtooth';
      this.o2 = ctx.createOscillator(); this.o2.type = 'square';
      this.f = ctx.createBiquadFilter(); this.f.type = 'lowpass'; this.f.frequency.value = 900;
      this.g = ctx.createGain(); this.g.gain.value = 0;
      const g2 = ctx.createGain(); g2.gain.value = 0.35;
      this.o1.connect(this.f); this.o2.connect(g2); g2.connect(this.f); this.f.connect(this.g); this.g.connect(ctx.destination);
      this.o1.start(); this.o2.start();
    }
    this.ctx.resume && this.ctx.resume();
  },
  update(rpm, thr, on) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime, f = rpm / 60 * 3;
    this.o1.frequency.setTargetAtTime(f, t, 0.03); this.o2.frequency.setTargetAtTime(f * 0.5, t, 0.03);
    this.f.frequency.setTargetAtTime(500 + thr * 2600, t, 0.05);
    this.g.gain.setTargetAtTime(on && cfg.sound ? 0.035 + 0.07 * thr : 0, t, 0.06);
  },
  stop() { if (this.ctx) { this.g.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05); } }
};
const GEAR_V = [0, 20, 30, 40, 50, 60, 70, 80, 200];
function gearRpm(v) {
  v = Math.abs(v); let g = 1; while (g < 8 && v > GEAR_V[g]) g++;
  const lo = GEAR_V[g - 1], hi = GEAR_V[g] === 200 ? 95 : GEAR_V[g];
  return { gear: g, rpm: 5500 + 6500 * clamp((v - lo) / (hi - lo), 0, 1) };
}

/* ---------------- Input ---------------- */
const keys = new Set();
addEventListener('keydown', e => { if (!D.active || /INPUT|SELECT|TEXTAREA/.test((e.target && e.target.tagName) || '')) return; keys.add(e.key.toLowerCase()); if (e.key === 'Escape' || e.key.toLowerCase() === 'p') togglePause(); if (/^arrow/i.test(e.key)) e.preventDefault(); });
addEventListener('keyup', e => keys.delete(e.key.toLowerCase()));
const touch = { left: false, right: false, gas: false, brake: false, steer: 0 };
const Tilt = {
  raw: 0, zero: 0, seen: false, bound: false,
  async enable() {
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('Motion access was declined. Allow it in Settings → Safari, or switch to buttons.');
    }
    if (!this.bound) { addEventListener('devicemotion', e => this.onMotion(e)); this.bound = true; }
  },
  onMotion(e) {
    const g = e.accelerationIncludingGravity; if (!g || g.x == null) return;
    const ang = ((screen.orientation && typeof screen.orientation.angle === 'number') ? screen.orientation.angle : (window.orientation || 0)) * Math.PI / 180;
    const sx = g.x * Math.cos(ang) - g.y * Math.sin(ang), sy = g.x * Math.sin(ang) + g.y * Math.cos(ang);
    this.raw = Math.atan2(sx, Math.hypot(sy, g.z || 0)); this.seen = true;
  },
  centre() { this.zero = this.raw; },
  value() { let r = this.raw - this.zero; if (cfg.tiltInv) r = -r; if (Math.abs(r) < 0.025) r = 0; return clamp(r / 0.42, -1, 1); }
};
const isTouch = () => matchMedia('(pointer: coarse)').matches;
let kbSteer = 0;
function gatherInput(dt, xrIn) {
  const out = { steer: 0, throttle: 0, brake: 0 };
  const pick = v => { if (Math.abs(v) > Math.abs(out.steer)) out.steer = v; };
  const kl = keys.has('arrowleft') || keys.has('a'), kr = keys.has('arrowright') || keys.has('d');
  kbSteer += ((kr ? 1 : 0) - (kl ? 1 : 0) - kbSteer) * Math.min(1, dt * 7);
  pick(kbSteer);
  if (keys.has('arrowup') || keys.has('w')) out.throttle = 1;
  if (keys.has('arrowdown') || keys.has('s') || keys.has(' ')) out.brake = 1;
  for (const gp of (navigator.getGamepads ? navigator.getGamepads() : [])) {
    if (!gp || !gp.connected || gp.mapping === 'xr-standard' || /oculus|meta|quest/i.test(gp.id)) continue;
    const ax = gp.axes[0] || 0; pick(Math.abs(ax) > 0.08 ? ax : 0);
    const b = i => (gp.buttons[i] ? gp.buttons[i].value || (gp.buttons[i].pressed ? 1 : 0) : 0);
    out.throttle = Math.max(out.throttle, b(7), b(0)); out.brake = Math.max(out.brake, b(6));
    if (b(9) && !D.gpStart) togglePause(); D.gpStart = b(9) > 0;
  }
  if (cfg.touch === 'buttons') {
    touch.steer += ((touch.right ? 1 : 0) - (touch.left ? 1 : 0) - touch.steer) * Math.min(1, dt * 6);
    pick(touch.steer);
  } else if (Tilt.seen) pick(Tilt.value());
  if (touch.gas) out.throttle = 1;
  if (touch.brake) out.brake = 1;
  if (xrIn) { pick(xrIn.steer); out.throttle = Math.max(out.throttle, xrIn.throttle); out.brake = Math.max(out.brake, xrIn.brake); }
  return out;
}
function applyAssists(inp, c) {
  if (cfg.autoThrottle) inp.throttle = inp.brake > 0.1 ? 0 : 1;
  const tr = D.track, P = D.prof;
  const i = Sim.profIdx(P, tr, c.dist), look = Sim.profIdx(P, tr, c.dist + Math.max(0, c.v) * 0.35);
  if (cfg.brakeAssist) {
    const vt = Math.min(P.vmax[i], P.vmax[look]) * 0.97;
    if (c.v > vt + 0.5) { inp.brake = Math.max(inp.brake, clamp((c.v - vt) / 5, 0.2, 1)); inp.throttle = 0; }
  }
  if (cfg.steerAssist) { // blends towards the racing line; your own steering still wins when you push harder
    const auto = Sim.autoSteer(c, tr, P), w = 1 - Math.min(1, Math.abs(inp.steer)) * 0.6;
    inp.steer = clamp(inp.steer * (1 - w * 0.7) + auto * w, -1, 1);
  }
  return inp;
}

/* ---------------- Headset input ---------------- */
const xrPos = { l: new THREE.Vector3(), r: new THREE.Vector3() };
function xrInput(frame) {
  const session = renderer.xr.getSession(), ref = renderer.xr.getReferenceSpace();
  const res = { steer: 0, throttle: 0, brake: 0, wheel: false, hands: false };
  if (!session || !frame || !ref) return res;
  let gotL = false, gotR = false, sticks = { l: null, r: null };
  D.xrButtons = D.xrButtons || {};
  for (const src of session.inputSources) {
    const side = src.handedness === 'left' ? 'l' : src.handedness === 'right' ? 'r' : null; if (!side) continue;
    if (src.hand && frame.getJointPose) {
      const w = src.hand.get('wrist'), th = src.hand.get('thumb-tip'), ix = src.hand.get('index-finger-tip');
      const pw = w && frame.getJointPose(w, ref), pt = th && frame.getJointPose(th, ref), pi = ix && frame.getJointPose(ix, ref);
      if (pw) { const p = pw.transform.position; xrPos[side].set(p.x, p.y, p.z); if (side === 'l') gotL = true; else gotR = true; }
      if (pt && pi) {
        const a = pt.transform.position, b = pi.transform.position, d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        const pinch = clamp((0.05 - d) / 0.03, 0, 1);
        if (side === 'r') res.throttle = pinch; else res.brake = pinch;
      }
      res.hands = true;
      continue;
    }
    if (src.gripSpace) {
      const pose = frame.getPose(src.gripSpace, ref);
      if (pose) { const p = pose.transform.position; xrPos[side].set(p.x, p.y, p.z); if (side === 'l') gotL = true; else gotR = true; }
    }
    const gp = src.gamepad; if (!gp) continue;
    const trig = gp.buttons[0] ? gp.buttons[0].value : 0;
    if (side === 'r') res.throttle = Math.max(res.throttle, trig); else res.brake = Math.max(res.brake, trig);
    sticks[side] = gp.axes.length >= 4 ? gp.axes[2] : (gp.axes[0] || 0);
    const by = gp.buttons[5] && gp.buttons[5].pressed, st = gp.buttons[3] && gp.buttons[3].pressed;
    if (by && !D.xrButtons[side + 'b']) togglePause();
    if (st && !D.xrButtons[side + 's']) recenter();
    D.xrButtons[side + 'b'] = by; D.xrButtons[side + 's'] = st;
  }
  const useWheel = (cfg.quest === 'wheel' || res.hands) && gotL && gotR;
  if (useWheel) {
    const f = KB.xrForward(), right = new THREE.Vector3(-f.z, 0, f.x);
    const d = xrPos.r.clone().sub(xrPos.l);
    const ang = Math.atan2(d.y, Math.max(0.05, d.dot(right)));
    res.steer = clamp(-ang / 1.15, -1, 1); res.wheel = true; D.wheelAngle = ang;
  } else {
    D.wheelAngle = null;
    const s = sticks.l != null ? sticks.l : sticks.r;
    if (s != null && Math.abs(s) > 0.08) res.steer = s;
  }
  return res;
}

/* ---------------- Ghosts of the real field (OpenF1 fastest laps) ---------------- */
async function loadFieldGhosts(sess, progress) {
  const ck = 'drive:ghosts:' + sess.session_key, cached = store.get(ck, null);
  if (cached && cached.length) return cached;
  const laps = await KB.OF1.get(`/laps?session_key=${sess.session_key}`);
  const drivers = await KB.OF1.get(`/drivers?session_key=${sess.session_key}`);
  const best = new Map();
  for (const l of laps) {
    if (!(l.lap_duration > 30) || l.is_pit_out_lap || !l.date_start) continue;
    const b = best.get(l.driver_number); if (!b || l.lap_duration < b.lap_duration) best.set(l.driver_number, l);
  }
  if (!best.size) throw new Error('This session has no timed laps to race against');
  const out = [], tr = D.track, v = new THREE.Vector3();
  let n = 0;
  for (const [num, lap] of best) {
    progress && progress(++n, best.size);
    const s0 = KB.isoMs(lap.date_start), e0 = s0 + lap.lap_duration * 1000 + 400;
    let loc;
    try { loc = await KB.OF1.get(`/location?session_key=${sess.session_key}&driver_number=${num}&date>=${encodeURIComponent(KB.iso(s0))}&date<=${encodeURIComponent(KB.iso(e0))}`); }
    catch (e) { continue; }
    const pts = []; let hint = -1, prevS = null, dist = 0, last = null;
    for (const p of loc) {
      if (!p.x && !p.y) continue;
      if (last && p.x === last.x && p.y === last.y) continue; last = p;
      tr.toLocal(p.x / 10, p.y / 10, (p.z || 0) / 10, v);
      const pr = tr.project(v, hint); hint = pr.i;
      if (prevS != null) dist += wrapD(pr.s - prevS, tr.length);
      else dist = pr.s > tr.length / 2 ? pr.s - tr.length : pr.s;
      prevS = pr.s;
      pts.push([Math.round((KB.isoMs(p.date) - s0)), Math.round(dist * 10) / 10, Math.round(pr.lat * 10) / 10]);
    }
    if (pts.length < 40) continue;
    const span = pts[pts.length - 1][1] - pts[0][1];
    if (span < tr.length * 0.8 || span > tr.length * 1.2) continue; // didn't line up with this circuit
    const d = drivers.find(x => x.driver_number === num) || {};
    out.push({ tla: d.name_acronym || String(num), color: KB.hexColor(d.team_colour, '#9aa5ab'), T: lap.lap_duration * 1000, pts });
  }
  if (!out.length) throw new Error('No laps from this session lined up with the circuit');
  try { store.set(ck, out); } catch (e) {}
  return out;
}
function ghostAt(g, tMs) { // distance and side offset at time tMs into their lap
  const a = g.pts, T = g.T, loops = Math.floor(tMs / T), u = tMs - loops * T;
  let lo = 0, hi = a.length - 1;
  while (lo < hi - 1) { const m = (lo + hi) >> 1; if (a[m][0] <= u) lo = m; else hi = m; }
  const p = a[lo], q = a[hi], f = q[0] > p[0] ? clamp((u - p[0]) / (q[0] - p[0]), 0, 1) : 0;
  return { dist: loops * D.track.length + p[1] + (q[1] - p[1]) * f, lat: p[2] + (q[2] - p[2]) * f };
}

/* ---------------- Online rooms ---------------- */
const Net = {
  ws: null, id: null, host: null, code: '', peers: [], offset: 0, rttBest: 1e9, setup: null, startAt: null, finishes: new Map(),
  url(code) {
    const r = KB.relayInfo(); if (!r) return null;
    return r.base.replace(/^http/, 'ws') + '/room?code=' + encodeURIComponent(code) + '&key=' + encodeURIComponent(r.key);
  },
  now() { return Date.now() + this.offset; },
  connect(code) {
    const u = this.url(code);
    if (!u) { toast('Online races use your relay. Enter the relay key under Live first.', 7000); return; }
    this.leave();
    this.code = code; this.peers = []; this.setup = null; this.startAt = null; this.finishes = new Map(); D.remotes.clear();
    const ws = this.ws = new WebSocket(u);
    ws.onopen = () => {
      this.send({ t: 'hello', name: playerName(), color: cfg.color });
      clearInterval(this.pingT); this.pingT = setInterval(() => this.send({ t: 'ping', c: Date.now() }), 2000);
      this.send({ t: 'ping', c: Date.now() });
    };
    ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } this.onMsg(m); };
    ws.onclose = () => { if (this.ws === ws) { this.ws = null; clearInterval(this.pingT); UI.lobby('Disconnected from the room.'); } };
    UI.lobby('Connecting…');
  },
  leave() { const R = raceBets(); if (R && this.ws) R.void(); const w = this.ws; this.ws = null; clearInterval(this.pingT); if (w) try { w.close(); } catch (e) {} for (const r of D.remotes.values()) dropMeshes(r); D.remotes.clear(); },
  send(m) { if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); },
  isHost() { return this.id != null && this.id === this.host; },
  onMsg(m) {
    if (m.t === 'welcome') { this.id = m.you; this.host = m.host; this.peers = m.peers || []; if (m.setup) this.applySetup(m.setup); UI.lobby(); }
    else if (m.t === 'roster') {
      this.host = m.host; this.peers = m.peers;
      for (const [id, r] of D.remotes) if (!this.peers.some(p => p.id === id)) { dropMeshes(r); D.remotes.delete(id); }
      UI.lobby();
    }
    else if (m.t === 'pong') { const now = Date.now(), rtt = now - m.c; if (rtt < this.rttBest * 1.5) { this.rttBest = Math.min(this.rttBest, rtt); this.offset = m.s - (m.c + rtt / 2); } }
    else if (m.t === 'setup') { this.applySetup(m.setup); UI.lobby(); }
    else if (m.t === 'start') { this.startAt = m.at; this.grid = m.grid || []; const R = raceBets(); if (R) R.close(); startRace('online'); }
    else if (m.t === 'lobby') { this.startAt = null; if (D.state !== 'menu') { endRace(); openMenu(); } UI.lobby(); }
    else if (m.t === 'state') {
      if (m.id === this.id) return;
      let r = D.remotes.get(m.id);
      if (!r) {
        const p = this.peers.find(x => x.id === m.id) || {};
        r = { id: m.id, buf: [], remote: true, x: 0, z: 0, h: 0, v: 0, dist: -1e9, lat: 0 };
        addMeshes(r, p.color || '#9aa5ab', (p.name || '???').slice(0, 3).toUpperCase(), 1); D.remotes.set(m.id, r);
      }
      r.buf.push(m.s); if (r.buf.length > 40) r.buf.shift();
    }
    else if (m.t === 'finish') { this.finishes.set(m.id, m.time); }
  },
  applySetup(s) {
    this.setup = s;
    if (!s || !s.outline) return;
    if (D.track && String(D.track.circuitKey) === String(s.circuitKey) && Math.abs(D.track.raw.length - s.outline.length) < 3) return;
    try {
      const tr = new KB.Track(s.outline.map(p => ({ x: p[0], y: p[1], z: p[2] })), s.circuitKey);
      KB.cacheTrack(tr); KB.setTrack(tr); setDriveTrack(tr, s.name);
    } catch (e) { toast('Could not build the host’s circuit: ' + e.message, 7000); }
  },
  publishSetup() {
    if (!D.track || !this.isHost()) return;
    this.send({ t: 'setup', setup: { circuitKey: D.track.circuitKey, name: D.trackName || 'Circuit', laps: cfg.laps, outline: KB.packTrack(D.track) } });
  },
  sendState(c) {
    const now = performance.now(); if (now - (this.lastSend || 0) < 95) return; this.lastSend = now;
    this.send({ t: 'state', s: { ts: this.now(), x: Math.round(c.x * 100) / 100, z: Math.round(c.z * 100) / 100, y: Math.round(c.y * 100) / 100, h: Math.round(c.h * 1000) / 1000, v: Math.round(c.v * 10) / 10, dist: Math.round(c.dist * 10) / 10, lat: Math.round(c.lat * 10) / 10 } });
  },
  interp(r) {
    const t = this.now() - 150, b = r.buf; if (!b.length) return false;
    let i = b.length - 1; while (i > 0 && b[i].ts > t) i--;
    const p = b[i], q = b[Math.min(i + 1, b.length - 1)];
    const f = q.ts > p.ts ? clamp((t - p.ts) / (q.ts - p.ts), 0, 1.2) : 0;
    r.x = p.x + (q.x - p.x) * f; r.z = p.z + (q.z - p.z) * f; r.y = p.y + (q.y - p.y) * f;
    r.h = p.h + wrapA(q.h - p.h) * f; r.v = p.v; r.dist = p.dist + (q.dist - p.dist) * f; r.lat = p.lat;
    return this.now() - b[b.length - 1].ts < 5000;
  }
};
const playerName = () => (cfg.name || (window.KBHang && KBHang.name && KBHang.active() && KBHang.name()) || 'You').trim().slice(0, 12) || 'You';
const playerTla = () => playerName().replace(/[^a-z0-9]/gi, '').slice(0, 3).toUpperCase() || 'YOU';
const roomCode = () => { const A = 'ABCDEFGHJKMNPQRSTUVWXYZ'; let s = ''; for (let i = 0; i < 4; i++) s += A[Math.floor(Math.random() * A.length)]; return s; };

/* ---------------- Circuit ---------------- */
function setDriveTrack(tr, name) {
  D.track = tr; D.prof = Sim.buildProfile(tr);
  if (name) D.trackName = name;
  const b = store.get('drive:best:' + tr.circuitKey + ':' + Math.round(tr.length), null);
  D.ttBest = b ? b.time : null; D.ownGhost = b && b.ghost ? b : null;
  buildBoards(tr);
  UI.refresh && UI.refresh();
}
async function loadCircuitFor(sess) {
  let tr = KB.cachedTrack(sess.circuit_key) || await KB.sharedTrack(sess.circuit_key);
  if (!tr) { const raw = await KB.outlineFromSession(sess.session_key); if (raw) { tr = new KB.Track(raw, sess.circuit_key); KB.cacheTrack(tr); } }
  if (!tr) throw new Error('No lap data to draw this circuit. Try another session there.');
  KB.setTrack(tr); setDriveTrack(tr, sess.circuit_short_name || sess.location);
}

/* ---------------- Race control ---------------- */
function clearField() {
  for (const a of D.ais) dropMeshes(a); D.ais = [];
  for (const g of D.ghosts) dropMeshes(g); D.ghosts = [];
  if (D.ownGhostEnt) { dropMeshes(D.ownGhostEnt); D.ownGhostEnt = null; }
  if (D.player) dropMeshes(D.player);
}
function gridSlot(k) { return { s: -14 - 8 * k, lat: k % 2 ? -2.6 : 2.6 }; }
function startRace(kind) {
  const tr = D.track; if (!tr) { toast('Load a circuit first.'); return; }
  clearField(); Snd.start();
  D.kind = kind || cfg.type; D.raceT = 0; D.lightsT = 0; D.accum = 0; D.results = null; D.finishT = null; D.fieldT = 0;
  D.lap = { n: 0, start: 0, best: D.kind === 'tt' ? D.ttBest : null, last: null, sectors: [], invalid: false, sectorStart: 0, lastSectors: [] };
  D.ghostRec = [];
  let slot = 0, field = 1;
  if (D.kind === 'ai') {
    field = cfg.rivals + 1;
    slot = cfg.gridPos === 'front' ? 0 : cfg.gridPos === 'middle' ? Math.floor(field / 2) : field - 1;
  }
  if (D.kind === 'online') {
    const ids = (Net.grid && Net.grid.length ? Net.grid : Net.peers.map(p => p.id));
    slot = Math.max(0, ids.indexOf(Net.id)); field = ids.length;
  }
  const rolling = D.kind === 'tt' || D.kind === 'ghosts';
  if (rolling) D.player = Sim.newCar(tr, -320, 0, 45);
  else { const g = gridSlot(slot); D.player = Sim.newCar(tr, g.s, g.lat, 0); }
  D.player.isPlayer = true;
  addMeshes(D.player, cfg.color, playerTla(), 1);
  if (D.kind === 'ai') {
    let k = 0;
    for (let n = 0; n < field; n++) {
      if (n === slot) continue;
      const g = gridSlot(n), i = k++;
      const ai = { kinematic: true, dist: g.s, lat: g.lat, v: 0, x: 0, z: 0, y: 0, h: 0, wait: 0.15 + Math.random() * 0.35,
        skill: (cfg.skill / 100) * (0.965 + Math.random() * 0.05) * (1 - n * 0.0025), tla: AI_NAMES[i % AI_NAMES.length], nx: 0, nz: 0 };
      addMeshes(ai, AI_COLORS[i % AI_COLORS.length], ai.tla, 1);
      D.ais.push(ai);
    }
    for (const ai of D.ais) { const p = new THREE.Vector3(), pose = Sim.poseAt(tr, ai.dist, ai.lat, p); ai.x = p.x; ai.z = p.z; ai.y = p.y; ai.h = pose.yaw; }
  }
  if (D.kind === 'ghosts') {
    for (const g of D.fieldGhosts || []) { const e = { g, dist: -1e9, lat: 0, v: 0 }; addMeshes(e, g.color, g.tla, 0.55); D.ghosts.push(e); }
  }
  if (D.kind === 'tt' && cfg.ownGhost && D.ownGhost) { D.ownGhostEnt = { dist: 0 }; addMeshes(D.ownGhostEnt, '#E9E6DF', 'PB', 0.4); }
  D.state = rolling ? 'race' : 'lights';
  D.goHold = 0.6 + Math.random() * 1.6;
  if (D.kind === 'online' && Net.startAt) { const ms = Net.startAt % 1000; D.goHold = 0.6 + ms / 1000 * 1.6; }
  D.lapStarted = !rolling; // rolling starts begin timing at the line
  if (!rolling) D.lap.start = 0;
  closeMenu();
  if (renderer.xr.isPresenting) recenter();
  UI.hud(true);
}
function endRace() { D.state = 'menu'; Snd.stop(); clearField(); UI.hud(false); UI.lights(-1); }
function togglePause() {
  if (!D.active) return;
  if (D.state === 'race' || D.state === 'lights' || D.state === 'finished') {
    if (D.kind === 'online') { D.menuOpen ? closeMenu() : openMenu(); return; } // online races don't pause
    D.paused = !D.paused; D.paused ? openMenu() : closeMenu();
  } else { D.menuOpen ? (D.track && closeMenu()) : openMenu(); }
}
function openMenu() { D.menuOpen = true; D.xrMenu = true; UI.menu(true); Snd.update(0, 0, false); placeXrMenu(); }
function closeMenu() { D.menuOpen = false; D.xrMenu = false; D.paused = false; UI.menu(false); }

function standings() {
  const L = D.track.length, rows = [];
  const add = (id, tla, color, dist, fin, you) => rows.push({ id, tla, color, dist, fin, you });
  if (D.player) add('you', playerTla(), cfg.color, D.player.dist, D.finishT, true);
  for (const a of D.ais) add(a.tla, a.tla, a.color, a.dist, a.fin ?? null, false);
  for (const g of D.ghosts) if (g.dist > -1e8) add(g.tla, g.tla, g.color, g.dist, null, false);
  if (D.kind === 'online') for (const [id, r] of D.remotes) add(id, r.tla, r.color, r.dist, Net.finishes.get(id) ?? null, false);
  rows.sort((a, b) => (a.fin != null && b.fin != null) ? a.fin - b.fin : (a.fin != null ? -1 : b.fin != null ? 1 : b.dist - a.dist));
  const lead = rows[0];
  for (const r of rows) {
    if (r === lead) r.gap = ''; else if (r.fin != null && lead.fin != null) r.gap = '+' + ((r.fin - lead.fin) / 1000).toFixed(1);
    else { const d = lead.dist - r.dist; r.gap = d > L ? '+' + Math.floor(d / L) + ' lap' + (d >= 2 * L ? 's' : '') : '+' + (d / Math.max(30, D.player ? D.player.v : 50)).toFixed(1); }
  }
  return rows;
}

/* ---------------- Per-step race logic ---------------- */
const tmpV = new THREE.Vector3();
function simStep(dt, inp) {
  const tr = D.track, L = tr.length, P = D.prof, c = D.player;
  if (D.state === 'lights') {
    let lt;
    if (D.kind === 'online' && Net.startAt) lt = (Net.now() - Net.startAt) / 1000;
    else lt = (D.lightsT += dt);
    UI.lights(lt < 0 ? 0 : Math.min(5, Math.floor(lt) + 1));
    if (lt >= 5 + D.goHold) { D.state = 'race'; D.raceT = 0; UI.lights(-1); UI.flash('Go!'); }
    else { c.v = 0; return; } // held on the grid until the lights go out
  }
  const racing = D.state === 'race' || D.state === 'finished';
  if (racing) D.raceT += dt;
  Sim.stepCar(c, D.state === 'finished' ? { steer: inp.steer, throttle: 0, brake: 0.25 } : inp, dt, tr);
  // timing
  const lapsDone = Math.floor(c.dist / L);
  if (!D.lapStarted && c.dist >= 0) { D.lapStarted = true; D.lap.start = D.raceT; D.lap.sectorStart = D.raceT; D.lap.invalid = false; c.invalid = false; D.ghostRec = []; D.fieldT0 = D.raceT; }
  if (D.lapStarted && lapsDone > D.lap.n) {
    const t = D.raceT - D.lap.start, valid = !c.invalid;
    D.lap.last = { time: t, valid };
    if (valid && (D.lap.best == null || t < D.lap.best)) {
      D.lap.best = t;
      if (D.kind === 'tt') {
        const rec = { time: t, ghost: D.ghostRec.slice() };
        try { store.set('drive:best:' + tr.circuitKey + ':' + Math.round(L), rec); } catch (e) {}
        D.ownGhost = rec; D.ttBest = t;
      }
      UI.flash((D.lap.n === 0 && D.kind !== 'tt') ? '' : 'Best lap ' + fmt(t));
    } else if (D.kind === 'tt') UI.flash((valid ? 'Lap ' : 'Lap (track limits) ') + fmt(t));
    D.lap.n = lapsDone; D.lap.start = D.raceT; c.invalid = false; D.ghostRec = [];
    D.lap.lastSectors = D.lap.sectors; D.lap.sectors = []; D.lap.sectorStart = D.raceT;
    if (D.kind !== 'tt' && D.lap.n >= cfg.laps && D.finishT == null) {
      D.finishT = D.raceT * 1000; D.state = 'finished'; UI.flash('Finished P' + (standings().findIndex(r => r.you) + 1));
      if (D.kind === 'online') Net.send({ t: 'finish', time: D.finishT });
      setTimeout(() => { if (D.active && D.state === 'finished') showResults(); }, 3500);
    }
  }
  if (D.lapStarted) {
    const sec = Math.floor((((c.dist % L) + L) % L) / (L / 3));
    if (sec > D.lap.sectors.length && sec <= 2) { D.lap.sectors.push(D.raceT - D.lap.sectorStart); D.lap.sectorStart = D.raceT; }
    if (D.kind === 'tt') {
      const lt = D.raceT - D.lap.start;
      if (!D.ghostRec.length || lt - D.ghostRec[D.ghostRec.length - 1][0] >= 0.05) D.ghostRec.push([Math.round(lt * 1000) / 1000, Math.round(c.x * 10) / 10, Math.round(c.z * 10) / 10, Math.round(c.h * 100) / 100, Math.round(c.y * 10) / 10]);
    }
  }
  // rivals
  if (D.ais.length) {
    const field = D.ais.concat([c]);
    if (D.state === 'race' || D.state === 'finished') {
      for (const a of D.ais) {
        const pose = Sim.poseAt(tr, a.dist, 0, tmpV); a.nx = tr.nrm[pose.i].x; a.nz = tr.nrm[pose.i].z;
        Sim.stepAI(a, dt, tr, P, field);
        if (a.fin == null && a.dist >= cfg.laps * L) a.fin = D.raceT * 1000;
      }
    }
    for (const a of D.ais) Sim.collide(c, a, 0.75);
  }
  if (D.kind === 'online') {
    for (const r of D.remotes.values()) if (r.live) Sim.collide(c, r, 1);
    Net.sendState(c);
  }
}
function showResults() {
  D.state = 'results'; Snd.stop();
  D.results = standings();
  if (D.kind === 'online') settleRaceBets(D.results);
  UI.results(D.results); openMenu();
}
const fmt = t => { if (t == null) return '–'; const m = Math.floor(t / 60), s = t - m * 60; return (m ? m + ':' + (s < 10 ? '0' : '') : '') + s.toFixed(3); };

/* ---------------- Cameras and views ---------------- */
const driveCam = new THREE.PerspectiveCamera(70, 1, 0.1, 16000); driveCam.layers.set(KB.REAL);
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(); let camYaw = 0, camInit = false;
function eyeFor(view, c, yaw, out) {
  const f = tmpV.set(Math.sin(yaw), 0, Math.cos(yaw));
  if (view === 'cockpit') return out.set(c.x, c.y + 0.98, c.z).addScaledVector(f, 0.45);
  return out.set(c.x, c.y + 2.6, c.z).addScaledVector(f, -7.5);
}
function updateFlatCam(dt) {
  KB.setGhostPost(D.view === 'cockpit' && D.player ? D.player.real : null);
  const c = D.player; if (!c) return;
  if (!camInit) { camYaw = c.h; camInit = true; }
  camYaw += wrapA(c.h - camYaw) * (D.view === 'cockpit' ? 1 : Math.min(1, dt * 6));
  eyeFor(D.view, c, camYaw, camPos);
  driveCam.position.copy(camPos);
  const ahead = D.view === 'cockpit' ? 30 : 8;
  camLook.set(c.x + Math.sin(camYaw) * ahead, Sim.trackY(D.track, c.prevS + ahead) + (D.view === 'cockpit' ? 0.85 : 0.9), c.z + Math.cos(camYaw) * ahead);
  driveCam.up.set(0, 1, 0); driveCam.lookAt(camLook);
}
function rcFollow() { // tabletop view on the iPad: keep the camera centred on your car
  const c = D.player; if (!c) return;
  KB.modelGroup.updateMatrixWorld();
  const w = KB.modelGroup.localToWorld(tmpV.set(c.x, c.y, c.z));
  KB.orbit.target.lerp(w, 0.2);
}

// Full-size views in the headset: the world moves so the car's eye point sits where your head was at recentre.
function recenter() {
  if (!renderer.xr.isPresenting) return;
  const h = KB.xrHead(), f = KB.xrForward();
  D.seat = { pos: h.clone(), yaw: Math.atan2(f.x, f.z) };
  placeXrMenu();
}
const seatTo = (x, y, z, out) => {
  const s = D.seat, c = Math.cos(s.yaw), n = Math.sin(s.yaw);
  return out.set(s.pos.x + x * c + z * n, s.pos.y + y, s.pos.z - x * n + z * c);
};
let xrYaw = 0;
function placeWorldXR(dt) {
  const c = D.player; if (!c || !D.seat) return;
  if (D.view === 'cockpit') xrYaw = c.h; else xrYaw += wrapA(c.h - xrYaw) * Math.min(1, dt * 4);
  const E = eyeFor(D.view, c, xrYaw, new THREE.Vector3());
  const th = D.seat.yaw - xrYaw, g = KB.modelGroup;
  g.scale.setScalar(1); g.rotation.set(0, th, 0);
  const cs = Math.cos(th), sn = Math.sin(th);
  g.position.set(D.seat.pos.x - (E.x * cs + E.z * sn), D.seat.pos.y - E.y, D.seat.pos.z - (-E.x * sn + E.z * cs));
}
function applyViewMode() {
  const full = fullSizeXR();
  if (App.forceRealModel !== full) { App.forceRealModel = full; KB.rebuildModelTrack(); }
  if (full) {
    KB.sky.layers.enable(0); KB.modelGround.visible = true; scene.fog = KB.FOG;
    for (const c of KB.controllers) c.userData.line.visible = D.xrMenu;
  } else {
    KB.layoutModel();
    if (renderer.xr.isPresenting) for (const c of KB.controllers) c.userData.line.visible = true;
  }
  layoutBoards();
}
function setView(v) {
  D.view = v; cfg.view = v; saveCfg(); camInit = false;
  if (renderer.xr.isPresenting && v === 'rc' && !App.placed) App.placing = true;
  applyViewMode(); UI.refresh();
}

/* ---------------- Comfort vignette (headset) ---------------- */
const vigMat = new THREE.ShaderMaterial({
  transparent: true, depthTest: false, depthWrite: false, uniforms: { k: { value: 0 } },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
  fragmentShader: 'uniform float k; varying vec2 vUv; void main(){ float d = distance(vUv, vec2(0.5)) * 2.0; float inner = mix(1.25, 0.42, k); float a = smoothstep(inner, inner + 0.28, d); gl_FragColor = vec4(0.0, 0.0, 0.0, a); }'
});
const vig = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.3), vigMat);
vig.position.z = -0.25; vig.renderOrder = 999; vig.frustumCulled = false; vig.visible = false;
camera.add(vig); if (!camera.parent) scene.add(camera);
let vigK = 0;
function updateVignette(dt) {
  const c = D.player, strength = { off: 0, low: 0.55, medium: 0.8, high: 1 }[cfg.comfort] || 0;
  const on = fullSizeXR() && c && strength > 0;
  vig.visible = !!on; if (!on) return;
  const want = clamp(Math.abs(c.yawRate) * 0.9 + Math.abs(c.latAcc) / 45, 0, 1) * strength;
  vigK += (want - vigK) * Math.min(1, dt * (want > vigK ? 6 : 2));
  vigMat.uniforms.k.value = vigK;
}

/* ---------------- Steering wheel (headset) ---------------- */
const wheel = (() => {
  const g = new THREE.Group();
  const rim = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.016, 8, 32), new THREE.MeshToonMaterial({ color: 0x24292d }));
  const hub = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.06, 0.03), new THREE.MeshToonMaterial({ color: 0xd2342b }));
  g.add(rim, hub); g.visible = false; scene.add(g); return g;
})();

/* ---------------- Headset panels (menu and HUD) ---------------- */
const XW = 1024, XH = 880, hudW = 768, hudH = 224;
const xmCanvas = document.createElement('canvas'); xmCanvas.width = XW; xmCanvas.height = XH;
const xmTex = new THREE.CanvasTexture(xmCanvas);
const xrMenuMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.62 * XH / XW), new THREE.MeshBasicMaterial({ map: xmTex, transparent: true, depthTest: false }));
xrMenuMesh.renderOrder = 1000; xrMenuMesh.visible = false; scene.add(xrMenuMesh);
const hudCanvas = document.createElement('canvas'); hudCanvas.width = hudW; hudCanvas.height = hudH;
const hudTex = new THREE.CanvasTexture(hudCanvas);
const hudMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.36, 0.36 * hudH / hudW), new THREE.MeshBasicMaterial({ map: hudTex, transparent: true, depthTest: false }));
hudMesh.renderOrder = 1000; hudMesh.visible = false; scene.add(hudMesh);
let xmHits = [], xmHover = null;
function placeXrMenu() {
  if (!renderer.xr.isPresenting) return;
  const h = KB.xrHead(), f = KB.xrForward();
  xrMenuMesh.position.copy(h).addScaledVector(f, 0.75); xrMenuMesh.position.y = h.y - 0.12;
  xrMenuMesh.lookAt(h);
}
function placeHud() {
  if (!renderer.xr.isPresenting) return;
  if (fullSizeXR() && D.seat) {
    seatTo(0, -0.3, 0.6, hudMesh.position); hudMesh.lookAt(D.seat.pos);
    seatTo(0, -0.42, 0.4, wheel.position); wheel.lookAt(D.seat.pos);
    wheel.rotateZ(D.wheelAngle != null ? D.wheelAngle : -D.player.steer * 1.15);
  } else {
    const h = KB.xrHead(), a = App.placed ? App.anchor : h.clone().addScaledVector(KB.xrForward(), 0.7);
    const toUser = h.clone().sub(a).setY(0).normalize();
    hudMesh.position.copy(a).addScaledVector(toUser, 0.45); hudMesh.position.y = a.y + 0.3; hudMesh.lookAt(h);
  }
}
function drawXrMenu() {
  const c = xmCanvas.getContext('2d'), hits = [];
  c.clearRect(0, 0, XW, XH);
  c.save(); KB.rr(c, 0, 0, XW, XH, 26); c.clip(); c.fillStyle = 'rgba(32,38,43,0.96)'; c.fillRect(0, 0, XW, XH);
  for (let x = 0; x < XW; x += 32) { c.fillStyle = (x / 32) % 2 ? '#E9E6DF' : '#D2342B'; c.fillRect(x, 0, 32, 12); }
  c.restore();
  c.fillStyle = '#E9E6DF'; c.font = '700 46px "Barlow Condensed", sans-serif'; c.textBaseline = 'alphabetic';
  const title = D.state === 'results' ? 'Results' : D.paused ? 'Paused' : 'Drive';
  c.fillText(title, 32, 70);
  c.font = '500 24px Barlow, sans-serif'; c.fillStyle = '#94A1A8';
  c.fillText((D.trackName || 'Circuit') + ' · ' + ({ tt: 'Time trial', ghosts: 'Real drivers', ai: 'AI race', online: 'Online ' + Net.code })[D.kind || cfg.type], 200, 66);
  const btn = (x, y, w, label, on, fn) => {
    const hv = xmHover && xmHover.x >= x && xmHover.x <= x + w && xmHover.y >= y && xmHover.y <= y + 64;
    KB.rr(c, x, y, w, 64, 12); c.fillStyle = on ? '#D2342B' : hv ? '#46525A' : '#2F383E'; c.fill();
    if (hv) { c.strokeStyle = '#E9E6DF'; c.lineWidth = 3; c.stroke(); }
    c.fillStyle = '#E9E6DF'; c.font = '600 28px "Barlow Condensed", sans-serif'; c.textAlign = 'center'; c.fillText(label, x + w / 2, y + 43); c.textAlign = 'left';
    hits.push({ x, y, w, h: 64, fn });
  };
  if (D.state === 'results' && D.results) {
    D.results.slice(0, 8).forEach((r, i) => {
      const y = 110 + i * 40;
      c.fillStyle = r.you ? '#E9E6DF' : '#94A1A8'; c.font = '600 28px "Barlow Condensed"';
      c.fillText((i + 1) + '', 40, y + 28); c.fillStyle = r.color; c.fillRect(80, y + 6, 6, 26);
      c.fillStyle = '#E9E6DF'; c.fillText(r.tla, 100, y + 28);
      c.fillStyle = '#94A1A8'; c.fillText(r.fin != null ? fmt(r.fin / 1000) : r.gap, 220, y + 28);
    });
  }
  let y = D.state === 'results' ? 440 : 110;
  const canResume = D.paused && D.kind !== 'online';
  btn(32, y, 220, canResume ? 'Resume' : (D.state === 'menu' || D.state === 'results') ? 'Start' : 'Close menu', true, () => { if (canResume) closeMenu(); else if (D.state === 'menu' || D.state === 'results') startFromMenu(); else closeMenu(); });
  btn(266, y, 200, 'Restart', false, () => startFromMenu());
  btn(480, y, 200, 'Recentre', false, recenter);
  btn(694, y, 298, 'Exit drive mode', false, () => Drive.close());
  if (D.state !== 'results') {
    const racing = D.state === 'race' || D.state === 'lights' || D.state === 'finished';
    if (!racing) { // choose the race here, without leaving the headset
      y += 108;
      c.fillStyle = '#94A1A8'; c.font = '600 26px "Barlow Condensed"'; c.fillText('Race', 32, y - 8);
      let rx = 32;
      for (const [v, l] of [['tt', 'Time trial'], ['ai', 'AI race']]) { btn(rx, y, 200, l, cfg.type === v, () => { cfg.type = v; saveCfg(); UI.refresh(); }); rx += 214; }
      btn(rx, y, 240, 'Race friends', cfg.type === 'online', raceFriends); rx += 254;
      if (cfg.type === 'ghosts') { c.fillStyle = '#94A1A8'; c.font = '500 22px Barlow, sans-serif'; c.fillText('Real drivers (set on the page)', rx, y + 40); }
      if (cfg.type === 'online') {
        y += 76; c.font = '500 24px Barlow, sans-serif'; c.fillStyle = '#E9E6DF';
        const names = Net.peers.map(p => p.name).join(', ');
        c.fillText(!Net.ws ? (UI.lobbyMsg || 'Not in a race room yet.') : `Room ${Net.code} · ${Net.peers.length} driver${Net.peers.length === 1 ? '' : 's'}: ${names.length > 44 ? names.slice(0, 43) + '…' : names}`, 32, y + 20);
        c.fillStyle = '#94A1A8'; if (Net.ws) c.fillText(Net.isHost() ? 'You’re the race host: press Start when everyone is in.' : 'Waiting for the race host to start.', 32, y + 50);
        const R = raceBets();
        if (R && Net.ws) { // chips on who wins
          y += 64; const mk = R.market();
          if (!mk) { if (Net.isHost() && Net.peers.length >= 2) btn(32, y, 240, 'Open bets', false, openRaceBets); else { c.fillText(Net.isHost() ? 'Bets open once a second driver joins.' : 'The race host can open bets on the winner.', 32, y + 40); } }
          else if (mk.status === 'open') {
            let bx = 32; mk.options.slice(0, 4).forEach(o => { btn(bx, y, 190, `${o.label.slice(0, 8)} +500`, R.staked(o.k) > 0, () => R.bet(o.k, 500)); bx += 200; });
            c.fillStyle = '#F2B233'; c.font = '500 22px Barlow, sans-serif'; c.fillText(`Pool ${mk.pool.toLocaleString()}`, bx + 8, y + 28); c.fillText(`You ${R.staked().toLocaleString()}`, bx + 8, y + 54);
          } else { c.fillStyle = '#F2B233'; c.fillText(`Bets are closed. Pool ${mk.pool.toLocaleString()} chips, your stake ${R.staked().toLocaleString()}.`, 32, y + 40); }
        }
      }
    }
    y += 108;
    c.fillStyle = '#94A1A8'; c.font = '600 26px "Barlow Condensed"'; c.fillText('View', 32, y - 8);
    let x = 32;
    for (const [v, l] of [['cockpit', 'Cockpit'], ['chase', 'Chase'], ['rc', 'Table (RC)']]) { btn(x, y, 200, l, D.view === v, () => setView(v)); x += 214; }
    if (D.view === 'rc') btn(x, y, 230, 'Place table', App.placing, () => { App.placing = true; App.placed = false; });
    y += 108;
    c.fillStyle = '#94A1A8'; c.fillText('Steering', 32, y - 8);
    x = 32;
    for (const [v, l] of [['wheel', 'Wheel (both hands)'], ['stick', 'Thumbstick']]) { btn(x, y, 270, l, cfg.quest === v, () => { cfg.quest = v; saveCfg(); }); x += 282; }
    btn(x, y, 196, cfg.drawTrack ? 'Track: on' : 'Track: off', cfg.drawTrack, () => setDrawTrack(!cfg.drawTrack)); x += 208;
    btn(x, y, 196, cfg.boards ? 'Boards: on' : 'Boards: off', cfg.boards, () => setBoards(!cfg.boards));
    y += 108;
    c.fillStyle = '#94A1A8'; c.fillText('Assists and comfort', 32, y - 8);
    x = 32;
    btn(x, y, 220, 'Auto throttle', cfg.autoThrottle, () => { cfg.autoThrottle = !cfg.autoThrottle; saveCfg(); UI.refresh(); }); x += 234;
    btn(x, y, 220, 'Brake assist', cfg.brakeAssist, () => { cfg.brakeAssist = !cfg.brakeAssist; saveCfg(); UI.refresh(); }); x += 234;
    btn(x, y, 220, 'Steer assist', cfg.steerAssist, () => { cfg.steerAssist = !cfg.steerAssist; saveCfg(); UI.refresh(); }); x += 234;
    const lv = ['off', 'low', 'medium', 'high'];
    btn(x, y, 258, 'Vignette: ' + cfg.comfort, cfg.comfort !== 'off', () => { cfg.comfort = lv[(lv.indexOf(cfg.comfort) + 1) % 4]; saveCfg(); });
  }
  c.font = '400 20px Barlow'; c.fillStyle = '#94A1A8';
  c.fillText('B / Y: menu · thumbstick press: recentre · right trigger: throttle · left trigger: brake.', 32, XH - 24);
  xmHits = hits; xmTex.needsUpdate = true;
}
function drawHud() {
  const c = hudCanvas.getContext('2d'), p = D.player;
  c.clearRect(0, 0, hudW, hudH);
  KB.rr(c, 0, 0, hudW, hudH, 22); c.fillStyle = 'rgba(32,38,43,0.88)'; c.fill();
  if (!p) { hudTex.needsUpdate = true; return; }
  const { gear } = gearRpm(p.v);
  c.fillStyle = '#E9E6DF'; c.font = '700 96px "Barlow Condensed", sans-serif'; c.textBaseline = 'alphabetic';
  c.fillText(String(Math.round(Math.abs(p.v) * 3.6)), 28, 112);
  c.font = '600 28px "Barlow Condensed"'; c.fillStyle = '#94A1A8'; c.fillText('km/h', 30, 148);
  c.font = '700 80px "Barlow Condensed"'; c.fillStyle = '#E9E6DF'; c.fillText(p.v < -0.5 ? 'R' : String(gear), 230, 108);
  const st = standings(), pos = st.findIndex(r => r.you) + 1;
  c.font = '700 54px "Barlow Condensed"';
  if (D.kind !== 'tt') c.fillText('P' + pos + '/' + st.length, 340, 72);
  c.font = '600 34px "Barlow Condensed"'; c.fillStyle = '#94A1A8';
  const lapNo = Math.min(D.lap.n + 1, D.kind === 'tt' ? 999 : cfg.laps);
  c.fillText(D.kind === 'tt' ? 'Lap ' + lapNo : 'Lap ' + lapNo + '/' + cfg.laps, 340, 118);
  c.fillStyle = D.player.invalid ? '#F2B233' : '#E9E6DF';
  c.fillText(D.lapStarted ? fmt(D.raceT - D.lap.start) : '–', 540, 72);
  c.fillStyle = '#94A1A8'; c.fillText('Best ' + fmt(D.lap.best), 540, 118);
  const lights = UI.lightsN || 0;
  if (D.state === 'lights') for (let i = 0; i < 5; i++) { c.beginPath(); c.arc(80 + i * 120, 190, 22, 0, Math.PI * 2); c.fillStyle = i < lights ? '#D2342B' : '#3A454C'; c.fill(); }
  else if (UI.flashText && performance.now() < UI.flashUntil) { c.fillStyle = '#E9E6DF'; c.font = '700 40px "Barlow Condensed"'; c.fillText(UI.flashText, 28, 200); }
  hudTex.needsUpdate = true;
}
const ray = new THREE.Raycaster(), rm = new THREE.Matrix4();
// Race friends: everyone in your hangout who chooses this lands in the same race room (it uses the
// hangout's room code), so there's nothing to type in the headset.
function raceFriends() {
  const code = window.KBHang && KBHang.active() ? KBHang.code() : '';
  if (!code) { toast('Racing friends needs a hangout: go back and choose Invite friends on the menu first.', 7000); return; }
  cfg.type = 'online'; saveCfg();
  if (!Net.ws || Net.code !== code) { Net.connect(code); Net.pendingSetup = true; }
  UI.refresh();
}
// Chips on a friends' race: the race host opens the bet, it closes at the start, and the winner settles it.
const raceBets = () => (window.KBPoker && KBPoker.race && window.KBHang && KBHang.active() ? KBPoker.race : null);
function openRaceBets() { const R = raceBets(); if (R && Net.isHost() && Net.peers.length >= 2) R.open(Net.peers.map(p => ({ k: String(p.id), label: p.name }))); }
function settleRaceBets(rows) {
  const R = raceBets(); if (!R || !R.mine()) return;
  const w = rows && rows[0];
  if (w && w.fin != null) R.settle(w.id === 'you' ? Net.id : w.id); else R.void();
}
function xrPointerTick() {
  let hp = null;
  for (const ctl of KB.controllers) {
    rm.identity().extractRotation(ctl.matrixWorld);
    ray.ray.origin.setFromMatrixPosition(ctl.matrixWorld); ray.ray.direction.set(0, 0, -1).applyMatrix4(rm);
    const hit = ray.intersectObjects([xrMenuMesh, hudMesh].filter(m => m.visible), false)[0];
    ctl.userData.line.scale.z = hit ? hit.distance : 2;
    if (hit && hit.object === xrMenuMesh && hit.uv) hp = { x: hit.uv.x * XW, y: (1 - hit.uv.y) * XH };
  }
  const k = hp ? xmHits.findIndex(b => hp.x >= b.x && hp.x <= b.x + b.w && hp.y >= b.y && hp.y <= b.y + b.h) : -2;
  xmHover = hp;
  if (k !== D.hoverKey) { D.hoverKey = k; if (D.xrMenu) drawXrMenu(); }
}
function onSelectXR(e) {
  const ctl = e.target;
  rm.identity().extractRotation(ctl.matrixWorld);
  ray.ray.origin.setFromMatrixPosition(ctl.matrixWorld); ray.ray.direction.set(0, 0, -1).applyMatrix4(rm);
  const hit = ray.intersectObjects([xrMenuMesh, hudMesh].filter(m => m.visible), false)[0];
  if (hit && hit.object === xrMenuMesh && hit.uv) {
    const px = hit.uv.x * XW, py = (1 - hit.uv.y) * XH;
    const b = xmHits.find(b => px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h);
    if (b) { b.fn(); drawXrMenu(); }
    return;
  }
  if (hit && hit.object === hudMesh) { togglePause(); return; }
  if (App.placing && D.view === 'rc') { KB.placeAtReticle(); return; }
}

/* ---------------- Page UI ---------------- */
const UI = {
  built: false,
  build() {
    if (this.built) return; this.built = true;
    const css = document.createElement('style');
    css.textContent = `
body.driving #bar, body.driving #dock, body.driving #board, body.driving #transport { display: none !important; }
#drive { position: fixed; inset: 0; z-index: 20; pointer-events: none; font: 400 15px/1.4 var(--body); color: var(--chalk); }
#drive * { box-sizing: border-box; }
#drive button { pointer-events: auto; font: 600 17px/1 var(--cond); color: var(--chalk); cursor: pointer; }
#dMenu { pointer-events: auto; position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(560px, calc(100% - 24px)); max-height: calc(100% - 24px); overflow: auto; background: rgba(32,38,43,.97); border: 1px solid var(--tarmac-3); border-radius: 12px; padding: 18px 18px 14px; }
#dMenu[hidden] { display: none; }
#dMenu h2 { margin: 0; font: 700 32px/1 var(--cond); }
#dMenu h4 { margin: 16px 0 8px; font: 600 17px/1.1 var(--cond); color: var(--muted); }
#dMenu .sub { color: var(--muted); margin: 4px 0 0; font-size: 14px; }
#dMenu .seg { display: flex; flex-wrap: wrap; background: var(--tarmac-2); border-radius: 8px; padding: 3px; gap: 3px; }
#dMenu .seg button { flex: 1 1 auto; border: 0; background: none; border-radius: 6px; padding: 9px 8px; color: var(--muted); }
#dMenu .seg button.on { background: var(--chalk); color: var(--tarmac); }
#dMenu label { display: block; color: var(--muted); font-size: 13px; margin: 8px 0; }
#dMenu select, #dMenu input[type=text] { display: block; width: 100%; margin-top: 4px; background: var(--tarmac-2); border: 1px solid var(--tarmac-3); border-radius: 6px; padding: 9px; color: var(--chalk); font: inherit; font-size: 15px; }
#dMenu input[type=range] { width: 100%; accent-color: var(--kerb); }
#dMenu .chk { display: flex; align-items: center; gap: 8px; color: var(--chalk); font-size: 14px; margin: 6px 0; }
#dMenu .row { display: flex; gap: 8px; flex-wrap: wrap; }
#dMenu .row > * { flex: 1 1 140px; }
#dMenu .go { border: 0; background: var(--kerb); border-radius: 8px; padding: 13px; font-size: 20px; }
#dMenu .ghost { border: 1px solid var(--tarmac-3); background: none; border-radius: 8px; padding: 11px; }
#dMenu .sw { display: flex; gap: 6px; flex-wrap: wrap; }
#dMenu .sw button { width: 34px; height: 34px; border-radius: 50%; border: 2px solid transparent; }
#dMenu .sw button.on { border-color: var(--chalk); }
#dMenu .code { font: 700 46px/1 var(--cond); letter-spacing: .12em; }
#dMenu ol { margin: 6px 0; padding-left: 22px; }
#dMenu .res li { display: grid; grid-template-columns: 6px 54px 1fr; gap: 8px; align-items: center; padding: 3px 0; }
#dMenu .res .you { font-weight: 600; }
#dHud { position: absolute; left: 0; right: 0; top: calc(10px + env(safe-area-inset-top, 0px)); display: flex; justify-content: center; gap: 10px; }
#dHud[hidden] { display: none; }
#dHud .box { background: rgba(32,38,43,.85); border-radius: 8px; padding: 6px 12px; font: 600 22px/1.1 var(--cond); font-variant-numeric: tabular-nums; text-align: center; }
#dHud .box small { display: block; font: 500 12px/1 var(--body); color: var(--muted); }
#dPause { position: absolute; left: calc(10px + env(safe-area-inset-left, 0px)); top: calc(10px + env(safe-area-inset-top, 0px)); background: rgba(32,38,43,.85); border: 1px solid var(--tarmac-3); border-radius: 8px; padding: 10px 14px; }
#dStand { position: absolute; right: calc(10px + env(safe-area-inset-right, 0px)); top: calc(64px + env(safe-area-inset-top, 0px)); background: rgba(32,38,43,.8); border-radius: 8px; padding: 6px 8px; list-style: none; margin: 0; min-width: 130px; font: 600 15px/1.35 var(--cond); font-variant-numeric: tabular-nums; }
#dStand:empty { display: none; }
#dStand li { display: grid; grid-template-columns: 20px 4px 40px 1fr; gap: 6px; align-items: center; }
#dStand li.you { color: var(--flag); }
#dStand .c { height: 14px; }
#dStand .g { color: var(--muted); text-align: right; }
#dSpeed { position: absolute; left: 50%; bottom: calc(14px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); background: rgba(32,38,43,.85); border-radius: 10px; padding: 6px 16px; font: 700 40px/1 var(--cond); font-variant-numeric: tabular-nums; display: flex; gap: 16px; align-items: baseline; }
#dSpeed small { font: 500 13px/1 var(--body); color: var(--muted); }
#dSpeed[hidden] { display: none; }
#dLights { position: absolute; left: 50%; top: 32%; transform: translateX(-50%); display: flex; gap: 14px; background: rgba(20,22,24,.85); padding: 14px 18px; border-radius: 14px; }
#dLights[hidden] { display: none; }
#dLights i { width: 44px; height: 44px; border-radius: 50%; background: #3A454C; }
#dLights i.on { background: var(--kerb); box-shadow: 0 0 18px var(--kerb); }
#dFlash { position: absolute; left: 50%; top: 22%; transform: translateX(-50%); font: 700 44px/1 var(--cond); text-shadow: 0 2px 8px rgba(0,0,0,.6); opacity: 0; transition: opacity .25s; white-space: nowrap; }
#dFlash.show { opacity: 1; }
#dTouch { position: absolute; inset: auto 0 0 0; height: 46%; display: flex; justify-content: space-between; align-items: flex-end; padding: 0 calc(12px + env(safe-area-inset-right, 0px)) calc(14px + env(safe-area-inset-bottom, 0px)) calc(12px + env(safe-area-inset-left, 0px)); }
#dTouch[hidden] { display: none; }
#dTouch .grp { display: flex; gap: 12px; align-items: flex-end; }
#dTouch button { pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none; border: 2px solid rgba(233,230,223,.4); background: rgba(32,38,43,.55); border-radius: 18px; font-size: 22px; }
#dTouch .st { width: 96px; height: 96px; }
#dTouch .pedal { width: 104px; height: 150px; }
#dTouch .pedal.gas { height: 190px; border-color: rgba(79,125,69,.9); }
#dTouch .pedal.brk { border-color: rgba(210,52,43,.9); }
#dTouch button.on { background: rgba(233,230,223,.35); }
#dTouch .centre { position: absolute; left: 50%; bottom: calc(80px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); padding: 8px 12px; font-size: 15px; border-radius: 8px; }
@media (max-height: 520px) { #dTouch .pedal { height: 110px; } #dTouch .pedal.gas { height: 140px; } #dTouch .st { width: 80px; height: 80px; } }
`;
    document.head.appendChild(css);
    const root = document.createElement('div'); root.id = 'drive';
    root.innerHTML = `
<div id="dHud" hidden>
  <div class="box"><span id="hPos">–</span><small>position</small></div>
  <div class="box"><span id="hLap">–</span><small>lap</small></div>
  <div class="box"><span id="hTime">–</span><small id="hTimeL">lap time</small></div>
  <div class="box"><span id="hBest">–</span><small>best</small></div>
</div>
<button id="dPause" hidden>Menu</button>
<ol id="dStand"></ol>
<div id="dSpeed" hidden><span><span id="hKmh">0</span> <small>km/h</small></span><span><span id="hGear">1</span> <small>gear</small></span></div>
<div id="dLights" hidden><i></i><i></i><i></i><i></i><i></i></div>
<div id="dFlash"></div>
<div id="dTouch" hidden>
  <div class="grp"><button class="st" data-k="left">◀</button><button class="st" data-k="right">▶</button></div>
  <button class="centre" id="dCentre">Centre tilt</button>
  <div class="grp"><button class="pedal brk" data-k="brake">Brake</button><button class="pedal gas" data-k="gas">Throttle</button></div>
</div>
<div id="dMenu"></div>`;
    document.body.appendChild(root);
    root.querySelectorAll('#dTouch [data-k]').forEach(b => {
      const k = b.dataset.k, on = v => { touch[k] = v; b.classList.toggle('on', v); };
      b.addEventListener('pointerdown', e => { e.preventDefault(); b.setPointerCapture(e.pointerId); on(true); });
      for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) b.addEventListener(t, () => on(false));
    });
    $('#dCentre').onclick = () => { Tilt.centre(); this.flash('Tilt centred'); };
    $('#dPause').onclick = () => togglePause();
  },
  menu(show) {
    $('#dMenu').hidden = !show;
    if (show) this.refresh();
    xrMenuMesh.visible = show && renderer.xr.isPresenting;
    if (xrMenuMesh.visible) { placeXrMenu(); drawXrMenu(); }
  },
  hud(show) {
    $('#dHud').hidden = $('#dSpeed').hidden = $('#dPause').hidden = !show;
    if (!show) $('#dStand').replaceChildren();
    this.touchControls();
  },
  touchControls() {
    const racing = D.state !== 'menu' && D.state !== 'results';
    $('#dTouch').hidden = !(racing && isTouch() && !renderer.xr.isPresenting);
    $('#dTouch .grp').style.visibility = cfg.touch === 'buttons' ? 'visible' : 'hidden';
    $('#dCentre').hidden = cfg.touch !== 'tilt';
  },
  lightsN: 0,
  lights(n) {
    this.lightsN = n; const el = $('#dLights'); el.hidden = n < 0;
    el.querySelectorAll('i').forEach((i, k) => i.classList.toggle('on', k < n));
  },
  flash(text) {
    if (!text) return;
    this.flashText = text; this.flashUntil = performance.now() + 2200;
    const f = $('#dFlash'); f.textContent = text; f.classList.add('show');
    clearTimeout(this.ft); this.ft = setTimeout(() => f.classList.remove('show'), 2000);
  },
  tick() {
    const p = D.player; if (!p) return;
    const { gear } = gearRpm(p.v);
    $('#hKmh').textContent = Math.round(Math.abs(p.v) * 3.6); $('#hGear').textContent = p.v < -0.5 ? 'R' : gear;
    const st = standings(), pos = st.findIndex(r => r.you) + 1;
    $('#hPos').textContent = D.kind === 'tt' ? 'TT' : 'P' + pos + '/' + st.length;
    $('#hLap').textContent = D.kind === 'tt' ? String(D.lap.n + 1) : Math.min(D.lap.n + 1, cfg.laps) + '/' + cfg.laps;
    $('#hTime').textContent = D.lapStarted ? fmt(D.raceT - D.lap.start) : '–';
    $('#hTime').style.color = p.invalid ? 'var(--flag)' : '';
    $('#hTimeL').textContent = p.invalid ? 'track limits' : 'lap time';
    $('#hBest').textContent = fmt(D.lap.best);
    if (D.kind !== 'tt') {
      const you = st.findIndex(r => r.you), lo = Math.max(0, Math.min(you - 2, st.length - 5)), show = st.slice(lo, lo + 5);
      $('#dStand').innerHTML = show.map((r, i) => `<li class="${r.you ? 'you' : ''}"><span>${lo + i + 1}</span><span class="c" style="background:${r.color}"></span><span>${r.tla}</span><span class="g">${r.gap}</span></li>`).join('');
    }
  },
  lobby(msg) { this.lobbyMsg = msg || ''; if (!$('#dMenu').hidden) this.refresh(); },
  results(rows) { this.resultRows = rows; },
  refresh() {
    if (!this.built) return;
    const m = $('#dMenu'), tr = D.track, sessions = KB.getSessions();
    const seg = (name, opts, val) => `<div class="seg" data-seg="${name}">${opts.map(([v, l]) => `<button data-v="${v}" class="${String(val) === String(v) ? 'on' : ''}">${l}</button>`).join('')}</div>`;
    const circuits = []; const seen = new Set();
    for (const s of sessions) if (!seen.has(s.circuit_key)) { seen.add(s.circuit_key); circuits.push(s); }
    const sameCircuit = tr ? sessions.filter(s => String(s.circuit_key) === String(tr.circuitKey)) : [];
    const ghostSessions = sameCircuit.length ? sameCircuit : [];
    const racing = D.state === 'race' || D.state === 'lights' || D.state === 'finished';
    let h = '';
    if (D.state === 'results' && this.resultRows) {
      h += `<h2>Results</h2><p class="sub">${D.trackName || 'Circuit'} · ${cfg.laps} laps</p><ol class="res">` +
        this.resultRows.map(r => `<li class="${r.you ? 'you' : ''}"><span style="background:${r.color};height:18px"></span><span>${r.tla}</span><span>${r.fin != null ? fmt(r.fin / 1000) : r.gap || 'running'}</span></li>`).join('') + '</ol>';
      if (D.lap.best != null) h += `<p class="sub">Your best lap ${fmt(D.lap.best)}</p>`;
    } else {
      h += `<h2>${D.paused ? 'Paused' : 'Drive'}</h2><p class="sub">${tr ? (D.trackName || 'Loaded circuit') : 'Choose a circuit to drive.'}</p>`;
    }
    if (!racing) {
      h += `<h4>Circuit</h4><div class="row"><select id="dCirc">${circuits.map(s => `<option value="${s.session_key}" ${tr && String(s.circuit_key) === String(tr.circuitKey) ? 'selected' : ''}>${s.circuit_short_name || s.location} (${new Date(s.date_start).getFullYear()})</option>`).join('')}</select><button class="ghost" id="dLoadCirc">Load</button></div>`;
      h += `<h4>Race</h4>` + seg('type', [['tt', 'Time trial'], ['ghosts', 'Real drivers'], ['ai', 'AI race'], ['online', 'Online']], cfg.type);
      if (cfg.type === 'tt') h += `<label class="chk"><input type="checkbox" id="dOwnGhost" ${cfg.ownGhost ? 'checked' : ''}> Race my best-lap ghost</label><p class="sub">Flying laps. Leaving the track for more than a moment cancels the lap.</p>`;
      if (cfg.type !== 'tt' && !(cfg.type === 'online' && Net.ws && !Net.isHost())) h += `<h4>Laps</h4>` + seg('laps', [[1, '1'], [3, '3'], [5, '5'], [10, '10']], cfg.laps);
      if (cfg.type === 'ghosts') {
        h += `<label>Session to race<select id="dGhostSess">${ghostSessions.length ? ghostSessions.map(s => `<option value="${s.session_key}">${s.session_name} (${new Date(s.date_start).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })})</option>`).join('') : '<option value="">No sessions at this circuit this season</option>'}</select></label>`;
        h += `<label>Their pace: <b id="dPaceV">${cfg.pace}%</b> of real<input type="range" id="dPace" min="60" max="100" value="${cfg.pace}"></label>`;
        h += `<p class="sub">Every driver's fastest lap from that session, all starting at the line with you. Ghosts don't collide. Downloads once per session, about 20 to 60 seconds.</p>`;
      }
      if (cfg.type === 'ai') {
        h += `<label>Rivals: <b id="dRivV">${cfg.rivals}</b><input type="range" id="dRiv" min="1" max="19" value="${cfg.rivals}"></label>`;
        h += `<label>Difficulty: <b id="dSkillV">${cfg.skill}</b><input type="range" id="dSkill" min="70" max="100" value="${cfg.skill}"></label>`;
        h += `<h4>Start from</h4>` + seg('gridPos', [['back', 'Back'], ['middle', 'Middle'], ['front', 'Pole']], cfg.gridPos);
      }
      if (cfg.type === 'online') {
        h += `<label>Your name<input type="text" id="dName" maxlength="12" value="${(cfg.name || '').replace(/"/g, '')}" placeholder="Shown to other players"></label>`;
        if (!Net.ws) {
          h += `<div class="row"><button class="go" id="dCreate">Create room</button></div><div class="row" style="margin-top:8px"><input type="text" id="dCode" maxlength="4" placeholder="Room code" style="text-transform:uppercase"><button class="ghost" id="dJoin">Join</button></div>`;
          h += `<p class="sub">Uses your relay and its key, so friends need your share link first. Computer rivals aren't available online.</p>`;
        } else {
          h += `<p class="sub">Room code</p><div class="code">${Net.code}</div><ol>${Net.peers.map(p => `<li><span style="color:${p.color}">●</span> ${p.name}${p.id === Net.host ? ' (host)' : ''}${p.id === Net.id ? ' (you)' : ''}</li>`).join('')}</ol>`;
          h += `<p class="sub">${this.lobbyMsg || (Net.isHost() ? 'Share the code. Start when everyone has joined.' : (Net.setup ? 'Waiting for the host to start.' : 'Waiting for the host to choose a circuit.'))}</p>`;
          const R = raceBets(), mk = R && R.market();
          if (R && !mk && Net.isHost() && Net.peers.length >= 2) h += `<div class="row"><button class="ghost" id="dBets">Open bets on the winner</button></div>`;
          else if (mk) h += `<p class="sub">Bets on the winner are ${mk.status === 'open' ? 'open' : 'closed'}: pool ${mk.pool.toLocaleString()} chips. Place them under Poker and race bets.</p>`;
          h += `<div class="row"><button class="ghost" id="dLeave">Leave room</button></div>`;
        }
      }
    }
    h += `<h4>View</h4>` + seg('view', [['cockpit', 'Cockpit'], ['chase', 'Chase'], ['rc', 'Table (RC)']], D.view);
    h += `<h4>Controls</h4>`;
    if (isTouch()) {
      h += seg('touch', [['tilt', 'Tilt to steer'], ['buttons', 'Steering buttons']], cfg.touch);
      if (cfg.touch === 'tilt') h += `<label class="chk"><input type="checkbox" id="dTiltInv" ${cfg.tiltInv ? 'checked' : ''}> Reverse tilt direction</label>`;
    }
    h += `<p class="sub">Keyboard: arrows or WASD. Game controller: left stick, right trigger, left trigger. Quest: choose wheel or thumbstick in the headset menu; hands work as a wheel, pinch for throttle (right) and brake (left).</p>`;
    h += `<label class="chk"><input type="checkbox" id="dAuto" ${cfg.autoThrottle ? 'checked' : ''}> Auto throttle</label>`;
    h += `<label class="chk"><input type="checkbox" id="dBrk" ${cfg.brakeAssist ? 'checked' : ''}> Braking assist</label>`;
    h += `<label class="chk"><input type="checkbox" id="dSteer" ${cfg.steerAssist ? 'checked' : ''}> Steering assist</label>`;
    h += `<label class="chk"><input type="checkbox" id="dSound" ${cfg.sound ? 'checked' : ''}> Engine sound</label>`;
    h += `<h4>Circuit display</h4><label class="chk"><input type="checkbox" id="dTrack" ${cfg.drawTrack ? 'checked' : ''}> Draw the track</label>`;
    h += `<label class="chk"><input type="checkbox" id="dBoards" ${cfg.boards ? 'checked' : ''}> Braking boards (200, 100, 50 m)</label>`;
    if (tr && D.boards) h += `<p class="sub">${D.boardCorners ? `Boards before ${D.boardCorners} braking corner${D.boardCorners > 1 ? 's' : ''} on this circuit.` : 'No corners here need heavy braking, so there are no boards.'}</p>`;
    if (!racing) h += `<h4>Your car</h4><div class="sw">${TEAM.map(([n, c]) => `<button data-col="${c}" title="${n}" style="background:${c}" class="${cfg.color === c ? 'on' : ''}"></button>`).join('')}</div>`;
    h += `<div class="row" style="margin-top:18px">`;
    if (D.paused) h += `<button class="go" id="dResume">Resume</button><button class="ghost" id="dRestart">Restart</button>`;
    else if (racing && D.kind === 'online') h += `<button class="go" id="dResume">Back to race</button>`;
    else if (cfg.type === 'online') { if (Net.ws && Net.isHost()) h += `<button class="go" id="dStart">Start race</button>`; }
    else h += `<button class="go" id="dStart">${D.state === 'results' ? 'Race again' : 'Start'}</button>`;
    h += `</div><div class="row" style="margin-top:8px">`;
    if (App.xrSupported && !renderer.xr.isPresenting) h += `<button class="ghost" id="dXR">${App.arOK ? 'Enter mixed reality' : 'Enter VR'}</button>`;
    h += `<button class="ghost" id="dExit">Exit drive mode</button></div><p class="sub" style="margin-top:10px">Drive mode build ${DRIVE_BUILD}</p>`;
    m.innerHTML = h;
    this.wire();
  },
  wire() {
    const m = $('#dMenu');
    m.querySelectorAll('[data-seg]').forEach(s => s.querySelectorAll('button').forEach(b => b.onclick = () => {
      const k = s.dataset.seg, v = b.dataset.v;
      if (k === 'view') setView(v);
      else { cfg[k] = k === 'laps' ? +v : v; saveCfg(); if (k === 'touch' && v === 'tilt') Tilt.enable().catch(e => toast(e.message, 7000)); if (k === 'laps' && Net.isHost()) Net.publishSetup(); }
      this.refresh();
    }));
    const on = (id, ev, fn) => { const el = m.querySelector('#' + id); if (el) el[ev] = fn; };
    on('dLoadCirc', 'onclick', async () => {
      const sk = +$('#dCirc').value, s = KB.getSessions().find(x => x.session_key === sk); if (!s) return;
      this.flash('Loading circuit…');
      try { await loadCircuitFor(s); D.fieldGhosts = null; if (Net.isHost()) Net.publishSetup(); this.flash('Circuit ready'); } catch (e) { toast(e.message, 7000); }
      this.refresh();
    });
    on('dOwnGhost', 'onchange', e => { cfg.ownGhost = e.target.checked; saveCfg(); });
    on('dPace', 'oninput', e => { cfg.pace = +e.target.value; $('#dPaceV').textContent = cfg.pace + '%'; saveCfg(); });
    on('dRiv', 'oninput', e => { cfg.rivals = +e.target.value; $('#dRivV').textContent = cfg.rivals; saveCfg(); });
    on('dSkill', 'oninput', e => { cfg.skill = +e.target.value; $('#dSkillV').textContent = cfg.skill; saveCfg(); });
    on('dName', 'onchange', e => { cfg.name = e.target.value.trim(); saveCfg(); if (Net.ws) Net.send({ t: 'hello', name: playerName(), color: cfg.color }); });
    on('dTiltInv', 'onchange', e => { cfg.tiltInv = e.target.checked; saveCfg(); });
    on('dAuto', 'onchange', e => { cfg.autoThrottle = e.target.checked; saveCfg(); });
    on('dBrk', 'onchange', e => { cfg.brakeAssist = e.target.checked; saveCfg(); });
    on('dSteer', 'onchange', e => { cfg.steerAssist = e.target.checked; saveCfg(); });
    on('dSound', 'onchange', e => { cfg.sound = e.target.checked; saveCfg(); if (!cfg.sound) Snd.stop(); });
    on('dTrack', 'onchange', e => setDrawTrack(e.target.checked));
    on('dBoards', 'onchange', e => setBoards(e.target.checked));
    m.querySelectorAll('[data-col]').forEach(b => b.onclick = () => { cfg.color = b.dataset.col; saveCfg(); if (Net.ws) Net.send({ t: 'hello', name: playerName(), color: cfg.color }); this.refresh(); });
    on('dCreate', 'onclick', () => {
      if (!D.track) { toast('Load a circuit first; the room uses it.'); return; }
      Net.connect(roomCode()); Net.pendingSetup = true;
    });
    on('dJoin', 'onclick', () => { const c = ($('#dCode').value || '').toUpperCase().replace(/[^A-Z]/g, ''); if (c.length !== 4) { toast('Room codes are 4 letters.'); return; } Net.connect(c); });
    on('dLeave', 'onclick', () => { Net.leave(); this.refresh(); });
    on('dBets', 'onclick', () => { openRaceBets(); setTimeout(() => this.refresh(), 400); });
    on('dStart', 'onclick', () => startFromMenu());
    on('dResume', 'onclick', () => closeMenu());
    on('dRestart', 'onclick', () => startFromMenu());
    on('dXR', 'onclick', () => KB.enterXR());
    on('dExit', 'onclick', () => Drive.close());
  }
};
async function startFromMenu() {
  if (!D.track) { toast('Load a circuit first.'); return; }
  Snd.start();
  if (isTouch() && cfg.touch === 'tilt' && !renderer.xr.isPresenting) {
    try { await Tilt.enable(); } catch (e) { toast(e.message, 8000); cfg.touch = 'buttons'; saveCfg(); }
  }
  if (cfg.type === 'online') {
    if (!Net.ws) { toast('Create or join a room first.'); return; }
    if (!Net.isHost()) { toast('The host starts the race.'); return; }
    Net.publishSetup(); Net.send({ t: 'start' }); return;
  }
  if (cfg.type === 'ghosts') {
    const sel = $('#dGhostSess'), sk = sel ? +sel.value : 0, sess = KB.getSessions().find(s => s.session_key === sk);
    if (!sess) { toast('Choose a session from this circuit to race.'); return; }
    if (!D.fieldGhosts || D.fieldGhostsKey !== sk) {
      try {
        UI.flash('Downloading laps…');
        D.fieldGhosts = await loadFieldGhosts(sess, (n, t) => { $('#dMenu .sub').textContent = `Downloading laps ${n} of ${t}…`; });
        D.fieldGhostsKey = sk;
      } catch (e) { toast('Couldn’t get the laps: ' + e.message + '. OpenF1 locks its free data during live sessions.', 9000); return; }
    }
  }
  if (D.state !== 'menu') endRace();
  startRace(cfg.type);
}

/* ---------------- Per-frame ---------------- */
let uiT = 0;
function frame(dt, xrFrame) {
  const tr = D.track, xr = renderer.xr.isPresenting;
  if (xr) {
    if (D.wasXR !== true) {
      D.wasXR = true; D.seat = null; applyViewMode(); UI.touchControls();
      App.placing = D.view === 'rc' && !App.placed; // only the table view needs a table
      if (D.menuOpen) { xrMenuMesh.visible = true; placeXrMenu(); drawXrMenu(); }
      setTimeout(() => toast(D.view === 'rc' ? 'Point at a table and pull the trigger (or pinch) to place the circuit.' : 'Sit comfortably, then press Start. Press a thumbstick in to recentre.', 7000), 50);
    }
    if (!D.seat) { const h = KB.xrHead(); if (h.lengthSq() > 0) recenter(); }
    KB.placementTick(xrFrame);
    xrPointerTick();
    const showRays = !fullSizeXR() || D.xrMenu; // hide pointer lines while driving full size
    for (const c of KB.controllers) c.userData.line.visible = showRays;
  } else if (D.wasXR) { D.wasXR = false; D.seat = null; xrMenuMesh.visible = hudMesh.visible = wheel.visible = vig.visible = false; applyViewMode(); UI.touchControls(); }
  const xin = xr ? xrInput(xrFrame) : null;
  const running = tr && D.player && (D.state === 'race' || D.state === 'lights' || D.state === 'finished') && !D.paused;
  if (running) {
    const inp = applyAssists(gatherInput(dt, xin), D.player);
    D.accum = Math.min(D.accum + dt, 0.1);
    const STEP = 1 / 120;
    while (D.accum >= STEP) { simStep(STEP, inp); D.accum -= STEP; }
    const { rpm } = gearRpm(D.player.v);
    Snd.update(rpm, D.state === 'race' ? inp.throttle : 0.2, true);
  }
  // others
  if (tr && D.player) {
    if (D.kind === 'ghosts' && D.lapStarted) {
      const t = (D.raceT - (D.fieldT0 || 0)) * 1000 * (cfg.pace / 100);
      for (const e of D.ghosts) {
        const g = ghostAt(e.g, t); e.dist = g.dist; e.lat = g.lat;
        const p = tmpV, pose = Sim.poseAt(tr, e.dist, e.lat, p);
        placeMesh(e, p.x, p.y, p.z, pose.yaw, true);
      }
    } else for (const e of D.ghosts) placeMesh(e, 0, 0, 0, 0, false);
    if (D.ownGhostEnt) {
      const g = D.ownGhost && D.ownGhost.ghost, t = D.raceT - D.lap.start;
      if (g && g.length > 2 && D.lapStarted && t <= g[g.length - 1][0]) {
        let lo = 0, hi = g.length - 1; while (lo < hi - 1) { const mm = (lo + hi) >> 1; if (g[mm][0] <= t) lo = mm; else hi = mm; }
        const a = g[lo], b = g[hi], f = b[0] > a[0] ? clamp((t - a[0]) / (b[0] - a[0]), 0, 1) : 0;
        placeMesh(D.ownGhostEnt, a[1] + (b[1] - a[1]) * f, a[4] + (b[4] - a[4]) * f, a[2] + (b[2] - a[2]) * f, a[3] + wrapA(b[3] - a[3]) * f, true);
      } else placeMesh(D.ownGhostEnt, 0, 0, 0, 0, false);
    }
    for (const a of D.ais) placeMesh(a, a.x, a.y, a.z, a.h, true);
    for (const r of D.remotes.values()) { r.live = Net.interp(r); placeMesh(r, r.x, r.y, r.z, r.h, r.live); }
    const p = D.player;
    placeMesh(p, p.x, p.y, p.z, p.h, true);
  }
  // online: the host's room setup arrives once the socket is open
  if (Net.pendingSetup && Net.ws && Net.ws.readyState === 1 && Net.id != null) { Net.pendingSetup = false; Net.publishSetup(); }
  if (performance.now() - uiT > 200) {
    uiT = performance.now();
    if (D.state !== 'menu' && D.state !== 'results') UI.tick();
    if (xr) { hudMesh.visible = !!D.player && D.state !== 'menu' && D.state !== 'results'; if (hudMesh.visible) drawHud(); if (D.xrMenu) drawXrMenu(); }
  }
  // render
  if (xr) {
    KB.setGhostPost(null);
    const full = fullSizeXR();
    if (full) placeWorldXR(dt);
    if (hudMesh.visible) placeHud();
    wheel.visible = full && D.view === 'cockpit' && D.state !== 'menu' && D.state !== 'results';
    xrMenuMesh.visible = D.xrMenu;
    updateVignette(dt);
    renderer.render(scene, camera);
  } else if (D.view === 'rc' || !D.player) {
    if (D.player && D.state !== 'menu') rcFollow();
    KB.flatCamTick();
    renderer.render(scene, camera);
  } else {
    updateFlatCam(dt);
    driveCam.aspect = camera.aspect; driveCam.updateProjectionMatrix();
    const fog = scene.fog; scene.fog = KB.FOG;
    renderer.render(scene, driveCam);
    scene.fog = fog;
  }
}

/* ---------------- Open and close ---------------- */
const Drive = {
  active: false,
  open() {
    UI.build();
    this.active = D.active = true;
    document.body.classList.add('driving');
    for (const c of KB.Cars.values()) { if (c.model) c.model.visible = c.real.visible = c.label.visible = false; }
    if (KB.Replay) KB.Replay.playing = false;
    KB.uiMesh.visible = false; KB.chaseMesh.visible = false;
    if (App.track && App.track !== D.track) setDriveTrack(App.track, (App.modeLabel || '').replace(/^(Replay|Live):\s*/, '').split(',')[0]);
    D.state = 'menu'; D.view = cfg.view; camInit = false;
    App.trackOverride = cfg.drawTrack; KB.applyTrackVis(); // the viewer's own track setting is left alone
    applyViewMode(); layoutBoards(true);
    openMenu();
    if (isTouch() && cfg.touch === 'tilt') Tilt.enable().catch(() => {});
  },
  close() {
    endRace(); Net.leave();
    this.active = D.active = false;
    document.body.classList.remove('driving');
    $('#dMenu').hidden = true; UI.hud(false); $('#dTouch').hidden = true;
    xrMenuMesh.visible = hudMesh.visible = wheel.visible = vig.visible = false;
    App.forceRealModel = false; KB.rebuildModelTrack(); KB.layoutModel();
    App.trackOverride = null; KB.applyTrackVis(); layoutBoards(true);
    KB.setGhostPost(null);
    if (renderer.xr.isPresenting) { KB.uiMesh.visible = true; for (const c of KB.controllers) c.userData.line.visible = true; KB.positionPanels(); }
  },
  frame, onSelect: onSelectXR,
  allowMapGestures() { return D.view === 'rc'; },
  _D: D, _Sim: Sim, _menu: () => xmHits, _net: Net
};
window.KBDrive = Drive;
})();
