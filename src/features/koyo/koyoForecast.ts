import { fetchExt } from "../../lib/extProxy";
import { KOYO_REGIONS, type KoyoRegionId } from "./koyoClimate";

/**
 * 紅葉マップ: 長期予報(気温)の取得。
 *
 * 「長期予報の気温を取得し 各地域ごとで 紅葉の進み具合を調節できる」への対応。
 * 気象庁「確率予測資料」(数値予報の計算結果から自動作成された、2週間気温予報・1か月予報の
 * 資料。地域平均の**平年差**のアンサンブル平均がCSVで提供されている)を使う:
 *
 * - 2週間気温予報: https://ds.data.jma.go.jp/risk/probability/guidance/download2w.php?2week_t_<地域番号>.csv
 *   「各5日間移動平均値」の平年差。毎日9時30分頃更新。
 * - 1か月予報:     https://ds.data.jma.go.jp/risk/probability/guidance/download.php?month1_t_<地域番号>.csv
 *   28日平均・1週目・2週目・3〜4週目の平年差。毎週木曜9時30分頃更新。
 *
 * 【注意】確率予測資料は自動作成された資料で、気象庁が実際に発表する2週間気温予報・1か月予報と
 * 異なる内容を含む場合がある(気象庁の注記)。このアプリは、その値を「紅葉の進み具合を調整する
 * 入力」として使うだけで、気温そのものの予報を独自に発表するものではない。
 *
 * 【CSVの列構成(気象庁の解説ページによる)】
 *   1行目(ヘッダ): 1〜3列=初期値日(年・月・日)、以降は累積確率の階級見出し
 *   2行目以降: 1〜3列=予報期間の開始日、4〜6列=終了日、7列=日数、8列=地域番号、
 *              9列=要素(1=日平均気温)、10列=ガイダンス番号、11列=アンサンブル平均の平年差(0.1℃単位)、
 *              12列〜=累積確率(使わない)
 * 列の意味は解説ページの記述に基づいており、実データでの確認は未了のため、パーサーは
 * 想定外の行を黙って取り込まず(日付・日数・値の範囲を検証して)捨てる作りにしている。
 * 1行も解釈できなかった場合は、その旨のエラーを画面に出す(0℃の予報として黙って扱わない)。
 */

const DAY_MS = 86_400_000;

/** 暦日を「1970年1月1日からの日数」にする(UTC基準。時刻の概念を持ち込まないため) */
export function dayNumber(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

export function dayNumberFromDate(date: Date): number {
  return Math.floor(date.getTime() / DAY_MS);
}

export function dateFromDayNumber(day: number): Date {
  return new Date(day * DAY_MS);
}

export interface ForecastPeriod {
  startDay: number;
  endDay: number;
  /** 平年差の予報(℃) */
  anomalyC: number;
}

export interface RegionForecast {
  /** 2週間気温予報(5日移動平均の平年差)。開始日の昇順 */
  twoWeek: ForecastPeriod[];
  /** 1か月予報(1週目・2週目・3〜4週目、または28日平均) */
  oneMonth: ForecastPeriod[];
  twoWeekCode?: number;
  oneMonthCode?: number;
}

export interface KoyoForecastBundle {
  /** 取得した時刻(ms) */
  fetchedAt: number;
  twoWeekInitDay: number | null;
  oneMonthInitDay: number | null;
  regions: Partial<Record<KoyoRegionId, RegionForecast>>;
  /** 取得・解釈に失敗した項目(画面に表示する) */
  errors: string[];
}

// ---------------------------------------------------------------------------
// CSVの解釈
// ---------------------------------------------------------------------------

export interface ProbabilityCsvRow {
  startDay: number;
  endDay: number;
  ndays: number;
  code: number;
  element: number;
  anomalyC: number;
}

export interface ParsedProbabilityCsv {
  initDay: number | null;
  rows: ProbabilityCsvRow[];
}

function validYear(y: number): boolean {
  return Number.isInteger(y) && y >= 2000 && y <= 2100;
}

/** 確率予測資料のCSV(2週間気温予報・1か月予報の両方)を解釈する。想定外の行は捨てる */
export function parseProbabilityCsv(text: string): ParsedProbabilityCsv {
  const lines = text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return { initDay: null, rows: [] };

  const toNums = (line: string) => line.split(",").map((c) => Number(c.trim().replace(/^"|"$/g, "")));

  let initDay: number | null = null;
  const head = toNums(lines[0]);
  if (head.length >= 3 && validYear(head[0]) && head[1] >= 1 && head[1] <= 12 && head[2] >= 1 && head[2] <= 31) {
    initDay = dayNumber(head[0], head[1], head[2]);
  }

  const rows: ProbabilityCsvRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = toNums(lines[i]);
    if (c.length < 11) continue;
    if (c.slice(0, 11).some((v) => !Number.isFinite(v))) continue;
    const [sy, sm, sd, ey, em, ed, ndays, code, element, , anom10] = c;
    if (!validYear(sy) || !validYear(ey)) continue;
    const startDay = dayNumber(sy, sm, sd);
    const endDay = dayNumber(ey, em, ed);
    if (endDay < startDay) continue;
    // 開始〜終了の日数と「日数」の列が(±1日を許して)整合する行だけを採用する
    if (!Number.isInteger(ndays) || ndays < 1 || Math.abs(endDay - startDay + 1 - ndays) > 1) continue;
    const anomalyC = anom10 / 10;
    if (Math.abs(anomalyC) > 15) continue;
    rows.push({ startDay, endDay, ndays, code, element, anomalyC });
  }
  return { initDay, rows };
}

/** 日平均気温の行だけを残す(要素の列が1の行があれば。無ければ全行を日平均とみなす) */
function meanTempRows(rows: ProbabilityCsvRow[], fileCode: number): ProbabilityCsvRow[] {
  let r = rows;
  if (r.some((x) => x.element === 1)) r = r.filter((x) => x.element === 1);
  // 1つのCSVに複数地域の行が含まれる場合に備え、ファイルの地域番号の行があればそれだけにする
  if (r.some((x) => x.code === fileCode)) r = r.filter((x) => x.code === fileCode);
  return r;
}

export function toTwoWeekPeriods(rows: ProbabilityCsvRow[], fileCode: number): ForecastPeriod[] {
  return meanTempRows(rows, fileCode)
    .map((r) => ({ startDay: r.startDay, endDay: r.endDay, anomalyC: r.anomalyC }))
    .sort((a, b) => a.startDay - b.startDay);
}

/**
 * 1か月予報: 「28日平均」「1週目」「2週目」「3〜4週目」の4行が入っている。
 * 短い期間(7日・14日)があればそれを使い、28日平均しか無ければそれだけを使う。
 */
export function toOneMonthPeriods(rows: ProbabilityCsvRow[], fileCode: number): ForecastPeriod[] {
  const r = meanTempRows(rows, fileCode);
  const short = r.filter((x) => x.ndays <= 14);
  const use = short.length > 0 ? short : r;
  return use
    .map((x) => ({ startDay: x.startDay, endDay: x.endDay, anomalyC: x.anomalyC }))
    .sort((a, b) => a.startDay - b.startDay);
}

// ---------------------------------------------------------------------------
// 日ごとの平年差を求める
// ---------------------------------------------------------------------------

/** 予報の範囲を過ぎたあと、平年差が0℃に戻っていく速さ(e-folding日数)。仮置きの値 */
export const ANOMALY_DECAY_DAYS = 15;

export type AnomalySource = "twoWeek" | "oneMonth" | "held" | "decay" | "none";

export const ANOMALY_SOURCE_LABEL: Record<AnomalySource, string> = {
  twoWeek: "2週間気温予報",
  oneMonth: "1か月予報",
  held: "予報開始前(発表時の値で代用)",
  decay: "予報期間外(平年へ漸減)",
  none: "予報なし(平年並み)",
};

/**
 * ある日の平年差(℃)を、予報から求める。
 * 1) 2週間気温予報の範囲内 → 5日移動平均の中心日どうしを線形補間
 * 2) 1か月予報の範囲内     → その期間の値
 * 3) 予報の開始より前       → 最も早い予報の値で代用(実況は反映しない)
 * 4) 予報の終了より後       → 最後の値から平年(0℃)へ指数的に戻す
 */
export function forecastAnomalyC(rf: RegionForecast | undefined, day: number): { anomalyC: number; source: AnomalySource } {
  if (!rf || (rf.twoWeek.length === 0 && rf.oneMonth.length === 0)) return { anomalyC: 0, source: "none" };

  const tw = rf.twoWeek;
  if (tw.length > 0) {
    const centers = tw.map((p) => (p.startDay + p.endDay) / 2);
    if (day >= centers[0] && day <= centers[centers.length - 1]) {
      let k = 0;
      while (k + 1 < centers.length && centers[k + 1] < day) k++;
      if (k + 1 >= centers.length) return { anomalyC: tw[tw.length - 1].anomalyC, source: "twoWeek" };
      const span = centers[k + 1] - centers[k];
      const t = span > 0 ? (day - centers[k]) / span : 0;
      return { anomalyC: tw[k].anomalyC + (tw[k + 1].anomalyC - tw[k].anomalyC) * t, source: "twoWeek" };
    }
  }

  const om = rf.oneMonth;
  for (const p of om) {
    if (day >= p.startDay && day <= p.endDay) return { anomalyC: p.anomalyC, source: "oneMonth" };
  }

  // 範囲外
  const all: ForecastPeriod[] = [...tw, ...om];
  const firstStart = Math.min(...all.map((p) => p.startDay));
  const lastEnd = Math.max(...all.map((p) => p.endDay));
  if (day < firstStart) {
    const first = all.reduce((a, b) => (b.startDay < a.startDay ? b : a));
    return { anomalyC: first.anomalyC, source: "held" };
  }
  const last = all.reduce((a, b) => (b.endDay > a.endDay ? b : a));
  return { anomalyC: last.anomalyC * Math.exp(-(day - lastEnd) / ANOMALY_DECAY_DAYS), source: "decay" };
}

// ---------------------------------------------------------------------------
// 取得
// ---------------------------------------------------------------------------

type CsvKind = "2week" | "month1";

function csvPath(kind: CsvKind, code: number): string {
  const file = kind === "2week" ? `download2w.php?2week_t_${code}.csv` : `download.php?month1_t_${code}.csv`;
  return `/risk/probability/guidance/${file}`;
}

/** 同時に実行する取得の上限(気象庁のサーバーに負荷をかけすぎないため) */
const MAX_CONCURRENT_FETCHES = 4;

async function runLimited<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

interface CsvResult {
  parsed: ParsedProbabilityCsv | null;
  error: string | null;
}

/**
 * 全地域の長期予報を取得する。地域ごとに、細分の番号→親の地方の番号の順に試す。
 * 一部の地域・種別が失敗しても、取れたものだけで`errors`付きの結果を返す。
 */
export async function fetchKoyoForecastBundle(): Promise<KoyoForecastBundle> {
  const cache = new Map<string, Promise<CsvResult>>();
  const getCsv = (kind: CsvKind, code: number): Promise<CsvResult> => {
    const key = `${kind}:${code}`;
    let p = cache.get(key);
    if (!p) {
      p = fetchExt("jmaProb", csvPath(kind, code))
        .then((text): CsvResult => {
          const parsed = parseProbabilityCsv(text);
          return parsed.rows.length > 0
            ? { parsed, error: null }
            : { parsed: null, error: `${kind}_${code}: CSVを解釈できませんでした(想定外の形式)` };
        })
        .catch((e: unknown): CsvResult => ({
          parsed: null,
          error: `${kind}_${code}: ${e instanceof Error ? e.message : String(e)}`,
        }));
      cache.set(key, p);
    }
    return p;
  };

  const errors: string[] = [];
  const regions: Partial<Record<KoyoRegionId, RegionForecast>> = {};
  let twoWeekInitDay: number | null = null;
  let oneMonthInitDay: number | null = null;

  const tasks = KOYO_REGIONS.map((region) => async () => {
    const rf: RegionForecast = { twoWeek: [], oneMonth: [] };
    for (const kind of ["2week", "month1"] as const) {
      let lastError: string | null = null;
      for (const code of region.csvCodes) {
        const { parsed, error } = await getCsv(kind, code);
        if (!parsed) {
          lastError = error;
          continue;
        }
        if (kind === "2week") {
          const periods = toTwoWeekPeriods(parsed.rows, code);
          if (periods.length === 0) continue;
          rf.twoWeek = periods;
          rf.twoWeekCode = code;
          twoWeekInitDay = twoWeekInitDay ?? parsed.initDay;
        } else {
          const periods = toOneMonthPeriods(parsed.rows, code);
          if (periods.length === 0) continue;
          rf.oneMonth = periods;
          rf.oneMonthCode = code;
          oneMonthInitDay = oneMonthInitDay ?? parsed.initDay;
        }
        lastError = null;
        break;
      }
      if (lastError) errors.push(`${region.name}: ${lastError}`);
    }
    if (rf.twoWeek.length > 0 || rf.oneMonth.length > 0) regions[region.id] = rf;
  });
  await runLimited(tasks, MAX_CONCURRENT_FETCHES);

  return { fetchedAt: Date.now(), twoWeekInitDay, oneMonthInitDay, regions, errors };
}

// ---------------------------------------------------------------------------
// キャッシュ(localStorage。予報は毎日〜毎週しか更新されないため、開くたびには取り直さない)
// ---------------------------------------------------------------------------

const CACHE_KEY = "koyoForecastV1";
/** この時間以内に取得済みなら取り直さない */
export const FORECAST_TTL_MS = 3 * 60 * 60 * 1000;

export function loadCachedKoyoForecast(): KoyoForecastBundle | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const b = JSON.parse(raw) as KoyoForecastBundle;
    if (typeof b?.fetchedAt !== "number" || typeof b.regions !== "object") return null;
    return b;
  } catch {
    return null;
  }
}

export function isForecastFresh(b: KoyoForecastBundle | null, now = Date.now()): boolean {
  return !!b && now - b.fetchedAt < FORECAST_TTL_MS && Object.keys(b.regions).length > 0;
}

/**
 * 長期予報を取得する(新しいキャッシュがあればそれを返す)。
 * 1地域も取得できなかったときはエラーにする(平年並みとして黙って続けない)。
 */
export async function loadKoyoForecast(force = false): Promise<KoyoForecastBundle> {
  const cached = loadCachedKoyoForecast();
  if (!force && isForecastFresh(cached)) return cached as KoyoForecastBundle;

  const bundle = await fetchKoyoForecastBundle();
  if (Object.keys(bundle.regions).length === 0) {
    const detail = bundle.errors.slice(0, 2).join(" / ");
    throw new Error(`気象庁の長期予報を取得できませんでした${detail ? `(${detail})` : ""}`);
  }
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(bundle));
  } catch {
    // 保存できなくても動作に支障はない(単なるキャッシュ)
  }
  return bundle;
}
