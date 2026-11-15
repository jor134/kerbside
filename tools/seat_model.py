# The casino's poker chairs: turns the Sketchfab racing bucket seat into one light, vertex-coloured mesh
# (public/models/casino/seat.glb), recoloured to the casino: red bolsters, black centre, gold harness,
# dark chrome rails. Faces +z (the way the app's chairs face), the cushion's middle at the origin, ~1.4 m tall.
# Each part's texture is baked into vertex colours (its light and dark kept, its hue replaced), then the whole
# seat is lightly simplified (to ~24k triangles) with quadric edge collapses (tools/qem.c `keep` mode, so colours carry across).
# usage: gcc -O2 -o /tmp/qem tools/qem.c -lm && python3 tools/seat_model.py seat_src.glb public/models/casino/seat.glb
import json, struct, sys, io, os, subprocess, tempfile
import numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]; QEM = '/tmp/qem'; TARGET = 24000; SCALE = 0.55; LIFT = 0.06
b = open(src, 'rb').read(); L = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + L]); B = b[20 + L + 8:]
def acc(i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]
    dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a['componentType']]; n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    st = bv.get('byteStride'); off = bv.get('byteOffset', 0) + a.get('byteOffset', 0); isz = np.dtype(dt).itemsize
    if st and st != n * isz:
        raw = np.frombuffer(B, np.uint8, st * a['count'], off).reshape(a['count'], st)[:, :n * isz]; return np.frombuffer(raw.tobytes(), dt).reshape(-1, n)
    return np.frombuffer(B, dt, a['count'] * n, off).reshape(-1, n)
def node_mat(n):
    if 'matrix' in n: return np.array(n['matrix']).reshape(4, 4).T
    M = np.eye(4)
    if 'scale' in n: M = np.diag(list(n['scale']) + [1]) @ M
    if 'rotation' in n:
        x, y, z, w = n['rotation']; R = np.eye(4)
        R[:3, :3] = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]]
        M = R @ M
    if 'translation' in n: T = np.eye(4); T[:3, 3] = n['translation']; M = T @ M
    return M
imgs = {}
def image(ti):
    s = j['textures'][ti]['source']
    if s not in imgs:
        bv = j['bufferViews'][j['images'][s]['bufferView']]; o = bv.get('byteOffset', 0)
        imgs[s] = np.asarray(Image.open(io.BytesIO(B[o:o + bv['byteLength']])).convert('RGB'), np.float32) / 255
    return imgs[s]
# casino palette (linear-ish sRGB 0..1), by source material
RED, GOLD, BLACK, CHROME = np.array([0.62, 0.09, 0.14]), np.array([0.85, 0.66, 0.24]), np.array([0.10, 0.09, 0.10]), np.array([0.30, 0.30, 0.32])
def target(mat):
    if mat.startswith('tali'): return GOLD           # harness straps
    if mat.startswith('SUPPORT') or mat.startswith('suport'): return RED  # side bolsters
    if mat.startswith('METAL'): return CHROME
    return BLACK                                      # centre panels
P_all, N_all, C_all, I_all = [], [], [], []; off = 0
def walk(ni, M):
    global off
    n = j['nodes'][ni]; W = M @ node_mat(n)
    if 'mesh' in n:
        for p in j['meshes'][n['mesh']]['primitives']:
            P = acc(p['attributes']['POSITION']).astype(float); P = (np.c_[P, np.ones(len(P))] @ W.T)[:, :3]
            N = acc(p['attributes']['NORMAL']).astype(float) @ W[:3, :3].T; N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
            m = j['materials'][p['material']]; ti = m.get('pbrMetallicRoughness', {}).get('baseColorTexture', {}).get('index'); tgt = target(m['name'])
            if ti is not None and 'TEXCOORD_0' in p['attributes']:
                uv = acc(p['attributes']['TEXCOORD_0']).astype(float); im = image(ti); h, w = im.shape[:2]
                tex = im[(np.clip(uv[:, 1] % 1, 0, 1) * (h - 1)).astype(int), (np.clip(uv[:, 0] % 1, 0, 1) * (w - 1)).astype(int)]
                lum = tex @ np.array([0.3, 0.59, 0.11]); shade = np.clip(lum / (np.median(lum) + 1e-4), 0.55, 1.45)
                C = tgt[None] * shade[:, None]
            else: C = np.tile(tgt, (len(P), 1))
            I = acc(p['indices']).reshape(-1, 3).astype(np.int64)
            P_all.append(P); N_all.append(N); C_all.append(np.clip(C, 0, 1)); I_all.append(I + off); off += len(P)
    for c in n.get('children', []): walk(c, W)
for r in j['scenes'][j.get('scene', 0)]['nodes']: walk(r, np.eye(4))
P = np.vstack(P_all); N = np.vstack(N_all); C = np.vstack(C_all); I = np.vstack(I_all)
# the source faces +x with its cushion around x 0.35: turn it to face +z, centre the cushion, scale, lift onto a plinth
P = np.c_[-P[:, 2], P[:, 1], P[:, 0]]; N = np.c_[-N[:, 2], N[:, 1], N[:, 0]]
P[:, 2] -= 0.35; P *= SCALE; P[:, 1] += LIFT
key = np.round(P / 0.0004).astype(np.int64) # weld by position only: splitting at colour edges let the two sides simplify apart and open cracks
_, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True); inv = inv.reshape(-1)
I2 = inv[I]; I2 = I2[(I2[:, 0] != I2[:, 1]) & (I2[:, 1] != I2[:, 2]) & (I2[:, 0] != I2[:, 2])]
s = np.sort(I2, 1); _, f = np.unique(s, axis=0, return_index=True); I2 = I2[np.sort(f)]
d = tempfile.mkdtemp(); a, bb = os.path.join(d, 'in.bin'), os.path.join(d, 'out.bin')
V = P[first]
with open(a, 'wb') as fh: fh.write(struct.pack('<ii', len(V), len(I2))); fh.write(V.astype(np.float64).tobytes()); fh.write(I2.astype(np.int32).tobytes())
subprocess.run([QEM, a, bb, str(min(TARGET, len(I2))), 'keep'], check=True, stderr=subprocess.DEVNULL)
r = open(bb, 'rb').read(); nv, nt = struct.unpack('<ii', r[:8]); o = 8
V2 = np.frombuffer(r, np.float64, nv * 3, o).reshape(nv, 3).astype(np.float32); o += nv * 24
T2 = np.frombuffer(r, np.int32, nt * 3, o).reshape(nt, 3); o += nt * 12
O = first[np.frombuffer(r, np.int32, nv, o)]
N2 = N[O].astype(np.float32); C2 = (C[O] * 255).astype(np.uint8); idx = T2.reshape(-1).astype(np.uint16 if nv < 65536 else np.uint32)
print(f'{len(I)} -> {nt} triangles, {nv} vertices; bounds {V2.min(0).round(3)} .. {V2.max(0).round(3)}')
bin_ = bytearray(); views = []; accs = []
def put(arr, target, ctype, typ, norm=False, mm=False):
    while len(bin_) % 4: bin_.append(0)
    views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': arr.nbytes, 'target': target}); bin_.extend(arr.tobytes())
    a = {'bufferView': len(views) - 1, 'componentType': ctype, 'count': len(arr) if arr.ndim > 1 else arr.size, 'type': typ}
    if norm: a['normalized'] = True
    if mm: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accs.append(a); return len(accs) - 1
attrs = {'POSITION': put(V2, 34962, 5126, 'VEC3', mm=True), 'NORMAL': put(N2, 34962, 5126, 'VEC3'), 'COLOR_0': put(C2, 34962, 5121, 'VEC3', norm=True)}
ia = put(idx, 34963, 5123 if idx.dtype == np.uint16 else 5125, 'SCALAR')
while len(bin_) % 4: bin_.append(0)
g = {'asset': {'version': '2.0', 'generator': 'kerbside tools/seat_model.py', 'extras': {'credit': j['asset'].get('extras', {}), 'plinth': [float(V2[:, 0].min()), float(V2[:, 0].max()), float(V2[:, 2].min()), float(V2[:, 2].max()), LIFT]}},
     'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'name': 'seat', 'mesh': 0}], 'meshes': [{'name': 'seat', 'primitives': [{'attributes': attrs, 'indices': ia}]}],
     'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}]}
js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
os.makedirs(os.path.dirname(dst), exist_ok=True)
open(dst, 'wb').write(struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(bin_)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_))
print('written', dst, len(bin_) // 1024, 'KB')
