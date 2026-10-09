import type { MouseEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "../lib/lucide";
import { Ico } from "./Ico";
import { useBackLayer } from "../lib/backStack";

interface Props {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /**
   * 暗いオーバーレイ(タップで閉じる)を表示するかどうか。既定はtrue。
   * 天文情報では、シートを開いたまま地図を操作できるようにするためfalseにしている
   * (下記コメント参照)。
   */
  showBackdrop?: boolean;
  /** 背の高いシート(画面の約85%まで)にする。読み物(出典・ライセンス)用 */
  tall?: boolean;
}

/**
 * スマホ版で「表示レイヤー」「天文情報」を画面下からせり上がる形で表示するための共通の入れ物。
 *
 * 「表示レイヤーはタップしたときに下に出てくるようにしてください また 天文情報も下から
 * スクロールしてでてくるようにして 両方とも少しちいさくしてください」という指示への対応。
 *
 * 【閉じるボタンを必ずヘッダーに固定する理由】以前(AstroPointPopup.tsxのコメント参照)、
 * 画面端に固定表示していたパネルで「中をスクロールすると閉じるボタンが画面外へ流れて
 * 閉じられなくなる」不具合があった。同じ問題を再発させないため、タイトル+閉じるボタンの
 * ヘッダー部分と、スクロールする本文部分を別要素に分け、ヘッダーは常に画面下端に固定されて
 * 動かないようにしている(本文だけがoverflow-y: autoでスクロールする)。
 *
 * 既定では背景の暗いオーバーレイをタップしても閉じられるようにしている(一般的なボトムシート
 * の挙動)。`showBackdrop={false}`のときはオーバーレイ自体を出さない(下記の「地図が動かせ
 * なくなる」不具合の修正コメント参照)。
 *
 * 【既知の不具合と修正: 天文情報のシートが閉じられない・下の方角がスクロールできない】
 * 「天文情報をタップするとずっと閉じれない状態になってしまいます また 下の 太陽と月の方角も
 * スクロールできないので みれません」という報告を受けて調査したところ、原因は天文情報での
 * 使われ方(`AstroPointPopup.tsx`)にあった。react-leafletの`<MapContainer>`は子要素を
 * 地図本体(`.leaflet-container`)のDOMの中にそのまま描画するため、このコンポーネントも
 * `.leaflet-container`の中に入れ子で存在することになる。Leafletは地図のドラッグ操作を
 * 検出するため`.leaflet-container`内のタッチ/クリックを自前で監視しており、中に置いた
 * 普通のスクロール可能な要素へのタッチを「地図をドラッグしようとしている」と誤認識して
 * 奪ってしまう(スクロールできない)うえ、タップの後に少しでも指が動くと「ドラッグの後の
 * クリックだから無視する」というLeaflet自身の抑制機構が働き、閉じるボタンのクリックが
 * 揉み消されてしまっていた(閉じられない)。表示レイヤー側のシート(`App.tsx`)は地図の外
 * (`<MapView>`の兄弟要素)に置いていたため、この問題が起きていなかった。
 *
 * 対策として、`createPortal`でこのコンポーネントの中身を`document.body`直下に描画する
 * ようにした。DOM上ではLeafletの地図の外に出るため、地図側のタッチ/クリック監視の対象に
 * ならなくなり、普通のオーバーレイとして正しく動作する(表示レイヤー側は元々問題が
 * 無かったが、こちらも同じ実装に揃えることで今後の同種の不具合を予防する)。
 *
 * `stopPropagation()`は、地図の外に出た後も念のための保険として残している
 * (万一何か他の祖先要素にクリックハンドラがあった場合の安全策。実害は無い)。
 *
 * 【既知の不具合と修正: 天文情報を開くと地図が動かせなくなる】
 * 「スマホ版の天文情報をタップしたときに 移動できない問題を解決してください」という報告
 * への対応。上記のPortal化で地図の外には出たものの、`bottom-sheet__backdrop`
 * (`position:fixed; inset:0`)は画面全体を覆ったまま残っていたため、シートが出ている間は
 * 実際に見えているシート部分(画面下半分)だけでなく、その上に見えている地図部分まで
 * タップ・ドラッグを吸い取ってしまい、地図を操作できなくなっていた。表示レイヤー(操作の
 * 邪魔にならないよう閉じてから地図を触ることを想定)と違い、天文情報は「地点を選んだら
 * 地図を動かしながら別の地点も見比べたい」という使い方が自然なため、`showBackdrop={false}`
 * を渡してオーバーレイ自体を出さない(=シートの下に見えている地図はそのまま操作できる)
 * ようにしている。
 */
export default function BottomSheet({ title, onClose, children, showBackdrop = true, tall = false }: Props) {
  const stop = (e: MouseEvent) => e.stopPropagation();
  // 戻るボタン(Android)・ブラウザの戻るで、このシートを閉じる(アプリごと閉じない)
  useBackLayer(true, onClose);
  return createPortal(
    <>
      {showBackdrop && (
        <div
          className="bottom-sheet__backdrop"
          onClick={(e) => {
            stop(e);
            onClose();
          }}
        />
      )}
      <div
        className={tall ? "bottom-sheet bottom-sheet--tall" : "bottom-sheet"}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={stop}
      >
        <div className="bottom-sheet__header">
          <span className="bottom-sheet__title">{title}</span>
          <button type="button" className="bottom-sheet__close" onClick={onClose} aria-label="閉じる">
            <Ico icon={X} size="1.3em" />
          </button>
        </div>
        <div className="bottom-sheet__body">{children}</div>
      </div>
    </>,
    document.body,
  );
}
