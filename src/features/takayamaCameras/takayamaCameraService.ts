import { parseJsonResponse } from "../../lib/safeJson";
import type { TakayamaCamera } from "../../types";

/**
 * 国交省 高山国道事務所「道路状況ライブカメラ」(飛騨地域、約75地点)。
 * https://www.cbr.mlit.go.jp/takayama/cctv/index.html
 *
 * 地点一覧は上流の `data_camera.json` (地点名・撮影方向・画像パスのみで緯度経度は含まない)を
 * 元に、各地点名を国土地理院 地名検索API(https://msearch.gsi.go.jp/address-search/AddressSearch)
 * で緯度経度に変換して `public/takayamaCameras.json` として静的に持たせている
 * (カメラ地点自体はほとんど変わらないため、都度ジオコーディングする代わりに一度だけ変換して同梱)。
 * 画像はHTTPS配信のため、プロキシなしで直接 <img> に埋め込める。
 */
export async function loadTakayamaCameras(): Promise<TakayamaCamera[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}takayamaCameras.json`);
  if (!res.ok) {
    throw new Error(`高山国道事務所カメラ一覧の読み込みに失敗しました (HTTP ${res.status})`);
  }
  const data = await parseJsonResponse<unknown>(res, "高山国道事務所カメラ一覧");
  if (!Array.isArray(data)) {
    throw new Error("takayamaCameras.json はカメラ一覧の配列である必要があります");
  }
  return data as TakayamaCamera[];
}
