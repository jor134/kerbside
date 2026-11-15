# The racing-driver avatar: turns the detailed Sketchfab driver (suit, gloves, HANS, helmet) into one light,
# skinned mesh for the headset (public/models/driver/driver.glb).
#  - Parts that can't be seen or carry brand marks are dropped (face and eyes inside the helmet, clear
#    covers, tear-offs, the visor decal and stickers, logo patch, tag).
#  - Five materials: suit, gloves and helmet keep their (white) textures so each person's colour tints them;
#    everything else (HANS, straps, padding, balaclava) is baked to vertex colours; the visor is dark glass. All drawn double-sided, like the source.
#  - Each material group is simplified with quadric edge collapses that keep original vertices (tools/qem.c
#    `keep` mode), so texture coordinates, normals and skin weights carry across.
#  - Skinned to 15 bones (pelvis, chest, head, and upper arm / forearm / hand / thigh / shin / foot per side)
#    by distance to each bone, blending smoothly across each joint. The rest pose is the model's own seated
#    driving pose; the app bends it into whatever pose it needs. Joint positions go in asset.extras.
# usage: gcc -O2 -o /tmp/qem tools/qem.c -lm && python3 tools/driver_model.py driver_src.glb public/models/driver/driver.glb
import json, struct, sys, io, os, subprocess, tempfile
import numpy as np
from PIL import Image

src, dst = sys.argv[1], sys.argv[2]; QEM = '/tmp/qem'
b = open(src, 'rb').read(); L = struct.unpack('<I', b[12:16])[0]; j = json.loads(b[20:20 + L]); B = b[20 + L + 8:]

def acc(i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]
    dt = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a['componentType']]; n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    st = bv.get('byteStride'); off = bv.get('byteOffset', 0) + a.get('byteOffset', 0); isz = np.dtype(dt).itemsize
    if st and st != n * isz:
        raw = np.frombuffer(B, np.uint8, st * a['count'], off).reshape(a['count'], st)[:, :n * isz]
        return np.frombuffer(raw.tobytes(), dt).reshape(-1, n)
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
images = {}
def image(ti):
    s = j['textures'][ti]['source']
    if s not in images:
        bv = j['bufferViews'][j['images'][s]['bufferView']]; o = bv.get('byteOffset', 0)
        images[s] = Image.open(io.BytesIO(B[o:o + bv['byteLength']])).convert('RGB')
    return images[s]

DROP = ('Eyes', 'FACE', 'Clear', 'TearOff', 'Visor_Decal', 'VISOR_Sticker', 'Logo', 'Tag_HR')
parts = []
def walk(ni, M):
    n = j['nodes'][ni]; W = M @ node_mat(n)
    if 'mesh' in n:
        name = j['meshes'][n['mesh']]['name']
        if not any(d in name for d in DROP):
            for p in j['meshes'][n['mesh']]['primitives']:
                P = acc(p['attributes']['POSITION']).astype(float); P = (np.c_[P, np.ones(len(P))] @ W.T)[:, :3] * 100
                N = acc(p['attributes']['NORMAL']).astype(float) @ W[:3, :3].T; N /= np.linalg.norm(N, axis=1, keepdims=True) + 1e-12
                UV = acc(p['attributes']['TEXCOORD_0']).astype(float)
                m = j['materials'][p['material']]; ti = m.get('pbrMetallicRoughness', {}).get('baseColorTexture', {}).get('index')
                parts.append(dict(name=name, P=P, N=N, UV=UV, I=acc(p['indices']).reshape(-1, 3).astype(np.int64), tex=ti))
    for c in n.get('children', []): walk(c, W)
for r in j['scenes'][j.get('scene', 0)]['nodes']: walk(r, np.eye(4))
# face -z like everything else in three.js (a half turn about y)
for p in parts: p['P'][:, 0] *= -1; p['P'][:, 2] *= -1; p['N'][:, 0] *= -1; p['N'][:, 2] *= -1

# joints, measured on the model (seated driving pose), after the half turn; side +1 is the right (x > 0)
def side(x, y, z, sd): return np.array([sd * x, y, -z])
JT = {'pelvis': np.array([0, 0.52, -0.03]), 'waist': np.array([0, 0.78, -0.03]), 'neck': np.array([0, 1.10, 0.0]), 'eye': np.array([0, 1.27, -0.07])}
for sd, k in ((1, 'R'), (-1, 'L')):
    JT['sh' + k] = side(0.19, 1.04, 0.0, sd); JT['el' + k] = side(0.23, 1.02, 0.22, sd); JT['wr' + k] = side(0.26, 1.02, 0.44, sd); JT['hand' + k] = side(0.28, 1.03, 0.70, sd)
    JT['hip' + k] = side(0.10, 0.55, 0.05, sd); JT['kn' + k] = side(0.12, 0.66, 0.46, sd); JT['an' + k] = side(0.15, 0.56, 0.84, sd); JT['toe' + k] = side(0.15, 0.60, 1.0, sd)
BONES = ['pelvis', 'chest', 'head', 'upperL', 'foreL', 'handL', 'upperR', 'foreR', 'handR', 'thighL', 'shinL', 'footL', 'thighR', 'shinR', 'footR']
SEG = {'pelvis': ('pelvis', 'waist'), 'chest': ('waist', 'neck')}
for k in 'LR':
    SEG.update({'upper' + k: ('sh' + k, 'el' + k), 'fore' + k: ('el' + k, 'wr' + k), 'hand' + k: ('wr' + k, 'hand' + k),
                'thigh' + k: ('hip' + k, 'kn' + k), 'shin' + k: ('kn' + k, 'an' + k), 'foot' + k: ('an' + k, 'toe' + k)})
ADJ = {('pelvis', 'chest')} | {(a, b) for k in 'LR' for a, b in [('chest', 'upper' + k), ('upper' + k, 'fore' + k), ('fore' + k, 'hand' + k), ('pelvis', 'thigh' + k), ('thigh' + k, 'shin' + k), ('shin' + k, 'foot' + k)]}
adj = lambda a, b: (a, b) in ADJ or (b, a) in ADJ
def seg_dist(P, a, b):
    A, Bp = JT[a], JT[b]; d = Bp - A; t = np.clip(((P - A) @ d) / (d @ d), 0, 1); return np.linalg.norm(P - (A + t[:, None] * d), axis=1)
def skin(P, cands):
    D = np.stack([seg_dist(P, *SEG[c]) for c in cands], 1); o = np.argsort(D, 1); J = np.zeros((len(P), 4), np.uint8); W = np.zeros((len(P), 4), np.float32)
    for i in range(len(P)):
        a, bb = o[i, 0], o[i, 1] if len(cands) > 1 else o[i, 0]
        J[i, 0] = BONES.index(cands[a])
        if len(cands) > 1 and adj(cands[a], cands[bb]):
            w = np.exp(-(D[i, bb] - D[i, a]) / 0.02); J[i, 1] = BONES.index(cands[bb]); W[i, 0], W[i, 1] = 1 / (1 + w), w / (1 + w)
        else: W[i, 0] = 1
    return J, W
BODY = [b for b in BONES if b != 'head']
def group_of(p):
    n = p['name']
    if 'SUIT' in n: return 'suit'
    if 'GLOVES' in n: return 'gloves'
    if 'Helmet_Visor_Helmet_Visor' in n: return 'visor'
    if p['tex'] == 7: return 'helmet'
    return 'misc'
def bones_of(p, P):
    n = p['name']
    if 'SUIT' in n: return skin(P, BODY)
    if 'GLOVES' in n:
        J = np.zeros((len(P), 4), np.uint8); W = np.zeros((len(P), 4), np.float32)
        for k, m in (('R', P[:, 0] > 0), ('L', P[:, 0] <= 0)):
            if m.any(): j2, w2 = skin(P[m], ['fore' + k, 'hand' + k]); J[m], W[m] = j2, w2
        return J, W
    rigid = BONES.index('chest' if ('COLLARE_HANS' in n or n.startswith('HansStrap')) else 'head')
    J = np.zeros((len(P), 4), np.uint8); J[:, 0] = rigid; W = np.zeros((len(P), 4), np.float32); W[:, 0] = 1; return J, W

def qem(V, T, target):
    d = tempfile.mkdtemp(); a, bb = os.path.join(d, 'in.bin'), os.path.join(d, 'out.bin')
    with open(a, 'wb') as f: f.write(struct.pack('<ii', len(V), len(T))); f.write(V.astype(np.float64).tobytes()); f.write(T.astype(np.int32).tobytes())
    subprocess.run([QEM, a, bb, str(target), 'keep'], check=True, stderr=subprocess.DEVNULL)
    r = open(bb, 'rb').read(); nv, nt = struct.unpack('<ii', r[:8]); o = 8
    V2 = np.frombuffer(r, np.float64, nv * 3, o).reshape(nv, 3); o += nv * 24
    T2 = np.frombuffer(r, np.int32, nt * 3, o).reshape(nt, 3); o += nt * 12
    O = np.frombuffer(r, np.int32, nv, o); return V2, T2, O

TARGET = {'suit': 11000, 'gloves': 3700, 'helmet': 12000, 'misc': 7000, 'visor': 2200} # about 36k: only the small hidden detail goes
groups = {}
for p in parts:
    g = group_of(p); J, W = bones_of(p, p['P'])
    C = None
    if g == 'misc' and p['tex'] is not None: # bake the texture into vertex colours
        im = np.asarray(image(p['tex']), np.float32) / 255; h, w = im.shape[:2]
        C = im[(np.clip(p['UV'][:, 1] % 1, 0, 1) * (h - 1)).astype(int), (np.clip(p['UV'][:, 0] % 1, 0, 1) * (w - 1)).astype(int)]
    elif g == 'misc': C = np.full((len(p['P']), 3), 0.5, np.float32)
    groups.setdefault(g, []).append(dict(P=p['P'], N=p['N'], UV=p['UV'], C=C, J=J, W=W, I=p['I']))
out = {}
for g, lst in groups.items():
    P = np.vstack([x['P'] for x in lst]); N = np.vstack([x['N'] for x in lst]); UV = np.vstack([x['UV'] for x in lst])
    J = np.vstack([x['J'] for x in lst]); W = np.vstack([x['W'] for x in lst]); C = np.vstack([x['C'] for x in lst]) if g == 'misc' else None
    I = []; off = 0
    for x in lst: I.append(x['I'] + off); off += len(x['P'])
    I = np.vstack(I)
    # weld vertices that share position and texture coordinate (and colour), so seams stay seams
    key = np.c_[np.round(P / 0.0003), np.round(UV * 2048)] if C is None else np.c_[np.round(P / 0.0003), np.round(C * 32)]
    _, first, inv = np.unique(key.astype(np.int64), axis=0, return_index=True, return_inverse=True); inv = inv.reshape(-1)
    I2 = inv[I]; I2 = I2[(I2[:, 0] != I2[:, 1]) & (I2[:, 1] != I2[:, 2]) & (I2[:, 0] != I2[:, 2])]
    V2, T2, O = qem(P[first], I2, min(len(I2), TARGET[g]))
    src_idx = first[O]
    out[g] = dict(P=V2.astype(np.float32), N=N[src_idx].astype(np.float32), UV=UV[src_idx].astype(np.float32), C=None if C is None else C[src_idx].astype(np.float32),
                  J=J[src_idx], W=W[src_idx], I=T2.astype(np.uint16 if len(V2) < 65536 else np.uint32))
    print(f'{g:7s} {len(I):6d} -> {len(T2):5d} triangles, {len(V2)} vertices')

# textures: suit, gloves, helmet as JPEG
TEX = {'suit': 20, 'gloves': 18, 'helmet': 7}
bin_ = bytearray(); views = []; accs = []; imgs = []; prims = []
def put(data, target=None):
    while len(bin_) % 4: bin_.append(0)
    v = {'buffer': 0, 'byteOffset': len(bin_), 'byteLength': len(data)}
    if target: v['target'] = target
    views.append(v); bin_.extend(data); return len(views) - 1
def acc_put(arr, ctype, typ, norm=False, minmax=False, target=34962):
    a = {'bufferView': put(arr.tobytes(), target), 'componentType': ctype, 'count': len(arr), 'type': typ}
    if norm: a['normalized'] = True
    if minmax: a['min'] = arr.min(0).tolist(); a['max'] = arr.max(0).tolist()
    accs.append(a); return len(accs) - 1
mats = []
for g in ('suit', 'gloves', 'helmet', 'misc', 'visor'):
    if g not in out: continue
    o = out[g]; attrs = {'POSITION': acc_put(o['P'], 5126, 'VEC3', minmax=True), 'NORMAL': acc_put(o['N'], 5126, 'VEC3'),
                         'JOINTS_0': acc_put(o['J'], 5121, 'VEC4'), 'WEIGHTS_0': acc_put(o['W'], 5126, 'VEC4')}
    m = {'name': g}
    if g in TEX:
        attrs['TEXCOORD_0'] = acc_put(o['UV'], 5126, 'VEC2')
        im = image(TEX[g]); bio = io.BytesIO(); im.save(bio, 'JPEG', quality=82); imgs.append({'bufferView': put(bio.getvalue()), 'mimeType': 'image/jpeg', 'name': g})
        m['pbrMetallicRoughness'] = {'baseColorTexture': {'index': len(imgs) - 1}}
    if o['C'] is not None: attrs['COLOR_0'] = acc_put((o['C'] * 255).astype(np.uint8), 5121, 'VEC3', norm=True)
    mats.append(m)
    prims.append({'attributes': attrs, 'indices': acc_put(o['I'].reshape(-1), 5123 if o['I'].dtype == np.uint16 else 5125, 'SCALAR', target=34963), 'material': len(mats) - 1})
while len(bin_) % 4: bin_.append(0)
extras = {'joints': {k: [round(float(x), 4) for x in v] for k, v in JT.items()}, 'bones': BONES, 'segments': SEG,
          'credit': j['asset'].get('extras', {})}
g = {'asset': {'version': '2.0', 'generator': 'kerbside tools/driver_model.py', 'extras': extras}, 'scene': 0, 'scenes': [{'nodes': [0]}], 'nodes': [{'name': 'driver', 'mesh': 0}],
     'meshes': [{'name': 'driver', 'primitives': prims}], 'materials': mats, 'textures': [{'source': i} for i in range(len(imgs))], 'images': imgs,
     'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}]}
js = json.dumps(g, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
os.makedirs(os.path.dirname(dst), exist_ok=True)
open(dst, 'wb').write(struct.pack('<III', 0x46546C67, 2, 28 + len(js) + len(bin_)) + struct.pack('<II', len(js), 0x4E4F534A) + js + struct.pack('<II', len(bin_), 0x004E4942) + bytes(bin_))
print('written', dst, len(bin_) // 1024, 'KB')
