import {
  CLIMATE_STATIONS,
  createStationWeights,
  interpolate,
  stationAnnualSeaLevelC,
  stationWeightsAt,
} from "./koyoClimate";
import { DEM_INVALID, DEM_TILE_SIZE, demToMeters } from "./koyoDem";
import { minTempAt } from "./koyoModel";
import {
  LEAF_MATURE_MEAN_C,
  LEAF_PEAK_MEAN_C,
  LEAF_START_MEAN_C,
  MELT_FADE_DAYS,
  PERENNIAL_SNOW_MEAN_C,
  SEASON_OFFSETS_DAYS,
  SNOW_EVERGREEN_MIN_C,
  SUN_MELT_DAYS,
  sunScore,
  type KoyoSeasonContext,
} from "./koyoSeason";
import { meltLeadDaysAt } from "./koyoSnowZones";
import {
  BARE_COLOR,
  EARLY_SPECIES_ID,
  EVERGREEN_COLOR,
  FALLEN_COLOR,
  SHINRYOKU_COLOR,
  KOYO_SPECIES,
  KOYO_SPECIES_BY_ID,
  UNRIPE_COLOR,
  VEG_CLASS,
  earlyLeadWeight,
  earlyMixApplies,
  effectiveClassForNonForest,
  fallbackClassByAnnualTemp,
  speciesByClassCode,
  stageForMinTemp,
  type KoyoSpecies,
} from "./koyoSpecies";
import { VEG_UNKNOWN, type KoyoVegetationGrid } from "./koyoVegetation";

/**
 * 紅葉マップ: 1枚のタイル(256×256)を、標高・植生・気温から塗り分ける。
 *
 * 画素ごとに ①標高 ②樹種グループ(植生グリッド。無ければ標高帯モデル) ③その場所の日最低気温の推定値
 * を求め、樹種のしきい値と比べて「まだ緑 → 色づき始め → 見頃 → 落葉」の色を決める。
 * 気温の補間(周辺観測所のIDW)は画素ごとでは重いので、4×4画素のブロックごとに1回だけ求める。
 *
 * 「紅葉メッシュを 全体的に もう少し 彩度を強く メッシュをグラデーションにしてください」への対応:
 *   ・色は気温に対して連続に変える(段階ごとの色の切り替えをやめ、緑→黄→葉の色→茶色を色相で補間)。
 *   ・植生は約500mメッシュの1セル1樹種だが、画素ごとに周囲4セルの色を距離で混ぜる(双線形補間)。
 *     セルの境目で色が急に変わらず、なめらかなグラデーションになる。
 *   ・彩度と不透明度を上げ、常緑樹林は濃い緑にした。
 */

const BLOCK = 4;
const BLOCKS = DEM_TILE_SIZE / BLOCK;

/** 植生図が無い所(標高帯モデルで代用する所)で、描画対象にする最低の標高(m)。平野・市街地を塗らないため */
export const FALLBACK_MIN_ELEV_M = 200;

export interface KoyoTileContext {
  /** 観測所ごとの海面換算の日平均気温(`buildStationT0`) */
  stationT0: Float32Array;
  /** 同・`LOWLAND_ADVANCE_DAYS`日先の値(`buildStationT0Ahead`)。低標高の前倒し補正に使う */
  stationT0Ahead: Float32Array;
  /**
   * 同・`WHITE_AFTER_FALL_DAYS`日前の値(`buildStationT0Past`)。落葉して2週間たった所を白にするのに使う。
   * 省略すると白にしない。
   */
  stationT0Past?: Float32Array;
  /**
   * 通年モデル(新緑・雪・雪解け。`koyoSeason.ts`)。春(1〜8月)は葉のない冬の木→新緑→夏の緑と、雪の残りと雪解け
   * (豪雪地帯・日当たり)を、秋(9〜12月)は紅葉に加えて常緑樹林の雪・万年雪を描く。省略すると従来どおり(紅葉と落葉樹の白だけ)。
   */
  season?: KoyoSeasonContext;
  lapseCPerM: number;
  veg: KoyoVegetationGrid | null;
  /**
   * 表示しない植生クラス(`VEG_CLASS`のコード。常緑樹林も含む)。チェックリスト(左上)で
   * 外された樹種で、該当する画素は塗らない。標高帯モデルで代用した画素にも同じく効く。
   */
  hiddenClasses: ReadonlySet<number>;
}

type RGB = readonly [number, number, number];
type HSL = readonly [number, number, number];
export type RGBA = [number, number, number, number];

// ---------------------------------------------------------------------------
// 色の計算(HSL)
// ---------------------------------------------------------------------------

function hexToRgb(hex: string): RGB {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl([r8, g8, b8]: RGB): HSL {
  const r = r8 / 255;
  const g = g8 / 255;
  const b = b8 / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let h: number;
  if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb([h, s, l]: HSL): RGB {
  const hh = (((h % 360) + 360) % 360) / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t0: number): number => {
    const t = (t0 + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [Math.round(f(hh + 1 / 3) * 255), Math.round(f(hh) * 255), Math.round(f(hh - 1 / 3) * 255)];
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function smoothstep(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x * x * (3 - 2 * x);
}

/** HSLでの補間(色相は近い側を回る。緑→赤なら黄・橙を通る) */
function hslLerp(a: HSL, b: HSL, t: number): RGB {
  const dh = ((b[0] - a[0] + 540) % 360) - 180;
  return hslToRgb([a[0] + dh * t, lerp(a[1], b[1], t), lerp(a[2], b[2], t)]);
}

// 色と不透明度(0〜255)。alphaは地図の下の地形が透けて見える程度にしてある
const UNRIPE_HSL = rgbToHsl(hexToRgb(UNRIPE_COLOR));
const FALLEN_HSL = rgbToHsl(hexToRgb(FALLEN_COLOR));
const EVERGREEN_RGB = hexToRgb(EVERGREEN_COLOR);
const UNRIPE_ALPHA = 115;
const PEAK_ALPHA = 225;
const FALLEN_ALPHA = 165;
/** 常緑樹林の不透明度。かつては70と薄く灰色がかって見えたため、「緑をつよく」で大きく上げた */
const EVERGREEN_ALPHA = 190;

/**
 * 「落葉して2週間たったところは白色にしてください」への対応。落葉・終盤の気温(`endMinC`)になって
 * から2週間以上たった所は白で塗る。「2週間前の日最低気温が`endMinC`以下だったか」で決めるので、
 * 今の日最低気温に、この2週間の冷え込み(2週間前の日平均気温−今の日平均気温)を足したものを
 * `endMinC`と比べる。境目は±`WHITE_FADE_C`℃(秋の冷え込みで約2〜3日分)でなめらかに白へ移る。
 */
const WHITE_RGB: RGB = [250, 250, 252];
const WHITE_ALPHA = 205;
const WHITE_FADE_C = 0.5;

/**
 * 見頃の幅(見頃のしきい値〜落葉のしきい値)のうち、葉の色のまま保つ最初の割合。残りで落葉の色へ
 * なめらかに移る。1に近いほど「見頃の色」が長く続く。
 */
const PEAK_PLATEAU = 0.65;

const LEAF_HSL = new Map<number, HSL>(KOYO_SPECIES.map((s) => [s.classCode, rgbToHsl(hexToRgb(s.leafColor))]));

/**
 * 森林の縁をやわらげる範囲。周囲4セルのうち「描く対象のセル」の重みの合計(0〜1)が
 * `EDGE_COVER_MIN`以下の画素は塗らず、`EDGE_COVER_FULL`以上なら全部の濃さで塗り、間はなめらかに薄くする。
 * セルの境目(重み0.5)ではおよそ4割の濃さになり、森林と森林以外の境が四角いブロックにならない。
 */
const EDGE_COVER_MIN = 0.25;
const EDGE_COVER_FULL = 0.85;

/**
 * 樹種の、日最低気温 tMinC のときの色(RGBA)。気温に対して連続に変化する:
 * しきい値の上(まだ緑)は一定 → 色づき始め〜見頃の手前は 緑→黄→葉の色 → 見頃は葉の色のまま
 * → 見頃の後半で落葉の茶色へ → 落葉のしきい値以下は一定。
 */
export function koyoColor(species: KoyoSpecies, tMinC: number): RGBA {
  const leaf = LEAF_HSL.get(species.classCode) ?? UNRIPE_HSL;
  const { startMinC: s, peakMinC: p, endMinC: e } = species;
  if (tMinC > s) {
    const c = hslToRgb(UNRIPE_HSL);
    return [c[0], c[1], c[2], UNRIPE_ALPHA];
  }
  if (tMinC > p) {
    const u = smoothstep(s > p ? (s - tMinC) / (s - p) : 1);
    const c = hslLerp(UNRIPE_HSL, leaf, u);
    return [c[0], c[1], c[2], Math.round(lerp(UNRIPE_ALPHA, PEAK_ALPHA, u))];
  }
  if (tMinC > e) {
    const v = p > e ? (p - tMinC) / (p - e) : 1;
    const f = smoothstep((v - PEAK_PLATEAU) / (1 - PEAK_PLATEAU));
    const c = hslLerp(leaf, FALLEN_HSL, f);
    return [c[0], c[1], c[2], Math.round(lerp(PEAK_ALPHA, FALLEN_ALPHA, f))];
  }
  const c = hslToRgb(FALLEN_HSL);
  return [c[0], c[1], c[2], FALLEN_ALPHA];
}

/**
 * 色を決める。落葉広葉樹林の「混生帯」(`earlyMixApplies`)では、ナナカマドなど早く紅葉する種類
 * (`EARLY_SPECIES_ID`)のほうが進んでいる間は、その種類の色を混ぜる(進み具合の差に応じて連続的に。`earlyLeadWeight`)。
 */
export function koyoColorWithEarlyMix(species: KoyoSpecies, tMinC: number, mixEarly: boolean): RGBA {
  const own = koyoColor(species, tMinC);
  if (!mixEarly || species.id === EARLY_SPECIES_ID) return own;
  const early = KOYO_SPECIES_BY_ID[EARLY_SPECIES_ID];
  const w = earlyLeadWeight(stageForMinTemp(species, tMinC), stageForMinTemp(early, tMinC));
  if (w <= 0) return own;
  const ec = koyoColor(early, tMinC);
  return [
    Math.round(lerp(own[0], ec[0], w)),
    Math.round(lerp(own[1], ec[1], w)),
    Math.round(lerp(own[2], ec[2], w)),
    Math.round(lerp(own[3], ec[3], w)),
  ];
}

// 日最低気温 → 色 の対応表(画素ごとにHSL計算をしないよう、樹種ごとに起動時に1回だけ作る)
const LUT_MIN_C = -12;
const LUT_MAX_C = 14;
const LUT_STEP_C = 0.04;
const LUT_LEN = Math.round((LUT_MAX_C - LUT_MIN_C) / LUT_STEP_C) + 1;

function buildLut(f: (tMinC: number) => RGBA): Uint8ClampedArray {
  const lut = new Uint8ClampedArray(LUT_LEN * 4);
  for (let i = 0; i < LUT_LEN; i++) {
    const c = f(LUT_MIN_C + i * LUT_STEP_C);
    lut[i * 4] = c[0];
    lut[i * 4 + 1] = c[1];
    lut[i * 4 + 2] = c[2];
    lut[i * 4 + 3] = c[3];
  }
  return lut;
}

function lutIndex(tMinC: number): number {
  const i = Math.round((tMinC - LUT_MIN_C) / LUT_STEP_C);
  return i < 0 ? 0 : i >= LUT_LEN ? LUT_LEN - 1 : i;
}

const PLAIN_LUT = new Map<number, Uint8ClampedArray>(
  KOYO_SPECIES.map((sp) => [sp.classCode, buildLut((t) => koyoColor(sp, t))]),
);
const MIXED_LUT = new Map<number, Uint8ClampedArray>(
  KOYO_SPECIES.map((sp) => [sp.classCode, buildLut((t) => koyoColorWithEarlyMix(sp, t, true))]),
);
const EVERGREEN_LUT = buildLut(() => [EVERGREEN_RGB[0], EVERGREEN_RGB[1], EVERGREEN_RGB[2], EVERGREEN_ALPHA]);

// ---------------------------------------------------------------------------
// 春(新緑): 日平均気温 → 色 の対応表
// ---------------------------------------------------------------------------

/** 葉のない冬の木(うすい茶色)・新緑の最盛(明るい黄緑)の色と不透明度 */
const BARE_HSL = rgbToHsl(hexToRgb(BARE_COLOR));
const SHINRYOKU_HSL = rgbToHsl(hexToRgb(SHINRYOKU_COLOR));
const BARE_ALPHA = 105;
const SHINRYOKU_ALPHA = 215;

/**
 * 落葉広葉樹の、日平均気温 tMeanC のときの春の色。芽吹きの気温(`LEAF_START_MEAN_C`)までは葉のない冬の木、
 * そこから新緑の最盛(`LEAF_PEAK_MEAN_C`)まで 茶色→黄緑 になり、夏の緑(`LEAF_MATURE_MEAN_C`)までに 黄緑→緑 へ落ち着く。
 */
export function springColor(tMeanC: number): RGBA {
  if (tMeanC <= LEAF_START_MEAN_C) {
    const c = hslToRgb(BARE_HSL);
    return [c[0], c[1], c[2], BARE_ALPHA];
  }
  if (tMeanC < LEAF_PEAK_MEAN_C) {
    const u = smoothstep((tMeanC - LEAF_START_MEAN_C) / (LEAF_PEAK_MEAN_C - LEAF_START_MEAN_C));
    const c = hslLerp(BARE_HSL, SHINRYOKU_HSL, u);
    return [c[0], c[1], c[2], Math.round(lerp(BARE_ALPHA, SHINRYOKU_ALPHA, u))];
  }
  if (tMeanC < LEAF_MATURE_MEAN_C) {
    const u = smoothstep((tMeanC - LEAF_PEAK_MEAN_C) / (LEAF_MATURE_MEAN_C - LEAF_PEAK_MEAN_C));
    const c = hslLerp(SHINRYOKU_HSL, UNRIPE_HSL, u);
    return [c[0], c[1], c[2], Math.round(lerp(SHINRYOKU_ALPHA, UNRIPE_ALPHA, u))];
  }
  const c = hslToRgb(UNRIPE_HSL);
  return [c[0], c[1], c[2], UNRIPE_ALPHA];
}

const SPRING_LUT_MIN_C = -10;
const SPRING_LUT_MAX_C = 26;
const SPRING_LUT_STEP_C = 0.05;
const SPRING_LUT_LEN = Math.round((SPRING_LUT_MAX_C - SPRING_LUT_MIN_C) / SPRING_LUT_STEP_C) + 1;
const SPRING_LUT = (() => {
  const lut = new Uint8ClampedArray(SPRING_LUT_LEN * 4);
  for (let i = 0; i < SPRING_LUT_LEN; i++) {
    const c = springColor(SPRING_LUT_MIN_C + i * SPRING_LUT_STEP_C);
    lut[i * 4] = c[0];
    lut[i * 4 + 1] = c[1];
    lut[i * 4 + 2] = c[2];
    lut[i * 4 + 3] = c[3];
  }
  return lut;
})();

function springLutIndex(tMeanC: number): number {
  const i = Math.round((tMeanC - SPRING_LUT_MIN_C) / SPRING_LUT_STEP_C);
  return i < 0 ? 0 : i >= SPRING_LUT_LEN ? SPRING_LUT_LEN - 1 : i;
}

/** ウェブメルカトルの256pxタイルで、ズームzの赤道での1画素の長さ(m) */
const EQUATOR_M_PER_PX_Z0 = 156543.03392;

/**
 * 「あと何日で日平均気温が芽吹きの気温になるか」。`fut[k*stride+b]`は、`SEASON_OFFSETS_DAYS[k]`日先の、ブロックbの
 * 海面換算の日平均気温T0。`target`は、その場所で芽吹きになる海面換算のT0(= 芽吹きの気温 + 逓減率×標高)。
 * もう芽吹いていれば0、先の日の範囲内で届かなければ Infinity。範囲内は10日刻みの値を直線で結んで求める。
 */
function daysToLeaf(fut: Float32Array, stride: number, b: number, target: number): number {
  if (fut[b] >= target) return 0;
  for (let k = 1; k < SEASON_OFFSETS_DAYS.length; k++) {
    const hi = fut[k * stride + b];
    if (hi >= target) {
      const lo = fut[(k - 1) * stride + b];
      const o0 = SEASON_OFFSETS_DAYS[k - 1];
      const o1 = SEASON_OFFSETS_DAYS[k];
      return hi > lo ? o0 + ((target - lo) / (hi - lo)) * (o1 - o0) : o1;
    }
  }
  return Infinity;
}

export interface KoyoTileResult {
  /** 色を付けた画素数(0なら透明なタイル) */
  painted: number;
}

/**
 * タイル(ズームz、タイル座標tx,ty)を描く。
 * @param dem 標高タイル(`loadDemTile`の結果)
 * @param out RGBA(256×256×4)の出力先。呼び出し側で0クリア済みのものを渡す
 */
export function renderKoyoTile(
  dem: Uint16Array,
  z: number,
  tx: number,
  ty: number,
  ctx: KoyoTileContext,
  out: Uint8ClampedArray,
): KoyoTileResult {
  const n = 2 ** z;
  const N = DEM_TILE_SIZE;
  const gamma = ctx.lapseCPerM;

  // 画素の中心の経度(列)・緯度(行)
  const lonOfCol = new Float64Array(N);
  const latOfRow = new Float64Array(N);
  for (let c = 0; c < N; c++) lonOfCol[c] = ((tx + (c + 0.5) / N) / n) * 360 - 180;
  for (let r = 0; r < N; r++) {
    const merc = Math.PI * (1 - (2 * (ty + (r + 0.5) / N)) / n);
    latOfRow[r] = (Math.atan(Math.sinh(merc)) * 180) / Math.PI;
  }

  // ブロックごとの T0(海面換算の日平均気温。当日と前倒し用の先の日)と年平均(海面換算)。標高帯モデルに使う
  const stationAnnual = new Float32Array(CLIMATE_STATIONS.length);
  for (let i = 0; i < stationAnnual.length; i++) stationAnnual[i] = stationAnnualSeaLevelC(i, gamma);
  const blockT0 = new Float32Array(BLOCKS * BLOCKS);
  const blockT0Ahead = new Float32Array(BLOCKS * BLOCKS);
  const blockAnnual = new Float32Array(BLOCKS * BLOCKS);
  // 2週間前のT0との差(=この2週間の冷え込み、℃)。stationT0Pastが無ければ白を使わない
  const past = ctx.stationT0Past;
  const blockDrop = new Float32Array(BLOCKS * BLOCKS);
  // 通年モデル(新緑・雪・雪解け)。春(1〜8月)は先の日の気温・冬の最低気温・雪解けの前倒し日数、秋は万年雪の判定に使う
  const season = ctx.season;
  const spring = season !== undefined && season.spring;
  const NB = BLOCKS * BLOCKS;
  const blockFut = new Float32Array(spring ? SEASON_OFFSETS_DAYS.length * NB : 0);
  const blockCold = new Float32Array(spring ? NB : 0);
  const blockColdEv = new Float32Array(spring ? NB : 0);
  const blockDropEv = new Float32Array(season && !spring ? NB : 0);
  const blockLead = new Float32Array(spring ? NB : 0);
  const blockT0Max = new Float32Array(season ? NB : 0);
  const wts = createStationWeights();
  for (let by = 0; by < BLOCKS; by++) {
    const lat = latOfRow[by * BLOCK + BLOCK / 2];
    for (let bx = 0; bx < BLOCKS; bx++) {
      const lon = lonOfCol[bx * BLOCK + BLOCK / 2];
      stationWeightsAt(lat, lon, wts);
      const b = by * BLOCKS + bx;
      blockT0[b] = interpolate(ctx.stationT0, wts);
      blockT0Ahead[b] = interpolate(ctx.stationT0Ahead, wts);
      blockAnnual[b] = interpolate(stationAnnual, wts);
      if (past) blockDrop[b] = interpolate(past, wts) - blockT0[b];
      if (season) {
        blockT0Max[b] = interpolate(season.t0Max, wts);
        if (!spring) blockDropEv[b] = interpolate(season.pastEv, wts) - blockT0[b];
        if (spring) {
          blockCold[b] = interpolate(season.cold, wts);
          blockColdEv[b] = interpolate(season.coldEv, wts);
          blockLead[b] = meltLeadDaysAt(season.zones, lat, lon);
          for (let k = 0; k < SEASON_OFFSETS_DAYS.length; k++) blockFut[k * NB + b] = interpolate(season.fut[k], wts);
        }
      }
    }
  }

  // 日当たりの計算(春だけ)。画素の1辺の長さ(m)と、南中高度の余接(cotα = |tan(緯度 − 太陽の赤緯)|)は行ごとに決まる
  const mppRow = new Float64Array(spring ? N : 0);
  const cotAltRow = new Float64Array(spring ? N : 0);
  if (spring && season) {
    for (let r = 0; r < N; r++) {
      const latRad = (latOfRow[r] * Math.PI) / 180;
      mppRow[r] = (EQUATOR_M_PER_PX_Z0 / n) * Math.cos(latRad);
      cotAltRow[r] = Math.min(20, Math.abs(Math.tan(latRad - (season.declDeg * Math.PI) / 180)));
    }
  }
  const SUN_STEP_PX = 2;
  /** 画素(r,c)の日当たり(0=日陰〜1=南向きの日なた)。標高の差分は±`SUN_STEP_PX`画素で見る */
  const sunAt = (r: number, c: number, elev: number): number => {
    const rN = Math.max(0, r - SUN_STEP_PX);
    const rS = Math.min(N - 1, r + SUN_STEP_PX);
    const cW = Math.max(0, c - SUN_STEP_PX);
    const cE = Math.min(N - 1, c + SUN_STEP_PX);
    const vN = dem[rN * N + c];
    const vS = dem[rS * N + c];
    const vW = dem[r * N + cW];
    const vE = dem[r * N + cE];
    const zN = vN === DEM_INVALID ? elev : demToMeters(vN);
    const zS = vS === DEM_INVALID ? elev : demToMeters(vS);
    const zW = vW === DEM_INVALID ? elev : demToMeters(vW);
    const zE = vE === DEM_INVALID ? elev : demToMeters(vE);
    const mpp = mppRow[r];
    const dzNorth = rS > rN ? (zN - zS) / ((rS - rN) * mpp) : 0;
    const dzEast = cE > cW ? (zE - zW) / ((cE - cW) * mpp) : 0;
    return sunScore(dzNorth, dzEast, cotAltRow[r]);
  };

  // 植生グリッド上の位置(セルの中心を基準にした双線形補間用)。列は経度だけ、行は緯度だけで決まる
  const veg = ctx.veg;
  const colX0 = new Int32Array(N);
  const colT = new Float32Array(N);
  const rowY0 = new Int32Array(N);
  const rowT = new Float32Array(N);
  if (veg) {
    for (let c = 0; c < N; c++) {
      const fx = (lonOfCol[c] - veg.west) / veg.lonStep - 0.5;
      const x0 = Math.floor(fx);
      colX0[c] = x0;
      colT[c] = fx - x0;
    }
    for (let r = 0; r < N; r++) {
      const fy = (veg.north - latOfRow[r]) / veg.latStep - 0.5;
      const y0 = Math.floor(fy);
      rowY0[r] = y0;
      rowT[r] = fy - y0;
    }
  }
  const cellRaw = (x: number, y: number): number =>
    veg && x >= 0 && y >= 0 && x < veg.cols && y < veg.rows ? veg.data[y * veg.cols + x] : VEG_UNKNOWN;

  const hiddenMask = new Uint8Array(256);
  ctx.hiddenClasses.forEach((c) => {
    if (c >= 0 && c < 256) hiddenMask[c] = 1;
  });
  const earlyOn = hiddenMask[KOYO_SPECIES_BY_ID[EARLY_SPECIES_ID].classCode] === 0;

  // 4つのセルの、画素ごとの扱い(色の元になる対応表・推定かどうか)。配列を使い回して割り当てを避ける
  const luts: (Uint8ClampedArray | null)[] = [null, null, null, null];
  // 各セルの樹種が落葉・終盤になる日最低気温(落葉しない常緑樹林はNaN)
  const ends = [NaN, NaN, NaN, NaN];
  /** 常緑樹林のセルか(雪になるまでの日数が落葉樹より短い) */
  const evergreen = [false, false, false, false];
  const raws = [0, 0, 0, 0];
  const weights = [0, 0, 0, 0];

  let painted = 0;
  for (let r = 0; r < N; r++) {
    const by = Math.floor(r / BLOCK);
    const y0 = rowY0[r];
    const ty1 = rowT[r];
    for (let c = 0; c < N; c++) {
      const v = dem[r * N + c];
      if (v === DEM_INVALID) continue;
      const elev = demToMeters(v);
      if (elev <= 1) continue; // 海・湖面

      const b = by * BLOCKS + Math.floor(c / BLOCK);
      const tMin = minTempAt(blockT0[b], elev, gamma, blockT0Ahead[b]);
      const annualHere = blockAnnual[b] - gamma * elev;
      const li = lutIndex(tMin) * 4;

      // 通年モデル: 春は日平均気温(新緑の色)・冬の最低気温(雪が積もったか)、秋は万年雪
      let tMean = 0;
      let springLi = 0;
      let coldMin = 0;
      let coldMinEv = 0;
      let perennial = 0;
      let snowLeft = -1; // 春: 雪が残っている割合(0〜1)。必要になったときに1画素1回だけ求める
      if (spring) {
        tMean = blockT0[b] - gamma * elev;
        springLi = springLutIndex(tMean) * 4;
        coldMin = minTempAt(blockCold[b], elev, gamma);
        coldMinEv = minTempAt(blockColdEv[b], elev, gamma);
      } else if (season) {
        perennial = smoothstep(PERENNIAL_SNOW_MEAN_C + 1 - (blockT0Max[b] - gamma * elev));
      }

      // 周囲4セルの植生クラス
      if (veg) {
        const x0 = colX0[c];
        const tx1 = colT[c];
        raws[0] = cellRaw(x0, y0);
        raws[1] = cellRaw(x0 + 1, y0);
        raws[2] = cellRaw(x0, y0 + 1);
        raws[3] = cellRaw(x0 + 1, y0 + 1);
        weights[0] = (1 - tx1) * (1 - ty1);
        weights[1] = tx1 * (1 - ty1);
        weights[2] = (1 - tx1) * ty1;
        weights[3] = tx1 * ty1;
      } else {
        raws[0] = raws[1] = raws[2] = raws[3] = VEG_UNKNOWN;
        weights[0] = 1;
        weights[1] = weights[2] = weights[3] = 0;
      }

      for (let k = 0; k < 4; k++) {
        luts[k] = null;
        ends[k] = NaN;
        evergreen[k] = false;
        if (weights[k] <= 0) continue;
        let cls = raws[k];
        if (cls === VEG_UNKNOWN) {
          // 植生図が無い・範囲外: 標高帯モデルで代用(平野・市街地を塗らないよう低標高は除く)
          if (elev < FALLBACK_MIN_ELEV_M) continue;
          cls = fallbackClassByAnnualTemp(annualHere);
        } else if (cls === VEG_CLASS.none) {
          // 標高2,000m以上に「森林以外」は無いものとし、高山帯の植生(草紅葉・低木)として、ほかの植生と同じ濃さで描く
          // (「2000m以上の場所に森林ではないとこはないはずです」への対応。以前は推定として2割薄くしていた)
          cls = effectiveClassForNonForest(elev);
          if (cls === VEG_CLASS.none) continue;
        }
        if (hiddenMask[cls]) continue; // チェックリストで外された樹種
        if (cls === VEG_CLASS.evergreen) {
          luts[k] = EVERGREEN_LUT;
          // 常緑樹林も、冷え込めば雪が積もる(通年モデルのとき)
          if (season) {
            ends[k] = SNOW_EVERGREEN_MIN_C;
            evergreen[k] = true;
          }
        } else {
          if (spring) {
            luts[k] = SPRING_LUT; // 春は新緑の色(気温は日平均気温)
          } else {
            // 左上のチェックリストで「ナナカマド…(早く紅葉)」を外していれば、混生も無効
            const mix = earlyOn && earlyMixApplies(cls, annualHere);
            luts[k] = (mix ? MIXED_LUT : PLAIN_LUT).get(cls) ?? null;
          }
          ends[k] = speciesByClassCode(cls)?.endMinC ?? NaN;
        }
      }
      // 描く対象のセルだけで、不透明度で重みづけして色を混ぜる
      let sumW = 0;
      let sumA = 0;
      let pr = 0;
      let pg = 0;
      let pb = 0;
      for (let k = 0; k < 4; k++) {
        const lut = luts[k];
        if (!lut) continue;
        const w = weights[k];
        const i0 = lut === SPRING_LUT ? springLi : li;
        let cr = lut[i0];
        let cg = lut[i0 + 1];
        let cb = lut[i0 + 2];
        let ca = lut[i0 + 3];
        // 雪(白)。秋: 落葉(常緑樹林は日最低気温0℃以下)して2週間以上たった所と万年雪。
        // 春: 冬に雪になる冷え込みがあった所のうち、雪解け(新緑の1か月前など。日当たりのよい所から)がまだの所
        let white = 0;
        if (spring) {
          if (ends[k] === ends[k]) {
            const onset = smoothstep((ends[k] + WHITE_FADE_C - (evergreen[k] ? coldMinEv : coldMin)) / (2 * WHITE_FADE_C));
            if (onset > 0) {
              if (snowLeft < 0) {
                if (blockT0Max[b] - gamma * elev < LEAF_START_MEAN_C) {
                  // 夏も新緑の気温にならない高所: 日平均気温が万年雪の気温を超えれば溶ける
                  snowLeft = smoothstep(PERENNIAL_SNOW_MEAN_C + 1 - tMean);
                } else {
                  const dLeaf = daysToLeaf(blockFut, NB, b, LEAF_START_MEAN_C + gamma * elev);
                  const lead = blockLead[b];
                  if (dLeaf <= lead) snowLeft = 0;
                  else if (dLeaf >= lead + SUN_MELT_DAYS + MELT_FADE_DAYS) snowLeft = 1;
                  else {
                    const meltDays = lead + SUN_MELT_DAYS * sunAt(r, c, elev);
                    snowLeft = 1 - smoothstep((meltDays + MELT_FADE_DAYS - dLeaf) / MELT_FADE_DAYS);
                  }
                }
              }
              white = onset * snowLeft;
            }
          }
        } else {
          if (past && ends[k] === ends[k]) {
            white = smoothstep((ends[k] + WHITE_FADE_C - (tMin + (evergreen[k] ? blockDropEv[b] : blockDrop[b]))) / (2 * WHITE_FADE_C));
          }
          if (perennial > white) white = perennial;
        }
        if (white > 0) {
          cr = lerp(cr, WHITE_RGB[0], white);
          cg = lerp(cg, WHITE_RGB[1], white);
          cb = lerp(cb, WHITE_RGB[2], white);
          ca = lerp(ca, WHITE_ALPHA, white);
        }
        const a = ca;
        const wa = w * a;
        sumW += w;
        sumA += wa;
        pr += cr * wa;
        pg += cg * wa;
        pb += cb * wa;
      }
      if (sumA <= 0 || sumW <= EDGE_COVER_MIN) continue;

      // 描く対象のセルが少ない(=森林の縁)ほど薄くして、森林と森林以外の境目をやわらげる
      const alpha = (sumA / sumW) * smoothstep((sumW - EDGE_COVER_MIN) / (EDGE_COVER_FULL - EDGE_COVER_MIN));
      if (alpha < 1) continue;
      const o = (r * N + c) * 4;
      out[o] = pr / sumA;
      out[o + 1] = pg / sumA;
      out[o + 2] = pb / sumA;
      out[o + 3] = alpha;
      painted++;
    }
  }
  return { painted };
}
