// Vercelサーバーレス関数: 「現在の気温」推定値のライブ生成 (本番用)。
// 開発/vite previewでの同機能は vite.config.ts の currentTemperatureGeneratePlugin が担う。
// 実際の生成ロジックは server/kougenTenkiGenerate.mjs の generateCurrentTemperature に共通化している。
//
// 「高原天気」(kougen-tenki-generate.js)と違い、Open-Meteo予報を使わない(現在1コマのみの
// ため不要)ので、単一区域だけならDEM取得(未キャッシュ時)を含めても数十秒程度で終わる想定
// だったが、「現在気温の推定の際は エリアを 陸上の本土5島まで 範囲を拡大してください」
// (実装は「東海地方より東」= 中部+関東+東北+北海道、DEMズーム9)への対応で対象範囲・
// 観測点数が大きく増え、IDW補間の計算量(セル数×観測点数)がその分重くなった。
// 高原天気(kougen-tenki-generate.js)と同じく300秒まで確保しておく(動作するプランを前提。
// Vercel HobbyプランはmaxDurationの上限が60秒までのためタイムアウトする可能性がある)。

import { generateCurrentTemperature } from "../server/kougenTenkiGenerate.mjs";

export const config = { maxDuration: 300 };

export default async function handler(req, res) {
  try {
    const result = await generateCurrentTemperature();
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.status(200).json(result);
  } catch (err) {
    res.status(502).json({ error: "failed to generate", detail: String(err) });
  }
}
