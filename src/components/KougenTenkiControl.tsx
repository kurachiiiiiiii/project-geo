import { fogRiskLabel } from "../lib/kougenTenkiGrid";
import type { KougenTenkiHistoryEntry } from "../features/kougenTenki/kougenTenkiService";
import type { KougenTenkiGrid, KougenTenkiValue } from "../types";
import { CircleCheck, FolderOpen, Hourglass, MapPin, Thermometer, TriangleAlert } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  visible: boolean;
  onVisibleChange: (v: boolean) => void;
  grid: KougenTenkiGrid | null;
  hourIndex: number;
  onHourIndexChange: (i: number) => void;
  tempOpacity: number;
  onTempOpacityChange: (v: number) => void;
  fogOpacity: number;
  onFogOpacityChange: (v: number) => void;
  showStations: boolean;
  onShowStationsChange: (v: boolean) => void;
  hover: (KougenTenkiValue & { lat: number; lon: number }) | null;
  onGenerate: () => void;
  generating: boolean;
  error: string | null;
  /** 保存済みの生成履歴(新しい順、直近5世代まで。IndexedDB) */
  history: KougenTenkiHistoryEntry[];
  /** 履歴の選択中の世代(generatedAtの値、または未選択なら"") */
  selectedHistory: string;
  onSelectedHistoryChange: (generatedAt: string) => void;
  /** 「過去に生成したデータを読み込む」ボタン */
  onLoadHistory: () => void;
  historyLoading: boolean;
  /** 次に実際のライブ生成ができるまでの残り時間(ms)。0なら生成可能(10時間に1回までの制限) */
  cooldownRemainingMs: number;
  /**
   * 現在地(「現在地を取得」ボタンで取得済みの場合)の、生成済みグリッド全コマぶんの
   * 気温・霧リスク。コマごとにnull(対象範囲外・欠測)を許容する。未取得/未生成ならnull。
   */
  currentLocationSeries: ({ timeKey: string; kind: "observed" | "forecast"; tempC: number; fog: number } | null)[] | null;
}

/** "2026-08-30T18:00" -> "18時"(現在地の1日の気温一覧を横並びのコンパクトな表で見せるための短い時刻表記) */
function formatHourOnly(timeKey: string): string {
  const m = timeKey.match(/T(\d{2}):/);
  return m ? `${m[1]}時` : timeKey;
}

/** 霧リスク(0〜1)を1〜2文字の短いラベルにする(コンパクトな表用。長い文言は fogRiskLabel を使う) */
function fogRiskShort(risk: number): string {
  if (risk >= 1) return "霧:高";
  if (risk >= 0.6) return "霧:中";
  if (risk > 0) return "霧:低";
  return "";
}

/** 残り時間(ms)を「3時間20分」のような日本語表記にする */
function formatDurationJa(ms: number): string {
  const totalMinutes = Math.max(1, Math.ceil(ms / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  if (h > 0 && m > 0) return `${h}時間${m}分`;
  if (h > 0) return `${h}時間`;
  return `${m}分`;
}

function formatTimeKey(timeKey: string): string {
  // "2026-08-30T18:00" -> "08/30 18:00"
  const m = timeKey.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]}/${m[2]} ${m[3]}` : timeKey;
}

/** "2026-08-30T18:00" -> "08/30 18:00 時点" (履歴の選択肢のラベル用) */
function formatHistoryLabel(entry: KougenTenkiHistoryEntry): string {
  const savedAt = new Date(entry.savedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const savedLabel = `${pad(savedAt.getMonth() + 1)}/${pad(savedAt.getDate())} ${pad(savedAt.getHours())}:${pad(savedAt.getMinutes())}保存`;
  return `${formatTimeKey(entry.generatedAt)} 時点(${savedLabel})`;
}

/**
 * 「高原天気」気温・霧シミュレーターの表示切り替え+生成ボタン。
 * データはボタンを押すたびにサーバー側で最新のアメダス観測から計算し直す
 * (過去12時間・1時間刻み)。生成済みなら時刻スライダーで12コマを見比べられる。
 */
export default function KougenTenkiControl({
  visible,
  onVisibleChange,
  grid,
  hourIndex,
  onHourIndexChange,
  tempOpacity,
  onTempOpacityChange,
  fogOpacity,
  onFogOpacityChange,
  showStations,
  onShowStationsChange,
  hover,
  onGenerate,
  generating,
  error,
  history,
  selectedHistory,
  onSelectedHistoryChange,
  onLoadHistory,
  historyLoading,
  cooldownRemainingMs,
  currentLocationSeries,
}: Props) {
  const hours = grid?.hours ?? [];
  const maxHourIndex = Math.max(hours.length - 1, 0);
  const selectedHour = hours[hourIndex];
  const inCooldown = cooldownRemainingMs > 0;

  return (
    <div className="layer-control">
      <label className="layer-control__checkbox">
        <input type="checkbox" checked={visible} onChange={(e) => onVisibleChange(e.target.checked)} />
        高原天気(気温・霧シミュレーター)
      </label>

      {visible && (
        <>
          <button type="button" className="rain-control__play kougen-tenki__generate" onClick={onGenerate} disabled={generating}>
            {generating ? "処理中…" : inCooldown ? (<><Ico icon={FolderOpen} /> キャッシュを表示</>) : (<><Ico icon={Thermometer} /> 気象情報を生成</>)}
          </button>

          {/*
            「高層天気取得は1日2回までと制限をかけてください(10時間に1回まで)。制限中は
            高層天気のキャッシュを読み込む形にしてください」という指示への対応。制限中は
            ボタンを押しても実際のライブ生成はせず、保存済みの最新キャッシュを表示するだけに
            なる(App.tsxのgenerateKougenTenkiWeather側で分岐)ため、ここでその旨を明示する。
          */}
          {inCooldown && (
            <div className="layer-control__status kougen-tenki__cooldown">
              <Ico icon={Hourglass} /> 高原天気のライブ取得は10時間に1回まで(1日2回程度)です。次に生成できるのは約
              {formatDurationJa(cooldownRemainingMs)}後です。今はボタンを押すと保存済みの最新
              キャッシュを表示します。
            </div>
          )}

          {/*
            「高原天気の気象予測を、過去に生成したデータを読み込めるボタンを追加してください」
            という要望を受けて追加。生成結果はIndexedDBに直近5世代まで保存しており(1世代
            10〜20MB程度あり、localStorageの上限を超えるため)、ここで選んで読み込み直せる。
          */}
          {history.length > 0 && (
            <div className="rain-control__row kougen-tenki__history-row">
              <select
                className="kougen-tenki__history-select"
                value={selectedHistory}
                onChange={(e) => onSelectedHistoryChange(e.target.value)}
              >
                {history.map((h) => (
                  <option key={h.generatedAt} value={h.generatedAt}>
                    {formatHistoryLabel(h)}
                  </option>
                ))}
              </select>
              <button type="button" onClick={onLoadHistory} disabled={historyLoading || !selectedHistory}>
                {historyLoading ? "読み込み中…" : (<><Ico icon={FolderOpen} /> 読み込む</>)}
              </button>
            </div>
          )}

          <div className="layer-control__status">
            岐阜県北部〜長野県中心のDEM地形補正モデル。過去12時間〜現在の気温・霧リスクを、アメダス観測(+犬山
            自動気象観測所を現在時刻のコマにのみ追加)と標高から推定します(実況の推定のみで、未来の予測は行いません)。
          </div>

          {/*
            「法律 利用規約に反するものはありますか」への回答を受けた対応。国土地理院は
            DEM(標高タイル)を加工して別の画像(気温・霧分布図)を生成する場合、出典表記に
            加えて「加工して作成」した旨を明記するよう定めている
            (https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html)。
            気象庁アメダスも同様に出典を明記する。(スマホ版ではOpen-Meteo・信州大学の観測所を使わなくなったので、出典から外した)
          */}
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
              {/*
                犬山自動気象観測所のマーカーは他のアメダス観測所と見た目上区別できず、
                「追加されていない」ように見えてしまっていたため、成功/失敗をここで明示する
                (「犬山の気温が追加されていません」という報告を受けて追加)。
              */}
              <div className="layer-control__status kougen-tenki__inuyama-status">
                <Ico icon={grid.inuyamaAwsError ? TriangleAlert : CircleCheck} />{" "}
                {grid.inuyamaAwsError
                  ? `犬山自動気象観測所: 取得失敗(${grid.inuyamaAwsError})`
                  : "犬山自動気象観測所: 最新の実測コマに追加済み"}
              </div>

              {/*
                「現在地の1日の気温と天気も、高層天気の取得した場合に表示されるようにしてください」
                という指示への対応。現在地(「現在地を取得」ボタンで取得済みの場合)について、
                生成済みの全コマ(過去12時間〜現在)の気温・霧リスクを横並びで見せる。
                セルを押すと、下のメイン時刻スライダー(hourIndex)もその時刻に切り替わる。
              */}
              {currentLocationSeries && (
                <div className="kougen-tenki__current-location">
                  <div className="layer-control__status"><Ico icon={MapPin} /> 現在地の気温・霧リスク(1日)</div>
                  {currentLocationSeries.every((entry) => entry === null) ? (
                    <div className="layer-control__status">
                      現在地は高原天気の対象範囲外です(岐阜県北部〜長野県中心のみ)
                    </div>
                  ) : (
                    <div className="kougen-tenki__current-location-list">
                      {currentLocationSeries.map((entry, i) =>
                        entry ? (
                          <button
                            type="button"
                            key={entry.timeKey}
                            className={
                              i === hourIndex
                                ? "kougen-tenki__current-location-item kougen-tenki__current-location-item--selected"
                                : "kougen-tenki__current-location-item"
                            }
                            onClick={() => onHourIndexChange(i)}
                          >
                            <span className="kougen-tenki__current-location-time">
                              {formatHourOnly(entry.timeKey)}
                              {entry.kind === "forecast" ? "予" : ""}
                            </span>
                            <span className="kougen-tenki__current-location-temp">{entry.tempC.toFixed(1)}℃</span>
                            {fogRiskShort(entry.fog) && (
                              <span className="kougen-tenki__current-location-fog">{fogRiskShort(entry.fog)}</span>
                            )}
                          </button>
                        ) : null,
                      )}
                    </div>
                  )}
                </div>
              )}

              <div className="rain-control__row">
                <span className="rain-control__label">気温不透明度</span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={tempOpacity}
                  onChange={(e) => onTempOpacityChange(Number(e.target.value))}
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

              <div className="rain-control__row">
                <span className="rain-control__label">時刻</span>
                <input
                  type="range"
                  min={0}
                  max={maxHourIndex}
                  step={1}
                  value={hourIndex}
                  onChange={(e) => onHourIndexChange(Number(e.target.value))}
                />
              </div>
              <div className="kougen-tenki__slider-range-label">
                <span>← 12時間前(実測)</span>
                <span>現在 →</span>
              </div>
              {selectedHour && (
                <div className="layer-control__status">
                  {formatTimeKey(selectedHour.timeKey)} 時点
                  <span
                    className={
                      selectedHour.kind === "forecast"
                        ? "kougen-tenki__kind kougen-tenki__kind--forecast"
                        : "kougen-tenki__kind kougen-tenki__kind--observed"
                    }
                  >
                    {selectedHour.kind === "forecast" ? "予測" : "実測"}
                  </span>
                </div>
              )}

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
            <div className="layer-control__status">まだ生成していません。ボタンを押してください。</div>
          )}
        </>
      )}

      {error && <div className="layer-control__error">{error}</div>}
    </div>
  );
}
