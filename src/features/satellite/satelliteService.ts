import type { SatelliteBand, SatelliteBandDef } from "../../types";
import { parseJsonResponse } from "../../lib/safeJson";

/**
 * 気象庁「ひまわり」衛星画像のタイル配信。
 *
 * 降水ナウキャストと同じく防災情報ページが内部で使っているエンドポイントだが、
 * こちらは `Access-Control-Allow-Origin: *` を返すためプロキシ不要で直接取得できる。
 *
 * タイルURL: {BASE}/{basetime}/fd/{validtime}/{バンド}/{プロダクト}/{z}/{x}/{y}.jpg
 * `fd` は全球(full disk)。日本域だけの `jp` もあるが、範囲が広い `fd` を使っている。
 */

const BASE = "https://www.jma.go.jp/bosai/himawari/data/satimg";

/** 表示できる衛星画像の種類 */
export const SATELLITE_BANDS: SatelliteBandDef[] = [
  // 赤外は雲頂温度。昼夜を問わず雲の分布が分かるので既定にしている
  { key: "infrared", label: "赤外", path: "B13/TBB" },
  // 可視は太陽光の反射なので夜間は真っ暗になる
  { key: "visible", label: "可視", path: "B03/ALBD" },
  { key: "truecolor", label: "トゥルーカラー", path: "REP/ETC" },
  { key: "vapor", label: "水蒸気", path: "B08/TBB" },
];

export interface SatelliteFrame {
  basetime: string;
  validtime: string;
}

interface RawTargetTime {
  basetime?: string;
  validtime?: string;
}

/** "YYYYMMDDHHmmss"(UTC)をDateにする */
export function parseValidTime(validtime: string): Date {
  return new Date(
    Date.UTC(
      Number(validtime.slice(0, 4)),
      Number(validtime.slice(4, 6)) - 1,
      Number(validtime.slice(6, 8)),
      Number(validtime.slice(8, 10)),
      Number(validtime.slice(10, 12)),
    ),
  );
}

/**
 * 「衛星画像は現在時間だけではなく3時間前まで取得して確認できるようにしてください」を
 * 元々は10分間隔(最大18コマ)で実装していたが、「1のesrgan(esrgan-medium)を使用して
 * ください。その場合は10分単位ではなく1時間単位で3枚の画像のみにして大丈夫です」という
 * 指示により、いったんコマ数を絞った(1時間間隔・3コマ)。当時はAI超解像がチェックボックス
 * ONで自動的に走る仕様だったため、コマ数=AI処理の発生回数に直結していたが、その後
 * 「生成」ボタン方式(`satelliteEnhanceTileLayer.ts`の`aiGenerationEnabled`)に変更し、
 * コマ切り替え自体はAI処理を伴わなくなったため、その制約は無くなった。「取得時間を
 * 30分毎、5時間分にしてください」という指示により、30分間隔・11コマ(5時間ぶん)に
 * 変更した。
 */
const FRAME_COUNT = 11;
const FRAME_STEP_HOURS = 0.5;

/**
 * 配信中の時刻一覧を取得し、最新のコマを起点に`stepHours`間隔で`frameCount`枚
 * (既定11枚・30分間隔、古い→新しい順、配列の最後の要素が最新=現在時刻相当)を選んで返す。
 * ちょうどその時刻のコマが配信されているとは限らないため、各節目の時刻以前で最も新しい
 * コマを選ぶ。`targetTimes_fd.json` 自体は直近36時間ぶん程度を返す(実測で確認済み)ため、
 * 11枚・30分間隔(=直近5時間ぶん)であれば必ず収まる。
 */
export async function fetchRecentSatelliteFrames(
  frameCount = FRAME_COUNT,
  stepHours = FRAME_STEP_HOURS,
): Promise<SatelliteFrame[]> {
  const res = await fetch(`${BASE}/targetTimes_fd.json`);
  if (!res.ok) {
    throw new Error(`ひまわり配信時刻の取得に失敗しました (HTTP ${res.status})`);
  }
  const data = await parseJsonResponse<RawTargetTime[]>(res, "ひまわり配信時刻");
  const frames = data.filter((d): d is Required<RawTargetTime> => !!d.basetime && !!d.validtime);
  if (frames.length === 0) {
    throw new Error("ひまわりの配信時刻が取得できませんでした");
  }
  // 時刻は "YYYYMMDDHHmmss" の14桁なので文字列比較でも時系列順になるが、
  // 節目の時刻との比較にはDate変換して行う。
  frames.sort((a, b) => a.validtime.localeCompare(b.validtime));
  const latest = frames[frames.length - 1];
  const latestMs = parseValidTime(latest.validtime).getTime();

  const pickedNewestFirst: SatelliteFrame[] = [];
  for (let i = 0; i < frameCount; i++) {
    const targetMs = latestMs - i * stepHours * 60 * 60_000;
    let candidate: SatelliteFrame | undefined;
    for (const f of frames) {
      if (parseValidTime(f.validtime).getTime() > targetMs) break;
      candidate = f; // targetMs以前で最も新しいコマ
    }
    if (candidate) pickedNewestFirst.push(candidate);
  }

  // データが薄い場合に同じコマを複数の節目で選んでしまうことがあるため重複を除く
  const seen = new Set<string>();
  const uniqueNewestFirst = pickedNewestFirst.filter((f) => {
    if (seen.has(f.validtime)) return false;
    seen.add(f.validtime);
    return true;
  });

  return uniqueNewestFirst.length > 0 ? uniqueNewestFirst.reverse() : [latest];
}

/** Leaflet の TileLayer にそのまま渡せる URL テンプレート */
export function buildSatelliteTileUrl(frame: SatelliteFrame, band: SatelliteBand): string {
  const def = SATELLITE_BANDS.find((b) => b.key === band) ?? SATELLITE_BANDS[0];
  return `${BASE}/${frame.basetime}/fd/${frame.validtime}/${def.path}/{z}/{x}/{y}.jpg`;
}

/** "YYYYMMDDHHmmss"(UTC) を日本時間の表示文字列にする */
export function formatSatelliteTime(validtime: string): string {
  return parseValidTime(validtime).toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}
