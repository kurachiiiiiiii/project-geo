import { DEM_INVALID, DEM_TILE_SIZE, demToMeters, loadDemTile, loadDemTile5m } from "../koyo/koyoDem";
import { renderKoyoTile, type KoyoTileContext } from "../koyo/koyoRender";
import { TILE_PX, metersPerPx, smoothstep, worldPx } from "./viewerMath";
import { isLowMemoryDevice } from "./viewerQuality";

/**
 * 3Dビューワー: 地形(標高タイル)・下地の地図・紅葉メッシュの読み込みと、3Dの地形メッシュの生成。
 *
 * クリックした地点を原点(X=東・Z=南、m)にして、
 *   ・遠景: ズーム11のタイルで半径約25km(標高 約60m/画素。描画範囲を拡張したときは半径約50km)
 *   ・近景: ズーム13のタイルで半径約7km(標高 約15m/画素)
 * の2段で読む(処理「中・高」では、標高だけ、より細かいズーム12・14のタイルも読む。`viewerQuality.ts`の`terrainSpec`)。地形メッシュは原点を中心にした極座標の網目(近くは細かく、遠くは粗く)にして、
 * 足元の起伏と遠くの山並みの両方を少ない頂点で表す。下地の地図と紅葉メッシュは、同じタイルの範囲の
 * 画像(テクスチャ)にして地形へ貼る(近景の画像が遠景の画像の上に重なる)。
 */

/** 地形を作る半径(m) */
export const TERRAIN_RADIUS_M = 25_000;
/** 描画範囲を拡張したとき(約50km)の、地形を作る半径(m)と、遠景の標高タイルを読む半径(m) */
export const TERRAIN_RADIUS_WIDE_M = 50_000;
const FAR_ZOOM = 11;
const FAR_HALF_M = 26_000;
const FAR_HALF_WIDE_M = 52_000;
const NEAR_ZOOM = 13;
export const NEAR_HALF_M = 7_000;
/** 地形の標高を、近景から遠景の標高へ切り替える距離(m)の範囲 */
const HEIGHT_BLEND_FROM_M = 5_000;
const HEIGHT_BLEND_TO_M = 6_500;

/** 地球の丸みで遠くの地面が下がる分を計算するための値(大気差の係数0.13を含める) */
const EARTH_RADIUS_M = 6_371_000;
const REFRACTION_K = 0.13;

/** 距離 r(m) の地面が、丸みで下がる高さ(m) */
export function curvatureDropM(r: number): number {
  return ((1 - REFRACTION_K) * r * r) / (2 * EARTH_RADIUS_M);
}

export interface TileSet {
  z: number;
  tx0: number;
  ty0: number;
  nx: number;
  ny: number;
  /** 原点(クリック地点)の世界ピクセル座標(ズームz) */
  wx0: number;
  wy0: number;
  /** 範囲の中心の世界ピクセル座標(ズームz)。原点の周りの範囲なら原点と同じ。タイルを読む順番(中心に近い順)に使う */
  cwx: number;
  cwy: number;
  /** 1ピクセルが何mか */
  mpp: number;
  /** タイル範囲の、原点から見た西端(x0)・北端(z0)と東西・南北の大きさ(m) */
  rect: { x0: number; z0: number; sx: number; sz: number };
}

/**
 * 原点の周り ±halfM(m)を覆うタイルの範囲。
 * (cx, cz)(原点から見た位置。X東・Z南、m)を渡すと、原点ではなくその位置の周りを覆う(カメラについていく細かい地面の画像用)。
 * rect は、どちらの場合も原点から見た位置で持つ(地形のテクスチャの引き方が変わらない)。
 */
export function makeTileSet(lat0: number, lon0: number, z: number, halfM: number, cx = 0, cz = 0): TileSet {
  const { x: wx0, y: wy0 } = worldPx(lat0, lon0, z);
  const mpp = metersPerPx(lat0, z);
  const halfPx = halfM / mpp;
  const cwx = wx0 + cx / mpp;
  const cwy = wy0 + cz / mpp;
  const tx0 = Math.floor((cwx - halfPx) / TILE_PX);
  const tx1 = Math.floor((cwx + halfPx) / TILE_PX);
  const ty0 = Math.floor((cwy - halfPx) / TILE_PX);
  const ty1 = Math.floor((cwy + halfPx) / TILE_PX);
  const nx = tx1 - tx0 + 1;
  const ny = ty1 - ty0 + 1;
  return {
    z,
    tx0,
    ty0,
    nx,
    ny,
    wx0,
    wy0,
    cwx,
    cwy,
    mpp,
    rect: {
      x0: (tx0 * TILE_PX - wx0) * mpp,
      z0: (ty0 * TILE_PX - wy0) * mpp,
      sx: nx * TILE_PX * mpp,
      sz: ny * TILE_PX * mpp,
    },
  };
}

/** 一辺 2×halfM の範囲(中心はどこでもよい)を覆うタイルの、一辺あたりの最大の枚数(画像の大きさの確保用) */
export function maxTilesAcross(lat0: number, z: number, halfM: number): number {
  return Math.floor((2 * halfM) / (metersPerPx(lat0, z) * TILE_PX)) + 2;
}

export const farTileSet = (lat0: number, lon0: number, wide = false): TileSet =>
  makeTileSet(lat0, lon0, FAR_ZOOM, wide ? FAR_HALF_WIDE_M : FAR_HALF_M);
export const nearTileSet = (lat0: number, lon0: number): TileSet => makeTileSet(lat0, lon0, NEAR_ZOOM, NEAR_HALF_M);

export interface TileRef {
  tx: number;
  ty: number;
  index: number;
}

/** 原点に近いタイルから順に並べる(読み込みの途中でも近くから見えるように) */
export function tileRefs(set: TileSet): TileRef[] {
  const refs: TileRef[] = [];
  const cx = set.cwx / TILE_PX;
  const cy = set.cwy / TILE_PX;
  for (let j = 0; j < set.ny; j++) {
    for (let i = 0; i < set.nx; i++) refs.push({ tx: set.tx0 + i, ty: set.ty0 + j, index: j * set.nx + i });
  }
  refs.sort((a, b) => Math.hypot(a.tx + 0.5 - cx, a.ty + 0.5 - cy) - Math.hypot(b.tx + 0.5 - cx, b.ty + 0.5 - cy));
  return refs;
}

/** 同時に limit 件まで fn を走らせる(地図サーバーに一度に大量のリクエストを送らないため) */
export async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>, cancelled: () => boolean) {
  let next = 0;
  const worker = async () => {
    while (next < items.length && !cancelled()) {
      const item = items[next++];
      await fn(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// ---------------------------------------------------------------------------
// 標高
// ---------------------------------------------------------------------------

export interface DemSet {
  set: TileSet;
  /** タイルごとの標高(取得できなかった・海のタイルはnull)。並びは j*nx+i */
  tiles: (Uint16Array | null)[];
}

/**
 * 標高タイルを読む。fine=true なら、ズーム15の5mメッシュ標高(dem5a_png。約4m/画素)を読む
 * (その範囲に5mメッシュが無い所は、ズーム14のタイルを引き伸ばして使う)。
 */
export async function loadDemSet(set: TileSet, onTile: () => void, cancelled: () => boolean, fine = false): Promise<DemSet> {
  const tiles: (Uint16Array | null)[] = new Array(set.nx * set.ny).fill(null);
  await runPool(
    tileRefs(set),
    8,
    async (r) => {
      tiles[r.index] = fine ? await loadDemTile5m(r.tx, r.ty) : await loadDemTile(set.z, r.tx, r.ty);
      onTile();
    },
    cancelled,
  );
  return { set, tiles };
}

/** 原点から見た位置(X東・Z南、m)の標高(m)。タイルが無い(海など)・無効なら null */
export function demHeightAt(d: DemSet, X: number, Z: number): number | null {
  const s = d.set;
  const wx = s.wx0 + X / s.mpp - 0.5;
  const wy = s.wy0 + Z / s.mpp - 0.5;
  const x0 = Math.floor(wx);
  const y0 = Math.floor(wy);
  const fx = wx - x0;
  const fy = wy - y0;
  let sum = 0;
  let wsum = 0;
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 2; dx++) {
      const px = x0 + dx;
      const py = y0 + dy;
      const tx = Math.floor(px / DEM_TILE_SIZE) - s.tx0;
      const ty = Math.floor(py / DEM_TILE_SIZE) - s.ty0;
      if (tx < 0 || ty < 0 || tx >= s.nx || ty >= s.ny) continue;
      const tile = d.tiles[ty * s.nx + tx];
      if (!tile) continue;
      const v = tile[(py - (s.ty0 + ty) * DEM_TILE_SIZE) * DEM_TILE_SIZE + (px - (s.tx0 + tx) * DEM_TILE_SIZE)];
      if (v === DEM_INVALID) continue;
      const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy);
      sum += w * demToMeters(v);
      wsum += w;
    }
  }
  return wsum > 0.4 ? sum / wsum : null;
}

/** 足もとの細かい標高(ズーム15。半径 half m を読んだ)。その7割〜95%の間で、近景の標高へなめらかにつなぐ */
export interface DetailDem {
  dem: DemSet;
  half: number;
}

/**
 * 近景・遠景の標高を距離でなめらかにつないだ、位置(X東・Z南、m)の標高(m)。標高が無い所(海)は0。
 * nearHalfM は近景の標高を読んだ半径(m)で、その7割〜95%の間で遠景へ切り替える(既定は従来の約7km: 5km〜6.5km)。
 * detail があれば、足もとはそれ(より細かい標高)を使い、その半径の7割〜95%の間で近景・遠景の標高へつなぐ。
 */
export function makeHeightFn(
  near: DemSet,
  far: DemSet,
  nearHalfM = NEAR_HALF_M,
  detail?: DetailDem | null,
): (X: number, Z: number) => number {
  const from = nearHalfM === NEAR_HALF_M ? HEIGHT_BLEND_FROM_M : nearHalfM * 0.72;
  const to = nearHalfM === NEAR_HALF_M ? HEIGHT_BLEND_TO_M : nearHalfM * 0.95;
  const dFrom = detail ? detail.half * 0.7 : 0;
  const dTo = detail ? detail.half * 0.95 : 0;
  const base = (X: number, Z: number, r: number): number | null => {
    const hf = demHeightAt(far, X, Z);
    const hn = r < to + 200 ? demHeightAt(near, X, Z) : null;
    if (hn === null && hf === null) return null;
    if (hn === null) return hf as number;
    if (hf === null) return hn;
    const w = smoothstep(from, to, r);
    return hn * (1 - w) + hf * w;
  };
  return (X, Z) => {
    const r = Math.hypot(X, Z);
    const b = base(X, Z, r);
    if (detail && r < dTo + 100) {
      const hd = demHeightAt(detail.dem, X, Z);
      if (hd !== null) {
        if (b === null) return hd;
        return hd * (1 - smoothstep(dFrom, dTo, r)) + b * smoothstep(dFrom, dTo, r);
      }
    }
    return b ?? 0;
  };
}

// ---------------------------------------------------------------------------
// 地形メッシュ(原点を中心にした極座標の網目)
// ---------------------------------------------------------------------------

export interface TerrainMesh {
  /** 頂点の位置(x,y,z)×頂点数 */
  positions: Float32Array;
  /** 頂点の法線(x,y,z)×頂点数 */
  normals: Float32Array;
  indices: Uint32Array;
  rings: number;
  segs: number;
}

/** 地形メッシュの細かさ(`viewerQuality.ts`の`TerrainSpec.mesh`) */
export interface MeshDetail {
  /** 最も細かい輪の間隔(m) */
  minStep: number;
  /** 輪の間隔を、半径の何割にするか(これより近くは minStep) */
  growth: number;
  /** 1周の分割数 */
  segs: number;
}

/** 既定(処理「低」)の細かさ: 近くは約16m刻み、遠くは半径の約2.2%刻み、1周720分割 */
export const MESH_DETAIL_LOW: MeshDetail = { minStep: 16, growth: 0.022, segs: 720 };

/** 中心から外側へ、半径ごとの輪の位置(m) */
function ringRadii(rMax: number, minStep: number, growth: number): number[] {
  const radii = [0];
  let r = 0;
  while (r < rMax) {
    r += Math.max(minStep, r * growth);
    radii.push(Math.min(r, rMax));
  }
  return radii;
}

export function buildTerrainMesh(
  heightAt: (X: number, Z: number) => number,
  rMax = TERRAIN_RADIUS_M,
  detail: MeshDetail = MESH_DETAIL_LOW,
): TerrainMesh {
  const radii = ringRadii(rMax, detail.minStep, detail.growth);
  const rings = radii.length;
  const segs = detail.segs;
  const positions = new Float32Array(rings * segs * 3);

  for (let i = 0; i < rings; i++) {
    const r = radii[i];
    const drop = curvatureDropM(r);
    for (let j = 0; j < segs; j++) {
      const th = (j / segs) * Math.PI * 2; // 北から時計回り
      const X = r * Math.sin(th);
      const Z = -r * Math.cos(th);
      const o = (i * segs + j) * 3;
      positions[o] = X;
      positions[o + 1] = i === 0 ? heightAt(0, 0) : heightAt(X, Z) - drop;
      positions[o + 2] = Z;
    }
  }
  // 中心の輪は全頂点が同じ高さ
  const centerY = positions[1];
  for (let j = 0; j < segs; j++) positions[j * 3 + 1] = centerY;

  const normals = new Float32Array(rings * segs * 3);
  const P = (i: number, j: number, k: number) => positions[(i * segs + ((j + segs) % segs)) * 3 + k];
  for (let i = 1; i < rings; i++) {
    const i0 = Math.max(1, i - 1);
    const i1 = Math.min(rings - 1, i + 1);
    for (let j = 0; j < segs; j++) {
      const tx = P(i, j + 1, 0) - P(i, j - 1, 0);
      const ty = P(i, j + 1, 1) - P(i, j - 1, 1);
      const tz = P(i, j + 1, 2) - P(i, j - 1, 2);
      const rx = P(i1, j, 0) - P(i0, j, 0);
      const ry = P(i1, j, 1) - P(i0, j, 1);
      const rz = P(i1, j, 2) - P(i0, j, 2);
      // 接線(時計回り)×放射(外向き)=上向き
      let nx = ty * rz - tz * ry;
      let ny = tz * rx - tx * rz;
      let nz = tx * ry - ty * rx;
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const o = (i * segs + j) * 3;
      normals[o] = nx;
      normals[o + 1] = ny;
      normals[o + 2] = nz;
    }
  }
  // 中心の輪の法線は、1つ外の輪の平均
  let sx = 0;
  let sy = 0;
  let sz = 0;
  for (let j = 0; j < segs; j++) {
    const o = (segs + j) * 3;
    sx += normals[o];
    sy += normals[o + 1];
    sz += normals[o + 2];
  }
  const sl = Math.hypot(sx, sy, sz) || 1;
  for (let j = 0; j < segs; j++) {
    normals[j * 3] = sx / sl;
    normals[j * 3 + 1] = sy / sl;
    normals[j * 3 + 2] = sz / sl;
  }

  const indices = new Uint32Array((rings - 1) * segs * 6);
  let k = 0;
  for (let i = 0; i < rings - 1; i++) {
    for (let j = 0; j < segs; j++) {
      const a = i * segs + j;
      const b = i * segs + ((j + 1) % segs);
      const c = (i + 1) * segs + j;
      const d = (i + 1) * segs + ((j + 1) % segs);
      indices[k++] = a;
      indices[k++] = c;
      indices[k++] = b;
      indices[k++] = b;
      indices[k++] = c;
      indices[k++] = d;
    }
  }
  return { positions, normals, indices, rings, segs };
}

// ---------------------------------------------------------------------------
// 地面の下地(国土地理院 標準地図 / 全国最新写真=衛星・航空写真)
// ---------------------------------------------------------------------------

/** 地面に貼る画像の種類。standard=標準地図、photo=衛星画像(国土地理院の全国最新写真) */
export type GroundKind = "std" | "photo";

function groundTileUrl(kind: GroundKind, z: number, x: number, y: number): string {
  return kind === "std"
    ? `https://cyberjapandata.gsi.go.jp/xyz/std/${z}/${x}/${y}.png`
    : `https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/${z}/${x}/${y}.jpg`;
}

/**
 * タイルを並べた1枚の画像。取得できなかったタイルは地図なら淡い色、写真なら暗めの灰緑で埋める。
 * zoomUp>0 のときは、set と同じ範囲を、ズームが zoomUp 段細かいタイルで描く(画像の大きさは 2^zoomUp 倍)。
 * そのとき underlay(同じ範囲を粗いズームで描いた画像)があれば、先に引き伸ばして敷く
 * (細かいタイルが無い所・読めなかった所が、灰緑で抜けないように)。
 */
/** 「画像が無い」ことを表す応答(やり直しても同じなので、やり直さない)。国土地理院は、写真の無いタイルを404で返す */
const NO_TILE_STATUS = new Set([400, 403, 404, 410]);

/**
 * 時間切れつきの fetch。通信が途中で止まったまま返ってこないと(電波の弱い所など)、そのタイルを待つ読み込みが
 * いつまでも終わらず、次の読み直しも始まらなくなる(「地面の画像がずっと読み込まれない」)ので、ms ミリ秒で打ち切る(例外になる)。
 */
export async function fetchWithTimeout(url: string, ms: number, init?: RequestInit): Promise<Response> {
  if (typeof AbortController === "undefined") return fetch(url, init);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { ...init, signal: ac.signal });
    // 本体の読み込みも時間切れの対象にする(ヘッダーだけ届いて本体が止まることがある)
    const blob = await res.blob();
    return new Response(blob, { status: res.status, statusText: res.statusText, headers: res.headers });
  } finally {
    clearTimeout(timer);
  }
}

/** 地面のタイル1回の読み込みの時間切れ(ms) */
const GROUND_TILE_TIMEOUT_MS = 15_000;

/**
 * 読んだ地面のタイル(JPEG・PNGのまま。1枚およそ10〜40KB)を、合計の大きさの上限まで取っておく(古いものから捨てる)。
 * カメラについていく下地は、動くたびに窓を読み直すが、前の窓と重なるタイルは通信せずにここから使うので、
 * 読み直しが速くなる(移動中に先の画像が間に合いやすい)。画像に戻す(createImageBitmap)のは、使うときに毎回行う。
 */
const groundBytes = new Map<string, Blob>();
let groundBytesTotal = 0;
const groundBytesMax = (): number => (isLowMemoryDevice() ? 24 : 64) * 1024 * 1024;

function rememberGroundTile(url: string, blob: Blob): void {
  const old = groundBytes.get(url);
  if (old) {
    groundBytesTotal -= old.size;
    groundBytes.delete(url);
  }
  groundBytes.set(url, blob);
  groundBytesTotal += blob.size;
  const max = groundBytesMax();
  while (groundBytesTotal > max && groundBytes.size > 0) {
    const first = groundBytes.keys().next();
    if (first.done) break;
    const b = groundBytes.get(first.value);
    groundBytesTotal -= b?.size ?? 0;
    groundBytes.delete(first.value);
  }
}

/**
 * 地面のタイル1枚を読む(画像には戻さず、JPEG・PNGのまま返す)。通信エラー・サーバーの混雑(429・5xx)・時間切れなど一時的な失敗は、
 * 少し待って最大2回やり直す(以前は1回の失敗でそのタイルが空白のまま残り、「近くなのに地面の画像が読み込まれない」ように見えた)。
 * 画像の無いタイル(404など)はやり直さない。前に読んだタイルは、取っておいたもの(`groundBytes`)を使う。
 * 戻り値: 中身(blob。fetch の無い古いブラウザでは img)、無ければ両方 null と、一時的な失敗のまま終わったか。
 */
async function fetchGroundTile(
  url: string,
  cancelled: () => boolean,
): Promise<{ blob: Blob | null; img: HTMLImageElement | null; transientFail: boolean }> {
  const canFetch = typeof fetch === "function" && typeof createImageBitmap === "function";
  if (canFetch) {
    const kept = groundBytes.get(url);
    if (kept) {
      // よく使うものを後ろへ(古いものから捨てるため)
      groundBytes.delete(url);
      groundBytes.set(url, kept);
      return { blob: kept, img: null, transientFail: false };
    }
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    if (cancelled()) return { blob: null, img: null, transientFail: false };
    if (attempt > 0) await new Promise<void>((r) => setTimeout(r, attempt === 1 ? 700 : 1800));
    try {
      if (canFetch) {
        const res = await fetchWithTimeout(url, GROUND_TILE_TIMEOUT_MS, { mode: "cors" });
        if (res.ok) {
          const blob = await res.blob();
          if (blob.size > 0) rememberGroundTile(url, blob);
          return { blob, img: null, transientFail: false };
        }
        if (NO_TILE_STATUS.has(res.status)) return { blob: null, img: null, transientFail: false };
      } else {
        const img = await new Promise<HTMLImageElement | null>((resolve) => {
          const im = new Image();
          im.crossOrigin = "anonymous";
          const timer = setTimeout(() => {
            im.src = "";
            resolve(null);
          }, GROUND_TILE_TIMEOUT_MS);
          im.onload = () => {
            clearTimeout(timer);
            resolve(im);
          };
          im.onerror = () => {
            clearTimeout(timer);
            resolve(null);
          };
          im.src = url;
        });
        if (img) return { blob: null, img, transientFail: false };
      }
    } catch {
      /* 通信エラー・時間切れ: やり直す */
    }
  }
  return { blob: null, img: null, transientFail: true };
}

/**
 * 大きな画像(canvas)を作って貼る処理を、1つずつ順番に行うための鍵。
 * 遠景・近景・カメラについていく下地(4種類)を同時に読むと、数千px四方のcanvasが同時に5〜6枚(数百MB)できて、
 * メモリ不足で落ちやすい。タイルの通信は同時に進めたまま、canvasを作って描いてGPUへ貼るところだけを順番にする。
 */
let composeChain: Promise<void> = Promise.resolve();
function withComposeLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = composeChain.then(fn, fn);
  composeChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function loadGroundCanvas(
  kind: GroundKind,
  set: TileSet,
  onTile: () => void,
  cancelled: () => boolean,
  zoomUp = 0,
  underlay?: HTMLCanvasElement,
  /** true なら下地の色で塗らず、タイルの無い所を透明にする(足もとの細かい画像用) */
  transparent = false,
  /** 一時的な失敗(やり直しても読めなかったタイルの数)を受け取る */
  stats?: { failed: number },
  /**
   * できた画像を使う処理(GPUへ貼るなど)。渡すと、canvasを作るところから、これを呼び終えるまでを、ほかの大きな画像と
   * 重ならないように順番に行う(`withComposeLock`)。canvasを手放すのは呼ぶ側
   */
  consume?: (canvas: HTMLCanvasElement) => void,
): Promise<HTMLCanvasElement> {
  const k = 2 ** zoomUp;
  const z = set.z + zoomUp;
  // 1) タイルを読む(画像に戻さず、小さいまま持つ)。この間はcanvasを作らない
  const got: { x: number; y: number; blob: Blob | null; img: HTMLImageElement | null }[] = [];
  await runPool(
    groundTileRefs(set, zoomUp),
    8,
    async (r) => {
      const t = await fetchGroundTile(groundTileUrl(kind, z, r.tx, r.ty), cancelled);
      if (t.blob || t.img) got.push({ x: (r.tx - set.tx0 * k) * TILE_PX, y: (r.ty - set.ty0 * k) * TILE_PX, blob: t.blob, img: t.img });
      else if (t.transientFail && stats) stats.failed++;
      onTile();
    },
    cancelled,
  );
  // 2) canvasを作って描く(ほかの大きな画像と順番に)
  return withComposeLock(async () => {
    const canvas = document.createElement("canvas");
    canvas.width = set.nx * TILE_PX * k;
    canvas.height = set.ny * TILE_PX * k;
    const c2d = canvas.getContext("2d");
    if (!c2d) {
      canvas.width = 0;
      canvas.height = 0;
      throw new Error("canvasを使えません(メモリ不足の可能性)");
    }
    try {
      if (!transparent) {
        c2d.fillStyle = kind === "std" ? "#e4e2d8" : "#59614f";
        c2d.fillRect(0, 0, canvas.width, canvas.height);
      }
      if (underlay) {
        c2d.imageSmoothingEnabled = true;
        c2d.imageSmoothingQuality = "high";
        c2d.drawImage(underlay, 0, 0, canvas.width, canvas.height);
      }
      if (!cancelled()) {
        await runPool(
          got,
          8,
          async (g) => {
            if (g.img) {
              c2d.drawImage(g.img, g.x, g.y, TILE_PX, TILE_PX);
              return;
            }
            if (!g.blob) return;
            let bmp: ImageBitmap | null = null;
            try {
              bmp = await createImageBitmap(g.blob);
            } catch {
              // 壊れたタイルは描かない
            }
            if (bmp) {
              c2d.drawImage(bmp, g.x, g.y, TILE_PX, TILE_PX);
              bmp.close();
            }
          },
          cancelled,
        );
      }
      got.length = 0;
      if (consume && !cancelled()) consume(canvas);
    } catch (e) {
      canvas.width = 0;
      canvas.height = 0;
      throw e;
    }
    return canvas;
  });
}

/** 地面の画像のタイル(set の範囲を、ズームを zoomUp 段上げて覆うもの)。原点に近い順 */
function groundTileRefs(set: TileSet, zoomUp: number): { tx: number; ty: number }[] {
  if (zoomUp === 0) return tileRefs(set);
  const k = 2 ** zoomUp;
  const refs: { tx: number; ty: number }[] = [];
  for (let j = 0; j < set.ny * k; j++) {
    for (let i = 0; i < set.nx * k; i++) refs.push({ tx: set.tx0 * k + i, ty: set.ty0 * k + j });
  }
  const cx = (set.cwx * k) / TILE_PX;
  const cy = (set.cwy * k) / TILE_PX;
  refs.sort((a, b) => Math.hypot(a.tx + 0.5 - cx, a.ty + 0.5 - cy) - Math.hypot(b.tx + 0.5 - cx, b.ty + 0.5 - cy));
  return refs;
}

/** 地面の画像を読むタイルの数(進み具合の表示用) */
export const groundTileCount = (set: TileSet, zoomUp: number): number => set.nx * set.ny * 4 ** zoomUp;

// ---------------------------------------------------------------------------
// 紅葉メッシュ(地図の紅葉マップと同じ計算で、タイルごとに描いて並べる)
// ---------------------------------------------------------------------------

export interface OverlayImage {
  /** 乗算済みアルファのRGBA */
  data: Uint8Array;
  width: number;
  height: number;
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function buildKoyoOverlay(
  set: TileSet,
  dem: DemSet,
  ctx: KoyoTileContext,
  cancelled: () => boolean,
): Promise<OverlayImage> {
  const width = set.nx * TILE_PX;
  const height = set.ny * TILE_PX;
  const data = new Uint8Array(width * height * 4);
  const out = new Uint8ClampedArray(TILE_PX * TILE_PX * 4);
  const refs = tileRefs(set);
  for (let n = 0; n < refs.length; n++) {
    if (cancelled()) break;
    const r = refs[n];
    const tile = dem.tiles[r.index];
    if (tile) {
      out.fill(0);
      renderKoyoTile(tile, set.z, r.tx, r.ty, ctx, out);
      const ox = (r.tx - set.tx0) * TILE_PX;
      const oy = (r.ty - set.ty0) * TILE_PX;
      for (let y = 0; y < TILE_PX; y++) {
        let src = y * TILE_PX * 4;
        let dst = ((oy + y) * width + ox) * 4;
        for (let x = 0; x < TILE_PX; x++, src += 4, dst += 4) {
          const a = out[src + 3];
          if (a === 0) continue;
          data[dst] = Math.round((out[src] * a) / 255);
          data[dst + 1] = Math.round((out[src + 1] * a) / 255);
          data[dst + 2] = Math.round((out[src + 2] * a) / 255);
          data[dst + 3] = a;
        }
      }
    }
    if (n % 3 === 2) await tick();
  }
  return { data, width, height };
}

