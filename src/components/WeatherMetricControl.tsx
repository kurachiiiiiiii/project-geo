import { WEATHER_METRICS } from "../features/amedas/amedasService";
import { metricLegend } from "../lib/metricColor";
import { metricDef } from "../lib/formatMetric";
import type { WeatherMetric } from "../types";

interface Props {
  visible: boolean;
  onVisibleChange: (v: boolean) => void;
  metric: WeatherMetric;
  onMetricChange: (m: WeatherMetric) => void;
  stationCount: number;
  observedAt: string | null;
  loading: boolean;
  error: string | null;
}

/** アメダス(+山岳観測所)の表示ON/OFFと、地図上に表示する気象要素の選択 */
export default function WeatherMetricControl({
  visible,
  onVisibleChange,
  metric,
  onMetricChange,
  stationCount,
  observedAt,
  loading,
  error,
}: Props) {
  const legend = metricLegend(metric);
  const def = metricDef(metric);

  return (
    <div className="layer-control">
      <label className="layer-control__checkbox">
        <input type="checkbox" checked={visible} onChange={(e) => onVisibleChange(e.target.checked)} />
        アメダス観測所
      </label>

      {visible && (
        <select
          className="layer-control__select"
          value={metric}
          onChange={(e) => onMetricChange(e.target.value as WeatherMetric)}
        >
          <option value="none">値を表示しない</option>
          {WEATHER_METRICS.map((m) => (
            <option key={m.key} value={m.key}>
              {m.label}
            </option>
          ))}
        </select>
      )}

      {visible && legend && def && (
        <div className="metric-legend">
          <div className="metric-legend__bar" style={{ background: legend.gradient }} />
          <div className="metric-legend__ticks">
            {legend.ticks.map((t, i) => (
              <span key={i}>
                {t}
                {i === legend.ticks.length - 1 ? def.unit : ""}
              </span>
            ))}
          </div>
        </div>
      )}

      {loading && <div className="layer-control__status">読み込み中...</div>}
      {!loading && !error && (
        <div className="layer-control__status">
          {stationCount}地点
          {observedAt && ` / ${observedAt.slice(5, 16).replace("T", " ")}`}
        </div>
      )}
      {error && <div className="layer-control__error">{error}</div>}
    </div>
  );
}
