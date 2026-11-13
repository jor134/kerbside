# Make a light copy of the car model for the small tabletop cars: vertex clustering per colour group
# (vertices in the same small cube merge into their average), dropping triangles that collapse.
# usage: python3 mini_car.py car.glb car_mini.glb cell_cm
import json, struct, sys, numpy as np
src, dst, cell = sys.argv[1], sys.argv[2], float(sys.argv[3]) / 100
d = open(src, 'rb').read(); L = struct.unpack('<I', d[12:16])[0]; j = json.loads(d[20:20 + L]); B = d[20 + L + 8:]
CT = {5126: np.float32, 5125: np.uint32, 5123: np.uint16}; NC = {'SCALAR': 1, 'VEC3': 3}
def acc(i):
    a = j['accessors'][i]; bv = j['bufferViews'][a['bufferView']]; o = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    return np.frombuffer(B, dtype=CT[a['componentType']], count=a['count'] * NC[a['type']], offset=o).reshape(a['count'], NC[a['type']])
out = []; total = 0
for m in j['meshes']:
    pr = m['primitives'][0]; P = acc(pr['attributes']['POSITION']).astype(np.float64); I = acc(pr['indices']).reshape(-1, 3).astype(np.int64)
    q = np.floor(P / cell).astype(np.int64); keys, inv = np.unique(q, axis=0, return_inverse=True); inv = inv.reshape(-1)
    NP = np.zeros((len(keys), 3)); cnt = np.bincount(inv, minlength=len(keys)); 
    for k in range(3): NP[:, k] = np.bincount(inv, weights=P[:, k], minlength=len(keys)) / cnt
    T = inv[I]; ok = (T[:, 0] != T[:, 1]) & (T[:, 1] != T[:, 2]) & (T[:, 0] != T[:, 2]); T = T[ok]
    _, first = np.unique(np.sort(T, axis=1), axis=0, return_index=True); T = T[np.sort(first)]  # drop exact duplicates, keep winding
    used, rem = np.unique(T.reshape(-1), return_inverse=True); NP = NP[used].astype(np.float32); T = rem.reshape(-1, 3).astype(np.uint32)
    out.append((m['name'], NP, T)); total += len(T); print(m['name'], len(I), '->', len(T))
print('total triangles', total)
bin_ = b''; views = []; accs = []; meshes = []; nodes = []
for name, NP, T in out:
    for arr, typ, ct, tgt in ((NP, 'VEC3', 5126, 34962), (T, 'SCALAR', 5125, 34963)):
        while len(bin_) % 4: bin_ += b'\0'
        b = arr.tobytes(); views.append({'buffer': 0, 'byteOffset': len(bin_), 'byteLength': len(b), 'target': tgt}); bin_ += b
        a = {'bufferView': len(views) - 1, 'componentType': ct, 'count': int(arr.size // (3 if typ == 'VEC3' else 1)), 'type': typ}
        if typ == 'VEC3': a['min'] = NP.min(0).tolist(); a['max'] = NP.max(0).tolist()
        accs.append(a)
    meshes.append({'name': name, 'primitives': [{'attributes': {'POSITION': len(accs) - 2}, 'indices': len(accs) - 1}]}); nodes.append({'name': name, 'mesh': len(meshes) - 1})
while len(bin_) % 4: bin_ += b'\0'
J = json.dumps({'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': list(range(len(nodes)))}], 'nodes': nodes, 'meshes': meshes, 'accessors': accs, 'bufferViews': views, 'buffers': [{'byteLength': len(bin_)}]}).encode()
while len(J) % 4: J += b' '
glb = struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(J) + 8 + len(bin_)) + struct.pack('<II', len(J), 0x4E4F534A) + J + struct.pack('<II', len(bin_), 0x004E4942) + bin_
open(dst, 'wb').write(glb); print(dst, len(glb), 'bytes')
