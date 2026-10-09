import { fetchExt } from "../../lib/extProxy";
import type { JmaVolcanoCamera, JmaVolcanoCameraImage } from "../../types";

/**
 * 気象庁 火山監視カメラ画像の取得サービス。
 * https://www.data.jma.go.jp/vois/data/obs/volcam/volcam.php
 *
 * 一覧(地点・座標)は geojson で公開されているが、各カメラの「現在の画像」は
 * 個別ページ(volcam.php?VC=xxxxx)のHTML内に埋め込まれた file_array から
 * 都度読み取る必要がある(専用のJSON APIは無い)。カメラ数が多い(約100件)ため、
 * 一覧取得は起動時に1回だけ、画像取得はポップアップを開いたときに遅延実行する。
 */

const JMA_ORIGIN = "https://www.data.jma.go.jp";
const GEOJSON_PATH = "/vois/data/obs/volcam/param/geojson/camname.geojson";

interface RawFeature {
  properties: { name: string };
  geometry: { type: "Point"; coordinates: [number, number] };
}

export async function loadJmaVolcanoCameras(): Promise<JmaVolcanoCamera[]> {
  const text = await fetchExt("jmaVolcam", GEOJSON_PATH);
  const data = JSON.parse(text) as { features: RawFeature[] };

  const cameras: JmaVolcanoCamera[] = [];
  for (const f of data.features) {
    const html = f.properties.name;
    const vcMatch = html.match(/VC=(\d+)/);
    const nameMatch = html.match(/>([^<]+)<\/a>/);
    if (!vcMatch || !nameMatch) continue;
    const [lng, lat] = f.geometry.coordinates;
    cameras.push({ vc: vcMatch[1], name: nameMatch[1], lat, lng });
  }
  return cameras;
}

export async function fetchLatestVolcamImage(vc: string): Promise<JmaVolcanoCameraImage | null> {
  const path = `/vois/data/obs/volcam/volcam.php?VC=${vc}`;
  const html = await fetchExt("jmaVolcam", path);

  const match = html.match(/file_array\[0\]\s*=\s*"([^"]+)"/);
  if (!match) return null;

  const relPath = match[1]; // 例: "../camera/104_82002710/20260829090601.jpg" (volcam.php からの相対パス)
  const absPath = "/vois/data/obs/" + relPath.replace(/^\.\.\//, "");
  const tsMatch = relPath.match(/(\d{14})\.jpg$/);

  return { imageUrl: JMA_ORIGIN + absPath, timestamp: tsMatch ? tsMatch[1] : "" };
}
