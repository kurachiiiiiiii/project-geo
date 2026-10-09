import { errorMessage } from "../../lib/errorMessage";
import { isNativeApp } from "../../lib/platform";
/**
 * 紅葉マップ: 植生GIS(環境省 自然環境保全基礎調査の1/25,000植生図)を樹種グループに集約した
 * 軽量グリッドの読み込み。
 *
 * 元の植生図は全国で数十GB規模のポリゴンデータで、そのままではアプリに載せられない。
 * `scripts/build-koyo-vegetation.py` (または `.mjs`) で、約250mメッシュ(緯度1/480°×経度1/320°。`--cell-scale 1` を付けると、
 * 従来の約500mメッシュ = 2次メッシュの1/16。緯度1/240°×経度1/160°)ごとに、紅葉の樹種グループ(`VEG_CLASS`)へ
 * 集約した1バイトのグリッドに変換し、次の2ファイルとして `public/data/` に置く:
 *
 *   koyoVegetation.json    … グリッドの範囲・刻み・出典などのメタデータ
 *   koyoVegetation.bin.gz  … uint8の行優先配列(rows×cols)をgzipしたもの
 *
 * ファイルが無い場合(まだ変換していない場合)は`status: "missing"`を返し、呼び出し側は
 * 標高帯モデル(`fallbackClassByAnnualTemp`)で代用する。グリッド上の255は「植生図の範囲外・未整備」で、
 * その場所も同様に標高帯モデルで代用する。
 */

/** 植生図の範囲外・未整備(標高帯モデルで代用する) */
export const VEG_UNKNOWN = 255;

export interface KoyoVegetationMeta {
  version: number;
  /** グリッド左端の経度 */
  west: number;
  /** グリッド上端の緯度 */
  north: number;
  /** 1セルの経度幅(度) */
  lonStep: number;
  /** 1セルの緯度幅(度) */
  latStep: number;
  cols: number;
  rows: number;
  /** 出典の表示用文字列 */
  source: string;
  /** 変換した日時(ISO8601) */
  generatedAt: string;
}

export interface KoyoVegetationGrid extends KoyoVegetationMeta {
  data: Uint8Array;
  /** 見ている場所のまわりの約50mメッシュ(あれば、約250mのグリッドより優先して引く)。`loadVegDetail` で作る */
  detail?: VegDetail;
}

/**
 * 約50mメッシュの「細かい植生」。全国を1枚にすると数GBになるので、512×512メッシュ(約25km四方)のタイルに分けて
 * `public/data/veg50/` に置いてあり(`scripts/build-koyo-vegetation.mjs --fine` が作る)、見ている場所のまわりのタイルだけを読む。
 * 読んでいないタイルの場所は、約250mのグリッドで代用する。
 */
export interface VegDetail {
  west: number;
  north: number;
  lonStep: number;
  latStep: number;
  cols: number;
  rows: number;
  /** タイルの一辺(メッシュ数) */
  tile: number;
  tilesX: number;
  /** 読み込み済みのタイル(キー = ty×tilesX+tx)。値は tile×tile バイト(255=植生図なし) */
  tiles: Map<number, Uint8Array>;
}

const NOT_LOADED = -1;

/** 約50mメッシュの植生クラス。そのタイルを読んでいなければ NOT_LOADED(-1) */
function detailCell(d: VegDetail, col: number, row: number): number {
  if (col < 0 || row < 0 || col >= d.cols || row >= d.rows) return NOT_LOADED;
  const tx = (col / d.tile) | 0;
  const ty = (row / d.tile) | 0;
  const t = d.tiles.get(ty * d.tilesX + tx);
  if (!t) return NOT_LOADED;
  return t[(row - ty * d.tile) * d.tile + (col - tx * d.tile)];
}

export type KoyoVegetationLoad =
  | { status: "ok"; grid: KoyoVegetationGrid }
  | { status: "missing" }
  | { status: "error"; message: string };

/** 緯度経度の位置の植生クラスコードを返す。グリッドの範囲外は`VEG_UNKNOWN` */
export function vegClassAt(grid: KoyoVegetationGrid, lat: number, lon: number): number {
  const dt = grid.detail;
  if (dt) {
    const c = detailCell(dt, Math.floor((lon - dt.west) / dt.lonStep), Math.floor((dt.north - lat) / dt.latStep));
    if (c !== NOT_LOADED) return c;
  }
  const col = Math.floor((lon - grid.west) / grid.lonStep);
  const row = Math.floor((grid.north - lat) / grid.latStep);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return VEG_UNKNOWN;
  return grid.data[row * grid.cols + col];
}

/** 整数の格子点の値ノイズ用(0〜1) */
function hash2(x: number, y: number): number {
  let h = Math.imul(x | 0, 0x27d4eb2f) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function valueNoise(x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  let tx = x - x0;
  let ty = y - y0;
  tx = tx * tx * (3 - 2 * tx);
  ty = ty * ty * (3 - 2 * ty);
  const a = hash2(x0, y0) * (1 - tx) + hash2(x0 + 1, y0) * tx;
  const b = hash2(x0, y0 + 1) * (1 - tx) + hash2(x0 + 1, y0 + 1) * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * 緯度経度の位置の植生クラスコード(3Dの木を立てる所用)。`vegClassAt` は、セルの中の全域を同じクラスにするので、
 * セルの境目が四角く目立つ。こちらは、位置を最大でセルの約0.45個ぶん(約150m〜250m)ゆらしてから、まわりの4セルを
 * 位置による重み(双線形)で多数決するので、境目が角ばらず、約半分のセル(2倍細かい)の入り組んだ境界になる。
 * (元の植生図に無い情報を足すものではなく、セルの境界をなめらかにするだけ。元データそのものを細かくするには、
 *  `scripts/build-koyo-vegetation.*` を `--cell-scale 2` で作り直す)
 */
export function vegClassAtFine(grid: KoyoVegetationGrid, lat: number, lon: number): number {
  const dt = grid.detail;
  if (dt && dt.tiles.size > 0) {
    // 約50mメッシュがあるところは、それを引く(ゆらしは約0.4セル=約20mだけ。境目が四角くならない程度)
    let fx = (lon - dt.west) / dt.lonStep - 0.5;
    let fy = (dt.north - lat) / dt.latStep - 0.5;
    const cx = Math.floor(fx + 0.5);
    const cy = Math.floor(fy + 0.5);
    if (detailCell(dt, cx, cy) !== NOT_LOADED) {
      fx += (valueNoise(fx * 3.1, fy * 3.1) - 0.5) * 0.8;
      fy += (valueNoise(fx * 3.1 + 17.3, fy * 3.1 + 5.7) - 0.5) * 0.8;
      const x0 = Math.floor(fx);
      const y0 = Math.floor(fy);
      const tx = fx - x0;
      const ty = fy - y0;
      const cell = (x: number, y: number): number => {
        const v = detailCell(dt, x, y);
        return v === NOT_LOADED ? detailCell(dt, cx, cy) : v;
      };
      const c = [cell(x0, y0), cell(x0 + 1, y0), cell(x0, y0 + 1), cell(x0 + 1, y0 + 1)];
      const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      let best = 0;
      let bestW = -1;
      for (let i = 0; i < 4; i++) {
        let sum = 0;
        for (let j = 0; j < 4; j++) if (c[j] === c[i]) sum += w[j];
        if (sum > bestW + 1e-9) {
          bestW = sum;
          best = c[i];
        }
      }
      return best;
    }
  }
  let fx = (lon - grid.west) / grid.lonStep - 0.5;
  let fy = (grid.north - lat) / grid.latStep - 0.5;
  fx += (valueNoise(fx * 3.1, fy * 3.1) - 0.5) * 0.9;
  fy += (valueNoise(fx * 3.1 + 17.3, fy * 3.1 + 5.7) - 0.5) * 0.9;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const cell = (x: number, y: number): number =>
    x >= 0 && y >= 0 && x < grid.cols && y < grid.rows ? grid.data[y * grid.cols + x] : VEG_UNKNOWN;
  const c = [cell(x0, y0), cell(x0 + 1, y0), cell(x0, y0 + 1), cell(x0 + 1, y0 + 1)];
  const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
  let best = 0;
  let bestW = -1;
  for (let i = 0; i < 4; i++) {
    let sum = 0;
    for (let j = 0; j < 4; j++) if (c[j] === c[i]) sum += w[j];
    if (sum > bestW + 1e-9) {
      bestW = sum;
      best = c[i];
    }
  }
  return best;
}

export function dataUrl(name: string): string {
  const base = import.meta.env.BASE_URL ?? "/";
  return `${base}data/${name}`;
}

/**
 * `public/data` の `.gz` のデータファイル(植生・豪雪地帯・50mタイル)を取得する。
 *
 * Androidアプリ(APK)にすると、ビルド(Android Gradle Plugin のアセットの取りまとめ)が、アセットの `*.gz` を
 * **展開して `.gz` を外した名前で入れてしまう**(`koyoVegetation.bin.gz` → `koyoVegetation.bin`。実機で
 * 「植生データ本体(koyoVegetation.bin.gz)がありません (HTTP 404)」になり、50mのタイルも全て読めず、約250mのまま
 * になっていた)。展開済みなので、中身はそのまま使える(`readGrid` は展開済みのバイトもそのまま受け取る)。
 * そのため、Androidアプリでは `.gz` を外した名前を先に取り、無ければ元の名前に戻る。ブラウザ(PWA・PC)は今までどおり
 * `.gz` の名前だけを取る(余分な問い合わせはしない)。
 */
export async function fetchGzAsset(name: string, init?: RequestInit): Promise<Response> {
  if (!isNativeApp() || !name.endsWith(".gz")) return fetch(dataUrl(name), init);
  const res = await fetch(dataUrl(name.slice(0, -3)), init);
  return res.status === 404 ? fetch(dataUrl(name), init) : res;
}

/** gzip の先頭2バイト(マジックナンバー) */
function isGzip(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === "undefined") {
    throw new Error("このブラウザはgzipの展開(DecompressionStream)に対応していません");
  }
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * 本体ファイル(.bin.gz)を読んで、展開済みのグリッド(1セル1バイト)を返す。
 *
 * 配信サーバーによっては `.gz` ファイルに `Content-Encoding: gzip` を付けて返す
 * (実際に `vite preview` がそうで、ブラウザが自動で展開してしまう)。その状態でさらに
 * こちらで展開しようとすると "Failed to fetch" になる(実際に起きた)。そのため:
 *   ・受け取ったバイト数が期待どおり(cols×rows)なら、既に展開済みとしてそのまま使う
 *   ・gzip の先頭(1f 8b)が付いていればこちらで展開する
 * のどちらでも動くようにしている。グリッドの値は 0〜8 と 255 だけで 0x8b(139)は現れないので、
 * 展開済みデータを gzip と取り違えることはない。
 */
export async function readGrid(res: Response, expectedBytes: number): Promise<Uint8Array> {
  const raw = new Uint8Array(await res.arrayBuffer());
  if (raw.length === expectedBytes && !isGzip(raw)) return raw;
  if (isGzip(raw)) return gunzip(raw);
  return raw;
}

/** 植生グリッドを読み込む。ファイルが無いときは `missing`(エラーではない) */
export async function loadKoyoVegetation(): Promise<KoyoVegetationLoad> {
  let metaRes: Response;
  try {
    metaRes = await fetch(dataUrl("koyoVegetation.json"), { cache: "no-cache" });
  } catch (e) {
    return { status: "error", message: `植生データの取得に失敗しました: ${errorMessage(e)}` };
  }
  if (!metaRes.ok) return { status: "missing" };

  const text = await metaRes.text();
  // 存在しないファイルに対し、アプリのindex.html(SPAフォールバック)がそのまま返ってくることがある
  if (text.trimStart().startsWith("<")) return { status: "missing" };

  let meta: KoyoVegetationMeta;
  try {
    meta = JSON.parse(text) as KoyoVegetationMeta;
  } catch {
    return { status: "error", message: "植生データのメタ情報(koyoVegetation.json)を解析できませんでした" };
  }
  if (!meta || meta.version !== 1 || !(meta.cols > 0) || !(meta.rows > 0) || !(meta.lonStep > 0) || !(meta.latStep > 0)) {
    return { status: "error", message: "植生データのメタ情報(koyoVegetation.json)の形式が想定と違います" };
  }

  try {
    const binRes = await fetchGzAsset("koyoVegetation.bin.gz", { cache: "no-cache" });
    if (!binRes.ok) {
      return { status: "error", message: `植生データ本体(koyoVegetation.bin.gz)がありません (HTTP ${binRes.status})` };
    }
    const data = await readGrid(binRes, meta.cols * meta.rows);
    if (data.length !== meta.cols * meta.rows) {
      return {
        status: "error",
        message: `植生データの大きさが合いません(期待 ${meta.cols * meta.rows} バイト、実際 ${data.length} バイト)`,
      };
    }
    return { status: "ok", grid: { ...meta, data } };
  } catch (e) {
    return { status: "error", message: `植生データの読み込みに失敗しました: ${errorMessage(e)}` };
  }
}

// ---------------------------------------------------------------------------
// 約50mメッシュ(public/data/veg50/ のタイル)の読み込み
// ---------------------------------------------------------------------------

interface VegDetailIndex {
  version: number;
  west: number;
  north: number;
  lonStep: number;
  latStep: number;
  cols: number;
  rows: number;
  tile: number;
  tilesX: number;
  tilesY: number;
  /** データのあるタイル [tx, ty] */
  tiles: [number, number][];
}

let detailIndexPromise: Promise<{ index: VegDetailIndex; present: Set<number> } | null> | null = null;
/** 読み込み済みのタイル(場所を変えても使い回す。古いものから捨てる) */
const detailTileCache = new Map<number, Uint8Array>();
const DETAIL_CACHE_MAX = 48;

function loadDetailIndex(): Promise<{ index: VegDetailIndex; present: Set<number> } | null> {
  if (!detailIndexPromise) {
    detailIndexPromise = (async () => {
      try {
        const res = await fetch(dataUrl("veg50/index.json"), { cache: "no-cache" });
        if (!res.ok) return null;
        const text = await res.text();
        if (text.trimStart().startsWith("<")) return null; // SPAフォールバックのindex.html
        const index = JSON.parse(text) as VegDetailIndex;
        if (!index || index.version !== 1 || !(index.tile > 0) || !Array.isArray(index.tiles)) return null;
        return { index, present: new Set(index.tiles.map(([tx, ty]) => ty * index.tilesX + tx)) };
      } catch {
        return null;
      }
    })();
  }
  return detailIndexPromise;
}

async function fetchDetailTile(index: VegDetailIndex, tx: number, ty: number): Promise<Uint8Array | null> {
  try {
    const res = await fetchGzAsset(`veg50/t${tx}_${ty}.bin.gz`);
    if (!res.ok) return null;
    const data = await readGrid(res, index.tile * index.tile);
    return data.length === index.tile * index.tile ? data : null;
  } catch {
    return null;
  }
}

/**
 * 緯度経度(lat, lon)から半径 radiusM(m)の範囲にかかる約50mメッシュのタイルを読んで返す。
 * 細かい植生のファイル(veg50)が無い・読めないときは null(約250mのグリッドのまま使う)。
 * 読み終えたタイルは取っておき、場所や範囲を変えたときに使い回す。
 */
export async function loadVegDetail(lat: number, lon: number, radiusM: number, isCancelled: () => boolean = () => false): Promise<VegDetail | null> {
  const idx = await loadDetailIndex();
  if (!idx || isCancelled()) return null;
  const { index, present } = idx;
  const dLat = radiusM / 111_320;
  const dLon = radiusM / (111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  const tileLon = index.tile * index.lonStep;
  const tileLat = index.tile * index.latStep;
  const tx0 = Math.max(0, Math.floor((lon - dLon - index.west) / tileLon));
  const tx1 = Math.min(index.tilesX - 1, Math.floor((lon + dLon - index.west) / tileLon));
  const ty0 = Math.max(0, Math.floor((index.north - (lat + dLat)) / tileLat));
  const ty1 = Math.min(index.tilesY - 1, Math.floor((index.north - (lat - dLat)) / tileLat));
  const wanted: [number, number, number][] = [];
  const mPerLat = 111_320;
  const mPerLon = 111_320 * Math.max(0.2, Math.cos((lat * Math.PI) / 180));
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const key = ty * index.tilesX + tx;
      if (!present.has(key)) continue;
      // 範囲は円。四角の角にだけかかる(円の外にある)タイルは読まない(最も近い点までの距離が半径より大きいタイル)
      const lonW = index.west + tx * tileLon;
      const latN = index.north - ty * tileLat;
      const nearDx = (Math.max(lonW, Math.min(lon, lonW + tileLon)) - lon) * mPerLon;
      const nearDy = (Math.max(latN - tileLat, Math.min(lat, latN)) - lat) * mPerLat;
      if (Math.hypot(nearDx, nearDy) > radiusM) continue;
      wanted.push([tx, ty, key]);
    }
  }
  const tiles = new Map<number, Uint8Array>();
  const queue = wanted.filter(([, , key]) => {
    const hit = detailTileCache.get(key);
    if (hit) {
      // 使ったものを、新しい側へ
      detailTileCache.delete(key);
      detailTileCache.set(key, hit);
      tiles.set(key, hit);
      return false;
    }
    return true;
  });
  let next = 0;
  const worker = async () => {
    while (next < queue.length && !isCancelled()) {
      const [tx, ty, key] = queue[next++];
      const data = await fetchDetailTile(index, tx, ty);
      if (data) {
        tiles.set(key, data);
        detailTileCache.set(key, data);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, worker));
  if (isCancelled()) return null;
  // 取っておく数を超えたら、古いものから捨てる(いま使っているタイルは Map で持っているので、使用中のものは消えない)
  while (detailTileCache.size > DETAIL_CACHE_MAX) {
    const oldest = detailTileCache.keys().next().value;
    if (oldest === undefined) break;
    detailTileCache.delete(oldest);
  }
  if (tiles.size === 0) return null;
  return {
    west: index.west,
    north: index.north,
    lonStep: index.lonStep,
    latStep: index.latStep,
    cols: index.cols,
    rows: index.rows,
    tile: index.tile,
    tilesX: index.tilesX,
    tiles,
  };
}
