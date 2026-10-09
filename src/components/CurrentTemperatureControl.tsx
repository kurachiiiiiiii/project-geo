import { fogRiskLabel } from "../lib/kougenTenkiGrid";
import type { KougenTenkiGrid, KougenTenkiValue } from "../types";
import { Thermometer } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  visible: boolean;
  onVisibleChange: (v: boolean) => void;
  grid: KougenTenkiGrid | null;
  opacity: number;
  onOpacityChange: (v: number) => void;
  fogOpacity: number;
  onFogOpacityChange: (v: number) => void;
  showStations: boolean;
  onShowStationsChange: (v: boolean) => void;
  hover: (KougenTenkiValue & { lat: number; lon: number }) | null;
  onGenerate: () => void;
  generating: boolean;
  error: string | null;
}

function formatTimeKey(timeKey: string): string {
  const m = timeKey.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]}/${m[2]} ${m[3]}` : timeKey;
}

/**
 * 「高層天気とは別に 現在の気温の推定値のみを表示するボタン」。
 *
 * 高原天気(KougenTenkiControl.tsx)と同じDEM地形補正+標高別逓減率+IDW補間のロジックで、
 * 「現在」1コマぶんの気温だけを都度計算して表示する。過去/未来の時刻スライダー・霧不透明度・
 * 生成履歴(IndexedDB)・10時間に1回のクールダウン制限は無い(1コマだけなので生成が軽く、
 * 都度ボタンを押して最新化する運用で十分なため)。
 */
export default function CurrentTemperatureControl({
  visible,
  onVisibleChange,
  grid,
  opacity,
  onOpacityChange,
  fogOpacity,
  onFogOpacityChange,
  showStations,
  onShowStationsChange,
  hover,
  onGenerate,
  generating,
  error,
}: Props) {
  return (
    <div className="layer-control">
      <label className="layer-control__checkbox">
        <input type="checkbox" checked={visible} onChange={(e) => onVisibleChange(e.target.checked)} />
        現在の気温(推定)
      </label>

      {visible && (
        <>
          <button
            type="button"
            className="rain-control__play kougen-tenki__generate"
            onClick={onGenerate}
            disabled={generating}
          >
            {generating ? "計算中…" : (<><Ico icon={Thermometer} /> 現在の気温を計算</>)}
          </button>

          <div className="layer-control__status">
            高原天気と同じDEM地形補正+標高別逓減率+IDW補間のロジックで、「現在」時点の気温・湿度・
            霧リスクを計算します。対象範囲は中部・関東・東北・北海道(概ね東海地方より東側)です。
            観測点はアメダス(+犬山自動気象観測所)です。観測から推定した実況の値で、予測ではありません。
          </div>

          <div className="layer-control__source">
            出典:{" "}
            <a href="https://www.jma.go.jp/jma/index.html" target="_blank" rel="noreferrer">
              気象庁アメダス
            </a>
            、
            <a href="https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html" target="_blank" rel="noreferrer">
              国土地理院
            </a>
            の標高タイル(基盤地図情報数値標高モデル)を加工して作成
          </div>

          {grid && (
            <>
              <div className="layer-control__status">{formatTimeKey(grid.generatedAt)} 時点</div>
              {/* 800hPa/700hPa高層データ(Open-Meteo)の取得状況の表示は、取得自体を廃止したので出さない */}

              <div className="rain-control__row">
                <span className="rain-control__label">気温不透明度</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={opacity}
                  onChange={(e) => onOpacityChange(Number(e.target.value))}
                />
              </div>
              <div className="rain-control__row">
                <span className="rain-control__label">霧不透明度</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={fogOpacity}
                  onChange={(e) => onFogOpacityChange(Number(e.target.value))}
                />
              </div>

              <label className="layer-control__checkbox">
                <input
                  type="checkbox"
                  checked={showStations}
                  onChange={(e) => onShowStationsChange(e.target.checked)}
                />
                観測地点を表示({grid.stations.length}件)
              </label>

              {hover && (
                <div className="layer-control__status kougen-tenki__hover">
                  標高 {hover.altM}m ／ 気温 {hover.tempC.toFixed(1)}℃ ／ 湿度 {hover.humidityPct}% ／{" "}
                  {fogRiskLabel(hover.fog)}
                </div>
              )}
            </>
          )}

          {!grid && !generating && (
            <div className="layer-control__status">まだ計算していません。ボタンを押してください。</div>
          )}
        </>
      )}

      {error && <div className="layer-control__error">{error}</div>}
    </div>
  );
}
