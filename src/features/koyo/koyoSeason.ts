import { CLIMATE_STATIONS, dayOfYear, stationDailyNormalC } from "./koyoClimate";
import { dateFromDayNumber, dayNumber } from "./koyoForecast";
import { WHITE_AFTER_FALL_DAYS, buildStationT0, type KoyoClimateInput } from "./koyoModel";
import type { KoyoSnowZoneGrid } from "./koyoSnowZones";

/**
 * 紅葉マップ: 通年化(新緑・雪・雪解け)の気温モデル。画面にも地図にも依存しない純粋な計算。
 *
 * 【新緑】落葉広葉樹は、その場所の日平均気温 Tmean = T0 − 逓減率×標高 が上がるにつれて、
 *   葉のない冬の木 → 芽吹き(`LEAF_START_MEAN_C`) → 新緑の最盛(`LEAF_PEAK_MEAN_C`) → 夏の緑(`LEAF_MATURE_MEAN_C`)
 * と進むとする。しきい値は、東京(4月上旬に芽吹き・下旬に新緑)・札幌(5月上旬)・上高地(5月下旬〜6月)の
 * 例年の時期に概算で合わせたもの(文献で確定した値ではない。要調整)。
 *
 * 【雪】落葉(`endMinC`)から`WHITE_AFTER_FALL_DAYS`(2週間)たった所が雪(白)。常緑樹林は落葉しないので、
 *   日最低気温が`SNOW_EVERGREEN_MIN_C`以下になってから2週間たった所を雪とする。冬のあいだ(1〜8月)は、
 *   前の11/1から「2週間前まで」で最も寒かった日の気温で判定する(その冬に一度でも雪になる冷え込みがあったか)。
 *
 * 【雪解け】「雪解けは新緑の一ヶ月前。特別豪雪地帯は0日、豪雪地帯は2週間前」への対応。
 *   雪解け日 = 新緑(芽吹き)の日 − 雪解けの前倒し日数(指定なし30日・豪雪地帯14日・特別豪雪地帯0日。
 *   `koyoSnowZones.ts`)。その日になると、その場所の雪はすっかり無くなる。
 *   「新緑の日」は、先の日の気温から求める(「あと何日でTmeanが芽吹きの気温になるか」=`daysToLeaf`が
 *   前倒し日数以下なら、もう溶けた)。
 *
 * 【日当たり】「雪解け一ヶ月前から日のよく当たる場所は雪が溶けていくように」への対応。雪解け日の
 *   `SUN_MELT_DAYS`(30日)前から、日当たりのよい場所(南向きの斜面)から順に溶け、雪解け日までに
 *   日陰(北向き斜面)も溶け切る。日当たりは、その日の南中高度と斜面の向き・傾きから決める(`sunScore`)。
 */

/** 芽吹き(新緑の始まり)・新緑の最盛・夏の緑になる日平均気温(℃) */
export const LEAF_START_MEAN_C = 10;
export const LEAF_PEAK_MEAN_C = 13.5;
export const LEAF_MATURE_MEAN_C = 17;

/** 常緑樹林が雪になる日最低気温(℃)。落葉樹の落葉のしきい値(0〜1℃)と同程度 */
export const SNOW_EVERGREEN_MIN_C = 0;

/**
 * 常緑樹林が、日最低気温`SNOW_EVERGREEN_MIN_C`以下になってから雪になるまでの日数。落葉樹(落葉して2週間)より短い。
 * 「常緑樹の積雪の時期が1週間から2週間ほど遅い」への対応で、2週間だったものを4日に短くした(約10日早まる)。
 */
export const SNOW_EVERGREEN_LAG_DAYS = 4;

/** 雪解けの日当たりによる前倒しの幅(日)。雪解け日の何日前から、日当たりのよい所が溶け始めるか */
export const SUN_MELT_DAYS = 30;

/** 雪解けの境目をなめらかにする幅(日)。雪解け日の`MELT_FADE_DAYS`日前から溶け始め、雪解け日にすっかり無くなる */
export const MELT_FADE_DAYS = 3;

/**
 * 「万年雪」の日平均気温(℃)。1年でいちばん暖かい頃でも日平均気温がこれに届かない高所(= 新緑の気温にも
 * ならない所)は、夏も雪が残る。逆に、新緑にならない高所でも、この気温を超えれば雪は溶ける。
 */
export const PERENNIAL_SNOW_MEAN_C = 5;

/** 日当たりの差の強さ。平地(日射の比r=1)を0.5として、rが1違うと日当たりが何ポイント変わるか */
export const SUN_GAIN = 1.5;

/** 先の日の気温を何日先まで見るか(`fut`の各配列に対応)。雪解けの前倒し最大(30日)+日当たり(30日)=60日 */
export const SEASON_OFFSETS_DAYS: readonly number[] = [0, 10, 20, 30, 40, 50, 60];

/** 冬の寒さを調べ始める日: 前年の11月1日 */
function coldStartDay(day: number): number {
  const year = dateFromDayNumber(day).getUTCFullYear();
  return dayNumber(year - 1, 11, 1);
}

/** 春(1〜8月)のモデルか、秋(9〜12月)のモデルか */
export function isSpringDay(day: number): boolean {
  return dateFromDayNumber(day).getUTCMonth() <= 7;
}

export interface KoyoSeasonContext {
  /** 1〜8月は春のモデル(雪解け・新緑)、9〜12月は秋のモデル(紅葉・雪) */
  spring: boolean;
  /** 春のモデル: 日 D+`SEASON_OFFSETS_DAYS`[k] の、観測所ごとの海面換算の日平均気温T0 */
  fut: Float32Array[];
  /** 春のモデル: 前年11/1〜(D−2週間)で最も寒かった日のT0(観測所ごと) */
  cold: Float32Array;
  /** 春のモデル: 常緑樹林用。前年11/1〜(D−`SNOW_EVERGREEN_LAG_DAYS`日)で最も寒かった日のT0(観測所ごと) */
  coldEv: Float32Array;
  /** 秋のモデル: 常緑樹林用。`SNOW_EVERGREEN_LAG_DAYS`日前のT0(観測所ごと) */
  pastEv: Float32Array;
  /** 1年で最も暖かい日の平年のT0(観測所ごと)。夏でも新緑にならない高所を「万年雪」とするのに使う */
  t0Max: Float32Array;
  /** 豪雪地帯のグリッド。無ければ雪解けの前倒しは全域「指定なし」(30日) */
  zones: KoyoSnowZoneGrid | null;
  /** その日の太陽の赤緯(度)。日当たりの計算に使う */
  declDeg: number;
}

const t0MaxCache = new Map<number, Float32Array>();

/** 観測所ごとの、1年で最も暖かい日の平年のT0(海面換算。予報の平年差は含めない) */
function stationT0Max(lapseCPerM: number): Float32Array {
  const hit = t0MaxCache.get(lapseCPerM);
  if (hit) return hit;
  const out = new Float32Array(CLIMATE_STATIONS.length);
  for (let i = 0; i < out.length; i++) {
    let mx = -Infinity;
    for (let doy = 1; doy <= 365; doy += 3) mx = Math.max(mx, stationDailyNormalC(i, doy));
    out[i] = mx + lapseCPerM * CLIMATE_STATIONS[i].elevM;
  }
  t0MaxCache.set(lapseCPerM, out);
  return out;
}

/** その日の太陽の赤緯(度)。近似式 */
export function solarDeclinationDeg(day: number): number {
  const doy = dayOfYear(dateFromDayNumber(day));
  return -23.44 * Math.cos(((2 * Math.PI) / 365) * (doy + 10));
}

/**
 * 通年モデル用の、観測所ごとの気温配列などをまとめる(日付・気温補正・予報が変わるたびに作り直す)。
 * 春のモデルでは、先の日(最大60日先)の気温を10日刻みで7本と、冬の最低気温を作る。
 */
export function makeSeasonContext(input: KoyoClimateInput, zones: KoyoSnowZoneGrid | null): KoyoSeasonContext {
  const spring = isSpringDay(input.day);
  const fut: Float32Array[] = [];
  let cold: Float32Array = new Float32Array(CLIMATE_STATIONS.length);
  let coldEv: Float32Array = new Float32Array(CLIMATE_STATIONS.length);
  if (spring) {
    for (const off of SEASON_OFFSETS_DAYS) fut.push(buildStationT0({ ...input, day: input.day + off }));
    cold = new Float32Array(CLIMATE_STATIONS.length).fill(Infinity);
    coldEv = new Float32Array(CLIMATE_STATIONS.length).fill(Infinity);
    const from = coldStartDay(input.day);
    const to = input.day - WHITE_AFTER_FALL_DAYS;
    const toEv = input.day - SNOW_EVERGREEN_LAG_DAYS;
    for (let d = from; d <= toEv; d += 3) {
      const t0 = buildStationT0({ ...input, day: d });
      for (let i = 0; i < cold.length; i++) {
        if (t0[i] < coldEv[i]) coldEv[i] = t0[i];
        if (d <= to && t0[i] < cold[i]) cold[i] = t0[i];
      }
    }
    // 念のため(範囲が空のとき)。1日目の値を使う
    if (!Number.isFinite(cold[0])) cold = buildStationT0({ ...input, day: to });
    if (!Number.isFinite(coldEv[0])) coldEv = buildStationT0({ ...input, day: toEv });
  }
  return {
    spring,
    fut,
    cold,
    coldEv,
    pastEv: spring ? new Float32Array(0) : buildStationT0({ ...input, day: input.day - SNOW_EVERGREEN_LAG_DAYS }),
    t0Max: stationT0Max(input.lapseCPerM),
    zones,
    declDeg: solarDeclinationDeg(input.day),
  };
}

/**
 * 日当たりの良さ(0=日陰〜1=南向きの日なた)。
 * 南中時の、斜面と平地の日射量の比 r = cosβ × (1 + cotα × ∂z/∂北) から、平地(r=1)を0.5として決める(0.5 + (r−1)×`SUN_GAIN`を0〜1に収める):
 *   β=傾斜、α=南中高度(= 90° − |緯度 − 太陽の赤緯|)、∂z/∂北=北向きの標高の変化率(南向き斜面で正)。
 * @param dzNorth 北へ進んだときの標高の変化率(m/m)
 * @param dzEast 東へ進んだときの標高の変化率(m/m)
 * @param tanZenith tan(緯度 − 太陽の赤緯)の絶対値 = cotα
 */
export function sunScore(dzNorth: number, dzEast: number, tanZenith: number): number {
  const cosBeta = 1 / Math.sqrt(1 + dzNorth * dzNorth + dzEast * dzEast);
  const r = cosBeta * (1 + tanZenith * dzNorth);
  const s = 0.5 + (r - 1) * SUN_GAIN;
  return s < 0 ? 0 : s > 1 ? 1 : s;
}
