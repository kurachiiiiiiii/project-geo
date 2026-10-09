/**
 * 気象庁 高解像度降水ナウキャストのタイル配信を利用するためのサービス。
 *
 * targetTimes_N1.json (実況・過去1時間, 5分刻み) と targetTimes_N2.json (今後1時間の予測, 5分刻み) は、
 * 気象庁の防災情報ページ(jma.go.jp/bosai/)が内部で使っている非公式(ドキュメント化されていない)
 * エンドポイント。個人利用の範囲でのアクセスを想定し、高頻度なポーリングは避ける
 * (このアプリでは既定で5分間隔)。将来レスポンス形式が変わる可能性があるため、
 * 想定外の形式はエラーとして扱う。
 */

import { parseJsonResponse } from "../../lib/safeJson";

export interface RainFrame {
  basetime: string;
  validtime: string;
}

const TARGET_TIMES_URLS = [
  "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N1.json", // 実況・過去
  "https://www.jma.go.jp/bosai/jmatile/data/nowc/targetTimes_N2.json", // 予測(今後60分)
];

interface RawTargetTime {
  basetime?: string;
  validtime?: string;
  elements?: string[];
}

async function fetchTargetTimes(url: string): Promise<RainFrame[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`JMAの降水ナウキャスト時刻情報の取得に失敗しました (HTTP ${res.status})`);
  }
  const data = await parseJsonResponse<RawTargetTime[]>(res, "JMA降水ナウキャスト時刻情報");
  if (!Array.isArray(data)) {
    throw new Error("JMAの降水ナウキャスト時刻情報のレスポンス形式が想定と異なります");
  }
  return data
    .filter((d): d is Required<Pick<RawTargetTime, "basetime" | "validtime">> & RawTargetTime =>
      !!d.basetime && !!d.validtime && (!d.elements || d.elements.includes("hrpns")),
    )
    .map((d) => ({ basetime: d.basetime!, validtime: d.validtime! }));
}

export async function fetchRainFrames(): Promise<RainFrame[]> {
  const results = await Promise.all(TARGET_TIMES_URLS.map(fetchTargetTimes));
  const merged = results.flat();

  // 同じ validtime が重複する場合は basetime が新しい方(＝より最近の観測に基づく予測)を優先する。
  const byValidTime = new Map<string, RainFrame>();
  for (const frame of merged) {
    const existing = byValidTime.get(frame.validtime);
    if (!existing || frame.basetime > existing.basetime) {
      byValidTime.set(frame.validtime, frame);
    }
  }

  // validtime(=表示対象時刻)の昇順に並べ替え。14桁の "YYYYMMDDHHmmss" 形式なので文字列比較で時系列順になる。
  return [...byValidTime.values()].sort((a, b) => a.validtime.localeCompare(b.validtime));
}

/** そのフレームが「現況」ではなく「予測(未来のコマ)」かどうか */
export function isForecastFrame(frame: RainFrame): boolean {
  return frame.validtime > frame.basetime;
}

/** Leaflet TileLayer にそのまま渡せる URL テンプレート ({z}/{x}/{y} プレースホルダ付き) */
export function buildRainTileUrlTemplate(frame: RainFrame): string {
  return `https://www.jma.go.jp/bosai/jmatile/data/nowc/${frame.basetime}/none/${frame.validtime}/surf/hrpns/{z}/{x}/{y}.png`;
}

/**
 * validtime (YYYYMMDDHHmmss) を人が読める日本時間の表示文字列に変換する。
 *
 * 【既知の不具合の修正】この値は一見JSTのように見えるが、実際にはUTC基準で配信されている
 * (例: 実況の最新コマのvaltimeは、取得した瞬間のUTC時刻とほぼ一致する。JSTなら9時間先の
 * 値になるはずなので、文字列をそのままJSTとして表示すると常に9時間遅れて表示されてしまう)。
 * そのため `Date.UTC` で明示的にUTCとして解釈してから、Asia/Tokyoタイムゾーンで整形する。
 */
export function formatValidTime(validtime: string): string {
  const utcMs = Date.UTC(
    Number(validtime.slice(0, 4)),
    Number(validtime.slice(4, 6)) - 1,
    Number(validtime.slice(6, 8)),
    Number(validtime.slice(8, 10)),
    Number(validtime.slice(10, 12)),
    Number(validtime.slice(12, 14) || "0"),
  );
  const jst = new Date(utcMs).toLocaleString("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  return `${jst.replace(/\//g, "/").replace(",", "")} JST`;
}
