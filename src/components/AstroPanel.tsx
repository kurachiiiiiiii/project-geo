import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { formatDirection } from "../lib/direction";
import { fogRiskLabel } from "../lib/kougenTenkiGrid";
import type { DirectionSample, KougenTenkiGrid, KougenTenkiValue, MilkyWayResult } from "../types";
import AstroCalendar from "./AstroCalendar";
import AstroKoyoSection, { type AstroKoyoInfo } from "./AstroKoyoSection";
import { Calendar, MapPin, Moon, Sparkles, Sun, Thermometer, TriangleAlert } from "../lib/lucide";
import { Ico, MoonPhaseIcon } from "./Ico";

interface Props {
  point: { lat: number; lng: number };
  /** 逆ジオコーディングで求めたおおまかな住所(取得中・失敗時はnullで、座標表示にフォールバックする) */
  roughAddress: string | null;
  date: Date;
  onDateChange: (d: Date) => void;
  result: MilkyWayResult;
  /** 地図上に表示中の天の川の方角の線に対応する directionSamples のindex */
  selectedHourIndex: number;
  onSelectHour: (index: number) => void;
  /** 地図上に表示中の太陽・月の方角の線に対応する sunDirectionSamples/moonDirectionSamples 共通のindex */
  selectedSunMoonHourIndex: number;
  onSelectSunMoonHour: (index: number) => void;
  /** 生成済みなら「高原天気」のグリッド全体(時刻一覧の表示・スライダーの範囲決めに使う) */
  kougenTenkiGrid: KougenTenkiGrid | null;
  /** 選択中のコマにおける、この地点の気温・霧リスク(対象範囲外・未生成ならnull) */
  kougenTenkiValue:
    | (KougenTenkiValue & {
        timeKey: string;
        kind: "observed" | "forecast";
        forecastSource?: "open-meteo" | "trend";
      })
    | null;
  /** 高原天気の時刻スライダーの選択中index(hoursの添字。過去12時間+未来12時間から選べる) */
  selectedKougenTenkiHourIndex: number;
  onSelectKougenTenkiHour: (index: number) => void;
  /** 生成済みかつ表示中なら「現在の気温」のグリッド(hoursは常に1コマ) */
  currentTempGrid: KougenTenkiGrid | null;
  /** この地点の「現在の気温」の値(対象範囲外・未生成・非表示ならnull) */
  currentTempValue:
    | (KougenTenkiValue & {
        timeKey: string;
        kind: "observed" | "forecast";
        forecastSource?: "open-meteo" | "trend";
      })
    | null;
  /**
   * 「天文情報のところに 紅葉のピークの時期と 植生の種類を追加してください」への対応。
   * この地点の植生(樹種)と紅葉の見頃の推定(`features/koyo/`)。nullなら表示しない。
   */
  koyo?: AstroKoyoInfo | null;
  /**
   * 「クリックしたところを表示するボタンを押すと 3d360度見渡せるビューワーを追加」への対応。
   * 渡されたときだけ、住所の下に「3Dで見渡す」ボタンを出す(押すとこの地点の3Dビューワーが開く)。
   */
  onOpen3D?: () => void;
}

function formatTime(d: Date | null): string {
  if (!d) return "—";
  return d.toLocaleString("ja-JP", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatHourMinute(d: Date): string {
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/** "2026-08-30T18:00" -> "08/30 18:00" */
function formatKougenTenkiTimeKey(timeKey: string): string {
  const m = timeKey.match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]}/${m[2]} ${m[3]}` : timeKey;
}

function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 日の出/日の入り/月の出/月の入りの1行(常に地図上にも方角の線を表示している) */
function DirectionRow({
  label,
  time,
  azimuthDeg,
}: {
  label: string;
  time: Date | null;
  azimuthDeg: number | null;
}) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {formatTime(time)}
        {azimuthDeg !== null && <span className="astro-panel__azimuth"> {formatDirection(azimuthDeg)}</span>}
      </dd>
    </>
  );
}

/** 一行分の「アイコン 時刻 方角 高度」表示(太陽・月共通スライダーの値表示に使う) */
function SampleLine({ icon, label, sample }: { icon: ReactNode; label: string; sample: DirectionSample | null }) {
  if (!sample) return null;
  return (
    <div className="astro-panel__slider-value">
      {icon} {label} {formatHourMinute(sample.time)}　{formatDirection(sample.azimuthDeg)}
      　高度 {sample.altitudeDeg >= 0 ? `${Math.round(sample.altitudeDeg)}°` : "地平線下"}
    </div>
  );
}

/**
 * 太陽・月の「時刻スライダー」ブロック。1本のスライダーで太陽・月両方の方角を同時に切り替える
 * (どちらも選択日の0時〜23時が対象で、別々に動かす利点が薄いため統合した)。
 */
function SunMoonHourSliderBlock({
  sunSamples,
  moonSamples,
  selectedIndex,
  onSelect,
}: {
  sunSamples: DirectionSample[];
  moonSamples: DirectionSample[];
  selectedIndex: number;
  onSelect: (index: number) => void;
}) {
  const selectedSun = sunSamples[selectedIndex] ?? null;
  const selectedMoon = moonSamples[selectedIndex] ?? null;
  if (!selectedSun && !selectedMoon) return null;
  const maxIndex = Math.max(sunSamples.length - 1, moonSamples.length - 1, 0);

  return (
    <div className="astro-panel__direction">
      <h3>太陽・月の方角(時間ごと)</h3>
      <p className="astro-panel__hint">
        スライダーで選択日の時刻を選ぶと、その時刻の太陽・月の方角を地図上に点線で表示します
      </p>
      <div className="astro-panel__slider-row">
        <input
          type="range"
          className="astro-panel__hour-slider"
          min={0}
          max={maxIndex}
          step={1}
          value={selectedIndex}
          onChange={(e) => onSelect(Number(e.target.value))}
        />
      </div>
      <SampleLine icon={<Ico icon={Sun} />} label="太陽" sample={selectedSun} />
      <SampleLine icon={<Ico icon={Moon} />} label="月" sample={selectedMoon} />
    </div>
  );
}

export default function AstroPanel({
  point,
  roughAddress,
  date,
  onDateChange,
  result,
  selectedHourIndex,
  onSelectHour,
  selectedSunMoonHourIndex,
  onSelectSunMoonHour,
  kougenTenkiGrid,
  kougenTenkiValue,
  selectedKougenTenkiHourIndex,
  onSelectKougenTenkiHour,
  currentTempGrid,
  currentTempValue,
  koyo = null,
  onOpen3D,
}: Props) {
  const [calendarOpen, setCalendarOpen] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  // ユーザーが最後に自分でスクロールした位置。再レンダーのたびにこの位置へ復元する
  // (以下の useLayoutEffect を参照)。ref なので更新しても再レンダーは起きない。
  const userScrollTopRef = useRef(0);

  const selectedSample = result.directionSamples[selectedHourIndex] ?? null;
  const maxHourIndex = Math.max(result.directionSamples.length - 1, 0);

  // ユーザー自身のスクロール操作を追跡しておく(プログラムによる復元と区別しない。
  // 復元も同じ scrollTop 代入なので scroll イベントが発火し、結局同じ値を書き戻すだけで安全)。
  useEffect(() => {
    const scrollEl = panelRef.current?.closest<HTMLElement>(".leaflet-popup-content");
    if (!scrollEl) return;
    const onScroll = () => {
      userScrollTopRef.current = scrollEl.scrollTop;
    };
    scrollEl.addEventListener("scroll", onScroll);
    return () => scrollEl.removeEventListener("scroll", onScroll);
  }, []);

  // スライダーを動かす/表の行を選ぶ/(rayKm再計算などによる)親の再レンダーで中身が更新されると、
  // react-leafletが裏でLeafletの Popup#update() を呼び直しており、その中でいったん高さ制限を
  // 外して実寸を測ってからスクロール用の高さに戻す処理をしているため、何もしないとポップアップ内の
  // スクロール位置が毎回いちばん上(0)に戻ってしまう。以前はスライダーのonChangeなど個別の
  // イベントハンドラでしか復元していなかったため、それ以外の理由(地図のズーム・移動に連動した
  // 親の再レンダーなど)で起きる巻き戻りには対応できていなかった。ここでは「レンダーのたびに
  // 必ず実行される」useLayoutEffect(依存配列なし)にすることで、原因を問わず常に直前のスクロール
  // 位置へ復元するようにしている。Leafletのその処理はReactの再レンダー後の別エフェクトで走るため、
  // 今回のレンダーが完全に落ち着いたあと(次の描画フレーム)にも復元する。
  // rAFがすぐ発火しない環境(裏タブなど)のフォールバックとしてsetTimeoutでも復元しておく。
  useLayoutEffect(() => {
    const scrollEl = panelRef.current?.closest<HTMLElement>(".leaflet-popup-content");
    if (!scrollEl) return;
    const restore = () => {
      scrollEl.scrollTop = userScrollTopRef.current;
    };
    restore();
    const raf = requestAnimationFrame(restore);
    const timeout = setTimeout(restore, 0);
    return () => {
      cancelAnimationFrame(raf);
      clearTimeout(timeout);
    };
  });

  return (
    <div className="astro-panel" ref={panelRef}>
      <div className="astro-panel__coords">
        <Ico icon={MapPin} /> {roughAddress ?? `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`}
      </div>

      {onOpen3D && (
        <button type="button" className="astro-panel__view3d" onClick={onOpen3D}>
          3Dで見渡す(地形・紅葉・太陽と月)
        </button>
      )}

      {currentTempGrid && currentTempGrid.hours.length > 0 && (
        <div className="astro-panel__kougen-tenki">
          <div className="astro-panel__kougen-tenki-title"><Ico icon={Thermometer} /> 現在の気温(推定)</div>
          {currentTempValue ? (
            <div className="astro-panel__kougen-tenki-value">
              {formatKougenTenkiTimeKey(currentTempValue.timeKey)}
              <br />
              気温 {currentTempValue.tempC.toFixed(1)}℃　湿度 {currentTempValue.humidityPct}%
              {fogRiskLabel(currentTempValue.fog)}
              <span className="astro-panel__kougen-tenki-note">(標高{currentTempValue.altM}m)</span>
            </div>
          ) : (
            <div className="astro-panel__none">この地点は現在の気温の対象範囲外です</div>
          )}
        </div>
      )}

      {kougenTenkiGrid && kougenTenkiGrid.hours.length > 0 && (
        <div className="astro-panel__kougen-tenki">
          <div className="astro-panel__kougen-tenki-title"><Ico icon={Thermometer} /> 気温・霧リスク(高原天気)</div>
          <input
            type="range"
            className="astro-panel__hour-slider"
            min={0}
            max={kougenTenkiGrid.hours.length - 1}
            step={1}
            value={selectedKougenTenkiHourIndex}
            onChange={(e) => onSelectKougenTenkiHour(Number(e.target.value))}
          />
          <div className="kougen-tenki__slider-range-label">
            <span>← 過去(実測)</span>
            <span>現在</span>
            <span>未来(予測) →</span>
          </div>
          {kougenTenkiValue ? (
            <div className="astro-panel__kougen-tenki-value">
              {formatKougenTenkiTimeKey(kougenTenkiValue.timeKey)}
              <span
                className={
                  kougenTenkiValue.kind === "forecast"
                    ? "kougen-tenki__kind kougen-tenki__kind--forecast"
                    : "kougen-tenki__kind kougen-tenki__kind--observed"
                }
              >
                {kougenTenkiValue.kind === "forecast" ? "予測" : "実測"}
              </span>
              <br />
              気温 {kougenTenkiValue.tempC.toFixed(1)}℃　湿度 {kougenTenkiValue.humidityPct}%
              {fogRiskLabel(kougenTenkiValue.fog)}
              <span className="astro-panel__kougen-tenki-note">(標高{kougenTenkiValue.altM}m)</span>
            </div>
          ) : (
            <div className="astro-panel__none">この地点は高原天気の対象範囲外です</div>
          )}
          {kougenTenkiValue && (
            <p className="astro-panel__hint astro-panel__kougen-tenki-note">
              アメダスの観測と標高から推定した実況の値です(予測ではありません)。
            </p>
          )}
        </div>
      )}

      <div className="astro-panel__date-row">
        <label className="astro-panel__date">
          日付
          <input
            type="date"
            value={toDateInputValue(date)}
            onChange={(e) => {
              const [y, m, d] = e.target.value.split("-").map(Number);
              if (y && m && d) onDateChange(new Date(y, m - 1, d));
            }}
          />
        </label>
        <button
          type="button"
          className="astro-panel__calendar-toggle"
          onClick={() => setCalendarOpen((v) => !v)}
        >
          <Ico icon={Calendar} /> {calendarOpen ? "カレンダーを閉じる" : "カレンダーで将来の日を選ぶ"}
        </button>
      </div>

      {calendarOpen && (
        <AstroCalendar point={point} selectedDate={date} onSelectDate={onDateChange} />
      )}

      <dl className="astro-panel__list">
        <DirectionRow
          label="日の出"
          time={result.twilight.sunrise}
          azimuthDeg={result.twilight.sunriseAzimuthDeg}
        />
        <DirectionRow
          label="日の入り"
          time={result.twilight.sunset}
          azimuthDeg={result.twilight.sunsetAzimuthDeg}
        />
        <dt>天文薄明 終了(夜)</dt>
        <dd>{formatTime(result.twilight.astroDusk)}</dd>
        <dt>天文薄明 開始(翌朝)</dt>
        <dd>{formatTime(result.twilight.astroDawn)}</dd>
        <DirectionRow
          label="月の出"
          time={result.twilight.moonrise}
          azimuthDeg={result.twilight.moonriseAzimuthDeg}
        />
        <DirectionRow
          label="月の入り"
          time={result.twilight.moonset}
          azimuthDeg={result.twilight.moonsetAzimuthDeg}
        />
        <dt>月齢</dt>
        <dd>
          <MoonPhaseIcon age={result.moon.ageDays} /> {result.moon.ageDays.toFixed(1)} (輝面
          {Math.round(result.moon.illumination * 100)}%)
        </dd>
      </dl>

      <SunMoonHourSliderBlock
        sunSamples={result.sunDirectionSamples}
        moonSamples={result.moonDirectionSamples}
        selectedIndex={selectedSunMoonHourIndex}
        onSelect={onSelectSunMoonHour}
      />

      {/*
        「天文情報の 紅葉の情報は 太陽などの情報の次にくるようにしてください」への対応。
        以前は気温・霧リスクのすぐ下(日付の前)にあったが、日の出・月の出などの一覧と
        「太陽・月の方角(時間ごと)」のスライダーの次(天の川の前)に移した。
      */}
      {koyo && <AstroKoyoSection info={koyo} />}

      <div className="astro-panel__milkyway">
        <h3>天の川 観測可能時間帯</h3>
        <p className="astro-panel__hint">銀河中心(いて座方向)の仰角15°以上 かつ 月が沈んでいる時間帯</p>
        {result.windows.length > 0 ? (
          <ul>
            {result.windows.map((w, i) => (
              <li key={i}>
                {formatTime(w.start)} 〜 {formatTime(w.end)}
              </li>
            ))}
          </ul>
        ) : (
          <p className="astro-panel__none">観測可能な時間帯はありません</p>
        )}
        {result.warnings.map((w, i) => (
          <p key={i} className="astro-panel__warning">
            <Ico icon={TriangleAlert} /> {w}
          </p>
        ))}
      </div>

      {result.directionSamples.length > 0 && selectedSample && (
        <div className="astro-panel__direction">
          <h3>天の川の方角(時間ごと)</h3>
          <p className="astro-panel__hint">
            天文薄明終了〜翌天文薄明開始の間で、スライダーで時刻を選ぶと地図上に線で表示します
          </p>

          <div className="astro-panel__slider-row">
            <input
              type="range"
              className="astro-panel__hour-slider"
              min={0}
              max={maxHourIndex}
              step={1}
              value={selectedHourIndex}
              onChange={(e) => onSelectHour(Number(e.target.value))}
            />
          </div>
          <div className="astro-panel__slider-value">
            <Ico icon={Sparkles} /> {formatHourMinute(selectedSample.time)}　{formatDirection(selectedSample.azimuthDeg)}
            　高度{" "}
            {selectedSample.altitudeDeg >= 0 ? `${Math.round(selectedSample.altitudeDeg)}°` : "地平線下"}
            {selectedSample.visible && <span className="astro-panel__visible-badge">観測可能</span>}
          </div>

          <table className="astro-panel__direction-table">
            <thead>
              <tr>
                <th>時刻</th>
                <th>方角</th>
                <th>高度</th>
              </tr>
            </thead>
            <tbody>
              {result.directionSamples.map((s, i) => {
                const selected = selectedHourIndex === i;
                const classNames = [
                  "astro-panel__direction-row",
                  s.visible && "astro-panel__direction-row--visible",
                  selected && "astro-panel__direction-row--selected",
                ]
                  .filter(Boolean)
                  .join(" ");
                return (
                  <tr key={i} className={classNames} onClick={() => onSelectHour(i)}>
                    <td>{formatHourMinute(s.time)}</td>
                    <td>{formatDirection(s.azimuthDeg)}</td>
                    <td>{s.altitudeDeg >= 0 ? `${Math.round(s.altitudeDeg)}°` : "地平線下"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <p className="astro-panel__note">※時刻は端末のタイムゾーンで表示しています</p>
    </div>
  );
}
