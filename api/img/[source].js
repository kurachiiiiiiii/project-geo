// カメラ画像の中継は廃止しました(2026年10月、スマホ版)。このファイルは削除してかまいません。
export default function handler(_req, res) {
  res.status(410).json({ error: "image proxy removed" });
}
