import type { RainFrame } from "../features/rain/rainService";
import { formatValidTime, isForecastFrame } from "../features/rain/rainService";

interface Props {
  frames: RainFrame[];
  /**
   * 「雨雲と衛星は時刻を統合してください」への対応で、このインデックスは呼び出し元
   * (App.tsx)が衛星画像側のコマ位置(マスター時刻)から自動算出した読み取り専用の値。
   * 以前あった再生ボタン・時刻スライダーは廃止し、ここでは選択中のコマの時刻表示のみ行う。
   */
  frameIndex: number;
  opacity: number;
  onOpacityChange: (v: number) => void;
  visible: boolean;
  onVisibleChange: (v: boolean) => void;
  error: string | null;
}

/**
 * 「雨雲を表示するのところを 衛星画像のタブと統合してください」への対応。以前は
 * 表示レイヤー一覧の独立した「雨雲表示」グループだったが、`SatelliteControl`
 * (画面下に常時表示する衛星画像パネル)の中に埋め込む形に変更した。そのため、
 * 独自の背景枠(`.rain-control`)と出典表記は持たず(埋め込み先の`.layer-control`の
 * 背景と、末尾の共通の出典表記〈同じ気象庁ホームページへのリンク〉をそのまま使う)、
 * 中身(チェックボックス・不透明度・現在時刻表示)だけをFragmentで返す。
 *
 * 続けて「雨雲と衛星は時刻を統合してください」という指示により、雨雲専用の
 * 時刻スライダー・再生ボタン(旧`rain-control__slider`/`rain-control__play`)は廃止した。
 * 雨雲(5分刻み)と衛星画像(30分刻み)は元々コマの刻みが違い、別々に動かせると
 * 「雨雲だけ3時間前、衛星画像は今」のようにずれてしまっていたため、衛星画像側の
 * 時刻スライダーに一本化し、雨雲はそれに一番近いコマを自動で追従する(App.tsx参照)。
 */
export default function RainLayerControl({
  frames,
  frameIndex,
  opacity,
  onOpacityChange,
  visible,
  onVisibleChange,
  error,
}: Props) {
  const currentFrame = frames[frameIndex];

  return (
    <>
      <label className="layer-control__checkbox">
        <input
          type="checkbox"
          checked={visible}
          onChange={(e) => onVisibleChange(e.target.checked)}
        />
        雨雲を表示
      </label>
      {error && <div className="layer-control__error">{error}</div>}
      {visible && frames.length > 0 && (
        <>
          <div className="rain-control__row">
            <span className="rain-control__label">不透明度</span>
            <input
              type="range"
              min={0.1}
              max={1}
              step={0.1}
              value={opacity}
              onChange={(e) => onOpacityChange(Number(e.target.value))}
            />
          </div>
          {currentFrame && (
            <div className="rain-control__time">
              {formatValidTime(currentFrame.validtime)}
              {isForecastFrame(currentFrame) ? " (予測)" : " (実況)"}
            </div>
          )}
        </>
      )}
    </>
  );
}
