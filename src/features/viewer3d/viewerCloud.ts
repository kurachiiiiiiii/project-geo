import { CLOUD_FULL, CLOUD_MESH_BOUNDS, CLOUD_PARTIAL, computeCloudMeshGrid } from "../../lib/cloudMesh";
import { parseValidTime, type SatelliteFrame } from "../satellite/satelliteService";
import { DEG, clamp, type Vec3 } from "./viewerMath";
import type { SkyLook } from "./viewerSky";

/**
 * 3Dビューワー: 衛星画像の「雲判定メッシュ」(白=雲あり・グレー=半分くらい・透明=雲なし。地図の衛星画像バーの
 * 「メッシュ」と同じもの)を、空の雲の層として描く。
 *
 * ここでは、使う衛星のコマ(最新の実測コマ=現在の雲だけ。過去のコマ・予測のコマは使わない)の選択と、
 * 描画器(`viewerGl.ts`)へ渡す「雲の濃さの地図」の作成を受け持つ。雲そのものの描き方(視線が雲の層を通る長さ)はシェーダー側。
 *   ・地図は原点から±120kmを覆う384×384(R8。白=255、グレー=66≒0.26、雲なし=0)
 *   ・雲の層は、海抜(雲の高さ。既定は上空7,000m)から厚さ800mの水平な層。雲判定メッシュに高さの情報は無いので、高さは設定で変えられる
 */

/** 雲の地図が覆う範囲(原点から±m)と解像度 */
export const CLOUD_HALF_M = 120_000;
export const CLOUD_RECT: [number, number, number, number] = [-CLOUD_HALF_M, -CLOUD_HALF_M, CLOUD_HALF_M * 2, CLOUD_HALF_M * 2];
export const CLOUD_MAP_SIZE = 384;

/** 雲の層の厚さ(m)と、既定の高さ(海抜m)、スライダーの範囲 */
export const CLOUD_THICK_M = 800;
export const CLOUD_ALT_DEFAULT_M = 7000;
export const CLOUD_ALT_MIN_M = 1000;
export const CLOUD_ALT_MAX_M = 8000;
/** 雲あり(白)の層を真上から見たときの光学的厚み(≒96%不透明)。グレー(半分)は地図の値0.26をかけて約6割の不透明になる */
export const CLOUD_TAU_VERTICAL = 3.2;

const GRAY_LEVEL = 66;

export interface ViewerCloudSource {
  /** 実測コマ(古い→新しい順)。使うのは最新の1コマだけ(現在の雲) */
  observed: SatelliteFrame[];
}

export interface CloudPick {
  /** 使うコマが変わったかどうかの判定用 */
  key: string;
  frame: SatelliteFrame;
  /** 画面に出す説明(例: "10/06 12:30") */
  label: string;
}

function shortTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * 使う衛星のコマ=最新の実測コマ(現在の雲)。見ている日付・時刻を動かしても雲は変わらない
 * (「雲は現在のみで、過去の部分は必要ない」という要望のため、日時に合うコマを探す処理はやめた)。コマが1つも無いときだけnull。
 */
export function pickCloudFrame(src: ViewerCloudSource): CloudPick | null {
  const f = src.observed[src.observed.length - 1];
  if (!f) return null;
  return { key: `o:${f.validtime}`, frame: f, label: shortTime(parseValidTime(f.validtime).getTime()) };
}

// ---------------------------------------------------------------------------
// 雲判定メッシュの読み込み
// ---------------------------------------------------------------------------

export interface CloudCells {
  gw: number;
  gh: number;
  /** CLOUD_NONE / CLOUD_PARTIAL / CLOUD_FULL。北西→南東、行優先 */
  cells: Uint8Array;
  south: number;
  west: number;
  north: number;
  east: number;
}

const cache = new Map<string, Promise<CloudCells>>();

/** 選んだコマの雲判定メッシュ。地図と同じ計算(`computeCloudMeshGrid`、ひまわりの赤外タイル)で作る。同じコマは使い回す */
export function loadCloudCells(pick: CloudPick): Promise<CloudCells> {
  const hit = cache.get(pick.key);
  if (hit) return hit;
  const p: Promise<CloudCells> = computeCloudMeshGrid(pick.frame).then((g) => ({
    gw: g.gw,
    gh: g.gh,
    cells: g.cells,
    south: CLOUD_MESH_BOUNDS.getSouth(),
    west: CLOUD_MESH_BOUNDS.getWest(),
    north: CLOUD_MESH_BOUNDS.getNorth(),
    east: CLOUD_MESH_BOUNDS.getEast(),
  }));
  cache.set(pick.key, p);
  // 失敗したものは覚えない(次に開いたとき取り直す)。覚える数にも上限を付ける
  p.catch(() => cache.delete(pick.key));
  if (cache.size > 8) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return p;
}

// ---------------------------------------------------------------------------
// 雲の濃さの地図
// ---------------------------------------------------------------------------

const mercY = (latDeg: number) => Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG) / 2));

/**
 * 原点から±120kmの雲の濃さの地図(0〜255)。メッシュの行は、地図の画像オーバーレイと同じく
 * Web Mercatorの縦方向で等間隔に並んでいるものとして位置を求める(`cloudMesh.ts`の「修正2」と同じ)。
 * 雲が1か所も無ければnull。
 */
export function buildCloudMap(
  c: CloudCells,
  toLatLon: (X: number, Z: number) => { lat: number; lon: number },
): Uint8Array | null {
  const n = CLOUD_MAP_SIZE;
  const out = new Uint8Array(n * n);
  const pN = mercY(c.north);
  const pS = mercY(c.south);
  let any = false;
  for (let j = 0; j < n; j++) {
    const Z = CLOUD_RECT[1] + ((j + 0.5) / n) * CLOUD_RECT[3];
    for (let i = 0; i < n; i++) {
      const X = CLOUD_RECT[0] + ((i + 0.5) / n) * CLOUD_RECT[2];
      const { lat, lon } = toLatLon(X, Z);
      const u = (lon - c.west) / (c.east - c.west);
      const v = (pN - mercY(lat)) / (pN - pS);
      if (u < 0 || u >= 1 || v < 0 || v >= 1) continue;
      const cell = c.cells[Math.floor(v * c.gh) * c.gw + Math.floor(u * c.gw)];
      if (cell === CLOUD_FULL) {
        out[j * n + i] = 255;
        any = true;
      } else if (cell === CLOUD_PARTIAL) {
        out[j * n + i] = GRAY_LEVEL;
        any = true;
      }
    }
  }
  return any ? out : null;
}

/** 雲の色。昼は白、朝夕は太陽の色が少し乗り、夜は暗い(霧と同じ光の強さで決める。霧よりは明るい白) */
export function layerCloudColor(look: SkyLook): Vec3 {
  const sun = look.sunStrength * 0.55;
  const moon = look.moonStrength * 0.15;
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    c[i] = clamp(look.ambient[i] * 0.95 + look.sunColor[i] * sun + look.moonColor[i] * moon, 0, 1);
  }
  return c;
}
