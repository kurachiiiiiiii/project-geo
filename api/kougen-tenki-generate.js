// Vercelサーバーレス関数: 「高原天気」気温・霧シミュレーターのライブ生成 (本番用)。
// 開発/vite previewでの同機能は vite.config.ts の kougenTenkiGeneratePlugin が担う。
// 実際の生成ロジックは server/kougenTenkiGenerate.mjs に共通化している。

import { generateKougenTenki } from "../server/kougenTenkiGenerate.mjs";

// DEM取得(初回は約240タイル)+グリッド計算に加え、Open-Meteo取得はレート制限を避けるために
// 意図的に間隔を空けており(server/kougenTenkiGenerate.mjs の OPEN_METEO_MIN_INTERVAL_MS)、
// 未キャッシュ時は合計で4分ほどかかることがある。Vercel HobbyプランはmaxDurationの上限が
// 60秒までのため、Hobbyプランではこのケースでタイムアウトする可能性がある(Pro以上なら
// 300秒まで指定可能)。ここでは動作するプランを前提に300秒まで延ばしている。
export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  try {
    const result = await generateKougenTenki();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: "failed to generate", detail: String(err) });
  }
}
