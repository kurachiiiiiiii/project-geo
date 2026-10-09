import { useState, type ReactNode } from "react";
import BottomSheet from "./BottomSheet";

/**
 * 「出典・ライセンス」画面。「法令適合と著作権などの抵触の確認」への対応(README「法令適合・著作権の確認
 * (2026年10月)」参照)。
 *
 * - データの出典: 各配信元の利用規約が求める書き方(出典+加工した旨)で、アプリ全体の出典をまとめて示す。
 *   地図の右下・各ポップアップにも個別の出典を出しているが、3Dや計算の元データ(植生図・豪雪地帯・
 *   天の川の形など)は画面のどこにも出ていなかったため、ここで必ず見られるようにした。
 * - オープンソースのライセンス: MIT・BSD・ISC・Hippocratic・Apache等は「著作権表示と許諾文を複製に含める」
 *   ことが条件。圧縮後のJSからはコメントが消えるため、ビルド時に作る `third-party-licenses.txt`
 *   (vite.config.ts の thirdPartyLicensesPlugin)を読み込んで全文を表示する。
 */

interface Props {
  onClose: () => void;
}

function Ext({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

export default function CreditsSheet({ onClose }: Props) {
  const [licenses, setLicenses] = useState<{ state: "idle" | "loading" | "ok" | "error"; text: string }>({
    state: "idle",
    text: "",
  });

  const loadLicenses = () => {
    setLicenses({ state: "loading", text: "" });
    fetch(`${import.meta.env.BASE_URL}third-party-licenses.txt`)
      .then(async (res) => {
        const text = await res.text();
        // 開発サーバー(npm run dev)ではビルドしないと作られず、代わりにindex.htmlが返ってくる
        if (!res.ok || /^\s*<!doctype html/i.test(text)) throw new Error(`HTTP ${res.status}`);
        setLicenses({ state: "ok", text });
      })
      .catch(() =>
        setLicenses({
          state: "error",
          text: "ライセンスの一覧を読み込めませんでした(ビルドしたアプリでのみ表示できます。通信が切れている場合は、つながってから開き直してください)。",
        }),
      );
  };

  return (
    <BottomSheet title="出典・ライセンス" onClose={onClose} tall>
      <div className="credits">
        <section>
          <h3>このアプリの表示について</h3>
          <p>
            気温・霧・雲・紅葉・新緑・雪・夜空の明るさなどは、下の公開データをもとにこのアプリが計算した目安で、
            気象の予報ではありません。天気の予報・警報は気象庁の発表を確認してください
            (雨雲の予報は、気象庁の降水ナウキャストをそのまま表示しています)。
          </p>
          <p>紅葉マップ・3Dの新緑・紅葉・雪は、気温と植生から描いたイメージです(積雪などの予報ではありません)。</p>
        </section>

        <section>
          <h3>データの出典</h3>
          <ul>
            <li>
              <b>気象庁</b>: 出典 <Ext href="https://www.jma.go.jp/">気象庁ホームページ</Ext>
              (降水ナウキャスト・気象衛星ひまわり・アメダス・火山監視カメラ・平年値・確率予測資料)。
              雲判定メッシュ・3Dの雲・現在の気温・高原天気・紅葉マップは、これらをもとにこのアプリが加工して作成したものです。
            </li>
            <li>
              <b>国土地理院</b>: <Ext href="https://maps.gsi.go.jp/development/ichiran.html">地理院タイル</Ext>
              (淡色地図・標準地図・全国最新写真・標高タイル・最適化ベクトルタイル・人口集中地区(令和2年))。
              全国最新写真の一部には Landsat-8(NASA/USGS)・GRUS画像(© Axelspace)を含みます。
              3Dの地形・建物・川・地名・夜空の明るさ、紅葉マップ・気温の地形補正は、地理院タイルを加工して作成しています。
              地名・住所の検索は国土地理院の地名検索・逆ジオコーダを利用しています。県境は{" "}
              <Ext href="https://www.gsi.go.jp/kankyochiri/gm_jpn.html">地球地図日本</Ext>(国土地理院)。
            </li>
            <li>
              <b>環境省</b>:{" "}
              <Ext href="https://www.biodic.go.jp/kiso/vg/vg_kiso.html">1/25,000植生図GISデータ(環境省生物多様性センター)</Ext>
              を使用し、このアプリの作成者が作成・加工したもの(紅葉マップの樹種・3Dの木)。
            </li>
            <li>
              <b>国土交通省</b>: 「<Ext href="https://nlftp.mlit.go.jp/ksj/">国土数値情報(豪雪地帯データ)</Ext>
              」(国土交通省)をもとにこのアプリの作成者が作成(雪解けの時期)。各地方整備局・国道事務所のライブカメラ。
            </li>
            <li>
              <b>そのほかの観測・カメラ</b>: <Ext href="https://www.ma.ccnw.ne.jp/jan/">犬山自動気象観測所</Ext>(気温)、
              立山雄山のライブカメラ(JR9VQ)など。ライブカメラの画像・映像の著作権は各配信元にあり、
              このアプリは配信元から直接読み込んで表示するだけで、保存・再配布はしていません(配信元は各ポップアップに表示)。
              カメラの画像をこのアプリが直接表示するのは、国の機関と、出典の表示を条件に認めている配信元(JR9VQ)だけです。
              それ以外は、配信元ページへのリンクか、YouTubeなどの埋め込みプレーヤーで表示しています。
            </li>
            <li>
              <b>天の川の形</b>: Milky Way Outline Catalog(Jose R. Vieira)を、
              <Ext href="https://github.com/ofrohn/d3-celestial">d3-celestial</Ext>(© 2015 Olaf Frohn、BSD 3-Clause License)の
              data/mw.json 経由で使い、明るさの地図に加工したもの。星座は主な明るい星の位置(赤経・赤緯)から描いています。
            </li>
            <li>
              <b>百名山</b>: 深田久弥『日本百名山』に選ばれた山の名前と、おおよその位置・標高。
            </li>
          </ul>
        </section>

        <section>
          <h3>オープンソースソフトウェア</h3>
          <p>
            React・Leaflet・react-leaflet・Leaflet.markercluster・astronomy-engine・Capacitor・Workbox・Lucide(アイコン)などを使っています。
            それぞれの著作権表示とライセンスの全文は、下のボタンから見られます。
          </p>
          {licenses.state === "idle" && (
            <button type="button" className="credits__button" onClick={loadLicenses}>
              ライセンスの全文を表示
            </button>
          )}
          {licenses.state === "loading" && <p>読み込み中…</p>}
          {licenses.state === "error" && <p className="credits__error">{licenses.text}</p>}
          {licenses.state === "ok" && <pre className="credits__licenses">{licenses.text}</pre>}
        </section>
      </div>
    </BottomSheet>
  );
}
