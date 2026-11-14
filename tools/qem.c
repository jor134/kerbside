/* Quadric-error mesh simplification (Garland & Heckbert), for tools/hq_car.py.
   Reads  in.bin: int32 nv, int32 nt, double[nv*3] positions, int32[nt*3] indices
   Writes out.bin in the same layout, simplified to about `target` triangles.
   Open edges (holes, and the seams between colour groups) are held in place by extra planes, and a
   collapse that would flip a triangle over is refused, so the outline and the panel edges survive.
   build: gcc -O2 -o qem tools/qem.c -lm      usage: ./qem in.bin out.bin target */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef struct { double q[10]; } Quad;
typedef struct { int *f; int n, cap; } List;
typedef struct { double cost; int a, b, sa, sb; double p[3]; } Item;

static int nv, nt; static double *P; static int *T; static char *dead; static char *vdead; static int *stamp;
static Quad *Q; static List *adj; static Item *heap; static int hn, hcap;

static void ladd(List *l, int f) { if (l->n == l->cap) { l->cap = l->cap ? l->cap * 2 : 8; l->f = realloc(l->f, l->cap * sizeof(int)); } l->f[l->n++] = f; }
static void qplane(Quad *o, double a, double b, double c, double d, double w) {
  double *q = o->q; q[0] += w*a*a; q[1] += w*a*b; q[2] += w*a*c; q[3] += w*a*d; q[4] += w*b*b; q[5] += w*b*c; q[6] += w*b*d; q[7] += w*c*c; q[8] += w*c*d; q[9] += w*d*d; }
static double qerr(const double *q, const double *v) { double x = v[0], y = v[1], z = v[2];
  return q[0]*x*x + 2*q[1]*x*y + 2*q[2]*x*z + 2*q[3]*x + q[4]*y*y + 2*q[5]*y*z + 2*q[6]*y + q[7]*z*z + 2*q[8]*z + q[9]; }
static void hpush(Item it) { if (hn == hcap) { hcap = hcap ? hcap * 2 : 1024; heap = realloc(heap, hcap * sizeof(Item)); }
  int i = hn++; while (i > 0) { int p = (i - 1) / 2; if (heap[p].cost <= it.cost) break; heap[i] = heap[p]; i = p; } heap[i] = it; }
static Item hpop(void) { Item top = heap[0], last = heap[--hn]; int i = 0;
  for (;;) { int l = 2*i + 1, r = l + 1, m = i; double c = last.cost;
    if (l < hn && heap[l].cost < c) { m = l; c = heap[l].cost; } if (r < hn && heap[r].cost < c) m = r;
    if (m == i) break; heap[i] = heap[m]; i = m; }
  heap[i] = last; return top; }
static void fnormal(int f, const double *override_v, int which, double *n) {
  const double *p[3]; for (int k = 0; k < 3; k++) p[k] = (T[f*3+k] == which && override_v) ? override_v : P + 3*T[f*3+k];
  double u[3] = { p[1][0]-p[0][0], p[1][1]-p[0][1], p[1][2]-p[0][2] }, v[3] = { p[2][0]-p[0][0], p[2][1]-p[0][1], p[2][2]-p[0][2] };
  n[0] = u[1]*v[2]-u[2]*v[1]; n[1] = u[2]*v[0]-u[0]*v[2]; n[2] = u[0]*v[1]-u[1]*v[0]; }
static void evaluate(int a, int b) {
  Quad s; for (int k = 0; k < 10; k++) s.q[k] = Q[a].q[k] + Q[b].q[k];
  double *q = s.q, A[9] = { q[0], q[1], q[2], q[1], q[4], q[5], q[2], q[5], q[7] }, rhs[3] = { -q[3], -q[6], -q[8] };
  double det = A[0]*(A[4]*A[8]-A[5]*A[7]) - A[1]*(A[3]*A[8]-A[5]*A[6]) + A[2]*(A[3]*A[7]-A[4]*A[6]);
  double best[3], bc = 1e300, cand[4][3]; int nc = 0;
  double *pa = P + 3*a, *pb = P + 3*b;
  if (fabs(det) > 1e-12) { double x[3];
    x[0] = (rhs[0]*(A[4]*A[8]-A[5]*A[7]) - A[1]*(rhs[1]*A[8]-A[5]*rhs[2]) + A[2]*(rhs[1]*A[7]-A[4]*rhs[2])) / det;
    x[1] = (A[0]*(rhs[1]*A[8]-A[5]*rhs[2]) - rhs[0]*(A[3]*A[8]-A[5]*A[6]) + A[2]*(A[3]*rhs[2]-rhs[1]*A[6])) / det;
    x[2] = (A[0]*(A[4]*rhs[2]-rhs[1]*A[7]) - A[1]*(A[3]*rhs[2]-rhs[1]*A[6]) + rhs[0]*(A[3]*A[7]-A[4]*A[6])) / det;
    /* keep the solved point near the edge, or thin parts can balloon */
    double ex = pb[0]-pa[0], ey = pb[1]-pa[1], ez = pb[2]-pa[2], L2 = ex*ex+ey*ey+ez*ez;
    double mx = (pa[0]+pb[0])/2, my = (pa[1]+pb[1])/2, mz = (pa[2]+pb[2])/2, dx = x[0]-mx, dy = x[1]-my, dz = x[2]-mz;
    if (dx*dx+dy*dy+dz*dz < L2) { memcpy(cand[nc++], x, sizeof x); } }
  memcpy(cand[nc++], pa, 3*sizeof(double)); memcpy(cand[nc++], pb, 3*sizeof(double));
  cand[nc][0] = (pa[0]+pb[0])/2; cand[nc][1] = (pa[1]+pb[1])/2; cand[nc][2] = (pa[2]+pb[2])/2; nc++;
  for (int i = 0; i < nc; i++) { double e = qerr(q, cand[i]); if (e < bc) { bc = e; memcpy(best, cand[i], sizeof best); } }
  Item it; it.cost = bc < 0 ? 0 : bc; it.a = a; it.b = b; it.sa = stamp[a]; it.sb = stamp[b]; memcpy(it.p, best, sizeof best); hpush(it); }
static int flips(int v, int other, const double *np) {
  for (int i = 0; i < adj[v].n; i++) { int f = adj[v].f[i]; if (dead[f]) continue;
    int hasO = 0; for (int k = 0; k < 3; k++) if (T[f*3+k] == other) hasO = 1; if (hasO) continue;
    double n0[3], n1[3]; fnormal(f, NULL, -1, n0); fnormal(f, np, v, n1);
    double l0 = sqrt(n0[0]*n0[0]+n0[1]*n0[1]+n0[2]*n0[2]), l1 = sqrt(n1[0]*n1[0]+n1[1]*n1[1]+n1[2]*n1[2]);
    if (l1 < 1e-18) return 1; if (l0 < 1e-18) continue;
    if ((n0[0]*n1[0]+n0[1]*n1[1]+n0[2]*n1[2]) / (l0*l1) < 0.3) return 1; }
  return 0; }
static int cmpi(const void *x, const void *y) { long long a = *(const long long*)x, b = *(const long long*)y; return a < b ? -1 : a > b; }

int main(int argc, char **argv) {
  if (argc < 4) { fprintf(stderr, "usage: qem in.bin out.bin target\n"); return 1; }
  FILE *fi = fopen(argv[1], "rb"); int target = atoi(argv[3]);
  if (fread(&nv, 4, 1, fi) != 1 || fread(&nt, 4, 1, fi) != 1) return 1;
  P = malloc(nv*3*sizeof(double)); T = malloc(nt*3*sizeof(int));
  if (fread(P, sizeof(double), nv*3, fi) != (size_t)nv*3 || fread(T, 4, nt*3, fi) != (size_t)nt*3) return 1; fclose(fi);
  dead = calloc(nt, 1); vdead = calloc(nv, 1); stamp = calloc(nv, sizeof(int)); Q = calloc(nv, sizeof(Quad)); adj = calloc(nv, sizeof(List));
  for (int f = 0; f < nt; f++) { double n[3]; fnormal(f, NULL, -1, n); double l = sqrt(n[0]*n[0]+n[1]*n[1]+n[2]*n[2]);
    if (l < 1e-18) { dead[f] = 1; continue; } double a = n[0]/l, b = n[1]/l, c = n[2]/l, d = -(a*P[3*T[f*3]] + b*P[3*T[f*3]+1] + c*P[3*T[f*3]+2]);
    for (int k = 0; k < 3; k++) { qplane(&Q[T[f*3+k]], a, b, c, d, l * 0.5); ladd(&adj[T[f*3+k]], f); } }
  /* edges: count how many faces use each, to find open edges */
  long long *E = malloc((size_t)nt*3*sizeof(long long)); int ne = 0;
  for (int f = 0; f < nt; f++) if (!dead[f]) for (int k = 0; k < 3; k++) { int a = T[f*3+k], b = T[f*3+(k+1)%3]; if (a > b) { int t = a; a = b; b = t; } E[ne++] = (long long)a * nv + b; }
  qsort(E, ne, sizeof(long long), cmpi);
  for (int i = 0; i < ne; ) { int j = i; while (j < ne && E[j] == E[i]) j++;
    int a = (int)(E[i] / nv), b = (int)(E[i] % nv);
    if (j - i == 1) { /* open edge: a plane through it, upright to the face, heavily weighted */
      int f = -1; for (int m = 0; m < adj[a].n && f < 0; m++) { int g = adj[a].f[m]; if (dead[g]) continue; for (int k = 0; k < 3; k++) if (T[g*3+k] == b) f = g; }
      if (f >= 0) { double n[3]; fnormal(f, NULL, -1, n); double *pa = P+3*a, *pb = P+3*b, e[3] = { pb[0]-pa[0], pb[1]-pa[1], pb[2]-pa[2] };
        double c[3] = { e[1]*n[2]-e[2]*n[1], e[2]*n[0]-e[0]*n[2], e[0]*n[1]-e[1]*n[0] }, l = sqrt(c[0]*c[0]+c[1]*c[1]+c[2]*c[2]), el2 = e[0]*e[0]+e[1]*e[1]+e[2]*e[2];
        if (l > 1e-18) { c[0] /= l; c[1] /= l; c[2] /= l; double d = -(c[0]*pa[0]+c[1]*pa[1]+c[2]*pa[2]); qplane(&Q[a], c[0], c[1], c[2], d, el2 * 1000); qplane(&Q[b], c[0], c[1], c[2], d, el2 * 1000); } } }
    evaluate(a, b); i = j; }
  free(E);
  int live = 0; for (int f = 0; f < nt; f++) live += !dead[f];
  int *mark = calloc(nv, sizeof(int)), markId = 0;
  while (live > target && hn > 0) {
    Item it = hpop(); int a = it.a, b = it.b;
    if (vdead[a] || vdead[b] || it.sa != stamp[a] || it.sb != stamp[b]) continue;
    if (flips(a, b, it.p) || flips(b, a, it.p)) continue;
    /* link condition: the two ends may share only the (one or two) faces' third corners, or the surface tears */
    markId++; int shared = 0, edgeFaces = 0;
    for (int i = 0; i < adj[a].n; i++) { int f = adj[a].f[i]; if (dead[f]) continue; for (int k = 0; k < 3; k++) mark[T[f*3+k]] = markId; }
    for (int i = 0; i < adj[b].n; i++) { int f = adj[b].f[i]; if (dead[f]) continue; int hasA = 0; for (int k = 0; k < 3; k++) if (T[f*3+k] == a) hasA = 1; if (hasA) edgeFaces++; }
    markId++; int seen = markId;
    for (int i = 0; i < adj[b].n; i++) { int f = adj[b].f[i]; if (dead[f]) continue; for (int k = 0; k < 3; k++) { int v = T[f*3+k]; if (v == a || v == b) continue; if (mark[v] == seen - 1) { mark[v] = seen; shared++; } } }
    if (shared > edgeFaces) continue;
    memcpy(P + 3*a, it.p, 3*sizeof(double)); for (int k = 0; k < 10; k++) Q[a].q[k] += Q[b].q[k];
    for (int i = 0; i < adj[b].n; i++) { int f = adj[b].f[i]; if (dead[f]) continue; int hasA = 0;
      for (int k = 0; k < 3; k++) if (T[f*3+k] == a) hasA = 1;
      if (hasA) { dead[f] = 1; live--; } else { for (int k = 0; k < 3; k++) if (T[f*3+k] == b) T[f*3+k] = a; ladd(&adj[a], f); } }
    vdead[b] = 1; stamp[a]++;
    int w = 0; for (int i = 0; i < adj[a].n; i++) if (!dead[adj[a].f[i]]) adj[a].f[w++] = adj[a].f[i]; adj[a].n = w;
    markId++;
    for (int i = 0; i < adj[a].n; i++) { int f = adj[a].f[i]; for (int k = 0; k < 3; k++) { int v = T[f*3+k]; if (v != a && mark[v] != markId) { mark[v] = markId; evaluate(a, v); } } }
  }
  int *remap = malloc(nv*sizeof(int)), mv = 0; for (int v = 0; v < nv; v++) remap[v] = -1;
  for (int f = 0; f < nt; f++) if (!dead[f]) for (int k = 0; k < 3; k++) { int v = T[f*3+k]; if (remap[v] < 0) remap[v] = mv++; }
  FILE *fo = fopen(argv[2], "wb"); fwrite(&mv, 4, 1, fo); fwrite(&live, 4, 1, fo);
  double *NP = malloc(mv*3*sizeof(double)); for (int v = 0; v < nv; v++) if (remap[v] >= 0) memcpy(NP + 3*remap[v], P + 3*v, 3*sizeof(double));
  fwrite(NP, sizeof(double), mv*3, fo);
  for (int f = 0; f < nt; f++) if (!dead[f]) { int t[3] = { remap[T[f*3]], remap[T[f*3+1]], remap[T[f*3+2]] }; fwrite(t, 4, 3, fo); }
  fclose(fo); fprintf(stderr, "%d -> %d triangles, %d verts\n", nt, live, mv); return 0; }
