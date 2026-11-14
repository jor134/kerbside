# Kerbside's car models, from the detailed, textured Sketchfab car (based on breachline tools/solid_car.py).
# Same colour sorting as there, but each colour group is simplified with quadric edge collapses (tools/qem.c)
# instead of vertex clustering, so the shape keeps its smooth curves at a far lower triangle count.
# - every triangle is sorted by the colour its texture shows: team paint, carbon, metal (body), tyre, rim (wheels)
# - decals and the tiny cockpit parts are dropped
# - each colour group is simplified by vertex clustering (vertices in the same small cube merge), keeping colour edges
# - the result faces +z, sits on y = 0, is CAR_LEN long, and is written as one mesh per colour group (positions + indices;
#   the game shades it flat, so no normals or texture coordinates are stored)
# usage: gcc -O2 -o /tmp/qem tools/qem.c -lm && python3 tools/hq_car.py in.glb out.glb target_triangles
import json, struct, io, sys, colorsys
import numpy as np
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]; TARGET = int(sys.argv[3]); QEM = '/tmp/qem'
import subprocess, tempfile, os
CAR_LEN = 5.6
SKIP = ('Buttons', 'Grip Button', 'Ferrari Button', 'Gears', 'Its for something', 'Steering Wheel', 'Antennas')
d = open(src, 'rb').read(); L = struct.unpack('<I', d[12:16])[0]; j = json.loads(d[20:20 + L]); B = d[20 + L + 8:]
NC = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}; CT = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}
def acc(i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]; n = NC[a['type']]; dt = np.dtype(CT[a['componentType']])
    o = bv.get('byteOffset', 0) + a.get('byteOffset', 0); st = bv.get('byteStride', dt.itemsize * n)
    if st == dt.itemsize * n: return np.frombuffer(B, dtype=dt, count=a['count'] * n, offset=o).reshape(a['count'], n).copy()
    raw = np.frombuffer(B, dtype=np.uint8, count=st * (a['count'] - 1) + dt.itemsize * n, offset=o)
    return np.lib.stride_tricks.as_strided(raw, (a['count'], dt.itemsize * n), (st, 1)).copy().view(dt).reshape(a['count'], n)
def texture(mi):
    t = j['materials'][mi]['pbrMetallicRoughness']['baseColorTexture']['index']; im = j['images'][j['textures'][t]['source']]; bv = j['bufferViews'][im['bufferView']]
    o = bv.get('byteOffset', 0); return np.asarray(Image.open(io.BytesIO(B[o:o + bv['byteLength']])).convert('RGB'), dtype=np.float32) / 255
TEX = {0: texture(0), 1: texture(1)}
def node_mats():
    out = {}
    def mat(nd):
        if 'matrix' in nd: return np.array(nd['matrix'], dtype=np.float64).reshape(4, 4).T
        T = np.eye(4); t = nd.get('translation', [0, 0, 0]); r = nd.get('rotation', [0, 0, 0, 1]); s = nd.get('scale', [1, 1, 1])
        x, y, z, w = r; R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
        T[:3, :3] = R * np.array(s); T[:3, 3] = t; return T
    def walk(i, P):
        M = P @ mat(j['nodes'][i]); out[i] = M
        for c in j['nodes'][i].get('children', []): walk(c, M)
    for r in j['scenes'][j.get('scene', 0)]['nodes']: walk(r, np.eye(4))
    return out
W = node_mats()
groups = {k: ([], []) for k in ('paint', 'carbon', 'metal', 'tyre', 'rim')}; nose = []
def classify(mi, rgb):
    h, s, v = np.vectorize(colorsys.rgb_to_hsv)(rgb[:, 0], rgb[:, 1], rgb[:, 2])
    if mi == 1: return np.where(v < 0.3, 'tyre', 'rim')
    red = (s > 0.45) & (v > 0.3) & ((h < 0.06) | (h > 0.94))
    return np.where(red, 'paint', np.where(v < 0.3, 'carbon', 'metal'))
for ni, nd in enumerate(j['nodes']):
    if 'mesh' not in nd: continue
    m = j['meshes'][nd['mesh']]; name = m.get('name', '')
    for p in m['primitives']:
        mi = p.get('material', 0); P = acc(p['attributes']['POSITION']).astype(np.float64); P = (np.c_[P, np.ones(len(P))] @ W[ni].T)[:, :3]
        if 'Decal Wing Front' in name: nose.append(P.mean(0))
        if mi == 2 or any(name.startswith(k) for k in SKIP): continue
        I = acc(p['indices']).reshape(-1, 3).astype(np.int64); UV = acc(p['attributes']['TEXCOORD_0'])
        tex = TEX[mi]; h, w = tex.shape[:2]; uv = UV[I].mean(1); u = (uv[:, 0] % 1) * (w - 1); vv = (uv[:, 1] % 1) * (h - 1)
        cls = classify(mi, tex[vv.astype(int), u.astype(int)])
        for k in groups:
            sel = I[cls == k]
            if len(sel): groups[k][0].append(P); groups[k][1].append(sel)
# one frame for everything: long axis to z, nose to +z, wheels on y = 0, length CAR_LEN
allP = np.vstack([np.vstack(g[0]) for g in groups.values() if g[0]]); lo, hi = allP.min(0), allP.max(0); ext = hi - lo
up = int(np.argmin(ext)); long = int(np.argmax(ext)); side = 3 - up - long
k = CAR_LEN / ext[long]; c = (lo + hi) / 2
nz = np.mean(nose, 0)[long] - c[long] if nose else 1; flip = -1 if nz < 0 else 1
def frame(P): q = (P - c) * k; return np.c_[q[:, side] * flip, q[:, up] - (lo[up] - c[up]) * k, q[:, long] * flip]
out = bytearray(); views = []; accs = []; meshes = []; nodes = []
def put(arr, target):
    while len(out) % 4: out.append(0)
    views.append({'buffer': 0, 'byteOffset': len(out), 'byteLength': arr.nbytes, 'target': target}); out.extend(arr.tobytes()); return len(views) - 1
def weld(V, T, tol=0.0003):
    key = np.round(V / tol).astype(np.int64); uk, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True); inv = inv.reshape(-1)
    T2 = inv[T]; T2 = T2[(T2[:, 0] != T2[:, 1]) & (T2[:, 1] != T2[:, 2]) & (T2[:, 0] != T2[:, 2])]
    s = np.sort(T2, 1); _, f = np.unique(s, axis=0, return_index=True); T2 = T2[np.sort(f)]
    return V[first], T2
def qem(V, T, target):
    d = tempfile.mkdtemp(); a, b = os.path.join(d, 'in.bin'), os.path.join(d, 'out.bin')
    with open(a, 'wb') as f: f.write(struct.pack('<ii', len(V), len(T))); f.write(V.astype(np.float64).tobytes()); f.write(T.astype(np.int32).tobytes())
    subprocess.run([QEM, a, b, str(target)], check=True)
    r = open(b, 'rb').read(); nv, nt = struct.unpack('<ii', r[:8]); V2 = np.frombuffer(r, np.float64, nv * 3, 8).reshape(nv, 3); T2 = np.frombuffer(r, np.int32, nt * 3, 8 + nv * 24).reshape(nt, 3)
    return V2, T2
work = {}
for name, (Ps, Is) in groups.items():
    if not Ps: continue
    V = []; T = []; off = 0
    for P, I in zip(Ps, Is): V.append(frame(P)); T.append(I + off); off += len(P)
    work[name] = weld(np.vstack(V), np.vstack(T))
# share of the budget: rims spin and sit in shadow, so they get less; tyres are already light
WEIGHT = {'paint': 1.4, 'carbon': 1.0, 'metal': 0.9, 'tyre': 4.0, 'rim': 0.35}
total = sum(len(t) * WEIGHT[n] for n, (_, t) in work.items()); ratio = TARGET / total
for name, (V, T) in work.items():
    V2, T2 = qem(V, T, max(60, min(len(T), int(len(T) * ratio * WEIGHT[name]))))
    pos = V2.astype(np.float32); idx = T2.reshape(-1).astype(np.uint16 if len(pos) < 65536 else np.uint32)
    pa = put(pos, 34962); accs.append({'bufferView': pa, 'componentType': 5126, 'count': len(pos), 'type': 'VEC3', 'min': pos.min(0).tolist(), 'max': pos.max(0).tolist()})
    ia = put(idx, 34963); accs.append({'bufferView': ia, 'componentType': 5123 if idx.dtype == np.uint16 else 5125, 'count': len(idx), 'type': 'SCALAR'})
    meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': len(accs) - 2}, 'indices': len(accs) - 1}]}); nodes.append({'name': name, 'mesh': len(meshes) - 1})
    print(f'{name:7s} {len(T):7d} tris  ->  {len(T2):6d} tris')
while len(out) % 4: out.append(0)
g = {'asset': {'version': '2.0', 'generator': 'kerbside tools/hq_car.py', 'extras': j['asset'].get('extras', {})}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}],
     'nodes': nodes, 'meshes': meshes, 'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(out)}]}
js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
open(dst, 'wb').write(struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(out)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(out), 0x004E4942) + bytes(out))
print('written', dst, len(out) // 1024, 'KB')
