/* Racing-driver avatars: one skinned model (models/driver/driver.glb, made by tools/driver_model.py from
   the Sketchfab driver) that bends into any pose. Friends in the hangout and the poker bots use it, each with
   their own colour on the suit, gloves and helmet.
   KBDriver.load()  starts loading (once) and resolves when ready; KBDriver.ready() says if it has loaded.
   KBDriver.make(colour) gives { g, setBone(name, at, dir, out), setHead(at, quaternion), J, len, setColor }:
     - g holds the meshes and bones; joint positions you pass are in g's parent's space.
     - setBone points a bone from `at` along `dir`, with its outer side towards `out`. Bones: pelvis, chest
       (pivots at the neck), upperL/R, foreL/R, handL/R, thighL/R, shinL/R, footL/R.
     - setHead puts the helmet's eye point at `at`, turned by `quaternion`.
     - J is the model's own joints (seated driving pose, facing -z), len its limb lengths. */
(function () {
  const { THREE } = KB;
  const VER = '2';
  let model = null, loading = null;
  const log = m => window.KBLog && KBLog(m);

  async function parse(buf) {
    const dv = new DataView(buf), jl = dv.getUint32(12, true);
    const j = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jl))), bin = 20 + jl + 8;
    const read = i => {
      const a = j.accessors[i], v = j.bufferViews[a.bufferView], o = bin + (v.byteOffset || 0) + (a.byteOffset || 0);
      const n = a.count * { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[a.type];
      const T = { 5126: Float32Array, 5125: Uint32Array, 5123: Uint16Array, 5121: Uint8Array }[a.componentType];
      return new T(buf.slice(o, o + n * T.BYTES_PER_ELEMENT));
    };
    const texs = await Promise.all((j.images || []).map(async im => {
      const v = j.bufferViews[im.bufferView], o = bin + (v.byteOffset || 0);
      const url = URL.createObjectURL(new Blob([new Uint8Array(buf, o, v.byteLength)], { type: im.mimeType }));
      const img = new Image(); img.src = url; await img.decode(); URL.revokeObjectURL(url);
      const t = new THREE.Texture(img); t.flipY = false; t.needsUpdate = true; return t;
    }));
    const prims = j.meshes[0].primitives.map(p => {
      const g = new THREE.BufferGeometry(), A = p.attributes;
      g.setAttribute('position', new THREE.BufferAttribute(read(A.POSITION), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(read(A.NORMAL), 3));
      if (A.TEXCOORD_0 != null) g.setAttribute('uv', new THREE.BufferAttribute(read(A.TEXCOORD_0), 2));
      if (A.COLOR_0 != null) g.setAttribute('color', new THREE.BufferAttribute(read(A.COLOR_0), 3, true));
      g.setAttribute('skinIndex', new THREE.BufferAttribute(new Uint16Array(read(A.JOINTS_0)), 4));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(read(A.WEIGHTS_0), 4));
      g.setIndex(new THREE.BufferAttribute(read(p.indices), 1));
      const m = j.materials[p.material], ti = m.pbrMetallicRoughness && m.pbrMetallicRoughness.baseColorTexture;
      return { name: m.name, geo: g, map: ti ? texs[ti.index] : null };
    });
    const ex = j.asset.extras, J = {};
    for (const k in ex.joints) { const v = ex.joints[k]; J[k] = new THREE.Vector3(v[0], v[1], v[2]); }
    const d = (a, b) => J[a].distanceTo(J[b]);
    const len = { upper: d('shR', 'elR'), fore: d('elR', 'wrR'), thigh: d('hipR', 'knR'), shin: d('knR', 'anR') };
    return { prims, bones: ex.bones, J, len };
  }
  function load() {
    if (!loading) loading = fetch('models/driver/driver.glb?v=' + VER).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
      .then(parse).then(m => { model = m; log('driver model ready'); return m; })
      .catch(e => { log('driver model failed: ' + e.message); loading = null; return null; });
    return loading;
  }

  // a bone's frame: y along the bone, x towards its outer side
  const _x = new THREE.Vector3(), _y = new THREE.Vector3(), _z = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion();
  function basis(dir, out, m) {
    _y.copy(dir).normalize(); _x.copy(out).addScaledVector(_y, -out.dot(_y)); if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0); _x.normalize();
    _z.crossVectors(_x, _y); return m.makeBasis(_x, _y, _z);
  }
  function make(colour) {
    if (!model) return null;
    const M = model, J = M.J, g = new THREE.Group();
    const col = new THREE.Color(colour || '#9aa5ab'), light = col.clone().lerp(new THREE.Color(0xffffff), 0.45);
    const X = new THREE.Vector3(1, 0, 0), UP = new THREE.Vector3(0, 1, 0);
    // each bone's rest frame (where it sits in the model's own pose)
    const rest = {};
    const seg = { upper: ['sh', 'el'], fore: ['el', 'wr'], hand: ['wr', 'hand'], thigh: ['hip', 'kn'], shin: ['kn', 'an'], foot: ['an', 'toe'] };
    for (const name of M.bones) {
      let p, dir, out;
      if (name === 'pelvis') { p = J.pelvis; dir = UP; out = X; }
      else if (name === 'chest') { p = J.neck; dir = J.neck.clone().sub(J.waist); out = X; }
      else if (name === 'head') { p = J.eye; dir = UP; out = X; }
      else { const k = name.slice(-1), s = seg[name.slice(0, -1)]; p = J[s[0] + k]; dir = J[s[1] + k].clone().sub(p); out = new THREE.Vector3(k === 'L' ? -1 : 1, 0, 0); }
      rest[name] = { p: p.clone(), inv: basis(dir, out, new THREE.Matrix4()).clone().invert() };
    }
    const bones = M.bones.map(name => { const b = new THREE.Bone(); b.name = name; b.position.copy(rest[name].p); g.add(b); return b; });
    const byName = {}; M.bones.forEach((n, i) => byName[n] = bones[i]);
    const skeleton = new THREE.Skeleton(bones, M.bones.map(n => new THREE.Matrix4().makeTranslation(-rest[n].p.x, -rest[n].p.y, -rest[n].p.z)));
    const mats = {};
    for (const p of M.prims) {
      let mat;
      if (p.name === 'visor') mat = KBMat({ color: 0x14181b, transparent: true, opacity: 0.9 }, 'glass');
      else if (p.name === 'misc') mat = KBMat({ vertexColors: true }, 'satin');
      else mat = KBMat({ map: p.map, color: p.name === 'suit' ? col : light }, p.name === 'helmet' ? 'paint' : 'satin');
      mat.skinning = true; mat.side = THREE.DoubleSide; mats[p.name] = mat; // the source model is double-sided throughout
      const mesh = new THREE.SkinnedMesh(p.geo, mat); mesh.frustumCulled = false; mesh.bind(skeleton, new THREE.Matrix4()); g.add(mesh);
    }
    const R = new THREE.Matrix4();
    return {
      g, J, len: M.len, bones: byName,
      setBone(name, at, dir, out) {
        const b = byName[name]; if (!b) return;
        R.multiplyMatrices(basis(dir, out, _m), rest[name].inv); // rest frame -> wanted frame
        b.quaternion.setFromRotationMatrix(R); b.position.copy(at);
      },
      setHead(at, q) { const b = byName.head; b.position.copy(at); b.quaternion.copy(q); },
      setColor(c) { const cc = new THREE.Color(c); mats.suit && mats.suit.color.copy(cc); const l = cc.clone().lerp(new THREE.Color(0xffffff), 0.45); mats.gloves && mats.gloves.color.copy(l); mats.helmet && mats.helmet.color.copy(l); }
    };
  }
  // Puts a driver in a pose from a few key points (any space, as long as it's g's parent's):
  //   eye, headQ (head turn), fwd (which way the body faces, flat), floorY, hands: [left, right] targets
  //   (palm points, or null to rest them), seated: { y } to sit with thighs level at that height (or null to stand/auto)
  const t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), t3 = new THREE.Vector3(), qy = new THREE.Quaternion(), UPV = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0);
  function reach(A, T, l1, l2, pole, joint, end) {
    t1.copy(T).sub(A); let d = t1.length() || 1e-4; t1.multiplyScalar(1 / d);
    d = Math.max(Math.abs(l1 - l2) + 1e-3, Math.min(l1 + l2 - 1e-3, d));
    const a = (l1 * l1 + d * d - l2 * l2) / (2 * d), h = Math.sqrt(Math.max(0, l1 * l1 - a * a));
    t2.copy(pole).addScaledVector(t1, -pole.dot(t1)); if (t2.lengthSq() < 1e-6) t2.set(0, -1, 0); t2.normalize();
    joint.copy(A).addScaledVector(t1, a).addScaledVector(t2, h); end.copy(A).addScaledVector(t1, d);
  }
  function pose(D, o) {
    const J = D.J, fwd = o.fwd.clone().setY(0); if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1); fwd.normalize();
    const right = new THREE.Vector3(-fwd.z, 0, fwd.x), yaw = Math.atan2(-fwd.x, -fwd.z); qy.setFromAxisAngle(UPV, yaw);
    const off = (a, b) => J[a].clone().sub(J[b]).applyQuaternion(qy);
    D.setHead(o.eye, o.headQ);
    const neck = o.eye.clone().add(off('neck', 'eye')), pelvis = neck.clone().add(off('pelvis', 'neck'));
    D.setBone('chest', neck, UPV, right); D.setBone('pelvis', pelvis, UPV, right);
    const el = new THREE.Vector3(), wr = new THREE.Vector3(), kn = new THREE.Vector3(), an = new THREE.Vector3();
    const res = { hands: [], feet: [] };
    [['L', -1], ['R', 1]].forEach(([k, sd], i) => {
      const out = right.clone().multiplyScalar(sd), sh = neck.clone().add(off('sh' + k, 'neck'));
      let h = o.hands && o.hands[i];
      if (!h) h = sh.clone().addScaledVector(fwd, 0.36).addScaledVector(right, -sd * 0.06).add(t3.set(0, -0.2, 0)); // resting in front
      const wrT = h.clone().addScaledVector(t3.copy(h).sub(sh).normalize(), -0.07); // the palm is a hand's width past the wrist
      const pole = DOWN.clone().addScaledVector(right, sd * 0.7).addScaledVector(fwd, -0.3);
      reach(sh, wrT, D.len.upper, D.len.fore, pole, el, wr);
      D.setBone('upper' + k, sh, t3.copy(el).sub(sh), out); D.setBone('fore' + k, el, t3.copy(wr).sub(el), out); D.setBone('hand' + k, wr, t3.copy(wr).sub(el), out);
      res.hands.push(wr.clone().addScaledVector(t3.copy(wr).sub(el).normalize(), 0.08));
      const hip = pelvis.clone().add(off('hip' + k, 'pelvis')), LEG = D.len.thigh + D.len.shin;
      let foot;
      if (o.seated) { // knees forward at seat height, shins down to the floor
        const knee = hip.clone().addScaledVector(fwd, D.len.thigh * 0.95).addScaledVector(right, sd * 0.03); knee.y = Math.max(o.seated.y, hip.y - 0.08);
        foot = knee.clone().addScaledVector(fwd, 0.08); foot.y = o.floorY + 0.08;
      } else {
        const hh = hip.y - o.floorY - 0.08, kk = Math.sqrt(Math.max(0, LEG * LEG - Math.min(LEG * LEG, hh * hh))) * 0.9;
        foot = hip.clone().addScaledVector(fwd, kk).addScaledVector(right, sd * 0.03); foot.y = o.floorY + 0.08;
      }
      reach(hip, foot, D.len.thigh, D.len.shin, fwd, kn, an);
      D.setBone('thigh' + k, hip, t3.copy(kn).sub(hip), out); D.setBone('shin' + k, kn, t3.copy(an).sub(kn), out);
      D.setBone('foot' + k, an, t3.copy(fwd).addScaledVector(DOWN, 0.15), out);
      res.feet.push(an.clone());
    });
    return res;
  }
  window.KBDriver = { load, ready: () => !!model, make, pose };
  load();
})();
