import { parseJsonResponse } from "../../lib/safeJson";
import type { KokudoCamera } from "../../types";

/**
 * 国交省 中部地方整備局 岐阜国道事務所・多治見砂防国道事務所の道路状況ライブカメラ。
 * 詳細は `types/index.ts` の `KokudoCamera` のコメントを参照。
 */
export async function loadKokudoCameras(): Promise<KokudoCamera[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}kokudoCameras.json`);
  if (!res.ok) {
    throw new Error(`国道事務所カメラ一覧の読み込みに失敗しました (HTTP ${res.status})`);
  }
  const data = await parseJsonResponse<unknown>(res, "国道事務所カメラ一覧");
  if (!Array.isArray(data)) {
    throw new Error("kokudoCameras.json はカメラ一覧の配列である必要があります");
  }
  return data as KokudoCamera[];
}
