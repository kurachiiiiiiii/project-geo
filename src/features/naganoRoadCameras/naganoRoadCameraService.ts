import { parseJsonResponse } from "../../lib/safeJson";
import type { NaganoOfficeLink } from "../../types";

/**
 * 長野県 建設事務所のライブカメラ一覧ページへのリンク(道路情報広場Nagano経由)。
 * https://www.pref.nagano.lg.jp/michikanri/infra/doro/joho/hiroba/index.html#camera
 *
 * 建設事務所ごとに配信システムが異なる(複数の legacy な個別サイトの寄せ集め)が、
 * 座標を特定できたのは一部の建設事務所のみで、そのカメラは実座標つきで画像を直接
 * 埋め込んでいた(`NaganoRoadCameraLayer`)。しかし長野県公式ホームページの著作権ページ
 * (https://www.pref.nagano.lg.jp/koho/kensei/koho/homepage/riyo.html)に「私的使用のための
 * 複製」や「引用」など著作権法上認められた場合を除き、無断で複製・転用することはできません、
 * との明記があり、ライブカメラ画像の直接埋め込みはこれに抵触すると判断したため、
 * 「確認して 規約違反の機能やライブカメラは削除してください」への対応でこの部分は削除した。
 *
 * 残るのは、座標を特定できなかった建設事務所(佐久・上田・諏訪・飯田・木曽・大町・長野・須坂)
 * 向けの簡易表示のみ: 緯度経度を持たない古い画像地図ベースのシステム(avis.ne.jp)か、
 * 座標が未設定の同システムのため、個々のカメラ位置は特定できなかった。そのため事務所所在地に
 * 代表マーカーを1つ置き、その事務所のカメラ一覧ページへのリンクを表示する
 * (`public/naganoOfficeLinks.json`)。画像を埋め込まない単なるハイパーリンクは、各サイトの
 * 「リンクについて」で原則自由とされているため、著作権上の問題はない。
 */
export async function loadNaganoOfficeLinks(): Promise<NaganoOfficeLink[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}naganoOfficeLinks.json`);
  if (!res.ok) {
    throw new Error(`長野県建設事務所リンク一覧の読み込みに失敗しました (HTTP ${res.status})`);
  }
  const data = await parseJsonResponse<unknown>(res, "長野県建設事務所リンク一覧");
  if (!Array.isArray(data)) {
    throw new Error("naganoOfficeLinks.json はリンク一覧の配列である必要があります");
  }
  return data as NaganoOfficeLink[];
}
