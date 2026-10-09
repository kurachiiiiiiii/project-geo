import { decodeMvt } from "./mvt";
import { TILE_PX } from "./viewerMath";
import { fetchWithTimeout, runPool, tileRefs, type TileRef, type TileSet } from "./viewerTerrain";

/**
 * 3Dビューワー: 国土地理院の「最適化ベクトルタイル」(optimal_bvmap-v1)から、水面・河川・建物を読む。
 * 標準地図の元になっているデータで、地図の画像(下地)とは別に、形そのものを取り出して3Dに使う。
 *   ・WA   = 水域の面(vt_code 5100=海、5200=湖沼・河川などの内水面)
 *   ・RvrCL = 河川中心線(幅の狭い川。線)
 *   ・BldA = 建物の面(vt_code 3101=普通建物、3102=堅ろう建物、3103=高層建物、3111=その他の建物)
 *   ・RdCL / RailCL = 道路・鉄道の中心線(線)
 * 座標は、原点(クリック地点)から見た位置(X=東・Z=南、m)に直して持つ。
 */

export const GEO_LAYER_WATER = "WA";
export const GEO_LAYER_RIVER = "RvrCL";
export const GEO_LAYER_BUILDING = "BldA";
/** 道路中心線・鉄道中心線(光害の「市街地らしさ」を、道路の密度から推し量るのに使う) */
export const GEO_LAYER_ROAD = "RdCL";
export const GEO_LAYER_RAIL = "RailCL";

/** vt_code が海のもの(5100番台)か */
export function isSeaCode(code: number): boolean {
  return code >= 5100 && code < 5200;
}

export interface GeoWaterArea {
  /** 海か(海には灰色の岸の帯をつけない) */
  sea: boolean;
  /** 輪(外側と穴)。x0,z0,x1,z1,… (m)。塗るときは偶奇規則で穴を抜く */
  rings: Float32Array[];
}

export interface GeoBuilding {
  code: number;
  /** 外側の輪。x0,z0,x1,z1,… (m)。最初の点は繰り返さない */
  ring: Float32Array;
  /**
   * 中心(m)。読み込み中に前もって整えた建物(`prepareBuilding`)だけが持つ。持っていれば、遠くの建物の間引きと
   * 簡単な箱への置き換えは済んでいる(`buildBuildingMesh` はもう一度やらない)
   */
  cx?: number;
  cz?: number;
}

/** 読み込んだ建物を、集める前に整える(使わない建物は null)。 */
export type BuildingPrep = (b: GeoBuilding) => GeoBuilding | null;

/**
 * 建物を「原点に近い順に、上限の件数まで」だけ持つ入れ物。
 * 都市の近くでズーム14〜16のタイルを広く読むと、建物が数百万件になってメモリが足りなくなる(タブが落ちる)ので、
 * 読みながら、遠い建物を捨てていく。上限に達したあとは、その距離より遠いタイルは読まない(通信も減る)。
 */
export class BuildingCollector {
  private list: GeoBuilding[] = [];
  /** これ以上遠い(中心までの距離の二乗がこれ以上の)建物は、上限の中に入らない */
  private cutoff2 = Infinity;
  readonly cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }

  /** 中心を持つ(整えた)建物を入れる */
  add(b: GeoBuilding): void {
    const x = b.cx ?? 0;
    const z = b.cz ?? 0;
    const d2 = x * x + z * z;
    if (d2 >= this.cutoff2) return;
    this.list.push(b);
    if (this.list.length > this.cap * 2) this.prune();
  }

  private prune(): void {
    const d2 = (b: GeoBuilding): number => (b.cx ?? 0) ** 2 + (b.cz ?? 0) ** 2;
    this.list.sort((p, q) => d2(p) - d2(q));
    if (this.list.length > this.cap) {
      this.list.length = this.cap;
      this.cutoff2 = d2(this.list[this.cap - 1]);
    }
  }

  /** 原点からの最短距離 dMin(m)のタイルは、もう上限の中に建物を持てないか */
  canSkip(dMin: number): boolean {
    return dMin * dMin >= this.cutoff2;
  }

  /** 原点に近い順の、上限までの建物 */
  result(): GeoBuilding[] {
    this.prune();
    return this.list;
  }
}

export interface GeoData {
  waters: GeoWaterArea[];
  /** 川の中心線(線)。x0,z0,x1,z1,… (m) */
  rivers: Float32Array[];
  buildings: GeoBuilding[];
  /** 道路・鉄道の中心線(線)。x0,z0,x1,z1,… (m) */
  roads: Float32Array[];
  rails: Float32Array[];
}

export function emptyGeo(): GeoData {
  return { waters: [], rivers: [], buildings: [], roads: [], rails: [] };
}

export function mergeGeo(into: GeoData, from: GeoData): void {
  for (const w of from.waters) into.waters.push(w);
  for (const r of from.rivers) into.rivers.push(r);
  for (const b of from.buildings) into.buildings.push(b);
  for (const r of from.roads) into.roads.push(r);
  for (const r of from.rails) into.rails.push(r);
}

const TILE_BASE = "https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1";

/**
 * 取得済みのタイル(同じ地点を開き直したときに読み直さないため)。取得できなかったタイルはnull。
 * 枚数(RAW_CACHE_MAX)と合計の大きさ(RAW_CACHE_MAX_BYTES)の上限を超えたら、古いものから捨てる
 * (街のタイルは1枚100KBを超えることもあり、枚数だけでは数十MBになるため)。
 */
const rawCache = new Map<string, Promise<ArrayBuffer | null>>();
const rawSize = new Map<string, number>();
let rawBytes = 0;
const RAW_CACHE_MAX = 600;
const RAW_CACHE_MAX_BYTES = 40 * 1024 * 1024;
/** ベクトルタイル1枚の読み込みの時間切れ(ms)。通信が止まったまま返ってこないときに、読み込み全体が止まらないように */
const RAW_TIMEOUT_MS = 20_000;

function forgetRaw(url: string): void {
  rawCache.delete(url);
  rawBytes -= rawSize.get(url) ?? 0;
  rawSize.delete(url);
}

function fetchRaw(z: number, x: number, y: number): Promise<ArrayBuffer | null> {
  const url = `${TILE_BASE}/${z}/${x}/${y}.pbf`;
  const hit = rawCache.get(url);
  if (hit) return hit;
  const p = fetchWithTimeout(url, RAW_TIMEOUT_MS)
    .then(async (res) => {
      if (res.ok) {
        const buf = await res.arrayBuffer();
        if (rawCache.get(url) === p) {
          rawSize.set(url, buf.byteLength);
          rawBytes += buf.byteLength;
        }
        return buf;
      }
      // 混雑・一時的な失敗(429・5xx)は、取っておかない(次に開いたときに読み直す)
      if (res.status === 429 || res.status >= 500) forgetRaw(url);
      return null;
    })
    .catch(() => {
      // 通信エラー・時間切れも、取っておかない
      forgetRaw(url);
      return null;
    });
  rawCache.set(url, p);
  while ((rawCache.size > RAW_CACHE_MAX || rawBytes > RAW_CACHE_MAX_BYTES) && rawCache.size > 1) {
    const first = rawCache.keys().next();
    if (first.done) break;
    forgetRaw(first.value);
  }
  return p;
}

function codeOf(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** 注記(地名・山名・標高点などの文字)の点 */
export interface AnnoPoint {
  /** 注記の種別コード(vt_code。110=市町村名・311〜316=山名・321=湖・7101〜7221=標高点など) */
  code: number;
  text: string;
  /** 原点から見た位置(X東・Z南、m) */
  x: number;
  z: number;
}

/** 注記のレイヤー名 */
export const GEO_LAYER_ANNO = "Anno";

/** 1枚のタイルから、注記(点のもの)を読む。取得できなければ空 */
export async function loadAnnoTile(set: TileSet, tx: number, ty: number): Promise<AnnoPoint[]> {
  const buf = await fetchRaw(set.z, tx, ty);
  if (!buf || buf.byteLength === 0) return [];
  let decoded;
  try {
    decoded = decodeMvt(buf, new Set([GEO_LAYER_ANNO]));
  } catch {
    return [];
  }
  const ox = tx * TILE_PX - set.wx0;
  const oy = ty * TILE_PX - set.wy0;
  const out: AnnoPoint[] = [];
  for (const layer of decoded) {
    const k = (TILE_PX / layer.extent) * set.mpp;
    for (const f of layer.features) {
      if (f.type !== 1 || f.paths.length === 0) continue;
      const pts = f.paths[0].pts;
      if (pts.length < 2) continue;
      const raw = f.props.vt_text;
      const text = raw === null || raw === undefined ? "" : String(raw).trim();
      if (!text) continue;
      out.push({ code: codeOf(f.props.vt_code), text, x: ox * set.mpp + pts[0] * k, z: oy * set.mpp + pts[1] * k });
    }
  }
  return out;
}

/** 原点からの距離の帯(rMin以上rMax未満。m)。建物の中心がこの帯に入るものだけを使う(帯ごとに粗さの違うズームで読むため) */
export interface DistBand {
  rMin: number;
  rMax: number;
}

/** タイルの、原点からの最短・最長の距離(m) */
function tileDistRange(set: TileSet, r: TileRef): { dMin: number; dMax: number } {
  const size = TILE_PX * set.mpp;
  const x0 = (r.tx * TILE_PX - set.wx0) * set.mpp;
  const z0 = (r.ty * TILE_PX - set.wy0) * set.mpp;
  const x1 = x0 + size;
  const z1 = z0 + size;
  const nx = x0 > 0 ? x0 : x1 < 0 ? x1 : 0;
  const nz = z0 > 0 ? z0 : z1 < 0 ? z1 : 0;
  return {
    dMin: Math.hypot(nx, nz),
    dMax: Math.hypot(Math.max(Math.abs(x0), Math.abs(x1)), Math.max(Math.abs(z0), Math.abs(z1))),
  };
}

/** 帯にかかるタイルだけ(帯の外側・内側にすっぽり収まるタイルは読まない)。原点に近い順 */
export function bandTileRefs(set: TileSet, band?: DistBand): TileRef[] {
  const refs = tileRefs(set);
  if (!band) return refs;
  return refs.filter((r) => {
    const { dMin, dMax } = tileDistRange(set, r);
    return dMin < band.rMax && dMax >= band.rMin;
  });
}

/** 1枚のタイルを読んで、原点から見た位置(m)に直す。set は、そのタイルのズームのタイル範囲 */
export async function loadGeoTile(
  set: TileSet,
  tx: number,
  ty: number,
  layers: ReadonlySet<string>,
  band?: DistBand,
  prep?: BuildingPrep,
): Promise<GeoData> {
  const out = emptyGeo();
  const buf = await fetchRaw(set.z, tx, ty);
  if (!buf || buf.byteLength === 0) return out;
  let decoded;
  try {
    decoded = decodeMvt(buf, layers);
  } catch {
    return out;
  }
  const ox = tx * TILE_PX - set.wx0;
  const oy = ty * TILE_PX - set.wy0;
  const toLocal = (pts: number[], extent: number): Float32Array => {
    const n = pts.length / 2;
    const a = new Float32Array(n * 2);
    const k = (TILE_PX / extent) * set.mpp;
    for (let i = 0; i < n; i++) {
      a[i * 2] = ox * set.mpp + pts[i * 2] * k;
      a[i * 2 + 1] = oy * set.mpp + pts[i * 2 + 1] * k;
    }
    return a;
  };
  for (const layer of decoded) {
    for (const f of layer.features) {
      const code = codeOf(f.props.vt_code);
      if (layer.name === GEO_LAYER_WATER && f.type === 3) {
        const rings = f.paths.filter((p) => p.pts.length >= 6).map((p) => toLocal(p.pts, layer.extent));
        if (rings.length > 0) out.waters.push({ sea: isSeaCode(code), rings });
      } else if (layer.name === GEO_LAYER_RIVER && f.type === 2) {
        for (const p of f.paths) if (p.pts.length >= 4) out.rivers.push(toLocal(p.pts, layer.extent));
      } else if ((layer.name === GEO_LAYER_ROAD || layer.name === GEO_LAYER_RAIL) && f.type === 2) {
        const list = layer.name === GEO_LAYER_ROAD ? out.roads : out.rails;
        for (const p of f.paths) if (p.pts.length >= 4) list.push(toLocal(p.pts, layer.extent));
      } else if (layer.name === GEO_LAYER_BUILDING && f.type === 3) {
        // 外側の輪(面積が正)だけを建物にする。中庭などの穴は無視する
        for (const p of f.paths) {
          if (p.area > 0 && p.pts.length >= 6) {
            const ring = toLocal(p.pts, layer.extent);
            if (band) {
              let cx = 0;
              let cz = 0;
              const n = ring.length / 2;
              for (let i = 0; i < n; i++) {
                cx += ring[i * 2];
                cz += ring[i * 2 + 1];
              }
              const d = Math.hypot(cx / n, cz / n);
              if (d < band.rMin || d >= band.rMax) continue;
            }
            const b = prep ? prep({ code, ring }) : { code, ring };
            if (b) out.buildings.push(b);
          }
        }
      }
    }
  }
  return out;
}

/**
 * タイル範囲を原点に近い順に読み、まとめる。取得に失敗したタイルは空として扱う。
 * `collector` を渡すと、建物は(`prep`で整えてから)そこへ入れ、上限に達したあと遠すぎるタイルは読まない。
 */
export async function loadGeoSet(
  set: TileSet,
  layers: ReadonlySet<string>,
  onTile: () => void,
  cancelled: () => boolean,
  band?: DistBand,
  buildings?: { collector: BuildingCollector; prep: BuildingPrep; /** true なら、立体の上限に達しても遠いタイルを読み続ける(夜景の光の点は、範囲のすべての建物から集めるため) */ noSkip?: boolean },
  /** 同時に読むタイルの数 */
  limit = 8,
): Promise<GeoData> {
  const all = emptyGeo();
  await runPool(
    bandTileRefs(set, band),
    limit,
    async (r) => {
      if (buildings && !buildings.noSkip && layers.has(GEO_LAYER_BUILDING) && !layers.has(GEO_LAYER_WATER) && buildings.collector.canSkip(tileDistRange(set, r).dMin)) {
        onTile();
        return;
      }
      const g = await loadGeoTile(set, r.tx, r.ty, layers, band, buildings?.prep);
      if (!cancelled()) {
        if (buildings) {
          for (const b of g.buildings) buildings.collector.add(b);
          g.buildings = [];
        }
        mergeGeo(all, g);
      }
      onTile();
    },
    cancelled,
  );
  return all;
}
