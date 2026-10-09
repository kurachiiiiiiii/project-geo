import { VEG_CLASS } from "../koyo/koyoSpecies";
import { VEG_UNKNOWN, vegClassAtFine, type KoyoVegetationGrid } from "../koyo/koyoVegetation";
import { TILE_PX } from "./viewerMath";
import type { TreeKind, TreeSetData } from "./viewerObjectsGl";
import { TERRAIN_RADIUS_M, TERRAIN_RADIUS_WIDE_M, type OverlayImage, type TileSet } from "./viewerTerrain";
import { VEG_SATURATION, qualitySpec, treeScaleOfStep, type Quality, type TreeRing } from "./viewerQuality";
import { maskAt, type WaterMask } from "./viewerWater";

/**
 * 3Dビューワー: 木の配置と色。
 * 植生図(環境省。約500mのセルごとの樹種グループ)が森林の所に、ばらつかせて木を立てる。
 *   ・常緑樹林 → 針葉樹(段のある円錐)、カラマツ → 針葉樹の形で紅葉に連動、それ以外の落葉広葉樹 → こぶを寄せた樹冠
 *   ・川・池・岸・建物の足もと、急すぎる斜面、視点のまわり(約45m。そこから150mにかけて少しずつ増やす)には立てない
 *   ・木は小さめにして、本数を増やした。視点に近い所は約5m間隔の細かい形、遠くなるほど間隔を広げ(18m→28m→45m→80m)、
 *     形も簡単にする(`viewerQuality.ts` の設定表。処理の低・中・高で、どこまで遠くまで立てるかが変わる)
 *   ・細かさの基準は「いま見ている視点(カメラ)」。視点が動いたら、帯ごとに視点を中心に作り直す(近い帯ほど細かく作り直す)ので、
 *     動いた先でも、近くの木は細かく、遠くの木は粗くなる。木の位置は升目ごとの乱数で決まるので、作り直しても木は踊らない
 * 色は、その場所の紅葉メッシュ(紅葉の進み・新緑・雪)の色。紅葉マップを消しているときは夏の緑。
 */

/** 森林に立てる木の割合(残りは空き地・林道など) */
const TREE_DENSITY = 0.9;
/**
 * 視点(クリックした地点)のまわりは空けておく。木の真ん中に立つと空も山も木の枝で見えなくなるため。
 * 半径CLEAR_Rmまでは木を立てず、RAMP_Rmにかけて少しずつ増やして、そこから先は通常の密度にする。
 */
const CLEAR_R = 45;
const RAMP_R = 150;
/** これより急な斜面(標高差/距離)には立てない */
const MAX_SLOPE = 1.4;
/** 木の高さ(m)。以前(針葉樹17〜27m・広葉樹11〜20m)の約65%にした */
const CONIFER_H: [number, number] = [11, 6.5];
const BROAD_H: [number, number] = [7, 6];

/** 32ビット整数のかき混ぜ(同じ入力なら同じ値。位置から決まる擬似乱数に使う) */
function mix32(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 植生クラス → 木の種類。木を立てないクラスはnull */
export function treeKindOf(cls: number): TreeKind | null {
  if (cls === VEG_CLASS.evergreen || cls === VEG_CLASS.larch) return "conifer";
  if (
    cls === VEG_CLASS.maple ||
    cls === VEG_CLASS.beech ||
    cls === VEG_CLASS.oak ||
    cls === VEG_CLASS.birch ||
    cls === VEG_CLASS.deciduousMix
  ) {
    return "broad";
  }
  return null;
}

export interface TreeInput {
  lat0: number;
  lon0: number;
  veg: KoyoVegetationGrid | null;
  /** 位置(X東・Z南、m)の地面の高さ(m) */
  groundAt: (X: number, Z: number) => number;
  toLatLon: (X: number, Z: number) => { lat: number; lon: number };
  masks: { near: WaterMask | null; wide: WaterMask | null; far: WaterMask | null };
  /** 処理の低・中・高(どこまで遠くまで立てるか) */
  quality: Quality;
  /** 描画範囲を拡張しているか(処理「高」のとき、木を50kmまで立てる) */
  wide: boolean;
}

interface Acc {
  inst: number[];
  inst2: number[];
}

/**
 * 帯(リング)ごとに、視点が動いたらどれだけ離れたら作り直すか(m)。近い帯ほど細かく作り直す
 * (遠くの帯は範囲が広く、視点が少し動いてもほとんど変わらない)。
 */
export function treeRebuildDistance(ring: TreeRing): number {
  return Math.max(40, ring.rMin * 0.12);
}

/**
 * 帯の境目では、細かい木と粗い木を、距離に応じて混ぜて入れ替える(視点が少し動いて、隣の帯とずれても、
 * 木の空白や二重の密集ができないように)。境目から前後この距離(m)の間で、確率で切り替える。
 */
function blendHalfWidth(rings: TreeRing[], i: number): number {
  if (i <= 0 || i >= rings.length) return 0;
  return 1.5 * Math.max(treeRebuildDistance(rings[i - 1]), treeRebuildDistance(rings[i]));
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/**
 * 1つの帯(リング)の木を、視点(cx,cz。X東・Z南、m)を中心に配置する。
 * 木の位置は「原点を基準にした格子の升目ごとに決まる乱数」で決めるので、視点が動いて作り直しても、
 * 同じ升目の木は同じ場所・同じ向きになる(作り直しで木が踊らない)。形の細かさだけが、視点との距離で変わる。
 * 時間のかかる帯があるので、一定時間ごとに画面へ処理を返す。作り直しの途中で不要になったら cancelled() でやめる。
 */
export async function placeTreeRing(
  input: TreeInput,
  ringIndex: number,
  cx: number,
  cz: number,
  cancelled: () => boolean,
): Promise<TreeSetData[] | null> {
  if (!input.veg) return [];
  const rings = qualitySpec(input.quality, input.wide).treeRings;
  const ring = rings[ringIndex];
  if (!ring) return [];
  const veg = input.veg;
  const seed = Math.floor(Math.abs(input.lat0 * 1e4) * 31 + Math.abs(input.lon0 * 1e4) * 17) | 0;
  const salt = mix32(seed ^ Math.imul(ringIndex + 1, 0x27d4eb2f));
  const hIn = blendHalfWidth(rings, ringIndex);
  const hOut = blendHalfWidth(rings, ringIndex + 1);
  const rLo = Math.max(0, ring.rMin - hIn);
  const rHi = ring.rMax + hOut;
  const scale = treeScaleOfStep(ring.step);
  const rTerrain = input.wide ? TERRAIN_RADIUS_WIDE_M : TERRAIN_RADIUS_M;
  const slopeD = Math.max(6, ring.step * 0.4);
  const { near, wide, far } = input.masks;
  const blocked = (X: number, Z: number): boolean => {
    const v =
      (near ? maskAt(near, X, Z) : null) ?? (wide ? maskAt(wide, X, Z) : null) ?? (far ? maskAt(far, X, Z) : null);
    return !!v && (v.water > 0.05 || v.bank > 0.05 || v.building > 0.05);
  };
  const acc: Record<TreeKind, Acc> = { broad: { inst: [], inst2: [] }, conifer: { inst: [], inst2: [] } };
  const i0 = Math.floor((cx - rHi) / ring.step);
  const i1 = Math.ceil((cx + rHi) / ring.step);
  const j0 = Math.floor((cz - rHi) / ring.step);
  const j1 = Math.ceil((cz + rHi) / ring.step);
  let t0 = performance.now();
  for (let j = j0; j <= j1; j++) {
    if (performance.now() - t0 > 8) {
      await yieldToUi();
      if (cancelled()) return null;
      t0 = performance.now();
    }
    const hj = mix32(Math.imul(j, 0x85ebca77) ^ salt);
    for (let i = i0; i <= i1; i++) {
      const h0 = mix32(Math.imul(i, 0x9e3779b1) ^ hj);
      const h1 = mix32(h0 + 0x6d2b79f5);
      const h2 = mix32(h1 + 0x6d2b79f5);
      const X = (i + h0 / 4294967296) * ring.step;
      const Z = (j + h1 / 4294967296) * ring.step;
      const r = Math.hypot(X - cx, Z - cz);
      if (r < rLo || r >= rHi) continue;
      // 帯の境目の混ぜ合わせ(内側の境目では外へ向かって増やし、外側の境目では減らす)
      let p = 1;
      if (hIn > 0 && r < ring.rMin + hIn) p *= (r - (ring.rMin - hIn)) / (2 * hIn);
      if (hOut > 0 && r >= ring.rMax - hOut) p *= 1 - (r - (ring.rMax - hOut)) / (2 * hOut);
      // 地形の外(原点から地形の半径より遠く)には立てない。原点から遠くへ移動すると、視点を中心にした遠くの帯が地形の外へはみ出し、
      // 見えない木を何十万本も作ってメモリを使っていた
      const ro = Math.hypot(X, Z);
      if (ro > rTerrain) continue;
      // 視点(クリックした地点=原点)のまわりは空けておく
      const open = ro < CLEAR_R ? 0 : ro < RAMP_R ? (ro - CLEAR_R) / (RAMP_R - CLEAR_R) : 1;
      if (h2 / 4294967296 > TREE_DENSITY * open * p) continue;
      const ll = input.toLatLon(X, Z);
      const cls = vegClassAtFine(veg, ll.lat, ll.lon);
      if (cls === VEG_UNKNOWN) continue;
      const kind = treeKindOf(cls);
      if (!kind) continue;
      if (blocked(X, Z)) continue;
      const y = input.groundAt(X, Z);
      const sx = (input.groundAt(X + slopeD, Z) - input.groundAt(X - slopeD, Z)) / (2 * slopeD);
      const sz = (input.groundAt(X, Z + slopeD) - input.groundAt(X, Z - slopeD)) / (2 * slopeD);
      if (Math.hypot(sx, sz) > MAX_SLOPE) continue;
      const h3 = mix32(h2 + 0x6d2b79f5);
      const h4 = mix32(h3 + 0x6d2b79f5);
      const h5 = mix32(h4 + 0x6d2b79f5);
      const [hh0, hw] = kind === "conifer" ? CONIFER_H : BROAD_H;
      const h = (hh0 + (h3 / 4294967296) * hw) * scale;
      const w = (kind === "conifer" ? 0.5 : 0.78) * (0.82 + 0.36 * (h4 / 4294967296));
      const a = acc[kind];
      // 遠くは奥行きの精度が粗いので、少し地面に沈めて、根もとが地面から浮いたりちらついたりしないようにする
      a.inst.push(X, y - 0.2 - r * 0.0002, Z, h);
      a.inst2.push(w, (h5 / 4294967296) * Math.PI * 2);
    }
  }
  const sets: TreeSetData[] = [];
  for (const kind of ["broad", "conifer"] as const) {
    const a = acc[kind];
    const count = a.inst.length / 4;
    if (count === 0) continue;
    sets.push({
      kind,
      lod: ring.lod,
      count,
      inst: new Float32Array(a.inst),
      inst2: new Float32Array(a.inst2),
      colors: new Float32Array(count * 3),
    });
  }
  return sets;
}

// ---------------------------------------------------------------------------
// 色
// ---------------------------------------------------------------------------

/** 夏の緑(紅葉マップを消しているときの色) */
const SUMMER: Record<TreeKind, [number, number, number]> = {
  broad: [0.3, 0.5, 0.2],
  conifer: [0.12, 0.3, 0.17],
};

function hash01(a: number, b: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

export interface OverlaySampler {
  (X: number, Z: number): [number, number, number, number] | null;
}

/** 紅葉メッシュ(近景。乗算済みアルファ)を、位置(X東・Z南、m)で引く */
export function makeOverlaySampler(set: TileSet, img: OverlayImage): OverlaySampler {
  return (X, Z) => {
    const px = Math.floor(set.wx0 + X / set.mpp - set.tx0 * TILE_PX);
    const py = Math.floor(set.wy0 + Z / set.mpp - set.ty0 * TILE_PX);
    if (px < 0 || py < 0 || px >= img.width || py >= img.height) return null;
    const o = (py * img.width + px) * 4;
    const a = img.data[o + 3];
    if (a === 0) return [0, 0, 0, 0];
    // 乗算済み → 元の色
    return [
      Math.min(255, (img.data[o] * 255) / a),
      Math.min(255, (img.data[o + 1] * 255) / a),
      Math.min(255, (img.data[o + 2] * 255) / a),
      a,
    ];
  };
}

/** この不透明度(0〜255)以上で塗られている所は、紅葉メッシュの色をそのまま木の色にする */
const OVERLAY_MIN_ALPHA = 40;

/**
 * 木の樹冠の色(0〜1)。samplers は近い範囲の細かい紅葉メッシュ→遠くまでの粗い紅葉メッシュの順に試す
 * (範囲外ならnullを返すものは次へ)。1つも無ければ夏の緑。
 */
export function computeTreeColors(set: TreeSetData, samplers: OverlaySampler[]): Float32Array {
  const out = new Float32Array(set.count * 3);
  const dflt = SUMMER[set.kind];
  for (let t = 0; t < set.count; t++) {
    const X = set.inst[t * 4];
    const Z = set.inst[t * 4 + 2];
    let r = dflt[0];
    let g = dflt[1];
    let b = dflt[2];
    for (const sampler of samplers) {
      const s = sampler(X, Z);
      if (!s) continue; // 範囲外 → 次(より広い範囲のもの)へ
      if (s[3] >= OVERLAY_MIN_ALPHA) {
        r = s[0] / 255;
        g = s[1] / 255;
        b = s[2] / 255;
      }
      break;
    }
    // 彩度を下げる(地面の植生の色と同じ割合。`VEG_SATURATION`)
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    r = lum + (r - lum) * VEG_SATURATION;
    g = lum + (g - lum) * VEG_SATURATION;
    b = lum + (b - lum) * VEG_SATURATION;
    // 木ごとの濃淡のばらつき
    const v = 0.86 + 0.28 * hash01(X, Z);
    const tint = 0.04 * (hash01(Z, X) - 0.5);
    out[t * 3] = Math.min(1, Math.max(0, r * v + tint));
    out[t * 3 + 1] = Math.min(1, Math.max(0, g * v));
    out[t * 3 + 2] = Math.min(1, Math.max(0, b * v - tint));
  }
  return out;
}
