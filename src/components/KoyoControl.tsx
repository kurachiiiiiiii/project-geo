import { dateFromDayNumber } from "../features/koyo/koyoForecast";
import type { KoyoController } from "../features/koyo/useKoyo";
import { CircleCheck, TriangleAlert } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  koyo: KoyoController;
}

function mmdd(day: number): string {
  const d = dateFromDayNumber(day);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

/**
 * 紅葉マップの操作パネル。日付・不透明度・データの状態・長期予報の再取得・長期予報の補正のあり/なしだけを扱う
 * (凡例・地域別の気温補正・北→南の標高ライン表・地点の見頃の表は、「再取得ボタンより下は不要」との要望で撤去した)。
 * 計算は`features/koyo/`、状態は`useKoyo`にある。
 */
export default function KoyoControl({ koyo }: Props) {
  const {
    visible,
    setVisible,
    day,
    setDay,
    today,
    dayRange,
    opacity,
    setOpacity,
    useForecast,
    setUseForecast,
    forecast,
    forecastLoading,
    forecastError,
    reloadForecast,
    veg,
    demProblem,
  } = koyo;

  const forecastDate = forecast?.twoWeekInitDay ?? forecast?.oneMonthInitDay ?? null;

  return (
    <div className="layer-control koyo">
      <label className="layer-control__checkbox">
        <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
        紅葉マップ(推定)
      </label>

      {visible && (
        <>
          <div className="rain-control__row">
            <span className="rain-control__label koyo__date">{mmdd(day)}</span>
            <input
              className="rain-control__slider"
              type="range"
              min={dayRange.start}
              max={dayRange.end}
              step={1}
              value={day}
              onChange={(e) => setDay(Number(e.target.value))}
              aria-label="紅葉を見る日付"
            />
            <button
              type="button"
              className="rain-control__play"
              onClick={() => setDay(Math.min(dayRange.end, Math.max(dayRange.start, today)))}
            >
              今日
            </button>
          </div>
          <div className="slider-range-label">
            <span>{mmdd(dayRange.start)}</span>
            <span>{mmdd(dayRange.end)}</span>
          </div>
          <div className="layer-control__status">
            新緑・紅葉・雪は気温と植生から描いたイメージで、積雪などの予報ではありません。
          </div>

          <div className="rain-control__row">
            <span className="rain-control__label">不透明度</span>
            <input
              className="rain-control__slider"
              type="range"
              min={0.1}
              max={1}
              step={0.05}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
            />
          </div>

          {/* ---- データの状態 ---- */}
          {veg === null && <div className="layer-control__status">植生データを読み込み中…</div>}
          {veg?.status === "ok" && (
            <div className="layer-control__status">
              <Ico icon={CircleCheck} /> 植生データ: {veg.grid.source}(樹種ごとに色づきを判定)
            </div>
          )}
          {veg?.status === "missing" && (
            <div className="layer-control__status">
              <Ico icon={TriangleAlert} /> 植生データ未配置のため、標高帯モデル(標高200m以上を、気温から推定した植生帯で代用)で表示しています
            </div>
          )}
          {veg?.status === "error" && <div className="layer-control__error">{veg.message}</div>}
          {demProblem && <div className="layer-control__error">{demProblem}</div>}

          <div className="layer-control__status">
            {forecastLoading
              ? "長期予報を取得中…"
              : forecast
                ? `気象庁 確率予測資料(2週間・1か月の気温の平年差)${forecastDate !== null ? `: ${mmdd(forecastDate)}発表分` : ""}${useForecast ? "を紅葉の進み具合に反映" : "(補正なしのため使っていません)"}`
                : "長期予報: 未取得(平年並みで計算)"}
          </div>
          {forecast && forecast.errors.length > 0 && (
            <details className="koyo__details">
              <summary>取得できなかった予報({forecast.errors.length}件)</summary>
              <ul className="koyo__errors">
                {forecast.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </details>
          )}
          {forecastError && <div className="layer-control__error">{forecastError}</div>}
          <button
            type="button"
            className="rain-control__play koyo__button"
            onClick={reloadForecast}
            disabled={forecastLoading}
          >
            {forecastLoading ? "取得中…" : "長期予報を再取得"}
          </button>

          {/* ---- 長期予報の補正 あり/なし ---- */}
          <label className="layer-control__checkbox">
            <input type="checkbox" checked={useForecast} onChange={(e) => setUseForecast(e.target.checked)} />
            長期予報の補正を反映する(なし=平年並みで計算)
          </label>
        </>
      )}
    </div>
  );
}
