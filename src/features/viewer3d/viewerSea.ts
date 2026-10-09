/**
 * 3Dビューワー: 雲海(厚さ100mの、水平に近い雲の層)。
 *
 * 雲海の高さの「基準」は、まわりの市街地(森林ではない所)の標高。原点を中心にした20km四方の区画ごとに、森林でない所
 * (盆地の底にある町・田畑・湖など)の標高から「基準点」を1つ作り、基準点どうしをガウス関数の重みでなめらかにつないで
 * (遠い基準点ほど影響を弱めて)、地図(基準の標高の地図)にする。森林・山間部は、近くの基準点の標高に近くなる。
 * 雲海の層の下面 = 基準の標高 + スライダーの高さ、上面 = 下面 + 100m。
 * 層の中・上の描き方(視線が層を通る長さ)はシェーダー側(`viewerGlsl.ts` の `SEA_GLSL`)。
 */

/** 雲海の厚さ(m) */
export const SEA_THICK_M = 100;
/** 層を真上から見たときの光学的厚み(≒99.8%不透明。雲海は白く、地面は透けない) */
export const SEA_TAU_VERTICAL = 6;
/** 1mあたりの減衰 */
export const SEA_SIGMA = SEA_TAU_VERTICAL / SEA_THICK_M;
/** 層の下面の、基準の標高からの高さ(m)のスライダーの範囲と既定値 */
export const SEA_H_MIN_M = 0;
export const SEA_H_MAX_M = 1500;
export const SEA_H_DEFAULT_M = 100;
export const SEA_H_STEP_M = 10;

/** 基準の標高の地図の大きさ(一辺)。なめらかな地図なので粗くてよい */
export const SEA_MAP_SIZE = 256;
/** 地図が覆う範囲(原点から±m)。通常の地形(半径25km)・拡張(50km)より少し広い */
export const seaHalfM = (wide: boolean): number => (wide ? 52_000 : 26_000);
export const seaRect = (wide: boolean): [number, number, number, number] => {
  const h = seaHalfM(wide);
  return [-h, -h, 2 * h, 2 * h];
};

/** 市街地の基準にする標高の上限(m)。これより高い「森林でない所」は、高山帯の草地・岩場なので基準にしない */
const REF_MAX_ELEV_M = 2000;
/** 低い所ほど重くする(盆地の底の町を基準にする)度合い。標高が600m高いと重みが約37% */
const LOW_BIAS_M = 600;
/** 基準点を作る間隔(m)。原点(クリックした所)を中心にした20km四方の区画ごとに、森林でない所から基準点を1つ作る */
export const SEA_POINT_SPACING_M = 20_000;
/** 基準点どうしをなめらかにつなぐ幅(m)。大きいほどゆるやかにつながる(点の間隔の3分の1強。区画の基準点の上では、その点の標高がほぼそのまま出る) */
const BLEND_SIGMA_M = 7_000;
/** 区画のうち森林でない所の割合がこれ未満なら、その区画の基準点の影響をその割合に応じて弱める(わずかな草地などで高さが決まらないように) */
const MIN_NONFOREST_FRAC = 0.04;

/** 位置(X東・Z南、m)が森林か(true=森林、false=森林でない、null=不明・植生図なし) */
export type ForestAt = (X: number, Z: number) => boolean | null;

/** 雲海の基準点: 位置(X東・Z南、m)、基準の標高(m)、影響の強さ(0〜1)、森林でない所のセル数 */
export interface SeaRefPoint {
  x: number;
  z: number;
  e: number;
  w: number;
  n: number;
}

/**
 * 基準点を作る: 原点を中心にした SEA_POINT_SPACING_M(20km)四方の区画ごとに、「森林でなく、標高が REF_MAX_ELEV_M 未満」の所を集め、
 * 低い所ほど重くした平均の位置・標高を、その区画の基準点にする(盆地の底の町・田畑・湖が基準になる)。森林でない所が無い区画には基準点を作らない。
 * elevAt は位置の標高(m。地球の丸みで下がる分を含まない海抜)。forestAt が null か、その位置が null(植生図なし)のときは、標高700m未満を市街地の仲間とみなす。
 * fallback は、基準点が1つも無いとき(深い山の中・海だけなど)に使う標高(全体の下位10%)。
 */
export function seaRefPoints(
  elevAt: (X: number, Z: number) => number,
  forestAt: ForestAt | null,
  half: number,
  size: number = SEA_MAP_SIZE,
): { points: SeaRefPoint[]; fallback: number } {
  const n = size;
  const cell = (2 * half) / n;
  const K = Math.ceil(half / SEA_POINT_SPACING_M) + 1;
  const W = 2 * K + 1;
  const sw = new Float64Array(W * W);
  const sx = new Float64Array(W * W);
  const sz = new Float64Array(W * W);
  const se = new Float64Array(W * W);
  const cnt = new Float64Array(W * W);
  const tot = new Float64Array(W * W);
  const all: number[] = [];
  for (let j = 0; j < n; j++) {
    const Z = -half + (j + 0.5) * cell;
    const bj = Math.floor((Z + SEA_POINT_SPACING_M / 2) / SEA_POINT_SPACING_M) + K;
    for (let i = 0; i < n; i++) {
      const X = -half + (i + 0.5) * cell;
      const bi = Math.floor((X + SEA_POINT_SPACING_M / 2) / SEA_POINT_SPACING_M) + K;
      const e = elevAt(X, Z);
      all.push(e);
      const k = bj * W + bi;
      tot[k] += 1;
      const fo = forestAt ? forestAt(X, Z) : null;
      const f = fo === null ? e >= 700 : fo;
      if (f === false && e < REF_MAX_ELEV_M) {
        const w = Math.exp(-Math.max(0, e) / LOW_BIAS_M);
        sw[k] += w;
        sx[k] += w * X;
        sz[k] += w * Z;
        se[k] += w * e;
        cnt[k] += 1;
      }
    }
  }
  all.sort((a, b) => a - b);
  const fallback = all.length > 0 ? all[Math.floor(all.length * 0.1)] : 0;
  const points: SeaRefPoint[] = [];
  for (let k = 0; k < W * W; k++) {
    if (cnt[k] === 0 || sw[k] <= 0) continue;
    const frac = cnt[k] / Math.max(1, tot[k]);
    points.push({
      x: sx[k] / sw[k],
      z: sz[k] / sw[k],
      e: se[k] / sw[k],
      w: Math.min(1, frac / MIN_NONFOREST_FRAC),
      n: cnt[k],
    });
  }
  return { points, fallback };
}

/**
 * 雲海の「基準の標高」の地図(m。size×size。上が北)を作る。
 *   1. 原点を中心にした20km四方の区画ごとに、森林でない所(標高 REF_MAX_ELEV_M 未満)から基準点を作る(`seaRefPoints`)
 *   2. 各画素の基準の標高 = 基準点の標高を、距離のガウス関数(幅 BLEND_SIGMA_M)の重みで混ぜた値。どこでもなめらかにつながる
 *      (森林・山間部は、近くの基準点=近くの市街地の標高に近くなり、遠い基準点ほど影響が弱い)
 * 基準点が1つも無いときは、全体の下位10%の標高の一定値にする。
 */
export function buildSeaRefMap(
  elevAt: (X: number, Z: number) => number,
  forestAt: ForestAt | null,
  half: number,
  size: number = SEA_MAP_SIZE,
): Float32Array {
  const n = size;
  const cell = (2 * half) / n;
  const { points, fallback } = seaRefPoints(elevAt, forestAt, half, n);
  const out = new Float32Array(n * n);
  if (points.length === 0) {
    out.fill(fallback);
    return out;
  }
  const inv = 1 / (2 * BLEND_SIGMA_M * BLEND_SIGMA_M);
  for (let j = 0; j < n; j++) {
    const Z = -half + (j + 0.5) * cell;
    for (let i = 0; i < n; i++) {
      const X = -half + (i + 0.5) * cell;
      let a = 0;
      let b = 0;
      let nearest = 0;
      let nd = Infinity;
      for (let q = 0; q < points.length; q++) {
        const p = points[q];
        const d2 = (X - p.x) ** 2 + (Z - p.z) ** 2;
        if (d2 < nd) {
          nd = d2;
          nearest = q;
        }
        const w = p.w * Math.exp(-d2 * inv);
        a += w * p.e;
        b += w;
      }
      // どの点からも遠すぎて重みが0に潰れるとき(影響0の点だけのとき)は、いちばん近い点の標高
      out[j * n + i] = b > 1e-300 ? a / b : points[nearest].e;
    }
  }
  return out;
}

/** 基準の標高の地図から、位置(X東・Z南、m)の基準の標高(m)を引く。範囲外は null */
export function seaRefAt(map: Float32Array, size: number, half: number, X: number, Z: number): number | null {
  const u = (X + half) / (2 * half);
  const v = (Z + half) / (2 * half);
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
  const fx = u * size - 0.5;
  const fy = v * size - 0.5;
  const x0 = Math.max(0, Math.min(size - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(size - 1, Math.floor(fy)));
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);
  const tx = Math.min(1, Math.max(0, fx - x0));
  const ty = Math.min(1, Math.max(0, fy - y0));
  const a = map[y0 * size + x0] * (1 - tx) + map[y0 * size + x1] * tx;
  const b = map[y1 * size + x0] * (1 - tx) + map[y1 * size + x1] * tx;
  return a * (1 - ty) + b * ty;
}
