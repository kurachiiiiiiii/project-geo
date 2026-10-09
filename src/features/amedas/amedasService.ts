import type { AmedasSnapshot, AmedasStation, WeatherMetricDef } from "../../types";
import { parseJsonResponse } from "../../lib/safeJson";
import { fetchExt } from "../../lib/extProxy";

/**
 * 気象庁アメダスの観測データ取得サービス。
 *
 * 気象庁の防災情報ページが使っている公開エンドポイントで、こちらは
 * `Access-Control-Allow-Origin: *` を返すためプロキシ不要でブラウザから直接取得できる
 * (岐阜県や川の防災情報とは異なる点)。
 *
 * - const/amedastable.json : 観測所マスタ(座標・標高・名称)。ほぼ変わらないので初回のみ取得しキャッシュ。
 * - data/latest_time.txt   : 最新の観測時刻
 * - data/map/{時刻}.json    : 全観測所のその時刻の観測値
 */

const BASE = "https://www.jma.go.jp/bosai/amedas";

/** 地図表示で選べる気象要素の定義(UIのセレクタと値の整形で共用) */
export const WEATHER_METRICS: WeatherMetricDef[] = [
  { key: "temp", label: "気温", unit: "℃", digits: 1 },
  { key: "precipitation1h", label: "降水量(1h)", unit: "mm", digits: 1 },
  { key: "sun1h", label: "日照時間(1h)", unit: "h", digits: 1 },
  { key: "humidity", label: "湿度", unit: "%", digits: 0 },
  { key: "wind", label: "風速", unit: "m/s", digits: 1 },
];

interface RawTableEntry {
  /** 度・分の2要素 */
  lat: [number, number];
  lon: [number, number];
  alt: number;
  kjName: string;
}

/** アメダスの観測値は [値, 品質情報] の配列。品質情報が0以外(欠測など)は値なし扱いにする。 */
type RawValue = [number, number] | undefined;

type RawMapEntry = Record<string, RawValue>;

let tableCache: Record<string, RawTableEntry> | null = null;

/** [度, 分] 形式を10進度に変換する */
function toDecimalDegrees([deg, min]: [number, number]): number {
  return deg + min / 60;
}

function value(raw: RawValue): number | null {
  if (!raw) return null;
  const [v, quality] = raw;
  if (quality !== 0) return null;
  return typeof v === "number" ? v : null;
}

async function loadTable(): Promise<Record<string, RawTableEntry>> {
  if (tableCache) return tableCache;
  const res = await fetch(`${BASE}/const/amedastable.json`);
  if (!res.ok) throw new Error(`アメダス観測所マスタの取得に失敗しました (HTTP ${res.status})`);
  tableCache = await parseJsonResponse<Record<string, RawTableEntry>>(res, "アメダス観測所マスタ");
  return tableCache;
}

async function loadLatestTime(): Promise<string> {
  const res = await fetch(`${BASE}/data/latest_time.txt`);
  if (!res.ok) throw new Error(`アメダス最新時刻の取得に失敗しました (HTTP ${res.status})`);
  return (await res.text()).trim();
}

/** "2026-08-29T09:50:00+09:00" -> "20260829095000" (データファイル名の形式) */
function toFileTimestamp(isoTime: string): string {
  return isoTime.slice(0, 19).replace(/[-:T]/g, "");
}

/**
 * 犬山自動気象観測所(https://www.ma.ccnw.ne.jp/jan/ 、愛知県犬山市の個人運用サイト)。
 * 「気温観測地点を追加してください」という指示で最初に高原天気(kougenTenkiGenerate.mjs)側
 * にのみ追加していたが、「犬山市に気温がない」という報告を受けて調査したところ、地図上の
 * 通常のアメダス気温表示(この`loadAmedas()`が返す一覧)には含まれておらず、高原天気の
 * レイヤーを有効化して生成しないと見えない状態だった。地図の既定表示である通常のアメダス
 * 気温マーカーの方にも同じ地点を追加し、どちらからでも見えるようにする。
 *
 * サーバー側(高原天気)は直接HTTPS/Shift_JISで取得しているが、ブラウザから直接fetchすると
 * 相手サイトがCORS非対応のためブロックされる。`server/externalProxy.mjs`の`inuyama`
 * エントリ経由で取得する(信州大学・立山雄山などと同じ仕組み)。
 */
const INUYAMA_AWS_PATH = "/jan/weather/main.html";

async function loadInuyamaAwsStation(): Promise<AmedasStation | null> {
  try {
    const html = await fetchExt("inuyama", INUYAMA_AWS_PATH);
    // 区切り文字は「：」ではなく「；」(全角セミコロン)、単位は「℃」ではなく「°C」
    // (server/kougenTenkiGenerate.mjs の犬山AWS取得で判明した実際の文字。詳細はそちらの
    // コメント・READMEを参照)。念のため全角コロン・半角コロン・℃も許容しておく。
    const tempMatch = html.match(/気温[；：:]\s*(-?\d+(?:\.\d+)?)\s*(?:°C|℃)/);
    const humMatch = html.match(/湿度[；：:]\s*(\d+(?:\.\d+)?)\s*%/);
    if (!tempMatch || !humMatch) return null;

    const temp = Number(tempMatch[1]);
    const humidity = Number(humMatch[1]);
    if (!Number.isFinite(temp) || !Number.isFinite(humidity)) return null;

    return {
      code: "inuyama_aws",
      name: "犬山自動気象観測所",
      lat: 35 + 23.3 / 60,
      lng: 136 + 59.9 / 60,
      altitudeM: 130,
      temp,
      humidity,
      precipitation1h: null,
      sun1h: null,
      wind: null,
      windDirection: null,
    };
  } catch {
    // 失敗しても通常のアメダス表示自体は成立させたいため、ここでは例外を投げず追加無しにする。
    return null;
  }
}

export async function loadAmedas(): Promise<AmedasSnapshot> {
  const [table, latestTime, inuyama] = await Promise.all([
    loadTable(),
    loadLatestTime(),
    loadInuyamaAwsStation(),
  ]);

  const res = await fetch(`${BASE}/data/map/${toFileTimestamp(latestTime)}.json`);
  if (!res.ok) throw new Error(`アメダス観測データの取得に失敗しました (HTTP ${res.status})`);
  const data = await parseJsonResponse<Record<string, RawMapEntry>>(res, "アメダス観測データ");

  const stations: AmedasStation[] = [];
  for (const [code, obs] of Object.entries(data)) {
    const meta = table[code];
    if (!meta) continue;
    stations.push({
      code,
      name: meta.kjName,
      lat: toDecimalDegrees(meta.lat),
      lng: toDecimalDegrees(meta.lon),
      altitudeM: meta.alt,
      temp: value(obs.temp),
      humidity: value(obs.humidity),
      precipitation1h: value(obs.precipitation1h),
      sun1h: value(obs.sun1h),
      wind: value(obs.wind),
      windDirection: value(obs.windDirection),
    });
  }

  if (inuyama) stations.push(inuyama);

  return { observedAt: latestTime, stations };
}

const WIND_DIRECTION_LABELS = [
  "静穏", "北北東", "北東", "東北東", "東", "東南東", "南東", "南南東",
  "南", "南南西", "南西", "西南西", "西", "西北西", "北西", "北北西", "北",
];

export function windDirectionLabel(dir: number | null): string {
  if (dir === null || dir < 0 || dir >= WIND_DIRECTION_LABELS.length) return "—";
  return WIND_DIRECTION_LABELS[dir];
}
