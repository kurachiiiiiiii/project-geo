// Vercelサーバーレス関数: 複数の外部サイトへの汎用CORSプロキシ (本番用)。
// 開発/vite previewでの同機能は vite.config.ts の externalProxyPlugin が担う。
// 実際の中継ロジックは server/externalProxy.mjs に共通化している。

import { fetchExternal } from "../../server/externalProxy.mjs";

export default async function handler(req, res) {
  const { source, path } = req.query;

  if (typeof source !== "string" || typeof path !== "string") {
    res.status(400).json({ error: "missing source or path" });
    return;
  }

  try {
    const { status, body } = await fetchExternal(source, path);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
    res.status(status).send(body);
  } catch (err) {
    res.status(404).json({ error: "failed to reach upstream", detail: String(err) });
  }
}
