import type { WeatherMetric } from "../types";

/**
 * 気象要素の値を色に変換する。
 * 地図上に数字を並べただけだと分布が読み取りにくいため、値に応じてマーカーを着色する。
 * 配色は気象庁の降水量凡例や一般的な気温色分けに近い並びにしている。
 */

type Rgb = [number, number, number];
interface ColorStop {
  /** この値のときの色 */
  v: number;
  color: Rgb;
}

/** 各要素の色スケール(v の昇順) */
const SCALES: Record<Exclude<WeatherMetric, "none">, ColorStop[]> = {
  temp: [
    { v: -15, color: [43, 58, 143] },
    { v: -5, color: [43, 111, 239] },
    { v: 0, color: [74, 163, 240] },
    { v: 5, color: [127, 208, 232] },
    { v: 10, color: [168, 230, 161] },
    { v: 15, color: [255, 224, 102] },
    { v: 20, color: [255, 194, 71] },
    { v: 25, color: [255, 154, 60] },
    { v: 30, color: [244, 100, 60] },
    { v: 35, color: [217, 43, 43] },
    { v: 40, color: [142, 27, 107] },
  ],
  precipitation1h: [
    { v: 0, color: [176, 186, 200] },
    { v: 0.1, color: [160, 216, 239] },
    { v: 1, color: [74, 144, 226] },
    { v: 5, color: [30, 95, 208] },
    { v: 10, color: [245, 230, 66] },
    { v: 20, color: [255, 154, 60] },
    { v: 30, color: [244, 100, 60] },
    { v: 50, color: [176, 47, 201] },
  ],
  sun1h: [
    { v: 0, color: [110, 124, 148] },
    { v: 0.3, color: [190, 200, 150] },
    { v: 0.6, color: [255, 224, 102] },
    { v: 1, color: [255, 154, 60] },
  ],
  humidity: [
    { v: 0, color: [201, 139, 75] },
    { v: 40, color: [232, 217, 160] },
    { v: 70, color: [127, 208, 232] },
    { v: 100, color: [43, 111, 239] },
  ],
  wind: [
    { v: 0, color: [207, 227, 245] },
    { v: 3, color: [127, 208, 232] },
    { v: 6, color: [168, 230, 161] },
    { v: 10, color: [255, 224, 102] },
    { v: 15, color: [255, 154, 60] },
    { v: 20, color: [217, 43, 43] },
    { v: 30, color: [142, 27, 107] },
  ],
};

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function toCss([r, g, b]: Rgb): string {
  return `rgb(${r},${g},${b})`;
}

function interpolate(stops: ColorStop[], value: number): Rgb {
  if (value <= stops[0].v) return stops[0].color;
  const last = stops[stops.length - 1];
  if (value >= last.v) return last.color;

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (value >= a.v && value <= b.v) {
      const t = b.v === a.v ? 0 : (value - a.v) / (b.v - a.v);
      return [
        lerp(a.color[0], b.color[0], t),
        lerp(a.color[1], b.color[1], t),
        lerp(a.color[2], b.color[2], t),
      ];
    }
  }
  return last.color;
}

/** 値に対応する色を返す。要素が "none" または値なしの場合は null */
export function metricColor(metric: WeatherMetric, value: number | null | undefined): string | null {
  if (metric === "none" || value === null || value === undefined) return null;
  const stops = SCALES[metric];
  if (!stops) return null;
  return toCss(interpolate(stops, value));
}

/** 背景色に対して読みやすい文字色(濃い色の上では白、淡い色の上では黒)を返す */
export function readableTextColor(rgbCss: string): string {
  const m = rgbCss.match(/(\d+),(\d+),(\d+)/);
  if (!m) return "#0b1220";
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // ITU-R BT.601 の輝度
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? "#0b1220" : "#ffffff";
}

/** 凡例表示用: グラデーションのCSSと目盛りラベル */
export function metricLegend(metric: WeatherMetric): { gradient: string; ticks: string[] } | null {
  if (metric === "none") return null;
  const stops = SCALES[metric];
  if (!stops) return null;

  const min = stops[0].v;
  const max = stops[stops.length - 1].v;
  const span = max - min;
  const gradient = `linear-gradient(to right, ${stops
    .map((s) => `${toCss(s.color)} ${(((s.v - min) / span) * 100).toFixed(1)}%`)
    .join(", ")})`;

  return { gradient, ticks: [String(min), String(stops[Math.floor(stops.length / 2)].v), String(max)] };
}
