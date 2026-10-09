import { fetchExt } from "../../lib/extProxy";
import type { Jr9vqCamera } from "../../types";

/**
 * 立山(雄山)山頂 3,003m に設置されたライブカメラ(JR9VQ 雄山山頂レピーター局)。
 * http://www.jr9vq.org/
 *
 * 同じ地点から2方向(北側の立山室堂方面パノラマ / 南側の富士山〜南アルプス・御嶽山方面)を
 * 撮影している。最新画像のファイル名は日時入り(例 `/lcam/2026/08/20260829_100002.jpg`)で
 * 規則的に推測できないため、ページHTMLから都度 <img src> を読み取る。
 * ページはShift_JISなので、プロキシ側でUTF-8にデコードしている(`server/externalProxy.mjs`)。
 *
 * サイトの利用条件: リンクフリーだが、画像を掲載する場合は「JR9VQのライブカメラからのもの
 * であること」と「その日付」を表示することが求められているため、ポップアップで両方を表示する。
 */

const JR9VQ_ORIGIN = "http://www.jr9vq.org";

/** 雄山山頂(標高3,003m)。2台とも同一地点のため、地図上で重ならないよう僅かにずらして配置する。 */
export const JR9VQ_CAMERAS: Jr9vqCamera[] = [
  {
    id: "jr9vq-north",
    name: "立山 雄山山頂",
    direction: "北側(立山室堂方面パノラマ)",
    lat: 36.5745,
    lng: 137.6188,
    pagePath: "/lcam/lcam.html",
  },
  {
    id: "jr9vq-south",
    name: "立山 雄山山頂",
    direction: "南側(富士山〜南アルプス・御嶽山方面)",
    lat: 36.5741,
    lng: 137.62,
    pagePath: "/lcams/lcam.html",
  },
];

export interface Jr9vqImage {
  imageUrl: string;
  /** 撮影日時 "YYYYMMDD_HHmmss" (JST) */
  timestamp: string;
}

export async function fetchJr9vqImage(camera: Jr9vqCamera): Promise<Jr9vqImage | null> {
  const html = await fetchExt("jr9vq", camera.pagePath);
  const match = html.match(/<img\s+src="(\/lcams?\/[^"]+\.jpg)"/i);
  if (!match) return null;

  const path = match[1];
  const tsMatch = path.match(/(\d{8}_\d{6})\.jpg$/);
  return { imageUrl: JR9VQ_ORIGIN + path, timestamp: tsMatch ? tsMatch[1] : "" };
}

/** "20260829_100002" -> "2026/08/29 10:00" */
export function formatJr9vqTimestamp(ts: string): string {
  if (ts.length !== 15) return "";
  return `${ts.slice(0, 4)}/${ts.slice(4, 6)}/${ts.slice(6, 8)} ${ts.slice(9, 11)}:${ts.slice(11, 13)} JST`;
}
