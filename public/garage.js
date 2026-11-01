// Kerbside pit garage: a fully virtual team garage built around the circuit table, with the pit lane,
// track and a grandstand out of the open front. Loaded on demand by index.html.
// In the headset the garage replaces your room; an optional cut-out window shows your real room (your TV).
// On an iPad or phone it's the background behind the table.
(function () {
'use strict';
const KB = window.KB, THREE = KB.THREE, App = KB.App, renderer = KB.renderer, scene = KB.scene;
const GARAGE_BUILD = 2;

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
function setTeamColor(hex) { teamMat.color.set(hex || '#D2342B'); }

/* ---------------- Building it ---------------- */
// Local frame: floor at y = 0, the table at the origin, +z towards where you stood when you placed the table,
// the open front onto the pit lane at -z.
const W = 9, Dback = 5.5, Dfront = -6.5, Ht = 4.6;
function box(g, w, h, d, x, y, z, mat, ry) { const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); if (ry) m.rotation.y = ry; g.add(m); return m; }
function cyl(g, r, h, x, y, z, mat, axis) { const m = new THREE.Mesh(new THREE.CylinderGeometry(r, r, h, 20), mat); m.position.set(x, y, z); if (axis === 'x') m.rotation.z = Math.PI / 2; if (axis === 'z') m.rotation.x = Math.PI / 2; g.add(m); return m; }
function tyre(g, x, y, z, band) {
  cyl(g, 0.33, 0.36, x, y, z, M.rubber);
  const t = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.018, 6, 24), toon(band)); t.rotation.x = Math.PI / 2; t.position.set(x, y + 0.181, z); g.add(t);
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
  // overhead gantry with the timing monitor, facing back into the garage
  box(G, 6, 0.12, 0.12, 0, 3.75, -3.2, M.steel);
  for (const x of [-2.7, 2.7]) box(G, 0.08, Ht - 3.75, 0.08, x, (Ht + 3.75) / 2, -3.2, M.steel);
  // the race car on jacks, nose out
  const car = new THREE.Group();
  car.add(new THREE.Mesh(KB.CarGeo.body, teamMat), new THREE.Mesh(KB.CarGeo.dark, KB.darkMat));
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
  // pit lane, pit wall, track, grass and a grandstand out front
  box(G, 70, 0.2, 10, 0, -0.1, Dfront - 5, M.asphalt);
  box(G, 70, 0.01, 0.12, 0, 0.005, Dfront - 1.2, M.paintWhite);
  box(G, 70, 0.01, 0.12, 0, 0.005, Dfront - 9.5, M.paintWhite);
  box(G, 70, 1.1, 0.4, 0, 0.55, Dfront - 10.5, M.concrete);
  for (let x = -34; x <= 34; x += 3) box(G, 0.06, 2.4, 0.06, x, 2.3, Dfront - 10.5, M.steel);
  box(G, 70, 0.2, 14, 0, -0.12, Dfront - 18, M.asphalt); // track surface 2 cm below the pit lane
  const grass = new THREE.Mesh(new THREE.PlaneGeometry(900, 900), M.grass); grass.rotation.x = -Math.PI / 2; grass.position.y = -0.35; G.add(grass); // well below everything, so it never flickers through at a distance
  box(G, 80, 0.32, 9, 0, -0.19, Dfront - 29.5, M.grass); // verge between the track and the grandstand, level with the track
  for (let k = 0; k < 7; k++) box(G, 80, 0.9 * (k + 1) + 0.35, 2.2, 0, 0.45 * (k + 1) - 0.175, Dfront - 34 - k * 2.2, M.stand); // down to the grass
  box(G, 84, 0.5, 18, 0, 9.5, Dfront - 40, M.roof);
  for (const x of [-40, 0, 40]) box(G, 0.6, 9.85, 0.6, x, 4.575, Dfront - 48, M.steel);
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
  // timing monitor
  const mon = monitor(); mon.mesh.position.set(-1.5, 3.05, -3.14); G.add(mon.mesh);
  box(G, 2.06, 1.32, 0.08, -1.5, 3.05, -3.2, M.dark);
  return { G, plinth, top, edge, mon };
}

/* ---------------- Timing monitor ---------------- */
function monitor() {
  const cv = document.createElement('canvas'); cv.width = 768; cv.height = 480;
  const tex = new THREE.CanvasTexture(cv);
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1.96, 1.22), new THREE.MeshBasicMaterial({ map: tex }));
  return { cv, tex, mesh, t: 0 };
}
function drawMonitor(mon) {
  const c = mon.cv.getContext('2d'), W = 768, H = 480;
  c.fillStyle = '#0e1215'; c.fillRect(0, 0, W, H);
  c.fillStyle = '#D2342B'; c.fillRect(0, 0, W, 8);
  c.fillStyle = '#E9E6DF'; c.font = '700 40px "Barlow Condensed", sans-serif'; c.textBaseline = 'alphabetic';
  c.fillText(App.lapText || 'Timing', 24, 58);
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
    c.fillStyle = '#E9E6DF'; c.font = '700 30px "Barlow Condensed"'; c.fillText(r.tla, x + 58, y + 29);
    c.fillStyle = r.pit ? '#F2B233' : '#94A1A8'; c.font = '500 24px Barlow'; c.textAlign = 'right';
    c.fillText(r.pit ? 'pit' : (r.gap || ''), x + 340, y + 28); c.textAlign = 'left';
  });
  mon.tex.needsUpdate = true;
}

/* ---------------- Window to your real room ---------------- */
// A cut-out that writes "see-through" into the picture, so the headset's passthrough shows there.
const SIZES = { S: 1.3, M: 1.9, L: 2.7 };
const holeMat = new THREE.MeshBasicMaterial({ color: 0x000000, opacity: 0, transparent: false, blending: THREE.NoBlending, depthWrite: true });
const hole = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), holeMat);
hole.renderOrder = -10; hole.visible = false; scene.add(hole);
const rim = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.5, -0.5, 0), new THREE.Vector3(0.5, -0.5, 0), new THREE.Vector3(0.5, 0.5, 0), new THREE.Vector3(-0.5, 0.5, 0)]),
  new THREE.LineBasicMaterial({ color: 0xe9e6df }));
rim.visible = false; scene.add(rim);
const win = { placed: false, pos: new THREE.Vector3(), quat: new THREE.Quaternion() };
const rayM = new THREE.Matrix4(), rO = new THREE.Vector3(), rD = new THREE.Vector3(), headV = new THREE.Vector3();
function aimPose(out) { // 3 m along the right controller's ray (or straight ahead), facing you
  const ctl = KB.controllers[1] || KB.controllers[0];
  rayM.identity().extractRotation(ctl.matrixWorld);
  rO.setFromMatrixPosition(ctl.matrixWorld); rD.set(0, 0, -1).applyMatrix4(rayM);
  if (rO.lengthSq() === 0) { rO.copy(KB.xrHead()); rD.copy(KB.xrForward()); }
  out.pos.copy(rO).addScaledVector(rD, 3);
  headV.copy(KB.xrHead());
  const m = new THREE.Object3D(); m.position.copy(out.pos); m.lookAt(headV); out.quat.copy(m.quaternion);
}
function sizeOf() { const w = SIZES[App.ptSize] || SIZES.M; return [w, w * 0.62]; }
function placeWindowDefault() { aimPose(win); win.placed = true; }
function startWindowPlacing() { if (!canWindow()) return false; App.placingWindow = true; return true; }
function confirmWindow() { aimPose(win); win.placed = true; App.placingWindow = false; KB.toast('Window placed. Choose “Place window” again to move it.', 4000); }
const canWindow = () => renderer.xr.isPresenting && App.xrMode === 'immersive-ar';

/* ---------------- Per frame ---------------- */
let built = null, frozenYaw = null, lastAnchor = new THREE.Vector3(1e9, 0, 0), monT = 0;
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
        if (KB.orbit.dist > 3.6) KB.orbit.dist = 3.6; // keep the camera inside the garage
      }
      // stand under the circuit model, sized to it
      const k = 1.1 * (xr ? App.tableScale : 1) * 0.97, topY = xr ? App.anchor.y : 0.75, tr = App.track;
      const wx = tr ? k * (tr.w / tr.extent + 0.1) : k, wz = tr ? k * (tr.d / tr.extent + 0.1) : k;
      built.top.scale.set(wx, 0.05, wz); built.top.position.y = topY - 0.003 - 0.025;
      built.edge.scale.set(wx * 0.92, Math.max(0.05, topY - 0.05), wz * 0.92); built.edge.position.y = (topY - 0.05) / 2;
      built.plinth.rotation.y = App.tableYaw - built.G.rotation.y; // follows the table when you turn it
      if ((monT += dt) > 0.5) { monT = 0; drawMonitor(built.mon); }
    }
  }
  // passthrough window
  const [w, h] = sizeOf();
  if (App.placingWindow && canWindow()) {
    aimPose(win); rim.visible = true; hole.visible = false;
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
function sessionEnded() { win.placed = false; frozenYaw = null; lastAnchor.set(1e9, 0, 0); App.placingWindow = false; }

window.KBGarage = { frame, startWindowPlacing, confirmWindow, canWindow, sessionEnded, setTeamColor, build: GARAGE_BUILD };
})();
