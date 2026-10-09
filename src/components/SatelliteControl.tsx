import { SATELLITE_BANDS, formatSatelliteTime, parseValidTime } from "../features/satellite/satelliteService";
import type { SatelliteFrame } from "../features/satellite/satelliteService";
import type { RainFrame } from "../features/rain/rainService";
import type { PredictedSatelliteFrame } from "../lib/satelliteForecast";
import type { SatelliteBand } from "../types";
import RainLayerControl from "./RainLayerControl";

interface Props {
  /** 「衛星画像に表示非表示のチェックリストを追加してください」への対応で復活させた表示ON/OFF */
  visible: boolean;
  onVisibleChange: (v: boolean) => void;
  band: SatelliteBand;
  onBandChange: (b: SatelliteBand) => void;
  opacity: number;
  onOpacityChange: (v: number) => void;
  /** 直近3時間分(10分間隔)のコマ一覧。古い→新しい順、最後が最新 */
  frames: SatelliteFrame[];
  frameIndex: number;
  onFrameIndexChange: (i: number) => void;
  /** 「雲のある部分を5キロメッシュで判定して...」への対応。詳細はlib/cloudMesh.ts参照 */
  cloudMeshVisible: boolean;
  onCloudMeshVisibleChange: (v: boolean) => void;
  cloudMeshOpacity: number;
  onCloudMeshOpacityChange: (v: number) => void;
  cloudMeshLoading: boolean;
  cloudMeshError: string | null;
  /** 「過去1時間分の衛星画像をもとに3時間後までどのように動くか予想したい」への対応。
   * 「衛星画像予測は常にonにしてください」という指示により、常に計算・表示する(トグルなし)。 */
  forecastFrames: PredictedSatelliteFrame[];
  forecastLoading: boolean;
  forecastError: string | null;
  /** 「自分用では実装して 発表用では 廃止することはできますか」への対応。
   * `src/lib/platform.ts`の`isSatelliteForecastEnabled`参照。falseの間は
   * forecastFrames自体が常に空になる(App.tsx側で計算自体を止めている)ため、
   * スライダーの範囲やコマ送りは自然に予測を含まなくなるが、下の説明文だけは
   * 無条件に表示されてしまうため、それを隠すためだけに使う。 */
  forecastEnabled: boolean;
  loading: boolean;
  error: string | null;
  /** 「雨雲を表示するのところを 衛星画像のタブと統合してください」への対応。RainLayerControl.tsx参照 */
  rainVisible: boolean;
  onRainVisibleChange: (v: boolean) => void;
  rainFrames: RainFrame[];
  /**
   * 「雨雲と衛星は時刻を統合してください」への対応で、雨雲のコマは上の衛星画像のコマ位置
   * (このコンポーネントの外、App.tsx側)から自動算出した読み取り専用の値になった。
   * ユーザーが直接動かす手段が無いため、setterは持たない。
   */
  rainFrameIndex: number;
  rainOpacity: number;
  onRainOpacityChange: (v: number) => void;
  rainError: string | null;
}

/**
 * ひまわり衛星画像(赤外・可視など)の表示切り替え。
 *
 * 「衛星画像のタブなのですが 表示レイヤーからなくして 画面の下に常に表示されるように
 * してください チェックリストもメッシュにするかどうかのみで ai画像向上は廃止 衛星画像予測は
 * 常にonにしてください」という指示への対応。以前はここに「衛星画像(ひまわり)表示」
 * 「画質を上げる(AI超解像、日本周辺のみ/生成)」「雲の動きを予測」の3つのチェックボックスが
 * あったが、以下のように整理した。
 * - AI超解像(`satelliteAiUpscale.ts`/`satelliteEnhanceTileLayer.ts`/
 *   `SatelliteEnhanceTileLayerComponent.tsx`)は「廃止」の指示により、機能自体を削除した
 *   (該当ファイルも削除済み)。
 * - 「雲の動きを予測」チェックボックスは廃止し、常にON(常に予測コマを計算・表示する)。
 *
 * その後「衛星画像に表示非表示のチェックリストを追加してください」という指示により、
 * 衛星画像自体の表示ON/OFFチェックボックスを改めて追加した(常時表示バーであることは
 * 変わらないが、バーの中身を隠したいケースに対応)。OFFのときは衛星画像タイル・予測コマ・
 * 移流矢印(雲の動きの矢印)をまとめて非表示にする(App.tsx側でMapViewへ渡す値をnullにして
 * ゲートしている)。雲判定メッシュはこれとは独立した別のチェックボックスのまま。
 *
 * さらに「雨雲を表示するのところを 衛星画像のタブと統合してください」という指示により、
 * 表示レイヤー一覧で独立していた「雨雲表示」(`RainLayerControl.tsx`)もこのパネルに
 * 埋め込んだ(実体はRainLayerControl.tsx、出典表記だけこのパネル末尾の共通のものを流用する)。
 * 続けて「雨雲と衛星は時刻を統合してください」という指示により、雨雲専用の時刻スライダー・
 * 再生ボタンは廃止し、上の衛星画像の時刻スライダーがそのままマスター時刻を兼ねるようにした
 * (雨雲は衛星画像より細かい5分刻みのため、逆に雨雲側に合わせると衛星画像側が歯抜けになる)。
 * 雨雲側に残るのは表示チェックボックス・不透明度・現在マッチしているコマ時刻の表示のみ
 * (算出はApp.tsx側、詳細はrainFrameIndexのコメント参照)。
 */
export default function SatelliteControl({
  visible,
  onVisibleChange,
  band,
  onBandChange,
  opacity,
  onOpacityChange,
  frames,
  frameIndex,
  onFrameIndexChange,
  cloudMeshVisible,
  onCloudMeshVisibleChange,
  cloudMeshOpacity,
  onCloudMeshOpacityChange,
  cloudMeshLoading,
  cloudMeshError,
  forecastFrames,
  forecastLoading,
  forecastError,
  forecastEnabled,
  loading,
  error,
  rainVisible,
  onRainVisibleChange,
  rainFrames,
  rainFrameIndex,
  rainOpacity,
  onRainOpacityChange,
  rainError,
}: Props) {
  // frameIndexは「実測コマ(0..frames.length-1)」の続きとして予測コマまで連続的に扱う
  // (App.tsxのisSatelliteForecastIndexと同じ考え方)。予測は常にONなので、常にforecastFrames
  // ぶんをスライダーの範囲に含める。
  const isForecastIndex = frameIndex >= frames.length;
  const currentFrame = isForecastIndex ? undefined : frames[frameIndex];
  const currentForecastFrame = isForecastIndex ? forecastFrames[frameIndex - frames.length] : undefined;
  // 「衛星画像の時間も表示し...」への対応。スライダーの範囲ラベルを固定文言(旧「← 2時間前」)
  // ではなく、実際に取得できているコマの範囲(最古〜最新の差)から動的に計算する
  // (FRAME_COUNT/FRAME_STEP_HOURSが変わっても表示が古いままにならないようにするため)。
  const oldestFrame = frames[0];
  const newestFrame = frames[frames.length - 1];
  const spanHours =
    oldestFrame && newestFrame
      ? Math.round(
          ((parseValidTime(newestFrame.validtime).getTime() - parseValidTime(oldestFrame.validtime).getTime()) /
            3_600_000) *
            10,
        ) / 10
      : 0;

  return (
    <div className="layer-control">
      <label className="layer-control__checkbox">
        <input type="checkbox" checked={visible} onChange={(e) => onVisibleChange(e.target.checked)} />
        衛星画像(ひまわり)表示
      </label>

      <select
        className="layer-control__select"
        value={band}
        onChange={(e) => onBandChange(e.target.value as SatelliteBand)}
      >
        {SATELLITE_BANDS.map((b) => (
          <option key={b.key} value={b.key}>
            {b.label}
          </option>
        ))}
      </select>

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

      {frames.length > 1 && (
        <>
          <div className="rain-control__row">
            <span className="rain-control__label">時刻</span>
            <input
              className="rain-control__slider"
              type="range"
              min={0}
              max={Math.max(0, frames.length - 1 + forecastFrames.length)}
              step={1}
              value={frameIndex}
              onChange={(e) => onFrameIndexChange(Number(e.target.value))}
            />
          </div>
          <div className="slider-range-label">
            <span>← {spanHours}時間前</span>
            <span>
              {currentFrame
                ? formatSatelliteTime(currentFrame.validtime)
                : currentForecastFrame && newestFrame
                  ? `${formatSatelliteTime(newestFrame.validtime)}の${currentForecastFrame.hoursAhead}時間後(予測)`
                  : "現在"}
            </span>
          </div>
        </>
      )}

      {/*
        「衛星画像予測は常にonにしてください」への対応。以前はチェックボックスで
        ON/OFFできたが、常時計算・表示するようにしたためチェックボックス自体を廃止した。
        「自分用では実装して 発表用では 廃止することはできますか」への対応で、
        forecastEnabledがfalseの間(=公開用ビルドの既定状態)はこの説明文自体を
        表示しない(forecastFrames/Loading/Errorも計算していないので常に無内容になる)。
      */}
      {forecastEnabled && (
        <div className="layer-control__status">
          100kmメッシュごとの高層風(350hPa・500hPaの平均)の向きに雲がそのまま流されると仮定した簡易的な予測です(発達・衰弱・雲の高さによる違いは考慮していません)
        </div>
      )}
      {forecastLoading && <div className="layer-control__status">予測コマを計算中...</div>}
      {forecastError && <div className="layer-control__error">予測コマの計算に失敗しました: {forecastError}</div>}

      {/*
        「雨雲を表示するのところを 衛星画像のタブと統合してください」への対応。以前は
        表示レイヤー一覧の独立した「雨雲表示」グループだったが、こちらに埋め込んだ
        (中身はRainLayerControl.tsx、出典は末尾の共通表記〈気象庁ホームページ〉を流用)。
        「雨雲と衛星は時刻を統合してください」への対応で、雨雲専用の時刻スライダーは廃止し、
        上の衛星画像の時刻スライダーがそのままマスター時刻を兼ねる(frameIndexは表示用の
        読み取り専用値)。
      */}
      <RainLayerControl
        frames={rainFrames}
        frameIndex={rainFrameIndex}
        opacity={rainOpacity}
        onOpacityChange={onRainOpacityChange}
        visible={rainVisible}
        onVisibleChange={onRainVisibleChange}
        error={rainError}
      />

      {/*
        「衛星画像で雲のある部分を5キロメッシュで判定して、ある部分を白くして、
        半分くらいのところはグレー、ないところは透明にしてください」への対応。
        赤外線バンドの生データから直接作るため、常時表示している衛星画像本体とは独立して
        使える(詳細はlib/cloudMesh.tsのコメント参照)。「チェックリストもメッシュにするか
        どうかのみで」という指示により、このパネルに残る唯一のチェックボックス。
      */}
      <label className="layer-control__checkbox">
        <input type="checkbox" checked={cloudMeshVisible} onChange={(e) => onCloudMeshVisibleChange(e.target.checked)} />
        雲判定メッシュ(5km・白=雲あり/グレー=半分くらい)
      </label>
      {cloudMeshVisible && (
        <div className="rain-control__row">
          <span className="rain-control__label">不透明度</span>
          <input
            type="range"
            min={0.1}
            max={1}
            step={0.1}
            value={cloudMeshOpacity}
            onChange={(e) => onCloudMeshOpacityChange(Number(e.target.value))}
          />
        </div>
      )}
      {cloudMeshLoading && <div className="layer-control__status">雲判定メッシュを計算中...</div>}
      {cloudMeshError && <div className="layer-control__error">雲判定メッシュの計算に失敗しました: {cloudMeshError}</div>}

      {band === "visible" && <div className="layer-control__status">※可視画像は夜間は暗くなります</div>}

      {loading && <div className="layer-control__status">読み込み中...</div>}
      {!loading && !error && currentFrame && (
        <div className="layer-control__status">{formatSatelliteTime(currentFrame.validtime)}</div>
      )}
      {error && <div className="layer-control__error">{error}</div>}

      {/*
        「法律 利用規約に反するものはありますか」への回答を受けた対応。気象庁は加工した
        画像を使う場合、出典に加えて加工した旨の明記を求めている(このパネルの「予測」は
        気象庁のひまわり画像を移流処理して作っているため該当する)。動きベクトルの計算に
        使っている高層風データはOpen-Meteo(CC BY 4.0、出典表記必須)。
      */}
      {/*
        スマホ版では衛星画像の予測(高層風にOpen-Meteoを使う)を廃止したので、出典は衛星画像のみ。
      */}
      <div className="layer-control__source">
        出典:{" "}
        <a href="https://www.jma.go.jp/jma/index.html" target="_blank" rel="noreferrer">
          気象庁ホームページ
        </a>
      </div>
    </div>
  );
}
