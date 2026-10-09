import { lookupKougenTenkiValue } from "../../lib/kougenTenkiGrid";
import type { KougenTenkiGrid } from "../../types";
import { DEG, TILE_PX, clamp, metersPerPx, worldPx, type Vec3 } from "./viewerMath";
import type { SkyLook } from "./viewerSky";

/**
 * 3Dビューワー: 「現在の気温」「高原天気(気温予測)」で霧が出ている場所に、地面から約100mの高さまで霧をかける。
 *
 * ここでは霧の元データ(時刻に合うコマの選択)と、描画器(`viewerGl.ts`)へ渡す2枚の地図を作る:
 *   ・霧の濃さの地図(256×256、±26km。濃さは霧リスク0/0.3/0.6/1.0から)
 *   ・地面の高さの地図(512×512、同じ範囲。霧の層の上端=この高さ+100mを求めるため)
 * 霧そのものの描き方(視線に沿って霧の層を通る長さを足す)はシェーダー側。
 */

/** 霧の層の厚み(地面からの高さ、m)。「地面から100mくらいの高度まで」 */
export const FOG_LAYER_TOP_M = 100;
/** 濃さ1の霧の減衰(1/m)。視程 ≒ 3.9/sigma ≒ 250m(濃霧)。真上から見ても層の約8割が白くなる */
export const FOG_SIGMA = 3.9 / 250;

/** 霧・高さの地図が覆う範囲(原点から±m)。地形(半径25km)より少し広い */
export const FOG_HALF_M = 26_000;
export const FOG_RECT: [number, number, number, number] = [-FOG_HALF_M, -FOG_HALF_M, FOG_HALF_M * 2, FOG_HALF_M * 2];
export const FOG_MAP_SIZE = 256;
export const HEIGHT_MAP_SIZE = 512;

/** 地図上の位置(原点から東X・南Z、m) → 緯度経度。原点の緯度経度から、ズーム11のメルカトル座標で換算する */
export function makeLocalToLatLon(lat0: number, lon0: number): (X: number, Z: number) => { lat: number; lon: number } {
  const z = 11;
  const { x: wx0, y: wy0 } = worldPx(lat0, lon0, z);
  const mpp = metersPerPx(lat0, z);
  const world = 2 ** z * TILE_PX;
  return (X, Z) => {
    const px = wx0 + X / mpp;
    const py = wy0 + Z / mpp;
    return {
      lon: (px / world) * 360 - 180,
      lat: Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / world))) / DEG,
    };
  };
}

// ---------------------------------------------------------------------------
// 時刻に合う霧の元データ
// ---------------------------------------------------------------------------

export interface ViewerFogData {
  /** 「現在の気温」のグリッド(生成済みなら。コマは1つ) */
  current: KougenTenkiGrid | null;
  /** 「高原天気」のグリッド(生成済みなら。過去6時間〜未来6時間の12コマ) */
  forecast: KougenTenkiGrid | null;
}

export interface FogSource {
  grid: KougenTenkiGrid;
  hourIndex: number;
}

export interface FogPick {
  sources: FogSource[];
  /** 画面に出す説明(使うコマごと) */
  labels: string[];
  /** 使うコマが変わったかどうかの判定用 */
  key: string;
}

/** コマの時刻とこの時間(ms)以上ずれていたら、そのコマは使わない */
const MAX_GAP_MS = 60 * 60_000;

function frameMs(timeKey: string): number {
  return Date.parse(`${timeKey}:00+09:00`);
}

function nearest(grid: KougenTenkiGrid, t: Date): number | null {
  let best = -1;
  let bestGap = Infinity;
  for (let i = 0; i < grid.hours.length; i++) {
    const gap = Math.abs(frameMs(grid.hours[i].timeKey) - t.getTime());
    if (gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best >= 0 && bestGap <= MAX_GAP_MS ? best : null;
}

function shortTime(timeKey: string): string {
  // "YYYY-MM-DDTHH:mm" → "MM/DD HH:mm"
  return `${timeKey.slice(5, 7)}/${timeKey.slice(8, 10)} ${timeKey.slice(11, 16)}`;
}

/** 見ている日時に合う霧のコマ(現在の気温・高原天気それぞれ)を選ぶ */
export function pickFogSources(fog: ViewerFogData, time: Date): FogPick {
  const sources: FogSource[] = [];
  const labels: string[] = [];
  const keys: string[] = [];
  if (fog.forecast) {
    const i = nearest(fog.forecast, time);
    if (i !== null) {
      const f = fog.forecast.hours[i];
      sources.push({ grid: fog.forecast, hourIndex: i });
      labels.push(`高原天気 ${shortTime(f.timeKey)}(${f.kind === "forecast" ? "予測" : "実測"})`);
      keys.push(`f${i}:${fog.forecast.generatedAt}`);
    }
  }
  if (fog.current) {
    const i = nearest(fog.current, time);
    if (i !== null) {
      const f = fog.current.hours[i];
      sources.push({ grid: fog.current, hourIndex: i });
      labels.push(`現在の気温 ${shortTime(f.timeKey)}`);
      keys.push(`c${i}:${fog.current.generatedAt}`);
    }
  }
  return { sources, labels, key: keys.join("|") };
}

// ---------------------------------------------------------------------------
// 霧の濃さの地図
// ---------------------------------------------------------------------------

/** 横→縦の順に、半径radiusの箱型ぼかしをかける(グリッドの四角い境目をやわらげる) */
function boxBlur(src: Float32Array, n: number, radius: number): Float32Array {
  const tmp = new Float32Array(n * n);
  const out = new Float32Array(n * n);
  const w = radius * 2 + 1;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += src[y * n + clamp(x + k, 0, n - 1)];
      tmp[y * n + x] = s / w;
    }
  }
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < n; y++) {
      let s = 0;
      for (let k = -radius; k <= radius; k++) s += tmp[clamp(y + k, 0, n - 1) * n + x];
      out[y * n + x] = s / w;
    }
  }
  return out;
}

/**
 * 霧の濃さの地図(0〜255)。霧リスク(0/0.3/0.6/1.0)が高いほど濃く(0.3→約2割、0.6→約5割、1.0→全部)。
 * 霧が1か所も無ければnull。
 */
export function buildFogMap(
  sources: FogSource[],
  toLatLon: (X: number, Z: number) => { lat: number; lon: number },
): Uint8Array | null {
  const n = FOG_MAP_SIZE;
  let raw: Float32Array = new Float32Array(n * n);
  let any = false;
  for (let j = 0; j < n; j++) {
    const Z = FOG_RECT[1] + ((j + 0.5) / n) * FOG_RECT[3];
    for (let i = 0; i < n; i++) {
      const X = FOG_RECT[0] + ((i + 0.5) / n) * FOG_RECT[2];
      const { lat, lon } = toLatLon(X, Z);
      let best = 0;
      for (const src of sources) {
        const v = lookupKougenTenkiValue(src.grid, src.hourIndex, lat, lon);
        if (v && v.fog > best) best = v.fog;
      }
      if (best > 0) {
        raw[j * n + i] = best ** 1.3;
        any = true;
      }
    }
  }
  if (!any) return null;
  raw = boxBlur(boxBlur(raw, n, 2), n, 2);
  const out = new Uint8Array(n * n);
  for (let k = 0; k < out.length; k++) out[k] = Math.round(clamp(raw[k], 0, 1) * 255);
  return out;
}

// ---------------------------------------------------------------------------
// 地面の高さの地図
// ---------------------------------------------------------------------------

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** 地面の高さ(m。地形メッシュと同じ、地球の丸みで下がる分を含む)の地図。途中で画面が固まらないよう、少しずつ作る */
export async function buildHeightMap(
  groundAt: (X: number, Z: number) => number,
  cancelled: () => boolean,
): Promise<Float32Array | null> {
  const n = HEIGHT_MAP_SIZE;
  const out = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const Z = FOG_RECT[1] + ((j + 0.5) / n) * FOG_RECT[3];
    for (let i = 0; i < n; i++) {
      const X = FOG_RECT[0] + ((i + 0.5) / n) * FOG_RECT[2];
      out[j * n + i] = groundAt(X, Z);
    }
    if (j % 32 === 31) {
      await tick();
      if (cancelled()) return null;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 霧の色
// ---------------------------------------------------------------------------

/** 霧の色。昼は白っぽい灰色、朝夕は太陽の色が少し乗り、夜は暗い(地形と同じ光の強さで決める) */
export function layerFogColor(look: SkyLook): Vec3 {
  const sun = look.sunStrength * 0.45;
  const moon = look.moonStrength * 0.12;
  const tint: Vec3 = [0.97, 0.98, 1.0];
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    c[i] = clamp((look.ambient[i] * 0.85 + look.sunColor[i] * sun + look.moonColor[i] * moon) * tint[i], 0, 0.96);
  }
  return c;
}
