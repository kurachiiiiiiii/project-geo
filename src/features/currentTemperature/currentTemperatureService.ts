import { isNativeApp } from "../../lib/platform";
import { parseJsonResponse } from "../../lib/safeJson";
import type { KougenTenkiGrid } from "../../types";

/**
 * 「高層天気とは別に 現在の気温の推定値のみを表示するボタン」への対応。
 *
 * 「高原天気」(kougenTenkiService.ts)と同じDEM地形補正+標高別逓減率+IDW補間のロジック
 * (`server/kougenTenkiGenerate.mjs`の`generateCurrentTemperature`)を使うが、過去12時間・
 * 未来12時間の複数コマやOpen-Meteo予報を使わず「現在」1コマだけを返すため、生成は数十秒程度で
 * 済む(高原天気のような「10時間に1回まで」のクールダウン制限は設けていない)。
 * レスポンスは`KougenTenkiGrid`型と同じ形(`hours`が要素数1の配列)なので、
 * `src/lib/kougenTenkiGrid.ts`の各関数(気温分布の描画・地点の値のホバー参照など)を
 * そのまま再利用できる。
 *
 * 「現在の気温は表示できるようにしてください」という指示により、高原天気とは異なり
 * Androidネイティブアプリでもこの機能自体は表示する(App.tsx側の分岐参照。高原天気の方は
 * 元アルゴリズムの出典・ライセンスが不明瞭という理由で引き続き非表示のまま)。
 * ネイティブでは`/api/current-temperature-generate`(サーバー)を使わず、同じ計算ロジックを
 * 端末内で実行する`kougenTenkiNativeGenerate.ts`の`generateCurrentTemperature`を動的importで
 * 読み込む(`kougenTenkiService.ts`の`generateKougenTenki`と同じパターン)。
 */
export async function generateCurrentTemperature(): Promise<KougenTenkiGrid> {
  if (isNativeApp()) {
    const { generateCurrentTemperature: generateNative } = await import(
      "../kougenTenki/kougenTenkiNativeGenerate"
    );
    return generateNative() as Promise<KougenTenkiGrid>;
  }

  const res = await fetch("/api/current-temperature-generate");
  if (!res.ok) {
    throw new Error(`現在の気温の生成に失敗しました (HTTP ${res.status})`);
  }
  return parseJsonResponse<KougenTenkiGrid>(res, "現在の気温");
}
