import { dataUrl, fetchGzAsset, readGrid } from "./koyoVegetation";
import { errorMessage } from "../../lib/errorMessage";

/**
 * 紅葉マップ: 豪雪地帯・特別豪雪地帯のグリッド。
 *
 * 「雪解けは新緑の一ヶ月前 特別豪雪地帯は0日 豪雪地帯は2週間前に 雪解け」への対応。
 * (その後「特別豪雪地帯でも新緑の1週間前には雪がとけるように」で、特別豪雪地帯を0日→7日前に変更)
 * 国土数値情報「豪雪地帯データ」(A22、平成28年。豪雪地帯対策特別措置法で指定された市町村の区域)の
 * ポリゴンを、約2km(経度0.025°×緯度1/60°)の1バイトのグリッドに変換して `public/data/` に置く:
 *
 *   koyoSnowZones.json    … グリッドの範囲・刻み・出典などのメタデータ
 *   koyoSnowZones.bin.gz  … uint8の行優先配列(rows×cols)をgzipしたもの
 *     0=指定なし / 1=豪雪地帯 / 2=特別豪雪地帯
 *
 * (作り方は `scripts/build-koyo-snow-zones.mjs`。ファイルが無いときは `status: "missing"` を返し、
 * 呼び出し側は雪解けの前倒しを行わない(全域を「指定なし」として扱う)。)
 */

export const SNOW_ZONE_NONE = 0;
export const SNOW_ZONE_HEAVY = 1;
export const SNOW_ZONE_SPECIAL = 2;

export interface KoyoSnowZoneMeta {
  version: number;
  west: number;
  north: number;
  lonStep: number;
  latStep: number;
  cols: number;
  rows: number;
  source: string;
  generatedAt: string;
}

export interface KoyoSnowZoneGrid extends KoyoSnowZoneMeta {
  data: Uint8Array;
}

export type KoyoSnowZoneLoad =
  | { status: "ok"; grid: KoyoSnowZoneGrid }
  | { status: "missing" }
  | { status: "error"; message: string };

/** 雪解けを新緑の何日前にするか(区分ごと): 指定なし30日前・豪雪地帯14日前(2週間前)・特別豪雪地帯7日前(1週間前) */
export const MELT_LEAD_DAYS_BY_ZONE: readonly number[] = [30, 14, 7];

/** 緯度経度の位置の区分(0/1/2)。グリッドの範囲外は0 */
export function snowZoneAt(grid: KoyoSnowZoneGrid, lat: number, lon: number): number {
  const col = Math.floor((lon - grid.west) / grid.lonStep);
  const row = Math.floor((grid.north - lat) / grid.latStep);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return SNOW_ZONE_NONE;
  return grid.data[row * grid.cols + col];
}

/**
 * 緯度経度での「雪解けを新緑の何日前にするか」(0〜30日)。セルの区分ごとの日数を、周囲4セルの中心から
 * 双線形補間するので、2kmのセルの境目が四角く出ず、区分の境目は1〜2km幅でなめらかに変わる。
 * グリッドが無い(null)・範囲外は「指定なし」の30日。
 */
export function meltLeadDaysAt(grid: KoyoSnowZoneGrid | null, lat: number, lon: number): number {
  if (!grid) return MELT_LEAD_DAYS_BY_ZONE[SNOW_ZONE_NONE];
  const fx = (lon - grid.west) / grid.lonStep - 0.5;
  const fy = (grid.north - lat) / grid.latStep - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const lead = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= grid.cols || y >= grid.rows) return MELT_LEAD_DAYS_BY_ZONE[SNOW_ZONE_NONE];
    return MELT_LEAD_DAYS_BY_ZONE[grid.data[y * grid.cols + x]] ?? MELT_LEAD_DAYS_BY_ZONE[SNOW_ZONE_NONE];
  };
  const a = lead(x0, y0) * (1 - tx) + lead(x0 + 1, y0) * tx;
  const b = lead(x0, y0 + 1) * (1 - tx) + lead(x0 + 1, y0 + 1) * tx;
  return a * (1 - ty) + b * ty;
}

/** 豪雪地帯グリッドを読み込む。ファイルが無いときは `missing`(エラーではない) */
export async function loadKoyoSnowZones(): Promise<KoyoSnowZoneLoad> {
  let metaRes: Response;
  try {
    metaRes = await fetch(dataUrl("koyoSnowZones.json"), { cache: "no-cache" });
  } catch (e) {
    return { status: "error", message: `豪雪地帯データの取得に失敗しました: ${errorMessage(e)}` };
  }
  if (!metaRes.ok) return { status: "missing" };
  const text = await metaRes.text();
  if (text.trimStart().startsWith("<")) return { status: "missing" };

  let meta: KoyoSnowZoneMeta;
  try {
    meta = JSON.parse(text) as KoyoSnowZoneMeta;
  } catch {
    return { status: "error", message: "豪雪地帯データのメタ情報(koyoSnowZones.json)を解析できませんでした" };
  }
  if (!meta || meta.version !== 1 || !(meta.cols > 0) || !(meta.rows > 0) || !(meta.lonStep > 0) || !(meta.latStep > 0)) {
    return { status: "error", message: "豪雪地帯データのメタ情報(koyoSnowZones.json)の形式が想定と違います" };
  }

  try {
    const binRes = await fetchGzAsset("koyoSnowZones.bin.gz", { cache: "no-cache" });
    if (!binRes.ok) {
      return { status: "error", message: `豪雪地帯データ本体(koyoSnowZones.bin.gz)がありません (HTTP ${binRes.status})` };
    }
    const data = await readGrid(binRes, meta.cols * meta.rows);
    if (data.length !== meta.cols * meta.rows) {
      return {
        status: "error",
        message: `豪雪地帯データの大きさが合いません(期待 ${meta.cols * meta.rows} バイト、実際 ${data.length} バイト)`,
      };
    }
    return { status: "ok", grid: { ...meta, data } };
  } catch (e) {
    return { status: "error", message: `豪雪地帯データの読み込みに失敗しました: ${errorMessage(e)}` };
  }
}
