// Kerbside pit garage: a fully virtual team garage built around the circuit table, with the pit lane,
// track and a grandstand out of the open front, and a pitwall stand across the pit lane you can jump to.
// Full-size cars drive down the straight and through the pit lane from the live or replay data, and the
// garage and pitwall screens show timing, the track map, weather and live camera views.
// Loaded on demand by index.html.
// In the headset the garage replaces your room; an optional cut-out window shows your real room (your TV).
// On an iPad or phone it's the background behind the table.
(function () {
'use strict';
const KB = window.KB, THREE = KB.THREE, App = KB.App, renderer = KB.renderer, scene = KB.scene;
const GARAGE_BUILD = 6;

/* ---------------- Materials ---------------- */
const toon = c => new THREE.MeshToonMaterial({ color: c });
const paint = c => new THREE.MeshToonMaterial({ color: c, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
const M = {
  floor: toon(0xb7bcc0), line: paint(0xe8c33a), white: toon(0xeeeeea), paintWhite: paint(0xeeeeea), wall: toon(0x353d43), back: toon(0x2a3136),
  ceil: toon(0x22282c), steel: toon(0x6f7a82), dark: toon(0x1c1f22), rubber: toon(0x17191b), asphalt: toon(0x3b4349),
  grass: toon(0x5b8a4e), concrete: toon(0x9aa1a6), stand: toon(0x7d8c99), roof: toon(0xeef0f1),
  glow: new THREE.MeshBasicMaterial({ color: 0xf4f6f8 }), screenOff: new THREE.MeshBasicMaterial({ color: 0x0e1215 })
};
let teamMat = toon(0xd2342b);
const garageDark = toon(0x1c1f22);
function outsideWindow(mat) { // don't draw this where the window is
  mat.stencilWrite = true; mat.stencilWriteMask = 0x00; mat.stencilRef = 1; mat.stencilFuncMask = 0xff;
  mat.stencilFunc = THREE.NotEqualStencilFunc;
  mat.stencilFail = mat.stencilZFail = mat.stencilZPass = THREE.KeepStencilOp;
  return mat;
}
function setTeamColor(hex) { teamMat.color.set(hex || '#D2342B'); }

/* ---------------- Building it ---------------- */
// Local frame: floor at y = 0, the table at the origin, +z towards where you stood when you placed the table,
// the open front onto the pit lane at -z.
const W = 9, Dback = 5.5, Dfront = -6.5, Ht = 4.6;
const STRAIGHT = 560, HALF = 270; // metres of straight you can see either side of your garage
const Z = { work: Dfront - 2.6, fast: Dfront - 7.3, wall: Dfront - 10.5, track: Dfront - 18 }; // lanes, wall and track centre lines
const STAND = { floor: 1.1, screenY: 3.32, feetZ: Dfront - 10.5 + 0.75 }; // pitwall platform height, screen height, where you stand
const teamMats = [];
function box(g, w, h, d, x, y, z, mat, ry) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); if (ry) m.rotation.y = ry; g.add(m); return m; }
function cyl(g, r, h, x, y, z, mat, axis) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), mat); m.position.set(x, y, z); if (axis === 'x') m.rotation.z = Math.PI / 2; if (axis === 'z') m.rotation.x = Math.PI / 2; g.add(m); return m; }
const bandMat = {};
function tyre(g, x, y, z, band) {
  cyl(g, 0.33, 0.36, x, y, z, M.rubber);
  const t = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.018, 6, 24), bandMat[band] || (bandMat[band] = toon(band))); t.rotation.x = Math.PI / 2; t.position.set(x, y + 0.181, z); g.add(t);
  cyl(g, 0.17, 0.37, x, y, z, M.steel);
}
function build() {
  const G = new THREE.Group(); G.name = 'garage';
  // floor with painted bay markings
  box(G, W, 0.2, Dback - Dfront, 0, -0.1, (Dback + Dfront) / 2, M.floor);
  for (const x of [-3.6, 3.6]) box(G, 0.08, 0.01, Dback - Dfront - 0.6, x, 0.005, (Dback + Dfront) / 2, M.line);
  box(G, W - 0.6, 0.01, 0.1, 0, 0.005, Dfront + 0.4, M.paintWhite);
  // walls and ceiling (boxes, so they look solid from either side)
  box(G, W, Ht, 0.2, 0, Ht / 2, Dback, M.back);
  box(G, W, 0.3, 0.22, 0, 2.45, Dback - 0.02, teamMat); // team stripe
  for (const sx of [-1, 1]) {
    box(G, 0.2, Ht, Dback - Dfront, sx * W / 2, Ht / 2, (Dback + Dfront) / 2, M.wall);
    box(G, 0.22, 0.3, Dback - Dfront, sx * (W / 2 - 0.02), 2.45, (Dback + Dfront) / 2, teamMat);
    for (let z = Dfront + 1; z < Dback; z += 2) box(G, 0.22, Ht, 0.04, sx * (W / 2 - 0.03), Ht / 2, z, M.dark); // panel seams
  }
  box(G, W, 0.2, Dback - Dfront, 0, Ht + 0.1, (Dback + Dfront) / 2, M.ceil);
  for (const x of [-2.6, 0, 2.6]) box(G, 0.22, 0.05, Dback - Dfront - 1.5, x, Ht - 0.04, (Dback + Dfront) / 2, M.glow);
  // open front: header with the rolled-up shutter, side pillars
  box(G, W, 0.9, 0.35, 0, Ht - 0.45, Dfront, M.wall);
  cyl(G, 0.32, W - 0.4, 0, Ht - 1.1, Dfront + 0.15, M.steel, 'x');
  for (const sx of [-1, 1]) box(G, 0.45, Ht, 0.45, sx * (W / 2 - 0.1), Ht / 2, Dfront, M.wall);
  // overhead gantry with the video wall, facing back into the garage
  box(G, 8.3, 0.12, 0.12, 0, 3.75, -3.2, M.steel);
  for (const x of [-4.1, 4.1]) box(G, 0.08, Ht - 3.75, 0.08, x, (Ht + 3.75) / 2, -3.2, M.steel);
  // the race car on jacks, nose out
  const car = new THREE.Group();
  car.add(new THREE.Mesh(KB.CarGeo.body, teamMat), new THREE.Mesh(KB.CarGeo.dark, garageDark));
  car.position.set(2.6, 0.22, -1.6); car.rotation.y = Math.PI; G.add(car);
  box(G, 0.5, 0.2, 0.3, 2.6, 0.1, -1.6 + 2.6, M.steel); box(G, 0.5, 0.2, 0.3, 2.6, 0.1, -1.6 - 2.3, M.steel);
  // tool chests along the left wall
  for (const z of [0.4, 2.0, 3.6]) {
    box(G, 0.62, 1.0, 1.4, -W / 2 + 0.45, 0.5, z, teamMat);
    for (let k = 0; k < 4; k++) box(G, 0.01, 0.02, 1.2, -W / 2 + 0.765, 0.2 + k * 0.22, z, M.dark);
    box(G, 0.66, 0.04, 1.44, -W / 2 + 0.45, 1.02, z, M.dark);
  }
  // wheel guns and a tablet stand next to the chests
  cyl(G, 0.05, 0.4, -W / 2 + 0.45, 1.25, 1.2, M.steel, 'z');
  // tyre racks along the right wall: soft, medium and hard sets
  const bands = [0xe8483b, 0xf2c84b, 0xe9e6df];
  box(G, 0.9, 0.06, 3.2, W / 2 - 0.6, 1.7, 3.6, M.steel);
  for (let s = 0; s < 3; s++) for (let k = 0; k < 4; k++) tyre(G, W / 2 - 0.6, 0.18 + k * 0.37, 2.4 + s * 0.95, bands[s]);
  // pit lane, pit wall, track, grass and a grandstand out front, long enough to watch cars come and go
  const L = STRAIGHT;
  box(G, L, 0.2, 10, 0, -0.1, Dfront - 5, M.asphalt);
  box(G, L, 0.01, 0.12, 0, 0.005, Dfront - 1.2, M.paintWhite);
  box(G, L, 0.01, 0.12, 0, 0.005, Dfront - 5.0, M.paintWhite); // working lane | fast lane
  box(G, L, 0.01, 0.12, 0, 0.005, Dfront - 9.5, M.paintWhite);
  box(G, L, 1.1, 0.4, 0, 0.55, Z.wall, M.concrete);
  for (let x = -L / 2 + 1; x <= L / 2; x += 3) box(G, 0.06, 2.4, 0.06, x, 2.3, Z.wall, M.steel);
  box(G, L, 0.04, 0.04, 0, 3.5, Z.wall, M.steel);
  box(G, L, 0.2, 14, 0, -0.12, Z.track, M.asphalt); // track surface 2 cm below the pit lane
  for (const z of [Z.track + 6.6, Z.track - 6.6]) box(G, L, 0.01, 0.2, 0, -0.015, z, M.paintWhite); // track edges
  for (let k = 0; k < 28; k++) for (let j = 0; j < 2; j++) box(G, 0.5, 0.01, 0.5, (j - 0.5) * 0.5, -0.014, Z.track - 7 + 0.25 + k * 0.5, (k + j) % 2 ? M.white : M.dark); // chequered start/finish line
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(1400, 1400), M.grass); grass.rotation.x = -Math.PI / 2; grass.position.y = -0.35; G.add(grass); // well below everything, so it never flickers through at a distance
  box(G, L + 20, 0.32, 9, 0, -0.19, Dfront - 29.5, M.grass); // verge between the track and the grandstand, level with the track
  for (let k = 0; k < 7; k++) box(G, L * 0.7, 0.9 * (k + 1) + 0.35, 2.2, 0, 0.45 * (k + 1) - 0.175, Dfront - 34 - k * 2.2, M.stand); // down to the grass
  box(G, L * 0.7 + 4, 0.5, 18, 0, 9.5, Dfront - 40, M.roof);
  for (let x = -L * 0.35; x <= L * 0.35; x += 40) box(G, 0.6, 9.85, 0.6, x, 4.575, Dfront - 48, M.steel);
  // the rest of the pit row: other teams' garages either side of yours
  const TEAM = [0x3671c6, 0x27f4d2, 0xff8000, 0x229971, 0x0093cc, 0x64c4ff, 0xb6babd, 0x52e252, 0xe8002d, 0x6692ff];
  for (const sx of [-1, 1]) {
    const len = L / 2 - W / 2, cx = sx * (W / 2 + len / 2);
    box(G, len, Ht, 12, cx, Ht / 2, Dfront + 6.6, M.back); // dark garage interiors, set back from the front
    box(G, len, 2.2, 12.6, cx, Ht + 1.1, Dfront + 6.3, M.dark); // hospitality floor above, glass front
    box(G, len, 0.25, 13, cx, Ht + 2.3, Dfront + 6.5, M.roof);
    box(G, len, 0.2, 13, cx, -0.1, Dfront + 6.5, M.floor);
    for (let k = 0; k * 9 < len - 1; k++) {
      const x = sx * (W / 2 + 4.5 + k * 9);
      box(G, 9, 0.9, 0.35, x, Ht - 0.45, Dfront, M.wall);
      box(G, 8.6, 0.25, 0.37, x, Ht - 0.2, Dfront, teamMats[k % TEAM.length] || (teamMats[k % TEAM.length] = toon(TEAM[k % TEAM.length])));
      box(G, 0.45, Ht, 0.45, x + sx * 4.5, Ht / 2, Dfront, M.wall);
    }
  }
  // your team's pitwall stand on the wall: platform, roof and a row of screens
  const S = STAND;
  box(G, 7.4, 0.2, 1.9, 0, S.floor - 0.1, Z.wall + 0.55, M.steel);
  for (const x of [-3.5, 3.5]) { box(G, 0.12, S.floor, 0.12, x, S.floor / 2, Z.wall + 1.4, M.steel); box(G, 0.1, 3.9 - S.floor, 0.1, x, (3.9 + S.floor) / 2, Z.wall - 0.3, M.steel); }
  box(G, 7.4, 0.06, 0.06, 0, S.floor + 1.05, Z.wall + 1.45, M.steel); // handrail on the pit-lane side
  box(G, 7.8, 0.15, 2.6, 0, 3.95, Z.wall + 0.4, M.dark);
  box(G, 7.8, 0.32, 0.06, 0, 3.8, Z.wall + 1.7, teamMat);
  // steps up from the pit lane
  for (let k = 0; k < 5; k++) box(G, 1.0, 0.22, 0.3, -4.2, 0.11 + k * 0.22, Z.wall + 2.2 - k * 0.3, M.steel);
  // sky
  const sky = new THREE.Mesh(new THREE.SphereGeometry(420, 32, 16), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: { top: { value: new THREE.Color(0x5d93c9) }, hor: { value: new THREE.Color(0xd6e0e6) } },
    vertexShader: 'varying vec3 vW; void main(){ vW = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 hor; varying vec3 vW; void main(){ float h = max(vW.y, 0.0); gl_FragColor = vec4(mix(hor, top, pow(h, 0.55)), 1.0); }'
  }));
  sky.renderOrder = -2; G.add(sky);
  // the stand the circuit model sits on (resized to the table every frame)
  const plinth = new THREE.Group();
  const top = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), M.dark); plinth.add(top);
  const edge = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), teamMat); plinth.add(edge);
  G.add(plinth);
  // screens: a video wall in the garage and a row on the pitwall, sharing the same pictures
  const keep = new Set([sky, plinth, car]);
  // Offsets are measured in the (possibly tilted) screen's own plane: du up the screen, dn out of it,
  // so frames, backing and labels stay flush with a tilted screen instead of poking through it.
  const along = (x, y, z, t, du, dn) => [x, y + du * Math.cos(t) - dn * Math.sin(t), z + du * Math.sin(t) + dn * Math.cos(t)];
  const screen = (tex, w, h, x, y, z, tilt = 0) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex }));
    m.position.set(x, y, z); m.rotation.x = tilt; G.add(m); keep.add(m);
    box(G, w + 0.06, h + 0.06, 0.04, ...along(x, y, z, tilt, 0, -0.03), M.dark).rotation.x = tilt; // frame, just behind the picture
    return m;
  };
  const camLabel = (lab, w, h, x, y, z, tilt = 0) => { // strip along the bottom of a camera screen
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, w * 0.11), new THREE.MeshBasicMaterial({ map: lab.tex, transparent: true }));
    m.position.set(...along(x, y, z, tilt, -h / 2 + w * 0.055, 0.01)); m.rotation.x = tilt; G.add(m); keep.add(m);
  };
  const SW = 1.9, SH = 1.18, SY = 3.05, SZ = -3.14, CH = SW * 9 / 16;
  screen(SCR.timing.tex, SW, SH, -3.0, SY, SZ); screen(SCR.map.tex, SW, SH, -1.0, SY, SZ);
  screen(SCR.cam[0].rt.texture, SW, CH, 1.0, SY, SZ); camLabel(SCR.cam[0].label, SW, CH, 1.0, SY, SZ);
  screen(SCR.weather.tex, SW, SH, 3.0, SY, SZ);
  const PW = 1.36, PH = PW * 0.625, PC = PW * 9 / 16, PZ = Z.wall - 0.24, PY = STAND.screenY, T = 0.22;
  box(G, 7.2, 0.94, 0.04, ...along(0, PY, PZ, T, 0, -0.09), M.dark).rotation.x = T; // backing panel, tilted with the screens
  screen(SCR.timing.tex, PW, PH, -2.8, PY, PZ, T); screen(SCR.map.tex, PW, PH, -1.4, PY, PZ, T);
  screen(SCR.cam[0].rt.texture, PW, PC, 0, PY, PZ, T); camLabel(SCR.cam[0].label, PW, PC, 0, PY, PZ, T);
  screen(SCR.cam[1].rt.texture, PW, PC, 1.4, PY, PZ, T); camLabel(SCR.cam[1].label, PW, PC, 1.4, PY, PZ, T);
  screen(SCR.weather.tex, PW, PH, 2.8, PY, PZ, T);
  const traffic = new THREE.Group(); G.add(traffic); keep.add(traffic);
  bake(G, keep);
  G.traverse(o => { if (o.material) [].concat(o.material).forEach(outsideWindow); });
  return { G, plinth, top, edge, traffic };
}

// Merge the garage's ~130 fixed pieces into one mesh per material: a handful of draw calls per eye
// instead of hundreds, which keeps the headset at full frame rate.
function bake(G, keep) {
  try {
    const byMat = new Map(), drop = [];
    for (const m of G.children) {
      if (keep.has(m) || !m.isMesh || !m.geometry || Array.isArray(m.material)) continue;
      m.updateMatrix();
      const g = (m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone()); g.applyMatrix4(m.matrix);
      if (!byMat.has(m.material)) byMat.set(m.material, []);
      byMat.get(m.material).push(g); drop.push(m);
    }
    for (const [mat, list] of byMat) {
      let n = 0; for (const g of list) n += g.attributes.position.count;
      if (!n) return; // nothing measurable to merge (test stand-in); keep the pieces as they are
      const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3); let o = 0;
      for (const g of list) { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); o += g.attributes.position.count; }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3)); geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geo.computeBoundingSphere();
      G.add(new THREE.Mesh(geo, mat));
    }
    for (const m of drop) G.remove(m);
  } catch (e) { /* if merging fails, the separate pieces still draw */ }
}

/* ---------------- Screens ---------------- */
// Canvas screens (timing, track map, weather) redraw a few times a second; the two camera screens are
// small render targets of the full-size circuit, drawn in turn at about 12 frames a second each.
function canvasScreen(w, h) { const cv = document.createElement('canvas'); cv.width = w; cv.height = h; return { cv, tex: new THREE.CanvasTexture(cv) }; }
function camScreen(name) {
  const rt = new THREE.WebGLRenderTarget(640, 360);
  const cam = new THREE.PerspectiveCamera(name === 'tv' ? 34 : 72, 16 / 9, 0.3, 20000); cam.layers.set(KB.REAL); // far enough for the sky dome (9 km)
  return { name, rt, cam, label: canvasScreen(512, 56), pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false, num: null };
}
const SCR = { timing: canvasScreen(768, 480), map: canvasScreen(768, 480), weather: canvasScreen(768, 480), cam: [camScreen('onboard'), camScreen('tv')] };
function header(c, W, title, right) {
  c.fillStyle = '#0e1215'; c.fillRect(0, 0, W, 480);
  c.fillStyle = teamMat.color.getStyle(); c.fillRect(0, 0, W, 8);
  c.fillStyle = '#E9E6DF'; c.font = '700 40px "Barlow Condensed", sans-serif'; c.textBaseline = 'alphabetic'; c.textAlign = 'left';
  c.fillText(title, 24, 58);
  if (right) { c.textAlign = 'right'; c.font = '500 26px Barlow, sans-serif'; c.fillStyle = '#94A1A8'; c.fillText(right, W - 24, 56); c.textAlign = 'left'; }
}
function drawTiming() {
  const c = SCR.timing.cv.getContext('2d'), W = 768;
  header(c, W, App.lapText || 'Timing');
  if (App.flag && App.flag.text) {
    c.font = '600 30px "Barlow Condensed"'; const w = c.measureText(App.flag.text).width + 24;
    c.fillStyle = App.flag.color || '#3A454C'; KB.rr(c, W - 24 - w, 22, w, 44, 8); c.fill();
    c.fillStyle = App.flag.color === '#F2B233' || App.flag.color === '#E9E6DF' ? '#20262B' : '#E9E6DF'; c.fillText(App.flag.text, W - 12 - w, 54);
  }
  const rows = (App.board || []).slice(0, 20);
  if (!rows.length) { c.fillStyle = '#94A1A8'; c.font = '500 28px Barlow'; c.fillText('Load a replay or go live to see timing here.', 24, 140); }
  rows.forEach((r, i) => {
    const col = i < 10 ? 0 : 1, x = 24 + col * 372, y = 92 + (i % 10) * 37;
    c.fillStyle = '#94A1A8'; c.font = '600 28px "Barlow Condensed"'; c.textAlign = 'right'; c.fillText(String(r.pos), x + 30, y + 28); c.textAlign = 'left';
    c.fillStyle = r.color; c.fillRect(x + 42, y + 6, 6, 26);
    c.fillStyle = r.num === App.chaseNum ? '#F2B233' : '#E9E6DF'; c.font = '700 30px "Barlow Condensed"'; c.fillText(r.tla, x + 58, y + 29);
    c.fillStyle = r.pit ? '#F2B233' : '#94A1A8'; c.font = '500 24px Barlow'; c.textAlign = 'right';
    c.fillText(r.pit ? 'pit' : (r.gap || ''), x + 340, y + 28); c.textAlign = 'left';
  });
  SCR.timing.tex.needsUpdate = true;
}
let mapFor = null, mapPath = null, mapK = 1, mapOx = 0, mapOy = 0;
function drawMap() {
  const c = SCR.map.cv.getContext('2d'), W = 768, H = 480, tr = App.track;
  header(c, W, 'Track', tr ? '' : 'no circuit loaded');
  if (!tr) { SCR.map.tex.needsUpdate = true; return; }
  if (mapFor !== tr) { // fit the circuit into the screen once per circuit
    mapFor = tr; let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const p of tr.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
    mapK = Math.min((W - 80) / (x1 - x0 || 1), (H - 120) / (z1 - z0 || 1));
    mapOx = W / 2 - (x0 + x1) / 2 * mapK; mapOy = 72 + (H - 72) / 2 - (z0 + z1) / 2 * mapK;
    mapPath = new Path2D(); tr.pts.forEach((p, i) => i ? mapPath.lineTo(p.x * mapK + mapOx, p.z * mapK + mapOy) : mapPath.moveTo(p.x * mapK + mapOx, p.z * mapK + mapOy)); mapPath.closePath();
  }
  c.lineJoin = 'round'; c.strokeStyle = '#3A454C'; c.lineWidth = 16; c.stroke(mapPath); c.strokeStyle = '#6F7A82'; c.lineWidth = 6; c.stroke(mapPath);
  const p0 = tr.pts[0]; c.fillStyle = '#E9E6DF'; c.fillRect(p0.x * mapK + mapOx - 3, p0.z * mapK + mapOy - 12, 6, 24); // start/finish
  const order = new Map((App.board || []).map(r => [r.num, r]));
  const list = [...KB.Cars.values()].filter(car => car.valid).sort((a, b) => ((order.get(b.num) || {}).pos || 99) - ((order.get(a.num) || {}).pos || 99));
  c.font = '700 22px "Barlow Condensed"'; c.textBaseline = 'middle';
  for (const car of list) {
    const x = car.pos.x * mapK + mapOx, y = car.pos.z * mapK + mapOy, r = order.get(car.num), lead = r && r.pos <= 3, mine = car.num === App.chaseNum;
    c.beginPath(); c.arc(x, y, mine ? 11 : 8, 0, Math.PI * 2); c.fillStyle = car.color; c.fill();
    if (mine) { c.lineWidth = 3; c.strokeStyle = '#F2B233'; c.stroke(); }
    if (lead || mine) { c.fillStyle = '#E9E6DF'; c.fillText(car.tla, x + 14, y); }
  }
  c.textBaseline = 'alphabetic';
  SCR.map.tex.needsUpdate = true;
}
function drawWeather() {
  const c = SCR.weather.cv.getContext('2d'), W = 768, KW = window.KBWeather, d = KW && KW.data ? KW.data() : null, em = KW && KW.emoji ? KW.emoji : () => '';
  const m = d && d.meeting;
  header(c, W, m ? `${d.now && d.now.code != null ? em(d.now.code) + ' ' : ''}${m.location}` : 'Weather', d && d.now ? `now ${d.now.temp}°C, wind ${d.now.wind} km/h` : '');
  if (!m) { c.fillStyle = '#94A1A8'; c.font = '500 28px Barlow'; c.fillText(d && d.error ? 'Forecast unavailable right now.' : 'Loading the forecast…', 24, 140); SCR.weather.tex.needsUpdate = true; return; }
  const tf = new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const list = (d.sessions || []).filter(s => s.end > Date.now()).slice(0, 5);
  list.forEach((s, i) => {
    const y = 104 + i * 74, w = s.w;
    c.font = '44px sans-serif'; c.fillText(w ? em(w.code || 0) : '·', 24, y + 44);
    c.fillStyle = '#E9E6DF'; c.font = '700 34px "Barlow Condensed"'; c.fillText(s.name, 96, y + 30);
    c.fillStyle = '#94A1A8'; c.font = '500 24px Barlow'; c.fillText(tf.format(new Date(s.start)) + (w ? ' · ' + w.text : ''), 96, y + 60);
    c.textAlign = 'right'; c.fillStyle = '#E9E6DF'; c.font = '700 36px "Barlow Condensed"';
    c.fillText(w ? `${w.temp}°  💧${w.prob}%` : 'soon', W - 24, y + 44); c.textAlign = 'left';
  });
  SCR.weather.tex.needsUpdate = true;
}
function drawCamLabel(sc, car) {
  const c = sc.label.cv.getContext('2d'); c.clearRect(0, 0, 512, 56);
  c.fillStyle = 'rgba(14,18,21,0.85)'; c.fillRect(0, 0, 512, 56);
  c.fillStyle = teamMat.color.getStyle(); c.fillRect(0, 0, 8, 56);
  c.font = '700 34px "Barlow Condensed", sans-serif'; c.textBaseline = 'middle'; c.fillStyle = '#E9E6DF';
  const row = car && (App.board || []).find(r => r.num === car.num);
  const what = sc.name === 'onboard' ? 'ONBOARD' : 'TV';
  c.fillText(car ? `${what} · ${row ? 'P' + row.pos + ' ' : ''}${car.tla}` : `${what} · no cars on track`, 22, 30);
  sc.label.tex.needsUpdate = true;
}
const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
function pickCar(which) {
  const valid = c => c && c.valid;
  if (which === 'onboard') { const f = App.chaseNum && KB.Cars.get(App.chaseNum); if (valid(f)) return f; }
  for (const r of App.board || []) { const c = KB.Cars.get(r.num); if (valid(c) && !r.pit) return c; } // TV follows the leader
  return [...KB.Cars.values()].find(valid) || null;
}
function aimCam(sc, dt) {
  const car = pickCar(sc.name), tr = App.track;
  if (car !== sc.car) { sc.car = car; sc.init = false; drawCamLabel(sc, car); }
  if (!car || !tr) return false;
  const f = vA.set(Math.sin(car.head), 0, Math.cos(car.head));
  if (sc.name === 'onboard') { // the T-cam view just above and behind the driver's head
    sc.cam.position.copy(car.pos).addScaledVector(f, -0.6); sc.cam.position.y += 1.25;
    const ahead = tr.pts[(car.idx + Math.round(40 / (tr.length / tr.N))) % tr.N];
    vB.copy(car.pos).addScaledVector(f, 40); vB.y = (ahead ? ahead.y : car.pos.y) + 0.6;
    sc.cam.up.set(0, 1, 0); sc.cam.lookAt(vB);
  } else { // a helicopter shot hanging off the car's left-rear quarter
    const side = vB.set(f.z, 0, -f.x);
    const want = vC.copy(car.pos).addScaledVector(f, -45).addScaledVector(side, 22); want.y = car.pos.y + 26;
    if (!sc.init) { sc.pos.copy(want); sc.look.copy(car.pos); sc.init = true; }
    sc.pos.lerp(want, Math.min(1, dt * 1.6)); sc.look.lerp(car.pos, Math.min(1, dt * 5));
    sc.cam.position.copy(sc.pos); sc.cam.up.set(0, 1, 0); sc.cam.lookAt(sc.look.x, sc.look.y + 1, sc.look.z);
  }
  return true;
}
let camTurn = 0, camT = [0, 0];
function renderCams(dt, both) {
  camT[0] += dt; camT[1] += dt;
  if ((camTurn = (camTurn + 1) % 3) !== 0) return; // one camera every third frame
  const k = both ? (camT[0] >= camT[1] ? 0 : 1) : 0, sc = SCR.cam[k], cdt = camT[k]; camT[k] = 0;
  if (!aimCam(sc, cdt)) return;
  const xrOn = renderer.xr.enabled, fog = scene.fog, bg = scene.background;
  renderer.xr.enabled = false; scene.fog = KB.FOG; scene.background = null;
  renderer.setRenderTarget(sc.rt); renderer.render(scene, sc.cam); renderer.setRenderTarget(null);
  renderer.xr.enabled = xrOn; scene.fog = fog; scene.background = bg;
}
let scrT = 0, slowT = 0;
function drawScreens(dt) {
  if ((scrT += dt) > 0.33) { scrT = 0; drawTiming(); drawMap(); for (const sc of SCR.cam) if (sc.car) drawCamLabel(sc, sc.car); }
  if ((slowT += dt) > 5 || slowT === dt) { slowT = 0.0001; drawWeather(); }
}
drawCamLabel(SCR.cam[0], null); drawCamLabel(SCR.cam[1], null);

/* ---------------- Cars on the straight and in the pit lane ---------------- */
// Every car within reach of the start/finish line is drawn full size: its distance from the line becomes
// its place along the straight and its sideways offset its line on the track. Cars the timing shows in
// the pits (or far off the racing line) use the pit lane instead: the fast lane while moving, and the
// working lane in front of the garages while stopped for their stop.
const bodyMats = new Map();
const trafficDark = toon(0x1c1f22);
function trafficCar(car) {
  const g = new THREE.Group();
  let bm = bodyMats.get(car.color); if (!bm) { bm = outsideWindow(toon(car.color)); bodyMats.set(car.color, bm); }
  g.add(new THREE.Mesh(KB.CarGeo.body, bm), new THREE.Mesh(KB.CarGeo.dark, trafficDark), new THREE.Mesh(KB.CarGeo.post, trafficDark));
  return { g, color: car.color, x: 0, z: 0, vx: 0, vz: 0, on: false, slow: 0 };
}
const TR = new Map();
outsideWindow(trafficDark);
function updateTraffic(dt) {
  const tr = App.track, group = built.traffic;
  const pits = new Map((App.board || []).map(r => [r.num, !!r.pit]));
  for (const car of KB.Cars.values()) {
    let t = TR.get(car.num);
    if (t && t.color !== car.color) { group.remove(t.g); TR.delete(car.num); t = null; }
    let show = false;
    if (tr && car.valid) {
      const pr = tr.project(car.pos, car.idx), L = tr.length;
      let rel = pr.s % L; if (rel > L / 2) rel -= L; if (rel < -L / 2) rel += L;
      if (Math.abs(rel) < HALF) {
        show = true;
        if (!t) { t = trafficCar(car); TR.set(car.num, t); group.add(t.g); }
        const inPit = pits.get(car.num) || Math.abs(pr.lat) > 12;
        const vx = t.on ? (rel - t.x) / Math.max(dt, 1e-3) : 0;
        t.slow = Math.abs(vx) < 3 ? Math.min(2, t.slow + dt) : 0; // stopped for a second or more: it's in its box
        const zWant = inPit ? (t.slow > 1 ? Z.work : Z.fast) : Z.track - Math.max(-6, Math.min(6, pr.lat));
        if (!t.on) { t.x = rel; t.z = zWant; t.on = true; }
        const ox = t.x, oz = t.z;
        t.x = rel; t.z += (zWant - t.z) * Math.min(1, dt * (inPit ? 1.4 : 3));
        const dx = t.x - ox, dz = t.z - oz;
        const yaw = Math.abs(dx) + Math.abs(dz) > 0.02 ? Math.atan2(dx, dz) : t.g.rotation.y || Math.PI / 2;
        t.g.position.set(t.x, inPit || t.z > Z.wall ? 0 : -0.02, t.z); t.g.rotation.y = yaw;
      }
    }
    if (t) { t.g.visible = show; if (!show) t.on = false; }
  }
  for (const [num, t] of TR) if (!KB.Cars.has(num)) { group.remove(t.g); TR.delete(num); }
}

/* ---------------- Going to the pitwall ---------------- */
// In the headset you jump across the pit lane by shifting where the room's floor is in the scene: every
// pose the headset reports (head, controllers, hands) is read through an offset space, so friends in a
// hangout see you standing on the pitwall too. On a flat screen the camera moves there instead.
let wantAway = false, OFF = null, BASE = null;
(function patchPoses() {
  if (typeof XRFrame === 'undefined') return;
  const P = XRFrame.prototype, swap = s => (OFF && s === BASE ? OFF : s);
  const gv = P.getViewerPose, gp = P.getPose, gj = P.getJointPose;
  if (gv) P.getViewerPose = function (s) { return gv.call(this, swap(s)); };
  if (gp) P.getPose = function (a, s) { return gp.call(this, a, swap(s)); };
  if (gj) P.getJointPose = function (j, s) { return gj.call(this, j, swap(s)); };
})();
const standLocal = new THREE.Vector3(0, STAND.floor, STAND.feetZ), standW = new THREE.Vector3();
function syncTeleport(show) {
  const want = wantAway && show && renderer.xr.isPresenting;
  if (want && !OFF) {
    const ref = renderer.xr.getReferenceSpace(); if (!ref || typeof XRRigidTransform === 'undefined') return;
    const head = KB.xrHead(); standW.copy(standLocal); built.G.localToWorld(standW);
    BASE = ref; OFF = ref.getOffsetReferenceSpace(new XRRigidTransform({ x: head.x - standW.x, y: -standW.y, z: head.z - standW.z }));
    setTimeout(() => KB.positionPanels(), 150);
  } else if (!want && OFF) { OFF = null; BASE = null; setTimeout(() => KB.positionPanels(), 150); }
}
const look = { yaw: 0, pitch: -0.14, fov: 68 };
function setAway(on) { wantAway = !!on; look.yaw = 0; look.pitch = -0.14; look.fov = 68; }
function away() { return wantAway && App.env === 'garage'; }
function flatCam(camera) { // flat screens: stand on the pitwall and look around
  if (!built || !built.G.visible || !wantAway || renderer.xr.isPresenting) return;
  standW.set(0, STAND.floor + 1.62, STAND.feetZ); built.G.localToWorld(standW);
  camera.position.copy(standW); camera.rotation.set(look.pitch, built.G.rotation.y + look.yaw, 0, 'YXZ');
  if (camera.fov !== look.fov) { camera.fov = look.fov; camera.updateProjectionMatrix(); }
}
function lookBy(dx, dy) { look.yaw += dx * 0.004; look.pitch = Math.max(-1.2, Math.min(1.2, look.pitch + dy * 0.004)); }
function zoomBy(f) { look.fov = Math.max(20, Math.min(90, look.fov * f)); }

/* ---------------- Window to your real room ---------------- */
// The window marks its area in the stencil buffer, and the garage simply isn't drawn there, so your real
// room (passthrough) shows through. It writes no depth, so it can't fight with anything, and it never
// cuts into the table, cars, friends or panels: those are drawn on top as normal.
const SIZES = { S: 1.3, M: 1.9, L: 2.7 };
const holeMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false, depthTest: false,
  stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc, stencilZPass: THREE.ReplaceStencilOp, stencilFail: THREE.ReplaceStencilOp, stencilZFail: THREE.ReplaceStencilOp });
const hole = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), holeMat);
hole.renderOrder = -10; hole.visible = false; scene.add(hole);
const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0)]),
  new THREE.LineBasicMaterial({ color: 0xe9e6df }));
rim.visible = false; scene.add(rim);
const win = { placed: false, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), dist: 2.5 };
const rayM = new THREE.Matrix4(), rO = new THREE.Vector3(), rD = new THREE.Vector3(), headV = new THREE.Vector3();
function upright(out) { // stand the window up and turn it to face you, like a real window or TV
  headV.copy(KB.xrHead());
  const yaw = Math.atan2(headV.x - out.pos.x, headV.z - out.pos.z);
  out.quat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
}
function aimPose(out) { // along the right controller's ray, at the chosen distance; never below the floor
  const ctl = KB.controllers[1] || KB.controllers[0];
  rayM.identity().extractRotation(ctl.matrixWorld);
  rO.setFromMatrixPosition(ctl.matrixWorld); rD.set(0, 0, -1).applyMatrix4(rayM);
  if (rO.lengthSq() === 0) { rO.copy(KB.xrHead()); rD.copy(KB.xrForward()); }
  out.pos.copy(rO).addScaledVector(rD, out.dist);
  out.pos.y = Math.max(sizeOf()[1] / 2 + 0.3, out.pos.y);
  upright(out);
}
function sizeOf() { const w = SIZES[App.ptSize] || SIZES.M; return [w, w * 0.62]; }
function placeWindowDefault() { // straight ahead at eye height, not wherever the controller happens to point
  const h = KB.xrHead(), f = KB.xrForward();
  win.pos.copy(h).addScaledVector(f, win.dist); win.pos.y = Math.max(sizeOf()[1] / 2 + 0.3, h.y - 0.1);
  upright(win); win.placed = true;
}
function startWindowPlacing() { if (!canWindow()) return false; App.placingWindow = true; return true; }
function confirmWindow() { aimPose(win); win.placed = true; App.placingWindow = false; KB.toast('Window placed. Choose “Place window” again to move it.', 4000); }
function aimStick(dt) { // while aiming: right stick up/down moves the window farther or closer
  const session = renderer.xr.getSession(); if (!session) return;
  for (const src of session.inputSources) {
    if (src.handedness !== 'right' || !src.gamepad || src.gamepad.axes.length < 4) continue;
    const ay = src.gamepad.axes[3]; if (Math.abs(ay) > 0.15) win.dist = Math.max(1, Math.min(6, win.dist - ay * dt * 2));
  }
}
const canWindow = () => renderer.xr.isPresenting && App.xrMode === 'immersive-ar';

/* ---------------- Per frame ---------------- */
let built = null, frozenYaw = null, lastAnchor = new THREE.Vector3(1e9, 0, 0);
function shouldShow() {
  if (App.env !== 'garage') return false;
  const driving = window.KBDrive && KBDrive.active;
  if (driving && KBDrive._D.view !== 'rc') return false; // full-size driving has its own world
  if (renderer.xr.isPresenting && (!App.placed || App.placing || App.placingWindow)) return false; // see the real room while placing
  return true;
}
function frame(dt) {
  const show = shouldShow();
  if (show && !built) { built = build(); scene.add(built.G); }
  const xr = renderer.xr.isPresenting;
  if (built) {
    built.G.visible = show;
    if (show) {
      if (xr) {
        if (!lastAnchor.equals(App.anchor)) { lastAnchor.copy(App.anchor); frozenYaw = App.tableYaw; } // turning the table doesn't turn the room
        built.G.position.set(App.anchor.x, 0, App.anchor.z);
        built.G.rotation.y = (frozenYaw ?? App.tableYaw) + (App.garageTurn || 0);
      } else {
        built.G.position.set(0, -0.78, 0); built.G.rotation.y = App.garageTurn || 0;
        if (!wantAway && KB.orbit.dist > 3.6) KB.orbit.dist = 3.6; // keep the camera inside the garage
      }
      // stand under the circuit model, sized to it
      const k = 1.1 * (xr ? App.tableScale : 1) * 0.97, topY = xr ? App.anchor.y : 0.75, tr = App.track;
      const wx = tr ? k * (tr.w / tr.extent + 0.1) : k, wz = tr ? k * (tr.d / tr.extent + 0.1) : k;
      built.top.scale.set(wx, 0.05, wz); built.top.position.y = topY - 0.003 - 0.025;
      built.edge.scale.set(wx * 0.92, Math.max(0.05, topY - 0.05), wz * 0.92); built.edge.position.y = (topY - 0.05) / 2;
      built.plinth.rotation.y = App.tableYaw - built.G.rotation.y; // follows the table when you turn it
      drawScreens(dt);
      updateTraffic(dt);
      renderCams(dt, wantAway);
    }
    syncTeleport(show);
  }
  // passthrough window
  const [w, h] = sizeOf();
  if (App.placingWindow && canWindow()) {
    aimStick(dt); aimPose(win); rim.visible = true; hole.visible = false;
    rim.position.copy(win.pos); rim.quaternion.copy(win.quat); rim.scale.set(w, h, 1);
  } else {
    rim.visible = false;
    const want = show && xr && App.ptWindow && canWindow();
    if (want && !win.placed) placeWindowDefault();
    hole.visible = want;
    if (want) { hole.position.copy(win.pos); hole.quaternion.copy(win.quat); hole.scale.set(w, h, 1); }
  }
  if (!xr && App.placingWindow) App.placingWindow = false;
}
function sessionEnded() { win.placed = false; frozenYaw = null; lastAnchor.set(1e9, 0, 0); App.placingWindow = false; OFF = null; BASE = null; }

window.KBGarage = { frame, startWindowPlacing, confirmWindow, canWindow, sessionEnded, setTeamColor, setAway, away, flatCam, lookBy, zoomBy, build: GARAGE_BUILD,
  _dbg: () => ({ TR, built, SCR, OFF, look }) };
})();
