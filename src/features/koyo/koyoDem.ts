import { errorMessage } from "../../lib/errorMessage";
/**
 * 紅葉マップ: 国土地理院の標高タイル(DEM PNG)の取得・デコード。
 *
 * 標高タイル: https://cyberjapandata.gsi.go.jp/xyz/dem_png/{z}/{x}/{y}.png (ズーム0〜14)
 * 画素値(R,G,B)から標高h(m)を求める式(国土地理院の仕様):
 *   x = 2^16×R + 2^8×G + B
 *   x < 2^23 のとき h = x × 0.01 / x = 2^23 のとき無効値 / x > 2^23 のとき h = (x − 2^24) × 0.01
 * 無効値は(R,G,B)=(128,0,0)。
 *
 * 1タイルを`Uint16Array`(0.1m単位、−100mのオフセット付き。無効は`DEM_INVALID`)で保持して、
 * 日付や補正を変えて描き直すたびに再取得しないようキャッシュする。
 */

export const DEM_TILE_SIZE = 256;
export const DEM_INVALID = 65535;
const DEM_OFFSET_M = 100;

/** タイルの標高値(0.1m単位のUint16)をメートルに戻す */
export function demToMeters(v: number): number {
  return v / 10 - DEM_OFFSET_M;
}

/** RGBA画素列(256×256×4)から標高配列を作る */
export function decodeDemRgba(rgba: ArrayLike<number>): Uint16Array {
  const n = DEM_TILE_SIZE * DEM_TILE_SIZE;
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) {
    const r = rgba[i * 4];
    const g = rgba[i * 4 + 1];
    const b = rgba[i * 4 + 2];
    const x = r * 65536 + g * 256 + b;
    if (x === 8388608 || rgba[i * 4 + 3] === 0) {
      out[i] = DEM_INVALID;
      continue;
    }
    const h = (x < 8388608 ? x : x - 16777216) * 0.01;
    const v = Math.round((h + DEM_OFFSET_M) * 10);
    out[i] = v < 0 ? 0 : v >= DEM_INVALID ? DEM_INVALID - 1 : v;
  }
  return out;
}

function demUrl(z: number, x: number, y: number, layer = "dem_png"): string {
  return `https://cyberjapandata.gsi.go.jp/xyz/${layer}/${z}/${x}/${y}.png`;
}

const CACHE_LIMIT = 220;
const cache = new Map<string, Promise<Uint16Array | null>>();

/**
 * 取得状況の記録(画面に「標高タイルを取得できません」と出すかどうかの判断用)。
 * 海上のタイルなどは正常でも404になるため、1枚の失敗ではエラー扱いにせず、
 * 「1枚も読めていないのに失敗が続いている」ときだけ問題とみなす。
 */
let okCount = 0;
let failCount = 0;
let lastFailMessage = "";

/** 標高タイルが1枚も読めない状態が続いているときだけエラーメッセージを返す */
export function demLoadProblem(): string | null {
  return okCount === 0 && failCount >= 3 ? lastFailMessage : null;
}

function decodeFromImage(img: HTMLImageElement): Uint16Array {
  const canvas = document.createElement("canvas");
  canvas.width = DEM_TILE_SIZE;
  canvas.height = DEM_TILE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvasを使えません");
  ctx.drawImage(img, 0, 0);
  // クロスオリジンの画像でCORSが許可されていないと、ここで例外(SecurityError)になる
  const data = ctx.getImageData(0, 0, DEM_TILE_SIZE, DEM_TILE_SIZE).data;
  return decodeDemRgba(data);
}

/**
 * 標高タイルを取得する。タイルが無い(海など)・取得に失敗した場合は null。
 * 同じタイルへの同時リクエストは1つにまとめ、直近`CACHE_LIMIT`枚をキャッシュする。
 */
/** 標高タイル1枚の読み込みの時間切れ(ms) */
const DEM_TIMEOUT_MS = 20_000;

export function loadDemTile(z: number, x: number, y: number, layer = "dem_png"): Promise<Uint16Array | null> {
  const key = layer === "dem_png" ? `${z}/${x}/${y}` : `${layer}/${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) {
    // LRU: 参照したものを末尾へ
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const p = new Promise<Uint16Array | null>((resolve) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    // 通信が止まったまま返ってこないときは、20秒で打ち切る(読み込み全体が止まらないように)。打ち切ったものは取っておかない(次は読み直す)
    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      img.src = "";
      failCount++;
      lastFailMessage = "標高タイルの読み込みが時間切れになりました";
      if (cache.get(key) === p) cache.delete(key);
      resolve(null);
    }, DEM_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      try {
        const dem = decodeFromImage(img);
        okCount++;
        resolve(dem);
      } catch (e) {
        failCount++;
        lastFailMessage = `標高タイルを読み取れません: ${errorMessage(e)}`;
        resolve(null);
      }
    };
    img.onerror = () => {
      clearTimeout(timer);
      // 海上など、タイルが存在しない場合も onerror(404) になる(demLoadProblemの説明参照)
      failCount++;
      lastFailMessage = "標高タイルを取得できません(通信エラー、または範囲外)";
      resolve(null);
    };
    img.src = demUrl(z, x, y, layer);
  });
  cache.set(key, p);
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  return p;
}

/**
 * 緯度経度の標高(m)を、ズーム14の標高タイルから求める。取得できなければ null。
 * 地点をクリックしたときの「この地点の紅葉時期」の標高に使う。
 */
export async function elevationAt(lat: number, lon: number): Promise<number | null> {
  const z = 14;
  const n = 2 ** z;
  const fx = ((lon + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const fy = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const tx = Math.floor(fx);
  const ty = Math.floor(fy);
  const dem = await loadDemTile(z, tx, ty);
  if (!dem) return null;
  const px = Math.min(DEM_TILE_SIZE - 1, Math.floor((fx - tx) * DEM_TILE_SIZE));
  const py = Math.min(DEM_TILE_SIZE - 1, Math.floor((fy - ty) * DEM_TILE_SIZE));
  const v = dem[py * DEM_TILE_SIZE + px];
  return v === DEM_INVALID ? null : demToMeters(v);
}

/**
 * 親のタイル(1段粗いズーム)の、1/4の範囲(qx,qy は 0 か 1)を、256×256に双線形補間で引き伸ばしたタイルを返す。
 * 5mメッシュの標高(ズーム15)が無い所を、ズーム14の標高で埋めるのに使う。無効値は最も近い有効値で埋めてから補間する。
 */
export function upsampleQuadrant(parent: Uint16Array, qx: number, qy: number): Uint16Array {
  const N = DEM_TILE_SIZE;
  const out = new Uint16Array(N * N);
  const at = (px: number, py: number): number => {
    const cx = Math.min(N - 1, Math.max(0, px));
    const cy = Math.min(N - 1, Math.max(0, py));
    return parent[cy * N + cx];
  };
  for (let y = 0; y < N; y++) {
    const fy = qy * (N / 2) + (y + 0.5) / 2 - 0.5;
    const y0 = Math.floor(fy);
    const ty = fy - y0;
    for (let x = 0; x < N; x++) {
      const fx = qx * (N / 2) + (x + 0.5) / 2 - 0.5;
      const x0 = Math.floor(fx);
      const tx = fx - x0;
      const v00 = at(x0, y0);
      const v10 = at(x0 + 1, y0);
      const v01 = at(x0, y0 + 1);
      const v11 = at(x0 + 1, y0 + 1);
      if (v00 === DEM_INVALID || v10 === DEM_INVALID || v01 === DEM_INVALID || v11 === DEM_INVALID) {
        // 1つでも無効なら、最も近い画素の値(無効のまま)にする
        out[y * N + x] = at(Math.round(fx), Math.round(fy));
        continue;
      }
      out[y * N + x] = Math.round((v00 * (1 - tx) + v10 * tx) * (1 - ty) + (v01 * (1 - tx) + v11 * tx) * ty);
    }
  }
  return out;
}

/**
 * ズーム15の標高タイル(国土地理院の5mメッシュ標高 dem5a_png。約4m/画素。ズーム14の約2倍の細かさ)。
 * 5mメッシュが無い所(タイルが無い)は、ズーム14の標高タイルを引き伸ばして使う。どちらも無ければ null。
 */
export async function loadDemTile5m(x: number, y: number): Promise<Uint16Array | null> {
  const fine = await loadDemTile(15, x, y, "dem5a_png");
  if (fine) return fine;
  const parent = await loadDemTile(14, x >> 1, y >> 1);
  return parent ? upsampleQuadrant(parent, x & 1, y & 1) : null;
}
