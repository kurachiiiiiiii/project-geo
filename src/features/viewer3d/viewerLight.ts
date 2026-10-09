import { VEG_UNKNOWN, vegClassAt, vegClassAtFine, type KoyoVegetationGrid } from "../koyo/koyoVegetation";
import { GEO_LAYER_ROAD, loadGeoSet } from "./viewerGeo";
import { TILE_PX } from "./viewerMath";
import { treeKindOf } from "./viewerTrees";
import { makeTileSet, runPool, tileRefs, type TileSet } from "./viewerTerrain";

/**
 * 3Dビューワー: 光害(市街地の方角の夜空が、ぼんやり明るい)と、夜に光る地面。
 *   ・建物のある所 = 白い光(空と地面)。国土地理院の標準地図(ズーム12)の「市街地」の色(うすいオレンジ。建物が多いほど濃い)から、
 *     250mの区画ごとの「建物のある割合」をおおまかに出す。(建物の形のデータ(ベクトルタイル)はズーム14以上にしか無く、
 *     ±40kmでは千数百枚になって重すぎるので、標準地図の画像で代わりにする)
 *   ・人口集中地区(DID。国土地理院の地理院タイル did2020)は、従来どおりの強さ。DIDの外は光害を30%弱める。
 *   ・道路 = オレンジ色の光(地面だけ)。道路は光害(空)には影響しない。
 *   ・森林・海・水面は光らない(森林は木に隠れるので、空は弱め、地面はごくわずか)。
 * 区画ごとの光の強さを、視点からの距離で弱めながら方位ごとに足し合わせ、
 * 「方位ごとの強さの表」(360画素)にして、空のシェーダーに渡す。
 */

/**
 * 読む範囲(原点から±m)とズーム。
 *   ・近く(±40km) = 標準地図(ズーム12)の市街地の色・人口集中地区(ズーム11)・道路。250m区画。地面の光と、空の光害に使う
 *   ・遠く(±150km) = 人口集中地区だけ(ズーム10。約120m/画素)を1km区画に。空の光害にだけ使う(遠い街ほど、距離で弱める)
 */
export const LIGHT_HALF_M = 40_000;
/** 空の光害のデータを集める半径(m)。この外の街は、光害に数えない */
export const LIGHT_FAR_HALF_M = 150_000;
/** 遠くの人口集中地区のタイルのズームと、1km区画の大きさ・数(一辺) */
const DID_FAR_ZOOM = 10;
const FAR_CELL_M = 1000;
const FAR_N = (2 * LIGHT_FAR_HALF_M) / FAR_CELL_M;
const LIGHT_ZOOM = 12;
/** 人口集中地区のタイルのズーム(約60m/画素。250m区画の割合を出すには十分) */
const DID_ZOOM = 11;
/** 区画の大きさ(m) */
const CELL_M = 1000;
/** 方位の分け方(1画素=1°) */
export const GLOW_BINS = 360;
/** 建物のある割合(0〜1)がこの値より小さい区画は光らない / この値で光の強さ1 */
const B_MIN = 0.08;
const B_FULL = 0.5;
/** 光の強さの上限(建物がびっしりの都心で約2.2になる) */
const S_MAX = 2.4;
/** 人口集中地区の区画は、建物のある割合をこの値以上とみなす(標準地図が読めなくても、DIDは光る) */
const DID_FLOOR = 0.85;
/**
 * 人口集中地区の光の強さ(従来=1に対する倍率)と、その外の倍率。人口集中地区は「明るすぎる」ので従来の0.6倍、
 * その外は、人口集中地区より弱く(従来の0.5倍)する。
 */
const DID_FACTOR = 0.48;
const NON_DID_FACTOR = 0.4;
/**
 * 遠くの人口集中地区の光(空の光害・地面の光)を強める倍率(「遠方のDID地区の発光を30%強く」)。
 * 原点から約3km→8kmにかけて1→1.3倍にする(足もとの街は、これまでどおり)。
 */
const DID_FAR_BOOST = 1.3;
/** 地面の白い光を消す人口集中地区の割合(ぼかした割合がFROM以下は光る、TO以上は光らない。間はなめらか) */
const DID_GROUND_OFF_FROM = 0.2;
const DID_GROUND_OFF_TO = 0.7;
function didFactorAt(dm: number): number {
  const t = Math.min(1, Math.max(0, (dm - 3000) / 5000));
  return DID_FACTOR * (1 + (DID_FAR_BOOST - 1) * t * t * (3 - 2 * t));
}
/** 大都市圏の外の光害の倍率(大都市圏の中は1。外側は少し小さく) */
const OUTSIDE_METRO_FACTOR = 0.75;
/** 大都市圏: 中心(緯度・経度)と半径(km)。半径の内側は1、そこから半径の1.3倍にかけて OUTSIDE_METRO_FACTOR まで弱める */
const METROS: { name: string; lat: number; lon: number; rKm: number }[] = [
  { name: "首都圏", lat: 35.68, lon: 139.77, rKm: 60 },
  { name: "名古屋圏", lat: 35.17, lon: 136.91, rKm: 35 },
  { name: "大阪圏", lat: 34.69, lon: 135.5, rKm: 45 },
  { name: "福岡圏", lat: 33.59, lon: 130.4, rKm: 28 },
  { name: "札幌圏", lat: 43.06, lon: 141.35, rKm: 25 },
  { name: "仙台圏", lat: 38.27, lon: 140.87, rKm: 22 },
  { name: "新潟圏", lat: 37.92, lon: 139.04, rKm: 20 },
];

/** 位置(緯度・経度)の、大都市圏による倍率(中は1、外は OUTSIDE_METRO_FACTOR、境目はなめらか) */
export function metroFactorAt(lat: number, lon: number): number {
  let inside = 0; // 0=外 〜 1=中
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180);
  for (const m of METROS) {
    const d = Math.hypot((lon - m.lon) * kx, (lat - m.lat) * 110.57);
    const t = d <= m.rKm ? 1 : d >= m.rKm * 1.3 ? 0 : 1 - (d - m.rKm) / (m.rKm * 0.3);
    if (t > inside) inside = t;
  }
  return OUTSIDE_METRO_FACTOR + (1 - OUTSIDE_METRO_FACTOR) * inside;
}

/** 森林と判定される区画の空への光は、この割合に弱める */
const FOREST_FACTOR = 0.5;
/** 森林と判定される区画の地面の光(木に隠れるので、わずか) */
const FOREST_GROUND_FACTOR = 0.3;
/** 距離による弱まり: 1/(距離km+DIST_OFFSET)^DIST_POW */
const DIST_OFFSET_KM = 2.5;
const DIST_POW = 1.35;
/**
 * 遠い街の光の、さらなる距離減衰(大気による吸収・散乱と、地球の丸みで街の光が見えにくくなる分)。
 * ATTEN_FROM_KM までは減らさず、それより遠くは指数で弱め、データを取る範囲の端(約150km)で ATTEN_AT_EDGE(60%)になるようにする。
 * (これに加えて、`DIST_OFFSET_KM`・`DIST_POW` の距離による弱まりも掛かる)
 */
const ATTEN_FROM_KM = 25;
const ATTEN_AT_EDGE = 0.6;
const ATTEN_E_KM = (LIGHT_FAR_HALF_M / 1000 - ATTEN_FROM_KM) / -Math.log(ATTEN_AT_EDGE);
/** 距離 dk(km)の街の光に掛ける倍率(0〜1)。150kmで約0.6 */
export function lightAttenuation(dk: number): number {
  if (dk <= ATTEN_FROM_KM) return 1;
  return Math.exp(-(dk - ATTEN_FROM_KM) / ATTEN_E_KM);
}
/** 全体の強さ(大きいほど光る) */
const GLOW_GAIN = 4.4;
/** 「光る地面の割合」を数える角度の広がり(rad)と、距離の重み 1/(距離km+RATIO_OFFSET_KM) */
const RATIO_SIGMA = 0.19;
const RATIO_OFFSET_KM = 3;

/** 地面の光の地図: 細かい区画(250m)の大きさと数。LIGHT_HALF_M の範囲を覆う */
export const FINE_CELL_M = 250;
export const FINE_N = (2 * LIGHT_HALF_M) / FINE_CELL_M;
/** 道路の光の地図の画素数(一辺。約39m/画素) */
export const ROAD_N = 2048;
/** 道路の光: 建物のない所(山の中・畑)の道路は、この割合に弱める(街の道路ほど強い。森林の道路はさらに弱める) */
const ROAD_BASE = 0.3;
const ROAD_FOREST_FACTOR = 0.5;

export interface LightSource {
  /** 250m区画ごとの「建物のある割合」(0〜1)。標準地図(ズーム12)の市街地の色から。FINE_N×FINE_N。上が北 */
  building: Float32Array;
  /** 250m区画ごとの人口集中地区(DID)の割合(0〜1)。FINE_N×FINE_N */
  did: Float32Array;
  /** 道路の線の地図(線の上が255)。ROAD_N×ROAD_N。上が北。地面のオレンジの光に使う */
  road: Uint8Array;
  /** 1km区画ごとの人口集中地区(DID)の割合(0〜1)。LIGHT_FAR_HALF_M(約150km)の範囲。FAR_N×FAR_N。上が北。空の光害の遠くの分 */
  didFar: Float32Array;
  /** 建物か人口集中地区のタイルを1枚でも取得できたか(道路だけでは光害を作らない) */
  loaded: boolean;
}

const TILE_BASE = "https://cyberjapandata.gsi.go.jp/xyz";

/** 標準地図の1画素が「建物のある所(市街地)」らしい度合い(0〜1)。うすいオレンジ(255,230,190)が建物の多い所、薄い同系色が建物がまばらな所 */
function buildingWeight(d: Uint8ClampedArray, i: number): number {
  const r = d[i];
  const g = d[i + 1];
  const b = d[i + 2];
  // 黄色・赤・橙の道路や、白・灰色・青・緑は除く
  if (r < 250 || g > 252 || g < b || r - g > 40) return 0;
  const c = r - b;
  return c < 8 ? 0 : Math.min(1, (c - 8) / 52);
}

/** 人口集中地区のタイルの画素が、地区の中(塗り・縁)か */
function didWeight(d: Uint8ClampedArray, i: number): number {
  return d[i + 3] >= 60 ? 1 : 0;
}

/**
 * 画像のタイルを並べて、画素ごとの重みを250m区画ごとの平均(0〜1)にまとめる。
 * 取得できなかったタイル(海・範囲外・地区なし)は0として扱う。
 */
interface CellGrid {
  /** 原点から±この距離(m)を覆う */
  half: number;
  /** 区画の大きさ(m) */
  cell: number;
  /** 一辺の区画数 */
  n: number;
}
const NEAR_GRID: CellGrid = { half: LIGHT_HALF_M, cell: FINE_CELL_M, n: FINE_N };
const FAR_GRID: CellGrid = { half: LIGHT_FAR_HALF_M, cell: FAR_CELL_M, n: FAR_N };

async function accumulateTiles(
  set: TileSet,
  urlOf: (z: number, tx: number, ty: number) => string,
  weightOf: (d: Uint8ClampedArray, i: number) => number,
  onTile: () => void,
  cancelled: () => boolean,
  grid: CellGrid = NEAR_GRID,
): Promise<{ value: Float32Array; tilesOk: number }> {
  const gn = grid.n;
  const sum = new Float32Array(gn * gn);
  const cnt = new Uint16Array(gn * gn);
  let tilesOk = 0;
  const canvas = document.createElement("canvas");
  canvas.width = TILE_PX;
  canvas.height = TILE_PX;
  const c2d = canvas.getContext("2d", { willReadFrequently: true });
  if (!c2d) throw new Error("canvasを使えません");
  await runPool(
    tileRefs(set),
    8,
    (r) =>
      new Promise<void>((resolve) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        // 通信が止まったまま返ってこないときは、15秒で打ち切る(そのタイルは無いものとする)
        const timer = setTimeout(() => {
          img.onload = null;
          img.onerror = null;
          img.src = "";
          onTile();
          resolve();
        }, 15_000);
        img.onload = () => {
          clearTimeout(timer);
          if (!cancelled()) {
            c2d.clearRect(0, 0, TILE_PX, TILE_PX);
            c2d.drawImage(img, 0, 0, TILE_PX, TILE_PX);
            const d = c2d.getImageData(0, 0, TILE_PX, TILE_PX).data;
            tilesOk++;
            const x0 = (r.tx * TILE_PX - set.wx0 + 0.5) * set.mpp + grid.half;
            for (let py = 0; py < TILE_PX; py++) {
              const Z = (r.ty * TILE_PX + py + 0.5 - set.wy0) * set.mpp + grid.half;
              const cz = Math.floor(Z / grid.cell);
              if (cz < 0 || cz >= gn) continue;
              for (let px = 0; px < TILE_PX; px++) {
                const cx = Math.floor((x0 + px * set.mpp) / grid.cell);
                if (cx < 0 || cx >= gn) continue;
                const k = cz * gn + cx;
                sum[k] += weightOf(d, (py * TILE_PX + px) * 4);
                cnt[k]++;
              }
            }
          }
          onTile();
          resolve();
        };
        img.onerror = () => {
          clearTimeout(timer);
          onTile();
          resolve();
        };
        img.src = urlOf(set.z, r.tx, r.ty);
      }),
    cancelled,
  );
  const value = new Float32Array(gn * gn);
  for (let i = 0; i < value.length; i++) value[i] = cnt[i] > 0 ? sum[i] / cnt[i] : 0;
  return { value, tilesOk };
}

/** 道路の線(原点から見た位置 m)を、白い細い線として画像にして、画素ごとの値(0〜255)にする */
function rasterizeRoads(lines: Float32Array[]): Uint8Array {
  const out = new Uint8Array(ROAD_N * ROAD_N);
  if (lines.length === 0) return out;
  const canvas = document.createElement("canvas");
  canvas.width = ROAD_N;
  canvas.height = ROAD_N;
  const g = canvas.getContext("2d", { willReadFrequently: true });
  if (!g) return out;
  g.fillStyle = "#000";
  g.fillRect(0, 0, ROAD_N, ROAD_N);
  g.strokeStyle = "#fff";
  g.lineWidth = 1.3;
  g.lineCap = "round";
  g.lineJoin = "round";
  const k = ROAD_N / (2 * LIGHT_HALF_M);
  let n = 0;
  g.beginPath();
  for (const a of lines) {
    if (a.length < 4) continue;
    g.moveTo((a[0] + LIGHT_HALF_M) * k, (a[1] + LIGHT_HALF_M) * k);
    for (let i = 2; i + 1 < a.length; i += 2) g.lineTo((a[i] + LIGHT_HALF_M) * k, (a[i + 1] + LIGHT_HALF_M) * k);
    if (++n % 3000 === 0) {
      g.stroke();
      g.beginPath();
    }
  }
  g.stroke();
  const data = g.getImageData(0, 0, ROAD_N, ROAD_N).data;
  for (let i = 0; i < out.length; i++) out[i] = data[i * 4];
  return out;
}

/**
 * 光害の元データを読む: 建物のある所(標準地図ズーム12の市街地の色。約±40km)・人口集中地区(did2020。近くはズーム11、約±150kmはズーム10)・
 * 道路(ベクトルタイルの道路中心線。約±40km)。並べて読む。道路は鉄道を含まない(道路だけが光る)。
 */
export async function loadLightSource(
  lat0: number,
  lon0: number,
  onProgress: (done: number, total: number) => void,
  cancelled: () => boolean,
): Promise<LightSource> {
  const set = makeTileSet(lat0, lon0, LIGHT_ZOOM, LIGHT_HALF_M);
  const didSet = makeTileSet(lat0, lon0, DID_ZOOM, LIGHT_HALF_M);
  const farSet = makeTileSet(lat0, lon0, DID_FAR_ZOOM, LIGHT_FAR_HALF_M);
  const total = set.nx * set.ny * 2 + didSet.nx * didSet.ny + farSet.nx * farSet.ny;
  let done = 0;
  const tick = () => {
    done++;
    onProgress(done, total);
  };
  const [bld, did, geo, didFar] = await Promise.all([
    accumulateTiles(set, (z, x, y) => `${TILE_BASE}/std/${z}/${x}/${y}.png`, buildingWeight, tick, cancelled),
    accumulateTiles(didSet, (z, x, y) => `${TILE_BASE}/did2020/${z}/${x}/${y}.png`, didWeight, tick, cancelled),
    loadGeoSet(set, new Set([GEO_LAYER_ROAD]), tick, cancelled),
    accumulateTiles(farSet, (z, x, y) => `${TILE_BASE}/did2020/${z}/${x}/${y}.png`, didWeight, tick, cancelled, FAR_GRID),
  ]);
  return {
    building: bld.value,
    did: did.value,
    didFar: didFar.value,
    road: rasterizeRoads(geo.roads),
    loaded: bld.tilesOk + did.tilesOk + didFar.tilesOk > 0,
  };
}

/** 250m区画ごとの「建物のある割合」(0〜1。人口集中地区は DID_FLOOR 以上)。原点から±half m を覆う n×n。上が北 */
export interface UrbanGrid {
  value: Float32Array;
  n: number;
  cell: number;
  half: number;
}

/**
 * 遠くの推定の建物(`viewerBuildings.ts` の `addUrbanProxies`)のために、原点から±half m の「建物のある割合」を、
 * 標準地図(ズーム12)の市街地の色と人口集中地区(ズーム11)から作る(光害と同じ求め方。光害のデータは夜にしか読まないので、別に読む)。
 */
export async function loadUrbanGrid(lat0: number, lon0: number, half: number, cancelled: () => boolean): Promise<UrbanGrid> {
  const n = Math.ceil((2 * half) / FINE_CELL_M);
  const grid: CellGrid = { half: (n * FINE_CELL_M) / 2, cell: FINE_CELL_M, n };
  const set = makeTileSet(lat0, lon0, LIGHT_ZOOM, grid.half);
  const didSet = makeTileSet(lat0, lon0, DID_ZOOM, grid.half);
  const none = () => undefined;
  const [bld, did] = await Promise.all([
    accumulateTiles(set, (z, x, y) => `${TILE_BASE}/std/${z}/${x}/${y}.png`, buildingWeight, none, cancelled, grid),
    accumulateTiles(didSet, (z, x, y) => `${TILE_BASE}/did2020/${z}/${x}/${y}.png`, didWeight, none, cancelled, grid),
  ]);
  const value = new Float32Array(n * n);
  for (let i = 0; i < value.length; i++) value[i] = Math.max(bld.value[i], DID_FLOOR * did.value[i]);
  return { value, n, cell: FINE_CELL_M, half: grid.half };
}

/** 250m区画ごとの「建物のある割合」(人口集中地区の中は DID_FLOOR 以上とみなす) */
function effectiveBuilding(src: LightSource): Float32Array {
  const out = new Float32Array(FINE_N * FINE_N);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(src.building[i], DID_FLOOR * src.did[i]);
  return out;
}

export interface GlowResult {
  /**
   * 方位ごとの値(各方位2画素: [光の強さ, 光る地面の割合]、どちらも0〜255)。方位 i は (i+0.5)°−180°(北=中央・南=両端)。
   * 光の強さ = 区画ごとの光を距離で弱めて足し合わせたもの。光る地面の割合 = その方角の地面のうち、森林以外で光る所の割合
   * (空への影響の強さ・高さに使う)。
   */
  table: Uint8Array;
  /** 全方位でならした、空全体のうっすらした明るさ(0〜1)。光る地面が多いほど大きい */
  dome: number;
  /** 光る区画(1km)の数 */
  litCells: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * 建物のある割合(人口集中地区は従来の強さ・その外は30%減)から、方位ごとの光の強さと「光る地面の割合」の表を作る。道路は使わない。
 * 表の添字iは、北を0°として時計回りの方位 (i+0.5)°−180° に当たる(北が表の中央、南が両端)。
 * (シェーダーは、方位azを atan(東, -南) で求め、az/2π+0.5 で表を引く)
 */
export function buildGlowTable(
  src: LightSource,
  veg: KoyoVegetationGrid | null,
  toLatLon: (X: number, Z: number) => { lat: number; lon: number },
): GlowResult {
  const acc = new Float32Array(GLOW_BINS);
  const accLit = new Float32Array(GLOW_BINS);
  const accAll = new Float32Array(GLOW_BINS);
  const binW = (2 * Math.PI) / GLOW_BINS;
  const spread = (centerBin: number, sigma: number, add: (bin: number, w: number) => void) => {
    const reach = Math.ceil((3 * sigma) / binW);
    for (let k = -reach; k <= reach; k++) {
      const j = Math.floor(centerBin) + k;
      const dAng = (j + 0.5 - centerBin) * binW;
      add(((j % GLOW_BINS) + GLOW_BINS) % GLOW_BINS, Math.exp(-0.5 * (dAng / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI)));
    }
  };
  let lit = 0;
  const eff = effectiveBuilding(src);
  const per = CELL_M / FINE_CELL_M;
  for (let cz = 0; cz < FAR_N; cz++) {
    for (let cx = 0; cx < FAR_N; cx++) {
      const X = -LIGHT_FAR_HALF_M + (cx + 0.5) * FAR_CELL_M;
      const Z = -LIGHT_FAR_HALF_M + (cz + 0.5) * FAR_CELL_M;
      const dm = Math.hypot(X, Z);
      if (dm > LIGHT_FAR_HALF_M) continue;
      const dk = Math.max(dm / 1000, 0.5);
      const inNear = Math.abs(X) < LIGHT_HALF_M && Math.abs(Z) < LIGHT_HALF_M;
      let b1 = 0;
      let d1 = 0;
      if (inNear) {
        // 近く: 1km区画の、建物のある割合と人口集中地区の割合(細かい区画4×4の平均)
        const ncx = Math.floor((X + LIGHT_HALF_M) / CELL_M);
        const ncz = Math.floor((Z + LIGHT_HALF_M) / CELL_M);
        for (let j = 0; j < per; j++) {
          for (let i = 0; i < per; i++) {
            const k = (ncz * per + j) * FINE_N + ncx * per + i;
            b1 += eff[k];
            d1 += src.did[k];
          }
        }
        b1 /= per * per;
        d1 /= per * per;
      } else {
        // 遠く: 人口集中地区の割合だけ(建物の細かい分布は分からないので、人口集中地区は建物がびっしりとみなす)
        d1 = src.didFar[cz * FAR_N + cx];
        b1 = DID_FLOOR * d1;
      }
      if (b1 < B_MIN) {
        // 光らない区画。近くでは、「光る地面の割合」の分母にだけ数える
        if (inNear) {
          const az0 = Math.atan2(X, -Z);
          const wr0 = 1 / (dk + RATIO_OFFSET_KM);
          spread((az0 + Math.PI) / binW, RATIO_SIGMA, (bin, w) => {
            accAll[bin] += wr0 * w;
          });
        }
        continue;
      }
      const az = Math.atan2(X, -Z); // 北0°から時計回り。-π〜π
      const centerBin = (az + Math.PI) / binW;
      // 建物のある所が光る。人口集中地区は明るすぎないよう弱め、それ以外はさらに弱め(境目は割合で混ぜる)、大都市圏の外は少し小さくする
      let s = Math.min(S_MAX, Math.max(0, (b1 - B_MIN) / (B_FULL - B_MIN))) * (NON_DID_FACTOR + (didFactorAt(dm) - NON_DID_FACTOR) * d1);
      if (s > 0) {
        const ll0 = toLatLon(X, Z);
        s *= metroFactorAt(ll0.lat, ll0.lon);
      }
      if (veg && s > 0) {
        const ll = toLatLon(X, Z);
        const cls = vegClassAt(veg, ll.lat, ll.lon);
        // 森林(木が生える所)は弱める
        if (cls !== VEG_UNKNOWN && treeKindOf(cls) !== null) s *= FOREST_FACTOR;
      }
      // 光る地面の割合: その方角の、距離で重みづけた地面全体のうち、光る区画の割合(近くの約40kmだけで数える)
      if (inNear) {
        const wr = 1 / (dk + RATIO_OFFSET_KM);
        const litFrac = Math.min(1, s);
        spread(centerBin, RATIO_SIGMA, (bin, w) => {
          accAll[bin] += wr * w;
          accLit[bin] += wr * w * litFrac;
        });
      }
      if (s < 0.03) continue;
      lit++;
      // 距離で弱める: 1/(距離+2.5km)^1.35 に、遠い街ほど弱まる倍率(25km以遠は指数で減り、約150kmで0.6倍)を掛ける
      const w = (s / (dk + DIST_OFFSET_KM) ** DIST_POW) * lightAttenuation(dk);
      if (w <= 0) continue;
      // 近いほど角度の広がりが大きい(視点のすぐそばの区画は、ほぼ全方位をうっすら明るくする)
      const sigma = Math.max(0.1, Math.atan(0.9 / dk));
      spread(centerBin, sigma, (bin, g) => {
        acc[bin] += w * 0.4 * g;
      });
    }
  }
  const table = new Uint8Array(GLOW_BINS * 2);
  let sumE = 0;
  let sumR = 0;
  for (let i = 0; i < GLOW_BINS; i++) {
    const g = 1 - Math.exp(-acc[i] * GLOW_GAIN);
    const e = Math.min(1, smooth(0.0, 1.0, g));
    const ratio = accAll[i] > 0 ? Math.min(1, accLit[i] / accAll[i]) : 0;
    table[i * 2] = Math.round(255 * e);
    table[i * 2 + 1] = Math.round(255 * Math.min(1, ratio * 1.6));
    sumE += e;
    sumR += ratio;
  }
  const dome = Math.min(1, (sumE / GLOW_BINS) * 0.6 + (sumR / GLOW_BINS) * 0.5);
  return { table, dome, litCells: lit };
}

// ---------------------------------------------------------------------------
// 地面の光(森林以外の地面を、夜に暖色に光らせる)
// ---------------------------------------------------------------------------

export interface GroundLightMap {
  /** 建物の光(白)の強さ(0〜255)。size×size。上が北 */
  data: Uint8Array;
  size: number;
  /** 原点から±この距離(m)を覆う */
  half: number;
  /** 光る区画の割合 */
  litRatio: number;
  /** 道路の光(オレンジ)の強さ(0〜255)。roadSize×roadSize。上が北。道路が読めなかったときはnull */
  road: Uint8Array | null;
  roadSize: number;
  /**
   * 人口集中地区(DID)の割合(0〜255。やや広めにぼかしたもの)。didSize×didSize。上が北。原点から±didHalf(m)を覆う。
   * 建物の発光を、DIDの中だけ弱めるのに使う(建物のシェーダーが読む)。
   */
  did: Uint8Array;
  didSize: number;
  didHalf: number;
}

/** 建物の発光を弱める人口集中地区の地図の範囲(原点から±m。描画範囲の最大50kmを覆う)。細かい250m区画 */
const DID_MAP_HALF_M = 50_000;
const DID_MAP_N = (2 * DID_MAP_HALF_M) / FINE_CELL_M;

/** 区画の値を、幅 2r+1 の平均でぼかす(縦横それぞれ。端はそのまま) */
function boxBlur(a: Float32Array, n: number, r: number): Float32Array {
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const w = 2 * r + 1;
  const cl = (v: number) => Math.min(n - 1, Math.max(0, v));
  for (let y = 0; y < n; y++) {
    let sum = 0;
    for (let x = -r; x <= r; x++) sum += a[y * n + cl(x)];
    for (let x = 0; x < n; x++) {
      tmp[y * n + x] = sum / w;
      sum += a[y * n + cl(x + r + 1)] - a[y * n + cl(x - r)];
    }
  }
  for (let x = 0; x < n; x++) {
    let sum = 0;
    for (let y = -r; y <= r; y++) sum += tmp[cl(y) * n + x];
    for (let y = 0; y < n; y++) {
      out[y * n + x] = sum / w;
      sum += tmp[cl(y + r + 1) * n + x] - tmp[cl(y - r) * n + x];
    }
  }
  return out;
}

/**
 * 地面の光の地図を作る。
 *   ・建物の光(白): 250m区画ごとの建物のある割合から。森林(植生図で木が生える所)はわずかにし、人口集中地区の外は30%弱める。
 *     細かい区画は建物1棟で割合が跳ね上がるので、まわり約750m四方でならしてから判定する(「おおまかに」光る)。
 *   ・道路の光(オレンジ): 道路の線の地図に、その場所の建物の多さを掛ける(街の道路は明るく、山や畑の道路は弱く)。
 *     道路は光害(空)には影響しない。
 */
export function buildGroundLightMap(
  src: LightSource,
  veg: KoyoVegetationGrid | null,
  toLatLon: (X: number, Z: number) => { lat: number; lon: number },
): GroundLightMap {
  const n = FINE_N;
  const bs = boxBlur(effectiveBuilding(src), n, 1);
  const ds = boxBlur(src.did, n, 1);
  const data = new Uint8Array(n * n);
  // 道路の光の強さの係数(細かい区画ごと): 建物が多いほど強い。森林の道路は弱める
  const roadK = new Float32Array(n * n);
  let litCount = 0;
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      const i = cz * n + cx;
      let forest = false;
      const base = Math.min(1.5, Math.max(0, (bs[i] - B_MIN) / (B_FULL - B_MIN)));
      if (veg) {
        const ll = toLatLon(-LIGHT_HALF_M + (cx + 0.5) * FINE_CELL_M, -LIGHT_HALF_M + (cz + 0.5) * FINE_CELL_M);
        const cls = vegClassAtFine(veg, ll.lat, ll.lon);
        forest = cls !== VEG_UNKNOWN && treeKindOf(cls) !== null;
      }
      roadK[i] = (ROAD_BASE + (1 - ROAD_BASE) * Math.min(1, bs[i] / 0.4)) * (forest ? ROAD_FOREST_FACTOR : 1);
      const dm = Math.hypot(-LIGHT_HALF_M + (cx + 0.5) * FINE_CELL_M, -LIGHT_HALF_M + (cz + 0.5) * FINE_CELL_M);
      let s = base * (NON_DID_FACTOR + (didFactorAt(dm) - NON_DID_FACTOR) * ds[i]);
      if (s >= 0.02) {
        const ll0 = toLatLon(-LIGHT_HALF_M + (cx + 0.5) * FINE_CELL_M, -LIGHT_HALF_M + (cz + 0.5) * FINE_CELL_M);
        s *= metroFactorAt(ll0.lat, ll0.lon);
      }
      if (forest) s *= FOREST_GROUND_FACTOR;
      // 人口集中地区(DID)の地面は光らせない(街の明かりは建物・道路が受け持つ。DIDの外の市街地・集落の地面だけが光る)
      s *= 1 - smooth(DID_GROUND_OFF_FROM, DID_GROUND_OFF_TO, ds[i]);
      if (s < 0.02) continue;
      litCount++;
      data[i] = Math.round(255 * Math.min(1, smooth(0, 1.2, s)));
    }
  }
  // 建物の発光を弱めるためのDIDの地図(±50km、250m区画)。近く(±40km)は細かい区画をぼかしたもの、その外は1km区画の値
  const did = new Uint8Array(DID_MAP_N * DID_MAP_N);
  for (let cz = 0; cz < DID_MAP_N; cz++) {
    for (let cx = 0; cx < DID_MAP_N; cx++) {
      const X = -DID_MAP_HALF_M + (cx + 0.5) * FINE_CELL_M;
      const Z = -DID_MAP_HALF_M + (cz + 0.5) * FINE_CELL_M;
      let v: number;
      if (Math.abs(X) < LIGHT_HALF_M && Math.abs(Z) < LIGHT_HALF_M) {
        const fx = Math.floor((X + LIGHT_HALF_M) / FINE_CELL_M);
        const fz = Math.floor((Z + LIGHT_HALF_M) / FINE_CELL_M);
        v = ds[fz * n + fx];
      } else {
        const fx = Math.floor((X + LIGHT_FAR_HALF_M) / FAR_CELL_M);
        const fz = Math.floor((Z + LIGHT_FAR_HALF_M) / FAR_CELL_M);
        v = src.didFar[fz * FAR_N + fx] ?? 0;
      }
      did[cz * DID_MAP_N + cx] = Math.round(255 * Math.min(1, Math.max(0, v)));
    }
  }
  // 道路の線の地図に、区画ごとの係数を掛ける
  let road: Uint8Array | null = null;
  if (src.road.some((v) => v > 0)) {
    road = new Uint8Array(ROAD_N * ROAD_N);
    const ratio = n / ROAD_N;
    for (let y = 0; y < ROAD_N; y++) {
      const cz = Math.min(n - 1, Math.floor(y * ratio));
      for (let x = 0; x < ROAD_N; x++) {
        const v = src.road[y * ROAD_N + x];
        if (v === 0) continue;
        road[y * ROAD_N + x] = Math.round(v * roadK[cz * n + Math.min(n - 1, Math.floor(x * ratio))]);
      }
    }
  }
  return { data, size: n, half: LIGHT_HALF_M, litRatio: litCount / (n * n), road, roadSize: ROAD_N, did, didSize: DID_MAP_N, didHalf: DID_MAP_HALF_M };
}
