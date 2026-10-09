import { WEATHER_METRICS } from "../features/amedas/amedasService";
import type { WeatherMetric, WeatherMetricDef } from "../types";

export function metricDef(metric: WeatherMetric): WeatherMetricDef | null {
  if (metric === "none") return null;
  return WEATHER_METRICS.find((m) => m.key === metric) ?? null;
}

/** 観測値をマーカーのラベル用文字列に整形する。値が無いときは null(ラベルを出さない) */
export function formatMetricValue(value: number | null | undefined, metric: WeatherMetric): string | null {
  const def = metricDef(metric);
  if (!def || value === null || value === undefined) return null;
  return `${value.toFixed(def.digits)}${def.unit}`;
}
