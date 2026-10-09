import type { GeoBuilding } from "./viewerGeo";
import type { BuildingMeshData } from "./viewerObjectsGl";

/**
 * 3Dビューワー: 建物の立体(建物の形を、高さ分だけ押し出した箱)を作る。
 * 国土地理院の建物データには高さが無いので、種類(vt_code)から高さを仮に決める:
 *   3101 普通建物 ≈ 6〜9m(2階建て前後)、3102 堅ろう建物 ≈ 9〜14m、3103 高層建物 ≈ 24〜40m、3111 その他 ≈ 5m。
 * 実際の高さではなく、街の雰囲気を出すための目安。
 */

/** 建物の高さの目安(m): [最小, 幅] */
const HEIGHT_BY_CODE: Record<number, [number, number]> = {
  3101: [6, 3],
  3102: [9, 5],
  3103: [24, 16],
  3111: [5, 1.5],
};
const HEIGHT_DEFAULT: [number, number] = [6, 3];

const WALL_COLORS: [number, number, number][] = [
  [0.89, 0.86, 0.8],
  [0.8, 0.8, 0.8],
  [0.84, 0.77, 0.69],
  [0.74, 0.78, 0.82],
  [0.91, 0.89, 0.78],
  [0.7, 0.68, 0.64],
];
const ROOF_COLORS: [number, number, number][] = [
  [0.42, 0.42, 0.44],
  [0.55, 0.3, 0.26],
  [0.32, 0.38, 0.45],
  [0.5, 0.5, 0.5],
  [0.28, 0.3, 0.28],
];

/** 0〜1の擬似乱数(位置から決める。同じ建物はいつも同じ見た目になる) */
function hash01(a: number, b: number, salt: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233 + salt * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function signedArea(a: Float32Array): number {
  const n = a.length / 2;
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += a[i * 2] * a[j * 2 + 1] - a[j * 2] * a[i * 2 + 1];
  }
  return s / 2;
}

/** 耳切り法で多角形を三角形に分ける。返すのは頂点番号の3つ組。面積が正(math向き)の輪を渡す */
export function triangulateRing(pts: Float32Array): number[] {
  const n = pts.length / 2;
  const out: number[] = [];
  if (n < 3) return out;
  const idx: number[] = [];
  for (let i = 0; i < n; i++) idx.push(i);
  const X = (i: number) => pts[i * 2];
  const Z = (i: number) => pts[i * 2 + 1];
  const cross = (a: number, b: number, c: number) => (X(b) - X(a)) * (Z(c) - Z(b)) - (Z(b) - Z(a)) * (X(c) - X(b));
  const inside = (p: number, a: number, b: number, c: number) => {
    const d1 = (X(p) - X(b)) * (Z(a) - Z(b)) - (X(a) - X(b)) * (Z(p) - Z(b));
    const d2 = (X(p) - X(c)) * (Z(b) - Z(c)) - (X(b) - X(c)) * (Z(p) - Z(c));
    const d3 = (X(p) - X(a)) * (Z(c) - Z(a)) - (X(c) - X(a)) * (Z(p) - Z(a));
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  let guard = n * n + 10;
  while (idx.length > 3 && guard-- > 0) {
    let found = false;
    const m = idx.length;
    for (let k = 0; k < m; k++) {
      const a = idx[(k + m - 1) % m];
      const b = idx[k];
      const c = idx[(k + 1) % m];
      if (cross(a, b, c) <= 1e-9) continue; // へこんだ頂点は耳にならない
      let ok = true;
      for (let q = 0; q < m; q++) {
        const p = idx[q];
        if (p === a || p === b || p === c) continue;
        if (inside(p, a, b, c)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      out.push(a, b, c);
      idx.splice(k, 1);
      found = true;
      break;
    }
    if (!found) {
      // 自己交差などで耳が見つからないとき: 残りを扇形に分けて終える
      for (let k = 1; k + 1 < idx.length; k++) out.push(idx[0], idx[k], idx[k + 1]);
      return out;
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

const MAX_VERTS_PER_BUILDING = 120;

/**
 * 建物の、距離ごとの作り方(原点=クリックした地点からの距離)。
 *   ・約2.5kmまで = 建物の形(多角形)をそのまま押し出した立体(`buildBuildingMesh`)
 *   ・約2.5km〜20km = 外接する四角い箱(`BoxCollector`・`buildBoxInstances`)。**間引かない**(すべての建物を作る)。
 *     2.5km先の家は画面で数画素なので、形を箱にしても見た目は変わらない。箱は1棟32バイトで、GPUの「インスタンス描画」で
 *     まとめて描く(1棟あたりの頂点データを持たないので、形の立体の約1/15のメモリで済む)
 *   ・20kmより先 = 遠いほど間引き(残す割合 = (20km/距離)^2。最小6%)、残した箱を、間引いたぶんだけ大きくする
 *     (半幅を 1/√残す割合 倍。建物の面積の合計=街の広がりの見え方を保つ)
 * 遠くの箱は、見える最小の大きさ(`boxMinHalf`)まで少しだけ広げる(画面で点より小さくなって消えないように)。
 */
export const FOOTPRINT_MAX_M = 2500;
export const DETAIL_MAX_M = 20_000;
const BOX_THIN_EXP = 2;
const BOX_KEEP_MIN = 0.06;
/** 距離d(m)の建物を残す割合(20kmまでは1=全部) */
export const boxKeepRatio = (d: number): number =>
  d <= DETAIL_MAX_M ? 1 : Math.max(BOX_KEEP_MIN, (DETAIL_MAX_M / d) ** BOX_THIN_EXP);
/** 距離d(m)で見える最小の箱の半幅(m): 2.5km先で2m、そこから1kmにつき0.25mずつ(20km先で約6m) */
export const boxMinHalf = (d: number): number => 2 + Math.max(0, d - FOOTPRINT_MAX_M) * 0.00025;

/** 輪の頂点の平均(中心) */
function ringCentroid(r: Float32Array): [number, number] {
  let x = 0;
  let z = 0;
  const n = r.length / 2;
  for (let i = 0; i < n; i++) {
    x += r[i * 2];
    z += r[i * 2 + 1];
  }
  return [x / n, z / n];
}

/**
 * 読み込み中の建物を、集める前に整える。形の立体にする建物(約2.5kmまで・頂点が多すぎない)だけを、中心(cx, cz)つきで返す。
 * それ以外(遠い建物・頂点が多すぎる建物)は null。呼ぶ側は、それを箱(`BoxCollector`)へ回す。
 */
export function prepareBuilding(b: GeoBuilding): GeoBuilding | null {
  if (b.ring.length / 2 > MAX_VERTS_PER_BUILDING) return null;
  const [cx, cz] = ringCentroid(b.ring);
  if (cx * cx + cz * cz > FOOTPRINT_MAX_M * FOOTPRINT_MAX_M) return null;
  return { code: b.code, ring: b.ring, cx, cz };
}

/** 箱1棟の持ち方(Float32の6つ): 中心x, 中心z, 半幅x, 半幅z, 種類(vt_code), 高さの倍率 */
const BOX_STRIDE = 6;
/** 距離で並べる・上限で切るときの距離の刻み(m) */
const BOX_BIN_M = 100;

/**
 * 箱にする建物(約2.5kmより遠い建物)を、1棟6つの数値で詰めて持つ(数十万〜百万棟でも、建物ごとの物を作らない)。
 * 距離による間引き・大きさの調整は、入れるときに済ませる。原点に近い順に上限(cap)までだけ持つ
 * (上限の1.5倍たまったら、距離の刻みごとの数を数えて、遠い側を捨てる)。
 */
export class BoxCollector {
  private buf: Float32Array;
  private n = 0;
  private cutoff2 = Infinity;
  readonly cap: number;
  constructor(cap: number) {
    this.cap = Math.max(0, Math.floor(cap));
    this.buf = new Float32Array(Math.min(this.cap, 1 << 16) * BOX_STRIDE + BOX_STRIDE);
  }

  get count(): number {
    return this.n;
  }

  add(b: GeoBuilding): void {
    if (this.cap === 0) return;
    const r = b.ring;
    if (r.length < 6) return;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < x0) x0 = r[i];
      if (r[i] > x1) x1 = r[i];
      if (r[i + 1] < z0) z0 = r[i + 1];
      if (r[i + 1] > z1) z1 = r[i + 1];
    }
    this.addRect((x0 + x1) / 2, (z0 + z1) / 2, (x1 - x0) / 2, (z1 - z0) / 2, b.code);
  }

  /** 原点から距離 d(m)より遠い建物は、もう上限の中に入らないか */
  full(d: number): boolean {
    return d * d >= this.cutoff2;
  }

  /**
   * 中心(cx, cz)・半幅(hx, hz)の四角い建物を入れる(推定の箱にも使う)。
   * preKept = 呼ぶ側で前もって間引いた割合(推定の箱は、区画ごとに間引いてから作る)。間引きはその分だけ減らし、大きさは全体の割合で決める
   */
  addRect(cx: number, cz: number, halfX: number, halfZ: number, code: number, preKept = 1): void {
    if (this.cap === 0) return;
    const d2 = cx * cx + cz * cz;
    if (d2 >= this.cutoff2) return;
    const d = Math.sqrt(d2);
    const keep = boxKeepRatio(d);
    const p = Math.min(1, keep / preKept);
    if (p < 1 && hash01(cx, cz, 9) >= p) return;
    // 間引いたぶん大きくし(面積を保つ)、見える最小の大きさより小さい辺は広げる
    const grow = Math.min(4, 1 / Math.sqrt(keep));
    const minHalf = boxMinHalf(d);
    const hx0 = Math.max(halfX, 1);
    const hz0 = Math.max(halfZ, 1);
    const hx = Math.max(hx0 * grow, minHalf);
    const hz = Math.max(hz0 * grow, minHalf);
    // 高さは、広げた倍率の平方根倍(最大2倍)。家が高いビルにならない
    const heightK = Math.min(2, Math.sqrt(Math.max(hx / hx0, hz / hz0)));
    if ((this.n + 1) * BOX_STRIDE > this.buf.length) {
      const bigger = new Float32Array(Math.max(this.buf.length * 2, (this.n + 1) * BOX_STRIDE));
      bigger.set(this.buf.subarray(0, this.n * BOX_STRIDE));
      this.buf = bigger;
    }
    const o = this.n * BOX_STRIDE;
    this.buf[o] = cx;
    this.buf[o + 1] = cz;
    this.buf[o + 2] = hx;
    this.buf[o + 3] = hz;
    this.buf[o + 4] = code;
    this.buf[o + 5] = heightK;
    this.n++;
    if (this.n > this.cap * 1.5 + 1024) this.prune();
  }

  /** 距離の刻みごとの数を数え、上限に収まる刻みまでを残す(遠い側を捨てる) */
  private prune(): void {
    if (this.n <= this.cap) return;
    const bins = this.binCounts();
    let acc = 0;
    let cut = bins.length;
    for (let i = 0; i < bins.length; i++) {
      if (acc + bins[i] > this.cap) {
        cut = i;
        break;
      }
      acc += bins[i];
    }
    const cutoff = cut * BOX_BIN_M;
    const c2 = cutoff * cutoff;
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const o = i * BOX_STRIDE;
      const x = this.buf[o];
      const z = this.buf[o + 1];
      if (x * x + z * z >= c2) continue;
      if (w !== i) this.buf.copyWithin(w * BOX_STRIDE, o, o + BOX_STRIDE);
      w++;
    }
    this.n = w;
    this.cutoff2 = Math.min(this.cutoff2, c2);
  }

  private binOf(i: number): number {
    const o = i * BOX_STRIDE;
    return Math.floor(Math.hypot(this.buf[o], this.buf[o + 1]) / BOX_BIN_M);
  }

  private binCounts(): Uint32Array {
    let maxBin = 0;
    for (let i = 0; i < this.n; i++) maxBin = Math.max(maxBin, this.binOf(i));
    const bins = new Uint32Array(maxBin + 1);
    for (let i = 0; i < this.n; i++) bins[this.binOf(i)]++;
    return bins;
  }

  /** いまの時点の箱(原点に近い順。上限まで)。持っている箱はそのまま(あとで足せる) */
  snapshot(): Float32Array {
    this.prune();
    return this.sorted();
  }

  /** 原点に近い順(刻みごと)に並べた、上限までの箱(1棟6つ)。持っている箱は手放す */
  result(): Float32Array {
    this.prune();
    const out = this.sorted();
    this.buf = new Float32Array(0);
    this.n = 0;
    return out;
  }

  private sorted(): Float32Array {
    if (this.n === 0) return new Float32Array(0);
    const bins = this.binCounts();
    const start = new Uint32Array(bins.length);
    for (let i = 1; i < bins.length; i++) start[i] = start[i - 1] + bins[i - 1];
    const out = new Float32Array(this.n * BOX_STRIDE);
    for (let i = 0; i < this.n; i++) {
      const k = this.binOf(i);
      const o = start[k]++ * BOX_STRIDE;
      out.set(this.buf.subarray(i * BOX_STRIDE, i * BOX_STRIDE + BOX_STRIDE), o);
    }
    return out;
  }
}

/**
 * 推定の箱(遠くの街): 建物のデータ(ズーム16)を読まない遠く(約20km〜)に、250m区画ごとの「建物のある割合」(標準地図の市街地の色。
 * 人口集中地区は0.85以上。`viewerLight.ts` の `loadUrbanGrid`)から、本物の建物と同じくらいの数・大きさの四角い建物を、区画の中に
 * ばらまく(位置・大きさは区画ごとの乱数で、いつも同じ)。数は、割合が0.08で0、0.5以上で1区画150棟(約2,400棟/km²。街なかの密度)。
 * 置いた建物は、本物の建物と同じく、距離に応じて間引き・大きくする(区画ごとに先に間引いてから作り、`BoxCollector.addRect` には
 * 間引いた割合を渡す)。夜景の光の点にも入れる。近い区画から順に置き、箱の上限に達したら終える。戻り値は置いた棟数。
 */
export const PROXY_PER_CELL = 150;
export async function addUrbanProxies(
  grid: { value: Float32Array; n: number; cell: number; half: number },
  rMin: number,
  rMax: number,
  /** preKept = 区画ごとに前もって間引いた割合(`BoxCollector.addRect` などに渡す) */
  add: (cx: number, cz: number, hx: number, hz: number, code: number, preKept: number) => void,
  cancelled: () => boolean,
  /** 原点からこの距離(m)より遠い区画は、もう置かなくてよいか(箱の上限に達した) */
  done: (d: number) => boolean = () => false,
): Promise<number> {
  const { value, n, cell, half } = grid;
  // 近い区画から順に置く(箱の上限に達したら、それより遠い区画は置かずに終える)
  const cells: { i: number; d: number }[] = [];
  for (let cz = 0; cz < n; cz++) {
    for (let cx = 0; cx < n; cx++) {
      if (value[cz * n + cx] < 0.08) continue;
      const d = Math.hypot(-half + (cx + 0.5) * cell, -half + (cz + 0.5) * cell);
      if (d >= rMin - cell && d < rMax + cell) cells.push({ i: cz * n + cx, d });
    }
  }
  cells.sort((a, b) => a.d - b.d);
  let placed = 0;
  for (let c = 0; c < cells.length; c++) {
    if (c % 1500 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (cancelled()) return placed;
    }
    const { i, d } = cells[c];
    if (done(d - cell)) break;
    const v = value[i];
    const X = -half + ((i % n) + 0.5) * cell;
    const Z = -half + (Math.floor(i / n) + 0.5) * cell;
    // 遠いほど間引く割合を、区画ごとに先に掛けてから作る(数百万棟を作ってから捨てないように)
    const kept = boxKeepRatio(Math.max(d, rMin));
    const want = PROXY_PER_CELL * Math.min(1, (v - 0.08) / 0.42) * kept;
    const count = Math.floor(want) + (hash01(X, Z, 99) < want - Math.floor(want) ? 1 : 0);
    for (let k = 0; k < count; k++) {
      const x = X + (hash01(X, Z, 100 + k) - 0.5) * cell;
      const z = Z + (hash01(X, Z, 300 + k) - 0.5) * cell;
      const r = Math.hypot(x, z);
      if (r < rMin || r >= rMax) continue;
      const h = hash01(x, z, 5);
      const code = h < 0.02 && v > 0.6 ? 3103 : h < 0.25 ? 3102 : 3101;
      add(x, z, 4 + 4 * hash01(x, z, 6), 3.5 + 3.5 * hash01(x, z, 7), code, kept);
      placed++;
    }
  }
  return placed;
}

/** 箱のインスタンス(1棟32バイト): a=中心x,中心z,半幅x,半幅z / b=下端y,上端y / colors=壁の色rgb+255,屋根の色rgb+255 */
export interface BoxInstances {
  a: Float32Array;
  b: Float32Array;
  colors: Uint8Array;
  count: number;
}

/**
 * 箱(`BoxCollector.result`)を、GPUに渡すインスタンスの並びにする。地面の高さは箱の4隅で引く(坂でも浮かない)。
 * 数十万棟あるので、2万棟ごとに一息つく(画面が固まらないように)。cancelled が真になったら null。
 */
export async function buildBoxInstances(
  boxes: Float32Array,
  groundAt: (X: number, Z: number) => number,
  cancelled: () => boolean,
): Promise<BoxInstances | null> {
  const count = Math.floor(boxes.length / BOX_STRIDE);
  const a = new Float32Array(count * 4);
  const b = new Float32Array(count * 2);
  const colors = new Uint8Array(count * 8);
  const b255 = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
  for (let i = 0; i < count; i++) {
    if (i > 0 && i % 20_000 === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (cancelled()) return null;
    }
    const o = i * BOX_STRIDE;
    const cx = boxes[o];
    const cz = boxes[o + 1];
    const hx = boxes[o + 2];
    const hz = boxes[o + 3];
    const code = boxes[o + 4];
    const heightK = boxes[o + 5];
    const g1 = groundAt(cx - hx, cz - hz);
    const g2 = groundAt(cx + hx, cz - hz);
    const g3 = groundAt(cx + hx, cz + hz);
    const g4 = groundAt(cx - hx, cz + hz);
    const gMin = Math.min(g1, g2, g3, g4);
    const gMax = Math.max(g1, g2, g3, g4);
    const [h0, hw] = HEIGHT_BY_CODE[code] ?? HEIGHT_DEFAULT;
    const h = (h0 + hw * hash01(cx, cz, 1)) * heightK;
    a[i * 4] = cx;
    a[i * 4 + 1] = cz;
    a[i * 4 + 2] = hx;
    a[i * 4 + 3] = hz;
    b[i * 2] = gMin - 1.2;
    b[i * 2 + 1] = gMax + h;
    const wall = WALL_COLORS[Math.floor(hash01(cx, cz, 2) * WALL_COLORS.length) % WALL_COLORS.length];
    const roof = ROOF_COLORS[Math.floor(hash01(cx, cz, 3) * ROOF_COLORS.length) % ROOF_COLORS.length];
    const shade = 0.92 + 0.12 * hash01(cx, cz, 4);
    colors[i * 8] = b255(wall[0] * shade);
    colors[i * 8 + 1] = b255(wall[1] * shade);
    colors[i * 8 + 2] = b255(wall[2] * shade);
    colors[i * 8 + 3] = 255;
    colors[i * 8 + 4] = b255(roof[0] * shade);
    colors[i * 8 + 5] = b255(roof[1] * shade);
    colors[i * 8 + 6] = b255(roof[2] * shade);
    colors[i * 8 + 7] = 255;
  }
  return { a, b, colors, count };
}

/** 数値を、足しながら伸びる型付き配列に入れる(数百万件の number[] だとメモリが膨らむので) */
class GrowBuf<T extends Float32Array | Uint32Array | Int8Array | Uint8Array> {
  private a: T;
  private readonly make: (len: number) => T;
  n = 0;
  constructor(make: (len: number) => T, initial = 1 << 16) {
    this.make = make;
    this.a = make(initial);
  }
  push(...v: number[]): void {
    if (this.n + v.length > this.a.length) {
      const bigger = this.make(Math.max(this.a.length * 2, this.n + v.length));
      bigger.set(this.a.subarray(0, this.n));
      this.a = bigger;
    }
    for (let i = 0; i < v.length; i++) this.a[this.n + i] = v[i];
    this.n += v.length;
  }
  get length(): number {
    return this.n;
  }
  done(): T {
    return this.a.slice(0, this.n) as T;
  }
}

/**
 * 夜景の光の点(建物1棟につき1つ)を、描画範囲のすべての建物から集める。建物の立体の数の上限・遠くの間引き(`prepareBuilding`)とは
 * 別に数えるので、立体が上限に達する街(都市)でも、遠く(約50kmまで)の建物が光の点として出る。
 *   ・遠いほど間引く(残す割合 = (2.5km/距離)^1.5。最小2%)が、残した1つの点を大きく(明るく)して、街全体の明るさをほぼ保つ
 *   ・点は、約3m四方の小さい建物でも、遠くで最低約3pxで描かれるので、間引いても街の灯りの広がりは見える
 * 1棟16バイト(x, z, 半幅, 高さ)。上限(maxLights)を超えたら、それ以降は入れない。
 */
const LIGHT_FULL_M = 2500;
const LIGHT_KEEP_EXP = 1.5;
const LIGHT_KEEP_MIN = 0.02;
const LIGHT_HALF_MAX_M = 40;
export const lightKeepRatio = (d: number): number => (d <= LIGHT_FULL_M ? 1 : Math.max(LIGHT_KEEP_MIN, (LIGHT_FULL_M / d) ** LIGHT_KEEP_EXP));

export class LightCollector {
  private readonly buf = new GrowBuf((n) => new Float32Array(n), 1 << 15);
  private readonly maxLights: number;
  constructor(maxLights: number) {
    this.maxLights = maxLights;
  }

  get count(): number {
    return this.buf.length / 4;
  }

  /** 建物の輪(x0,z0,x1,z1,… m)と種類を渡す。間引きの結果、入れたら true */
  add(b: GeoBuilding): boolean {
    if (this.count >= this.maxLights) return false;
    const r = b.ring;
    if (r.length < 6) return false;
    let x0 = Infinity;
    let x1 = -Infinity;
    let z0 = Infinity;
    let z1 = -Infinity;
    for (let i = 0; i < r.length; i += 2) {
      if (r[i] < x0) x0 = r[i];
      if (r[i] > x1) x1 = r[i];
      if (r[i + 1] < z0) z0 = r[i + 1];
      if (r[i + 1] > z1) z1 = r[i + 1];
    }
    return this.addRect((x0 + x1) / 2, (z0 + z1) / 2, Math.max(x1 - x0, z1 - z0) / 2, b.code);
  }

  /** 中心(cx, cz)・半幅 halfW(m)の建物の光の点を入れる(推定の箱にも使う)。間引きの結果、入れたら true */
  addRect(cx: number, cz: number, halfW: number, code: number, preKept = 1): boolean {
    if (this.count >= this.maxLights) return false;
    const keep = lightKeepRatio(Math.hypot(cx, cz));
    const p = Math.min(1, keep / preKept);
    if (p < 1 && hash01(cx, cz, 11) >= p) return false;
    // 間引いたぶん、1つの点を大きく(明るく)する(街全体の明るさを保つ)
    const half = Math.min(LIGHT_HALF_MAX_M, (halfW + 1) / Math.sqrt(keep));
    const [h0, hw] = HEIGHT_BY_CODE[code] ?? HEIGHT_DEFAULT;
    this.buf.push(cx, cz, half, h0 + hw * hash01(cx, cz, 1));
    return true;
  }

  /** 光の点(x, y, z, 大きさ)にする。高さは、地面の高さ+建物の高さの約55% */
  result(groundAt: (X: number, Z: number) => number): Float32Array {
    const a = this.buf.done();
    const n = a.length / 4;
    const out = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) {
      const x = a[i * 4];
      const z = a[i * 4 + 1];
      out[i * 4] = x;
      out[i * 4 + 1] = groundAt(x, z) + a[i * 4 + 3] * 0.55;
      out[i * 4 + 2] = z;
      out[i * 4 + 3] = a[i * 4 + 2];
    }
    return out;
  }
}

/**
 * 近く(約2.5kmまで)の建物の形を、押し出した立体にして1つのメッシュにまとめる(遠い建物は箱。`buildBoxInstances`)。
 * @param groundAt 位置(X東・Z南、m)の地面の高さ(m)
 * @param maxCount 作る建物の数の上限(原点に近いものから)
 */
export function buildBuildingMesh(
  buildings: GeoBuilding[],
  groundAt: (X: number, Z: number) => number,
  maxCount = 20_000,
): BuildingMeshData & { /** 作った建物の数 */ count: number } {
  // 整えてある建物(中心を持つ)は、頂点数の確認はもう済んでいる
  const list = buildings
    .map((b) => {
      const [cx, cz] = b.cx !== undefined && b.cz !== undefined ? [b.cx, b.cz] : ringCentroid(b.ring);
      return { b, cx, cz, d: cx * cx + cz * cz };
    })
    .filter((e) => e.b.cx !== undefined || e.b.ring.length / 2 <= MAX_VERTS_PER_BUILDING)
    .sort((p, q) => p.d - q.d)
    .slice(0, maxCount);

  const pos = new GrowBuf((n) => new Float32Array(n));
  // 法線は1頂点4バイト(Int8・正規化。x,y,z,0)、色は1頂点4バイト(Uint8・正規化。r,g,b,255)。Float32(各12バイト)の約1/3(GPUのメモリを抑える)
  const nrm = new GrowBuf((n) => new Int8Array(n));
  const col = new GrowBuf((n) => new Uint8Array(n));
  const b127 = (v: number): number => Math.round(Math.max(-1, Math.min(1, v)) * 127);
  const b255 = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255);
  const idx = new GrowBuf((n) => new Uint32Array(n));

  for (const { b, cx, cz } of list) {
    let ring = b.ring;
    // 最後の点が最初と同じなら除く
    let n = ring.length / 2;
    if (n > 3 && ring[0] === ring[(n - 1) * 2] && ring[1] === ring[(n - 1) * 2 + 1]) {
      ring = ring.subarray(0, (n - 1) * 2);
      n--;
    }
    if (n < 3) continue;
    // math向き(面積が正)にそろえる
    if (signedArea(ring) < 0) {
      const r2 = new Float32Array(ring.length);
      for (let i = 0; i < n; i++) {
        r2[i * 2] = ring[(n - 1 - i) * 2];
        r2[i * 2 + 1] = ring[(n - 1 - i) * 2 + 1];
      }
      ring = r2;
    }
    let gMin = Infinity;
    let gMax = -Infinity;
    for (let i = 0; i < n; i++) {
      const g = groundAt(ring[i * 2], ring[i * 2 + 1]);
      if (g < gMin) gMin = g;
      if (g > gMax) gMax = g;
    }
    const [h0, hw] = HEIGHT_BY_CODE[b.code] ?? HEIGHT_DEFAULT;
    const h = h0 + hw * hash01(cx, cz, 1);
    const wall = WALL_COLORS[Math.floor(hash01(cx, cz, 2) * WALL_COLORS.length) % WALL_COLORS.length];
    const roof = ROOF_COLORS[Math.floor(hash01(cx, cz, 3) * ROOF_COLORS.length) % ROOF_COLORS.length];
    const shade = 0.92 + 0.12 * hash01(cx, cz, 4);
    const yBottom = gMin - 1.2;
    const yTop = gMax + h;

    // 壁
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x0 = ring[i * 2];
      const z0 = ring[i * 2 + 1];
      const x1 = ring[j * 2];
      const z1 = ring[j * 2 + 1];
      const dx = x1 - x0;
      const dz = z1 - z0;
      const l = Math.hypot(dx, dz);
      if (l < 0.05) continue;
      const nx = dz / l;
      const nz = -dx / l;
      const base = pos.length / 3;
      pos.push(x0, yBottom, z0, x1, yBottom, z1, x1, yTop, z1, x0, yTop, z0);
      const wnx = b127(nx);
      const wnz = b127(nz);
      const wr = b255(wall[0] * shade);
      const wg = b255(wall[1] * shade);
      const wb = b255(wall[2] * shade);
      for (let k = 0; k < 4; k++) {
        nrm.push(wnx, 0, wnz, 0);
        col.push(wr, wg, wb, 255);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    // 屋根
    const tris = triangulateRing(ring);
    if (tris.length > 0) {
      const base = pos.length / 3;
      for (let i = 0; i < n; i++) {
        pos.push(ring[i * 2], yTop, ring[i * 2 + 1]);
        nrm.push(0, 127, 0, 0);
        col.push(b255(roof[0] * shade), b255(roof[1] * shade), b255(roof[2] * shade), 255);
      }
      for (const t of tris) idx.push(base + t);
    }
  }
  return {
    positions: pos.done(),
    normals: nrm.done(),
    colors: col.done(),
    indices: idx.done(),
    count: list.length,
  };
}
