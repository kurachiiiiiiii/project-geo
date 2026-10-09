/**
 * 3Dビューワー(処理「高」): 山の影と、谷・くぼ地の暗がり(遮蔽)の地図。
 *
 * 地形の高さ(地形メッシュと同じ高さ)を、原点を中心にした正方形の格子(size×size)で一度だけ調べ(`buildShadeBase`)、
 *   ・谷・くぼ地の暗がり(ao。0.5〜1): まわりの平均の高さより低いほど暗い(150m・700mの2つの広がりで見る)。昼の空の明かり(環境光)に掛ける
 *   ・太陽の影(`computeSunShadow`): 太陽の向きに沿って、風上の山の稜線が地面を隠すかを、斜めの「影の面」を掃くように一度に求める
 * を作る。太陽が動いたとき(時刻の変更)は、影だけを作り直す(約0.1〜0.3秒)。
 *
 * 影の値 g は、影の面から地面までの高さの差 d(m。正=面の下=影、負=日向)を、太陽の円盤の大きさで決まる半影の幅
 * w = 3m + 太陽の見かけの直径(約0.0094rad)× 隠す山までの距離 で割ったもの。シェーダーは smoothstep(-0.5, 0.5, g) で影の濃さにする
 * (山から遠い影ほど縁がぼける)。
 */

/** 格子の大きさ(一辺)。メモリの少ない端末は小さく */
export const SHADE_SIZE = 2048;
export const SHADE_SIZE_LOWMEM = 1024;
/** 太陽の見かけの直径(rad)。影の縁のぼけに使う */
const SUN_DIAMETER_RAD = 0.0094;
/** 影の縁の最小のぼけ(m) */
const PENUMBRA_MIN_M = 3;
/** この太陽の高さ(rad相当のsin)より低いときは、全面を影(日没後)にする */
const SUN_MIN_SIN = 0.003;
/** g の範囲(これ以上は意味が無いので切る) */
const G_LIMIT = 2;

export interface ShadeBase {
  size: number;
  /** 格子が覆う範囲: 原点から±half(m) */
  half: number;
  /** 画素の大きさ(m) */
  cell: number;
  /** 各画素(中心)の地面の高さ(m。地形メッシュと同じ、地球の丸みで下がる分を含む) */
  h: Float32Array;
  /** 谷・くぼ地の暗がり(0〜255。255=開けた所=暗がりなし) */
  ao: Uint8Array;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function boxBlurRow(src: Float32Array, dst: Float32Array, n: number, r: number): void {
  // 行方向(横)。端は端の値を延ばす
  const w = 2 * r + 1;
  for (let y = 0; y < n; y++) {
    const o = y * n;
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += src[o + (x < 0 ? 0 : x >= n ? n - 1 : x)];
    for (let x = 0; x < n; x++) {
      dst[o + x] = sum / w;
      const add = x + r + 1;
      const sub = x - r;
      sum += src[o + (add >= n ? n - 1 : add)] - src[o + (sub < 0 ? 0 : sub)];
    }
  }
}

function boxBlurCol(src: Float32Array, dst: Float32Array, n: number, r: number): void {
  // 列方向(縦)
  const w = 2 * r + 1;
  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += src[(y < 0 ? 0 : y >= n ? n - 1 : y) * n + x];
    for (let y = 0; y < n; y++) {
      dst[y * n + x] = sum / w;
      const add = y + r + 1;
      const sub = y - r;
      sum += src[(add >= n ? n - 1 : add) * n + x] - src[(sub < 0 ? 0 : sub) * n + x];
    }
  }
}

/** 高さの格子を、半径 r 画素の箱でぼかす(2回かけて、なめらかな山型に近づける) */
function blurHeights(h: Float32Array, n: number, r: number): Float32Array {
  if (r < 1) return h;
  const a = new Float32Array(h.length);
  const b = new Float32Array(h.length);
  boxBlurRow(h, a, n, r);
  boxBlurCol(a, b, n, r);
  boxBlurRow(b, a, n, r);
  boxBlurCol(a, b, n, r);
  return b;
}

/** 谷・くぼ地の暗がり(0〜255)を、高さの格子から求める */
export function computeOpenness(h: Float32Array, n: number, cell: number): Uint8Array {
  const b1 = blurHeights(h, n, Math.max(1, Math.round(150 / cell)));
  const b2 = blurHeights(h, n, Math.max(2, Math.round(700 / cell)));
  const ao = new Uint8Array(n * n);
  for (let k = 0; k < ao.length; k++) {
    const c1 = Math.min(1, Math.max(0, (b1[k] - h[k]) / 35));
    const c2 = Math.min(1, Math.max(0, (b2[k] - h[k]) / 180));
    ao[k] = Math.round(255 * (1 - 0.2 * c1 - 0.26 * c2));
  }
  return ao;
}

/**
 * 高さの格子を作る。途中で画面が固まらないよう、少しずつ作る。groundAt は地形メッシュと同じ高さ(m)。
 * 途中で cancelled() が true になったら null を返す
 */
export async function buildShadeBase(
  groundAt: (X: number, Z: number) => number,
  half: number,
  size: number,
  cancelled: () => boolean,
): Promise<ShadeBase | null> {
  const n = size;
  const cell = (2 * half) / n;
  const h = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const Z = -half + (j + 0.5) * cell;
    for (let i = 0; i < n; i++) h[j * n + i] = groundAt(-half + (i + 0.5) * cell, Z);
    if (j % 64 === 63) {
      await tick();
      if (cancelled()) return null;
    }
  }
  await tick();
  if (cancelled()) return null;
  const ao = computeOpenness(h, n, cell);
  return { size: n, half, cell, h, ao };
}

/**
 * 太陽の影の g(size×size。符号付き。上の説明を参照)を求める。sunDir=太陽の向き(X東・Y上・Z南。単位ベクトル)。out を渡すと、その配列を使い回す。
 * 太陽が地平線より下のときは、全面を影(g=G_LIMIT)にする。
 */
export function computeSunShadow(base: ShadeBase, sunDir: readonly [number, number, number], out?: Float32Array): Float32Array {
  const n = base.size;
  // 時刻を動かすたびに16MBの配列を作ると、片づけが追いつかず使用メモリが膨らむので、渡された配列(全部を上書きする)を使い回せる
  const g = out && out.length === n * n ? out : new Float32Array(n * n);
  const horiz = Math.hypot(sunDir[0], sunDir[2]);
  if (sunDir[1] < SUN_MIN_SIN || horiz < 1e-6) {
    g.fill(G_LIMIT);
    return g;
  }
  const tanT = sunDir[1] / horiz;
  const ux = sunDir[0] / horiz; // 太陽の向き(水平)。Xが東、Zが南(画素の列i・行jの増える向きと同じ)
  const uz = sunDir[2] / horiz;
  const xMajor = Math.abs(ux) >= Math.abs(uz);
  const uMajor = xMajor ? ux : uz;
  const uMinor = xMajor ? uz : ux;
  const sgn = uMajor >= 0 ? 1 : -1;
  // 太陽側へ1層進むときの、層の中の位置のずれ(画素)と、進む長さ(m)
  const shift = uMinor / Math.abs(uMajor);
  const stepM = base.cell / Math.abs(uMajor);
  const drop = stepM * tanT;
  const strideMajor = xMajor ? 1 : n;
  const strideMinor = xMajor ? n : 1;
  const h = base.h;

  // 層ごと(太陽に近い側から順に)に、「その層までの影の面の高さ M = max(その場所の高さ, 影の面)」と、隠している山までの距離 D を持つ
  let mPrev = new Float32Array(n);
  let dPrev = new Float32Array(n);
  let mCur = new Float32Array(n);
  let dCur = new Float32Array(n);
  const first = sgn > 0 ? n - 1 : 0;
  for (let k = 0; k < n; k++) {
    mPrev[k] = -1e9;
    dPrev[k] = 0;
  }
  for (let step = 0; step < n; step++) {
    const layer = first - sgn * step;
    for (let k = 0; k < n; k++) {
      let a: number;
      let dist: number;
      if (step === 0) {
        a = -1e9;
        dist = 0;
      } else {
        // 1つ太陽側の層の、位置 k+shift の M・D を、直線補間で読む
        let f = k + shift;
        if (f < 0) f = 0;
        else if (f > n - 1) f = n - 1;
        const k0 = Math.floor(f);
        const k1 = k0 + 1 < n ? k0 + 1 : k0;
        const t = f - k0;
        const mv = mPrev[k0] * (1 - t) + mPrev[k1] * t;
        const dv = dPrev[k0] * (1 - t) + dPrev[k1] * t;
        a = mv - drop; // 影の面の高さ(この画素の上空)
        dist = dv + stepM;
      }
      const idx = layer * strideMajor + k * strideMinor;
      const hh = h[idx];
      const d = a - hh; // 正=影の面の下(影)、負=日向
      const w = PENUMBRA_MIN_M + SUN_DIAMETER_RAD * dist;
      let v = d / w;
      if (v > G_LIMIT) v = G_LIMIT;
      else if (v < -G_LIMIT) v = -G_LIMIT;
      g[idx] = v;
      // 次の層へ渡す M・D: この画素自身の高さが影の面より高ければ、この画素が隠す山(距離0)
      if (hh >= a) {
        mCur[k] = hh;
        dCur[k] = 0;
      } else {
        mCur[k] = a;
        dCur[k] = dist;
      }
    }
    const tm = mPrev;
    mPrev = mCur;
    mCur = tm;
    const td = dPrev;
    dPrev = dCur;
    dCur = td;
  }
  return g;
}
