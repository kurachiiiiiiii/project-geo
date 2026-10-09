import {
  CLIMATE_STATIONS,
  DEFAULT_LAPSE_C_PER_M,
  MEAN_MINUS_MIN_C,
  REGION_INFOS_NORTH_TO_SOUTH,
  createStationWeights,
  dayOfYear,
  interpolate,
  stationAnnualSeaLevelC,
  stationDailyNormalC,
  stationWeightsAt,
  type KoyoRegionId,
  type RegionInfo,
} from "./koyoClimate";
import {
  dateFromDayNumber,
  forecastAnomalyC,
  type AnomalySource,
  type KoyoForecastBundle,
} from "./koyoForecast";
import { VEG_CLASS, effectiveClassForNonForest, fallbackClassByAnnualTemp, type KoyoSpecies } from "./koyoSpecies";
import { VEG_UNKNOWN, vegClassAtFine, type KoyoVegetationGrid } from "./koyoVegetation";

/**
 * 紅葉マップ: 気温から紅葉の標高ラインを求めるモデル本体(画面にも地図にも依存しない純粋な計算)。
 *
 * 考え方:
 *   その日・その場所の日最低気温 Tmin = T0 − γ×標高 − (日平均と日最低の差)
 *     T0 … 海面換算の日平均気温 = 平年値(海面換算) + 長期予報の平年差 + 利用者が地域ごとに入れる補正
 *     γ  … 気温逓減率(既定 0.55℃/100m)
 *   樹種ごとのしきい値(色づき始め・見頃・落葉)になる標高は、Tmin=しきい値 を標高について解けばよい:
 *     標高 = (T0 − 日平均と日最低の差 − しきい値) / γ
 *   T0 は北の地域ほど低いので、同じ日でも北ほど低い標高で紅葉が進む(北→南の標高差)。
 *   T0 は日を追って下がるので、標高ラインは日ごとに降りてくる(1日あたりの降下量)。
 *
 * 低標高の前倒し補正(「紅葉の速度が全体的に1500m以下で1週間程度 実際より遅くなる傾向があります」への対応):
 *   標高1,500m以下では、気温を`LOWLAND_ADVANCE_DAYS`(7)日先の値に置き換えて、紅葉が約1週間早く進むようにする。
 *   1,500m〜2,000mの間は補正を直線的に弱め、2,000m以上では補正しない(`advanceWeight`)。
 *   補正の入った気温:  Tmin = T0 + w(標高)×(T0(日+7) − T0(日)) − γ×標高 − (日平均と日最低の差)
 */

/** 低標高の紅葉を早める日数 */
export const LOWLAND_ADVANCE_DAYS = 7;
/** この標高(m)以下では、前倒し補正を全部かける */
export const ADVANCE_FULL_M = 1500;
/** この標高(m)以上では、前倒し補正をかけない。間は直線で弱める */
export const ADVANCE_ZERO_M = 2000;

/** 標高ごとの前倒し補正の強さ(1=全部、0=なし) */
export function advanceWeight(elevM: number): number {
  if (elevM <= ADVANCE_FULL_M) return 1;
  if (elevM >= ADVANCE_ZERO_M) return 0;
  return (ADVANCE_ZERO_M - elevM) / (ADVANCE_ZERO_M - ADVANCE_FULL_M);
}

export interface KoyoClimateInput {
  /** 対象日(1970年1月1日からの日数) */
  day: number;
  forecast: KoyoForecastBundle | null;
  /** 地域ごとの気温補正(℃)。+は暖かい側(紅葉が遅れる)、−は寒い側(紅葉が早まる) */
  adjustC: Partial<Record<KoyoRegionId, number>>;
  /** 気温逓減率(℃/m) */
  lapseCPerM: number;
}

export function defaultClimateInput(day: number): KoyoClimateInput {
  return { day, forecast: null, adjustC: {}, lapseCPerM: DEFAULT_LAPSE_C_PER_M };
}

export interface RegionAnomaly {
  forecastC: number;
  adjustC: number;
  totalC: number;
  source: AnomalySource;
}

export function regionAnomaly(regionId: KoyoRegionId, input: KoyoClimateInput): RegionAnomaly {
  const { anomalyC, source } = forecastAnomalyC(input.forecast?.regions[regionId], input.day);
  const adjustC = input.adjustC[regionId] ?? 0;
  return { forecastC: anomalyC, adjustC, totalC: anomalyC + adjustC, source };
}

/**
 * 観測所ごとの「海面換算の日平均気温(℃)」(平年値+予報の平年差+補正)。
 * 地図の各点はこの配列を周辺観測所から補間して使う。
 */
export function buildStationT0(input: KoyoClimateInput): Float32Array {
  const doy = dayOfYear(dateFromDayNumber(input.day));
  const anomalyByRegion = new Map<KoyoRegionId, number>();
  const out = new Float32Array(CLIMATE_STATIONS.length);
  for (let i = 0; i < CLIMATE_STATIONS.length; i++) {
    const st = CLIMATE_STATIONS[i];
    let a = anomalyByRegion.get(st.regionId);
    if (a === undefined) {
      a = regionAnomaly(st.regionId, input).totalC;
      anomalyByRegion.set(st.regionId, a);
    }
    out[i] = stationDailyNormalC(i, doy) + input.lapseCPerM * st.elevM + a;
  }
  return out;
}

/**
 * `buildStationT0`の、`LOWLAND_ADVANCE_DAYS`日先の日の値。低標高の前倒し補正(`minTempAt`)に使う。
 * 長期予報の平年差も、その先の日の値を使う。
 */
export function buildStationT0Ahead(input: KoyoClimateInput): Float32Array {
  return buildStationT0({ ...input, day: input.day + LOWLAND_ADVANCE_DAYS });
}

/**
 * 「落葉して2週間たったところは白色にしてください」への対応。落葉・終盤のしきい値(`endMinC`)に
 * なってから、この日数以上たった所を白で塗る(`koyoRender.ts`)。
 */
export const WHITE_AFTER_FALL_DAYS = 14;

/**
 * `buildStationT0`の、`WHITE_AFTER_FALL_DAYS`日前の日の値。「その日の2週間前にはもう落葉の気温に
 * なっていたか」(=落葉して2週間たったか)を、いまの気温との差(2週間の冷え込み)から求めるのに使う。
 */
export function buildStationT0Past(input: KoyoClimateInput): Float32Array {
  return buildStationT0({ ...input, day: input.day - WHITE_AFTER_FALL_DAYS });
}

/**
 * 海面換算の日平均気温 T0 から、標高 elevM の日最低気温(℃)を推定する。
 * @param t0AheadC `LOWLAND_ADVANCE_DAYS`日先のT0。省略すると前倒し補正なし(T0と同じ値として扱う)
 */
export function minTempAt(t0C: number, elevM: number, lapseCPerM: number, t0AheadC: number = t0C): number {
  const t0Eff = t0C + advanceWeight(elevM) * (t0AheadC - t0C);
  return t0Eff - lapseCPerM * elevM - MEAN_MINUS_MIN_C;
}

/**
 * 日最低気温がしきい値 thrMinC になる標高(m)。負なら海面でもその気温に達している(=もう終わっている)。
 * 前倒し補正で標高によって気温の式が変わるので、二分法で解く(標高が高いほど低温になる=単調なので解は1つ)。
 */
export function lineElevationM(t0C: number, thrMinC: number, lapseCPerM: number, t0AheadC: number = t0C): number {
  let lo = -3000; // Tmin(lo) > thr の側
  let hi = 8000; // Tmin(hi) < thr の側
  for (let i = 0; i < 48; i++) {
    const mid = (lo + hi) / 2;
    if (minTempAt(t0C, mid, lapseCPerM, t0AheadC) > thrMinC) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

// ---------------------------------------------------------------------------
// 地域ごとの標高ライン(北→南の比較表)
// ---------------------------------------------------------------------------

export interface RegionLineSummary {
  regionId: KoyoRegionId;
  name: string;
  meanLat: number;
  /** 地域内の観測所の平均: 海面換算の日平均気温(平年値+予報+補正) */
  t0C: number;
  /** 同・平年値だけ */
  normalT0C: number;
  anomaly: RegionAnomaly;
  /** 色づき始めになる標高(m) */
  startLineM: number;
  /** 見頃になる標高(m) */
  peakLineM: number;
  /** 落葉・終盤になる標高(m) */
  endLineM: number;
  /** 見頃ラインの1日あたりの降下量(m/日)。前日との差。負なら上昇(暖かい日が続いている) */
  peakDescentPerDayM: number;
}

function regionMeanT0(
  info: RegionInfo,
  input: KoyoClimateInput,
): { t0C: number; t0AheadC: number; normalT0C: number } {
  const t0s = buildStationT0(input);
  const t0sAhead = buildStationT0Ahead(input);
  const doy = dayOfYear(dateFromDayNumber(input.day));
  let t0 = 0;
  let t0Ahead = 0;
  let normal = 0;
  for (const i of info.stationIdx) {
    t0 += t0s[i];
    t0Ahead += t0sAhead[i];
    normal += stationDailyNormalC(i, doy) + input.lapseCPerM * CLIMATE_STATIONS[i].elevM;
  }
  const n = Math.max(1, info.stationIdx.length);
  return { t0C: t0 / n, t0AheadC: t0Ahead / n, normalT0C: normal / n };
}

export function summarizeRegion(info: RegionInfo, species: KoyoSpecies, input: KoyoClimateInput): RegionLineSummary {
  const today = regionMeanT0(info, input);
  const yesterday = regionMeanT0(info, { ...input, day: input.day - 1 });
  const g = input.lapseCPerM;
  const peakToday = lineElevationM(today.t0C, species.peakMinC, g, today.t0AheadC);
  const peakYesterday = lineElevationM(yesterday.t0C, species.peakMinC, g, yesterday.t0AheadC);
  return {
    regionId: info.region.id,
    name: info.region.name,
    meanLat: info.meanLat,
    t0C: today.t0C,
    normalT0C: today.normalT0C,
    anomaly: regionAnomaly(info.region.id, input),
    startLineM: lineElevationM(today.t0C, species.startMinC, g, today.t0AheadC),
    peakLineM: peakToday,
    endLineM: lineElevationM(today.t0C, species.endMinC, g, today.t0AheadC),
    peakDescentPerDayM: peakYesterday - peakToday,
  };
}

/** 北から南の順に、全地域の標高ラインを求める */
export function summarizeAllRegionsNorthToSouth(species: KoyoSpecies, input: KoyoClimateInput): RegionLineSummary[] {
  return REGION_INFOS_NORTH_TO_SOUTH.map((info) => summarizeRegion(info, species, input));
}

// ---------------------------------------------------------------------------
// 1地点の「いつ色づくか」
// ---------------------------------------------------------------------------

export interface TimelineEntry {
  /** しきい値に達する日(1970年1月1日からの日数)。期間内に達しなければnull */
  day: number | null;
  /** 期間の最初の日にすでにしきい値を下回っていた(=それより前に達している) */
  alreadyReached: boolean;
}

export interface PointTimelineRow {
  species: KoyoSpecies;
  start: TimelineEntry;
  peak: TimelineEntry;
  end: TimelineEntry;
}

function firstCrossing(tMinByDay: Float32Array, thrMinC: number, fromDay: number): TimelineEntry {
  if (tMinByDay.length > 0 && tMinByDay[0] <= thrMinC) return { day: fromDay, alreadyReached: true };
  for (let i = 1; i < tMinByDay.length; i++) {
    if (tMinByDay[i] <= thrMinC) return { day: fromDay + i, alreadyReached: false };
  }
  return { day: null, alreadyReached: false };
}

/**
 * ある地点(標高 elevM)について、各樹種が「色づき始め・見頃・落葉」になる日を求める。
 * fromDay〜toDay の毎日の日最低気温(推定)を並べ、初めてしきい値以下になる日を探す。
 */
export function pointTimeline(
  lat: number,
  lon: number,
  elevM: number,
  species: readonly KoyoSpecies[],
  base: Omit<KoyoClimateInput, "day">,
  fromDay: number,
  toDay: number,
): PointTimelineRow[] {
  const wts = stationWeightsAt(lat, lon, createStationWeights());
  const n = toDay - fromDay + 1;
  // その地点のT0を、fromDay〜toDay+LOWLAND_ADVANCE_DAYS の毎日分求めておく(前倒し補正で先の日の値も使うため)
  const t0Series = new Float32Array(n + LOWLAND_ADVANCE_DAYS);
  for (let i = 0; i < t0Series.length; i++) {
    t0Series[i] = interpolate(buildStationT0({ ...base, day: fromDay + i }), wts);
  }
  const tMin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    tMin[i] = minTempAt(t0Series[i], elevM, base.lapseCPerM, t0Series[i + LOWLAND_ADVANCE_DAYS]);
  }
  return species.map((sp) => ({
    species: sp,
    start: firstCrossing(tMin, sp.startMinC, fromDay),
    peak: firstCrossing(tMin, sp.peakMinC, fromDay),
    end: firstCrossing(tMin, sp.endMinC, fromDay),
  }));
}

// ---------------------------------------------------------------------------
// 1地点の樹種グループ(植生図 → 無ければ標高帯モデル)
// ---------------------------------------------------------------------------

export interface PointClass {
  /** 植生グリッドのクラスコード(`VEG_CLASS`) */
  classCode: number;
  /**
   * 植生図から決めたか、標高帯モデルで代用したか、標高2,000m以上の「森林以外」を高山の紅葉として推定したか
   * (`NONFOREST_ESTIMATE_MIN_ELEV_M`)
   */
  source: "vegetation" | "elevationZone" | "highAltitudeEstimate";
  /** その地点の年平均気温(℃。海面換算の平年値−逓減率×標高)。早く紅葉する種類の混生帯かの判定に使う */
  annualMeanC: number;
}

/** その地点の樹種グループ。植生図の範囲外・未整備、または植生図が無いときは標高帯モデルで代用する */
export function classAtPoint(
  lat: number,
  lon: number,
  elevM: number,
  veg: KoyoVegetationGrid | null,
  lapseCPerM: number,
): PointClass {
  const wts = stationWeightsAt(lat, lon, createStationWeights());
  const annualSL = new Float32Array(CLIMATE_STATIONS.length);
  for (let i = 0; i < annualSL.length; i++) annualSL[i] = stationAnnualSeaLevelC(i, lapseCPerM);
  const annualMeanC = interpolate(annualSL, wts) - lapseCPerM * elevM;
  if (veg) {
    const c = vegClassAtFine(veg, lat, lon);
    if (c === VEG_CLASS.none) {
      const est = effectiveClassForNonForest(elevM);
      if (est !== VEG_CLASS.none) return { classCode: est, source: "highAltitudeEstimate", annualMeanC };
    }
    if (c !== VEG_UNKNOWN) return { classCode: c, source: "vegetation", annualMeanC };
  }
  return { classCode: fallbackClassByAnnualTemp(annualMeanC), source: "elevationZone", annualMeanC };
}
