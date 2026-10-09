import { loadAnnoTile, type AnnoPoint } from "./viewerGeo";
import { seaRefAt } from "./viewerSea";
import { clamp, projectPoint, worldPx, type Mat4, type Vec3 } from "./viewerMath";
import { curvatureDropM, makeTileSet, runPool, tileRefs, type TileSet } from "./viewerTerrain";

/**
 * 3Dビューワー: 地名・百名山の表示(√のような形のラベル)。
 *
 * ・地名 = 国土地理院の「最適化ベクトルタイル」の注記(Anno)から。市町村名・山名・湖・峠・高原。山名には近くの標高点の標高を添える。
 * ・百名山 = 日本百名山の一覧(下の表。名前・おおよその位置・標高)。位置は、注記の山名と一致するものがあればその位置、無ければ表の位置から
 *   いちばん高い所へ登って(山頂に合わせて)決める。
 * ラベルの形は「√」: 山・町の位置を√の底にして、右上へ伸びる線の先から右へ線(√の上線)を引き、その下に名前を書く。
 * 山に隠れて見えない所・雲海の下にある所は出さない(視点が動いたときだけ見え方を計算し直す)。
 */

export type LabelKind = "peak" | "place";

export interface LabelItem {
  kind: LabelKind;
  text: string;
  /** 名前の下に小さく添える文字(標高など) */
  sub: string;
  /** 重なったときの優先度(大きいほど先に置く) */
  rank: number;
  /** 原点から見た位置(X東・Z南、m) */
  x: number;
  z: number;
  /** ワールドのY(m。地面の高さ+少し。地球の丸みで下がる分を含む) */
  y: number;
}

// ---------------------------------------------------------------------------
// 日本百名山(名前・おおよその位置・標高)
// ---------------------------------------------------------------------------

/** [表示名, 地図上の名前(正規化して照合), 緯度, 経度, 標高m] */
type Hyaku = [string, string[], number, number, number];

export const HYAKUMEIZAN: Hyaku[] = [
  ["利尻岳", ["利尻山", "利尻岳"], 45.1783, 141.2425, 1721],
  ["羅臼岳", ["羅臼岳"], 44.0742, 145.1236, 1661],
  ["斜里岳", ["斜里岳"], 43.7589, 144.7283, 1547],
  ["阿寒岳", ["雌阿寒岳", "阿寒岳"], 43.3869, 144.0128, 1499],
  ["大雪山", ["旭岳", "大雪山"], 43.6636, 142.8539, 2291],
  ["トムラウシ", ["トムラウシ山", "トムラウシ"], 43.5283, 142.8458, 2141],
  ["十勝岳", ["十勝岳"], 43.4181, 142.6867, 2077],
  ["幌尻岳", ["幌尻岳"], 42.7233, 142.6833, 2052],
  ["羊蹄山", ["羊蹄山", "後方羊蹄山"], 42.8258, 140.8114, 1898],
  ["岩木山", ["岩木山"], 40.6556, 140.3039, 1625],
  ["八甲田山", ["八甲田山", "大岳"], 40.6575, 140.8797, 1585],
  ["八幡平", ["八幡平"], 39.9553, 140.8564, 1613],
  ["岩手山", ["岩手山"], 39.8531, 141.0011, 2038],
  ["早池峰", ["早池峰山", "早池峰"], 39.4981, 141.4833, 1917],
  ["鳥海山", ["鳥海山"], 39.0992, 140.0494, 2236],
  ["月山", ["月山"], 38.55, 140.0289, 1984],
  ["朝日岳", ["大朝日岳"], 38.1272, 139.9264, 1871],
  ["蔵王山", ["熊野岳", "蔵王山"], 38.1431, 140.4425, 1841],
  ["飯豊山", ["飯豊山"], 37.8553, 139.7108, 2105],
  ["吾妻山", ["西吾妻山", "吾妻山"], 37.7414, 140.0881, 2035],
  ["安達太良山", ["安達太良山"], 37.6219, 140.2808, 1700],
  ["磐梯山", ["磐梯山"], 37.6006, 140.0728, 1816],
  ["会津駒ヶ岳", ["会津駒ヶ岳"], 37.0083, 139.3733, 2133],
  ["那須岳", ["茶臼岳", "那須岳"], 37.1219, 139.9694, 1915],
  ["越後駒ヶ岳", ["越後駒ヶ岳", "魚沼駒ヶ岳"], 37.06, 139.06, 2003],
  ["平ヶ岳", ["平ヶ岳"], 36.97, 139.17, 2141],
  ["巻機山", ["巻機山"], 36.97, 138.88, 1967],
  ["燧ヶ岳", ["燧ヶ岳", "燧岳"], 36.9556, 139.2917, 2356],
  ["至仏山", ["至仏山"], 36.85, 139.18, 2228],
  ["谷川岳", ["谷川岳"], 36.835, 138.9283, 1977],
  ["武尊山", ["武尊山", "沖武尊"], 36.87, 139.1, 2158],
  ["苗場山", ["苗場山"], 36.83, 138.7, 2145],
  ["雨飾山", ["雨飾山"], 36.92, 137.98, 1963],
  ["妙高山", ["妙高山"], 36.8933, 138.1158, 2454],
  ["火打山", ["火打山"], 36.9111, 138.0667, 2462],
  ["高妻山", ["高妻山"], 36.7236, 138.0542, 2353],
  ["男体山", ["男体山"], 36.7656, 139.4942, 2486],
  ["日光白根山", ["日光白根山", "奥白根山", "白根山"], 36.8003, 139.3786, 2578],
  ["皇海山", ["皇海山"], 36.65, 139.38, 2144],
  ["赤城山", ["黒檜山", "赤城山"], 36.5614, 139.1953, 1828],
  ["草津白根山", ["白根山", "草津白根山", "本白根山"], 36.6197, 138.5256, 2160],
  ["四阿山", ["四阿山", "吾妻山"], 36.52, 138.37, 2354],
  ["浅間山", ["浅間山"], 36.4064, 138.5231, 2568],
  ["筑波山", ["筑波山", "男体山"], 36.2253, 140.1067, 877],
  ["両神山", ["両神山"], 36.0, 138.89, 1723],
  ["雲取山", ["雲取山"], 35.8556, 138.9433, 2017],
  ["甲武信ヶ岳", ["甲武信ヶ岳", "甲武信岳"], 35.9, 138.72, 2475],
  ["金峰山", ["金峰山"], 35.8697, 138.6286, 2599],
  ["瑞牆山", ["瑞牆山"], 35.89, 138.59, 2230],
  ["大菩薩嶺", ["大菩薩嶺"], 35.78, 138.83, 2057],
  ["丹沢", ["蛭ヶ岳", "丹沢山"], 35.47, 139.13, 1673],
  ["富士山", ["富士山", "剣ヶ峰"], 35.3606, 138.7274, 3776],
  ["天城山", ["万三郎岳", "天城山"], 34.86, 138.97, 1406],
  ["白馬岳", ["白馬岳"], 36.7583, 137.7586, 2932],
  ["五竜岳", ["五竜岳"], 36.6417, 137.7961, 2814],
  ["鹿島槍ヶ岳", ["鹿島槍ヶ岳", "鹿島槍岳"], 36.6264, 137.7917, 2889],
  ["剱岳", ["剱岳", "剣岳"], 36.6236, 137.6178, 2999],
  ["立山", ["立山", "雄山", "大汝山"], 36.5767, 137.6203, 3015],
  ["薬師岳", ["薬師岳"], 36.32, 137.55, 2926],
  ["黒部五郎岳", ["黒部五郎岳"], 36.39, 137.52, 2840],
  ["水晶岳", ["水晶岳", "黒岳"], 36.4167, 137.6, 2986],
  ["鷲羽岳", ["鷲羽岳"], 36.4056, 137.6056, 2924],
  ["槍ヶ岳", ["槍ヶ岳", "槍岳"], 36.3417, 137.6475, 3180],
  ["穂高岳", ["奥穂高岳", "穂高岳"], 36.2894, 137.6486, 3190],
  ["常念岳", ["常念岳"], 36.3167, 137.7239, 2857],
  ["笠ヶ岳", ["笠ヶ岳", "笠岳"], 36.28, 137.56, 2898],
  ["焼岳", ["焼岳"], 36.2271, 137.5864, 2455],
  ["乗鞍岳", ["剣ヶ峰", "乗鞍岳"], 36.1064, 137.5547, 3026],
  ["御嶽山", ["御嶽山", "剣ヶ峰"], 35.8933, 137.4805, 3067],
  ["美ヶ原", ["王ヶ頭", "美ヶ原"], 36.2358, 138.1067, 2034],
  ["霧ヶ峰", ["車山", "霧ヶ峰"], 36.1127, 138.1958, 1925],
  ["蓼科山", ["蓼科山"], 36.0956, 138.3039, 2531],
  ["八ヶ岳", ["赤岳", "八ヶ岳"], 35.9708, 138.3706, 2899],
  ["木曽駒ヶ岳", ["木曽駒ヶ岳", "駒ヶ岳"], 35.7894, 137.8044, 2956],
  ["空木岳", ["空木岳"], 35.7, 137.8, 2864],
  ["恵那山", ["恵那山"], 35.4469, 137.5947, 2191],
  ["甲斐駒ヶ岳", ["甲斐駒ヶ岳", "甲斐駒"], 35.7589, 138.2372, 2967],
  ["仙丈ヶ岳", ["仙丈ヶ岳", "仙丈岳"], 35.7208, 138.1819, 3033],
  ["鳳凰山", ["観音岳", "鳳凰山", "地蔵ヶ岳", "薬師岳"], 35.7144, 138.3253, 2841],
  ["北岳", ["北岳"], 35.6742, 138.2386, 3193],
  ["間ノ岳", ["間ノ岳", "間ノ岳"], 35.6461, 138.2297, 3190],
  ["塩見岳", ["塩見岳"], 35.57, 138.13, 3052],
  ["悪沢岳", ["東岳", "悪沢岳"], 35.5167, 138.1561, 3141],
  ["赤石岳", ["赤石岳"], 35.4533, 138.1519, 3121],
  ["聖岳", ["聖岳"], 35.4, 138.1, 3013],
  ["光岳", ["光岳", "テカリ岳"], 35.33, 138.1, 2592],
  ["白山", ["御前峰", "白山"], 36.1544, 136.7714, 2702],
  ["荒島岳", ["荒島岳"], 35.92, 136.58, 1523],
  ["伊吹山", ["伊吹山"], 35.4175, 136.4064, 1377],
  ["大台ヶ原山", ["日出ヶ岳", "大台ヶ原山", "大台ヶ原"], 34.1833, 136.1167, 1695],
  ["大峰山", ["八経ヶ岳", "大峰山", "八剣山"], 34.1544, 135.9242, 1915],
  ["大山", ["大山", "剣ヶ峰"], 35.3711, 133.5403, 1729],
  ["剣山", ["剣山"], 33.8556, 134.0944, 1955],
  ["石鎚山", ["石鎚山", "天狗岳"], 33.7681, 133.1153, 1982],
  ["九重山", ["久住山", "中岳", "九重山"], 33.0833, 131.2417, 1791],
  ["祖母山", ["祖母山"], 32.8, 131.37, 1756],
  ["阿蘇山", ["高岳", "阿蘇山", "中岳"], 32.8847, 131.1043, 1592],
  ["霧島山", ["韓国岳", "霧島山"], 31.9333, 130.8617, 1700],
  ["開聞岳", ["開聞岳"], 31.18, 130.5283, 924],
  ["宮之浦岳", ["宮之浦岳"], 30.3358, 130.5042, 1936],
];

/** 山名の表記ゆれをそろえる(ヶ/ケ、嶽/岳、剣/釼/劔 など) */
export function normName(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[\s　・]/g, "")
    .replace(/[ケヶ]/g, "ヶ")
    .replace(/嶽/g, "岳")
    .replace(/[剣劔釼]/g, "剱");
}

/** 市町村名の「市・町・村・区」を落とした名前(「長野市」と「長野」を同じ町として扱う) */
function stemOf(s: string): string {
  return s.length >= 3 ? s.replace(/[市町村区]$/, "") : s;
}

// ---------------------------------------------------------------------------
// 読み込み
// ---------------------------------------------------------------------------

/** 地名の種別コード → 優先度(大きいほど先に置く)。山名(311〜316)は別に扱う */
const PLACE_RANK: Record<number, number> = {
  1401: 900, // 道府県庁所在地クラスの市
  1402: 800, // 市
  110: 700, // 市町村(標準地図に出る市町村名)
  1403: 650, // 町村
  332: 450, // 峠
  331: 420, // 高原
  321: 350, // 湖・池
};
const isMountain = (code: number): boolean => code >= 311 && code <= 316;
const isElevPoint = (code: number): boolean => code === 7101 || code === 7102 || code === 7201 || code === 7221;

/** 注記を読む範囲(原点からの距離。これより外の注記は、地形そのものが無いので使わない) */
const EDGE_MARGIN_M = 400;
/** 山の注記の位置を、描いている地形のいちばん高い所へ寄せる最大の距離(m)。百名山・地名の山 */
const SNAP_PEAK_M = 350;
const SNAP_PLACE_PEAK_M = 250;

function localXZ(ref: TileSet, lat: number, lon: number): [number, number] {
  const p = worldPx(lat, lon, ref.z);
  return [(p.x - ref.wx0) * ref.mpp, (p.y - ref.wy0) * ref.mpp];
}

/** (x,z) から、まわり(最大 maxDist m)でいちばん高い所へ登る(山頂に合わせる) */
function climb(x: number, z: number, groundAt: (X: number, Z: number) => number, maxDist: number): [number, number] {
  let cx = x;
  let cz = z;
  let best = groundAt(cx, cz);
  let step = 80;
  for (let it = 0; it < 60 && step >= 10; it++) {
    let bx = cx;
    let bz = cz;
    let bh = best;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      const nx = cx + Math.cos(a) * step;
      const nz = cz + Math.sin(a) * step;
      if (Math.hypot(nx - x, nz - z) > maxDist) continue;
      const h = groundAt(nx, nz);
      if (h > bh + 0.3) {
        bh = h;
        bx = nx;
        bz = nz;
      }
    }
    if (bh > best + 0.3) {
      best = bh;
      cx = bx;
      cz = bz;
    } else {
      step /= 2;
    }
  }
  return [cx, cz];
}

export interface LabelLoad {
  items: LabelItem[];
  peaks: number;
  places: number;
}

/**
 * 地名・百名山を読み込む。
 * 注記タイル: ズーム9(広く。主な山・町・峠)と、ズーム11(描画範囲を広げたときは10。細かい町・山・湖など)。
 * rangeM = 地形の半径(m)。groundAt = ワールドのY(地面の高さ。地球の丸みの分を含む)。
 */
export async function loadLabels(
  lat0: number,
  lon0: number,
  rangeM: number,
  wide: boolean,
  groundAt: (X: number, Z: number) => number,
  cancelled: () => boolean,
): Promise<LabelLoad> {
  const sets: TileSet[] = [makeTileSet(lat0, lon0, 9, rangeM), makeTileSet(lat0, lon0, wide ? 10 : 11, rangeM)];
  const pts: AnnoPoint[] = [];
  const jobs: { set: TileSet; tx: number; ty: number }[] = [];
  for (const set of sets) for (const r of tileRefs(set)) jobs.push({ set, tx: r.tx, ty: r.ty });
  await runPool(
    jobs,
    6,
    async (j) => {
      const got = await loadAnnoTile(j.set, j.tx, j.ty);
      for (const p of got) pts.push(p);
    },
    cancelled,
  );
  if (cancelled()) return { items: [], peaks: 0, places: 0 };

  const limit = rangeM - EDGE_MARGIN_M;
  const within = (p: { x: number; z: number }): boolean => Math.hypot(p.x, p.z) <= limit;

  // 標高点(数字だけの注記)。山名に標高を添えるのに使う
  const elevPts = pts.filter((p) => isElevPoint(p.code) && /^\d{2,4}$/.test(p.text) && within(p));
  const elevNear = (x: number, z: number): string => {
    let best = "";
    let bd = 350;
    for (const e of elevPts) {
      const d = Math.hypot(e.x - x, e.z - z);
      if (d < bd) {
        bd = d;
        best = `${Number(e.text)}m`;
      }
    }
    return best;
  };

  // ---- 百名山 ----
  const mountains = pts.filter((p) => isMountain(p.code) && p.text.length <= 12);
  const refSet = sets[0];
  const hyakuTaken: { x: number; z: number; n: string }[] = [];
  const items: LabelItem[] = [];
  let peaks = 0;
  for (const h of HYAKUMEIZAN) {
    const [name, alts, lat, lon, elev] = h;
    // 遠すぎる山は、すぐ捨てる(緯度経度の差でおおまかに)
    if (Math.abs(lat - lat0) > (rangeM / 111_000) * 1.3 || Math.abs(lon - lon0) > (rangeM / 90_000) * 1.4) continue;
    const [tx, tz] = localXZ(refSet, lat, lon);
    if (Math.hypot(tx, tz) > limit + 25_000) continue;
    const want = new Set(alts.map(normName));
    let cand: AnnoPoint | null = null;
    let cd = 18_000;
    for (const m of mountains) {
      if (!want.has(normName(m.text))) continue;
      const d = Math.hypot(m.x - tx, m.z - tz);
      if (d < cd) {
        cd = d;
        cand = m;
      }
    }
    let x: number;
    let z: number;
    if (cand) {
      // 注記の位置は山頂から数十m〜百数十mずれていることがあるので、描いている地形でいちばん高い所(近く)に合わせる
      [x, z] = climb(cand.x, cand.z, groundAt, SNAP_PEAK_M);
    } else {
      [x, z] = climb(tx, tz, groundAt, 2000);
    }
    if (Math.hypot(x, z) > limit) continue;
    // 標高が表と大きく違う所は、位置を取り違えているので出さない(まちがった所にラベルを付けないため)
    const gy = groundAt(x, z);
    const trueElev = gy + curvatureDropM(Math.hypot(x, z));
    if (Math.abs(trueElev - elev) > (cand ? 600 : 350)) continue;
    items.push({ kind: "peak", text: name, sub: `${elev}m`, rank: 1000 + elev / 10, x, z, y: gy + 8 });
    hyakuTaken.push({ x, z, n: normName(name) });
    for (const a of alts) hyakuTaken.push({ x, z, n: normName(a) });
    peaks++;
  }

  // ---- 地名 ----
  const cand: { it: LabelItem; stem: string }[] = [];
  for (const p of pts) {
    if (!within(p) || p.text.length > 12) continue;
    let rank = PLACE_RANK[p.code];
    let sub = "";
    if (isMountain(p.code)) {
      // 百名山として出す山は、ここには入れない
      const n = normName(p.text);
      if (hyakuTaken.some((t) => t.n === n && Math.hypot(t.x - p.x, t.z - p.z) < 1500)) continue;
      rank = 300 + (p.code - 310) * 40;
      sub = elevNear(p.x, p.z);
    }
    if (rank === undefined) continue;
    if (/^[\dE]+$/.test(p.text)) continue;
    // 山の名前は、位置を描いている地形の山頂に合わせる(矢印の先が山頂からずれないように)
    const [px, pz] = isMountain(p.code) ? climb(p.x, p.z, groundAt, SNAP_PLACE_PEAK_M) : [p.x, p.z];
    cand.push({ it: { kind: "place", text: p.text, sub, rank, x: px, z: pz, y: groundAt(px, pz) + 4 }, stem: stemOf(normName(p.text)) });
  }
  cand.sort((a, b) => b.it.rank - a.it.rank);
  const kept: { it: LabelItem; stem: string }[] = [];
  for (const c of cand) {
    // 同じ名前の近くの重複(ズームの違う注記・市と市役所の位置の違いなど)は、優先度の高い方だけにする
    if (kept.some((k) => k.stem === c.stem && Math.hypot(k.it.x - c.it.x, k.it.z - c.it.z) < 6000)) continue;
    kept.push(c);
  }
  for (const k of kept) items.push(k.it);
  return { items, peaks, places: kept.length };
}

// ---------------------------------------------------------------------------
// 見え方(山・雲海に隠れるか)
// ---------------------------------------------------------------------------

export interface SeaVis {
  map: Float32Array;
  size: number;
  half: number;
  /** 層の下面 = 基準の標高 + h */
  h: number;
  thick: number;
  /** 1mあたりの減衰 */
  sigma: number;
}

/**
 * 視点 eye から各ラベルの位置が見えるか(0〜1)。山(地面)に隠れていれば0。雲海の層を通る分だけ弱くする。
 * groundAt = ワールドのY(地面の高さ。地球の丸みの分を含む)。
 */
export function computeVisibility(
  items: LabelItem[],
  eye: Vec3,
  groundAt: (X: number, Z: number) => number,
  sea: SeaVis | null,
): Float32Array {
  const out = new Float32Array(items.length);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const dx = it.x - eye[0];
    const dz = it.z - eye[2];
    const dy = it.y - eye[1];
    const D = Math.hypot(dx, dz);
    if (D < 20) {
      out[i] = 1;
      continue;
    }
    const n = clamp(Math.ceil(D / 70), 10, 110);
    const len3 = Math.hypot(D, dy);
    let hidden = false;
    let tau = 0;
    let prevS = 0;
    for (let k = 1; k <= n; k++) {
      const s = k / n;
      if (!hidden && (1 - s) * D > 45) {
        const X = eye[0] + dx * s;
        const Z = eye[2] + dz * s;
        const rayY = eye[1] + dy * s;
        if (rayY < groundAt(X, Z)) hidden = true;
      }
      if (sea) {
        const sm = (prevS + s) / 2;
        const Xm = eye[0] + dx * sm;
        const Zm = eye[2] + dz * sm;
        const ref = seaRefAt(sea.map, sea.size, sea.half, Xm, Zm);
        if (ref !== null) {
          const drop = (0.87 * (Xm * Xm + Zm * Zm)) / 12_742_000;
          const base = ref + sea.h - drop;
          const top = base + sea.thick;
          const y0 = eye[1] + dy * prevS;
          const y1 = eye[1] + dy * s;
          let frac: number;
          if (Math.abs(y1 - y0) < 1e-6) frac = y0 >= base && y0 <= top ? 1 : 0;
          else {
            const tl = (base - y0) / (y1 - y0);
            const th = (top - y0) / (y1 - y0);
            frac = clamp(Math.min(1, Math.max(tl, th)) - Math.max(0, Math.min(tl, th)), 0, 1);
          }
          tau += sea.sigma * 0.93 * len3 * (s - prevS) * frac;
        }
      }
      prevS = s;
      if (hidden) break;
    }
    if (hidden) {
      out[i] = 0;
      continue;
    }
    // 雲海を通ってくる光の残り(exp(-tau))が少ないほど、ラベルを薄く・消す
    out[i] = clamp((Math.exp(-tau) - 0.18) / 0.45, 0, 1);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 描画(√の形のラベル)
// ---------------------------------------------------------------------------

export interface LabelDrawInput {
  /** 画面の大きさ(CSS px) */
  width: number;
  height: number;
  vp: Mat4;
  eye: Vec3;
  items: LabelItem[];
  vis: Float32Array;
  placesOn: boolean;
  peaksOn: boolean;
  /** 上部のバー・下部のパネルに隠れないよう空ける高さ(px) */
  topInset: number;
  bottomInset: number;
}

const FONT_FAMILY = "system-ui, 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic UI', sans-serif";
const MAX_PEAKS = 40;
const MAX_PLACES = 80;

const widthCache = new Map<string, number>();
function textW(ctx: CanvasRenderingContext2D, font: string, s: string): number {
  const key = font + "|" + s;
  let w = widthCache.get(key);
  if (w === undefined) {
    ctx.font = font;
    w = ctx.measureText(s).width;
    widthCache.set(key, w);
    if (widthCache.size > 2000) widthCache.clear();
  }
  return w;
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}
const overlaps = (a: Box, b: Box): boolean => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * √の形のラベルを描く。底の点(V)が山・町の位置。Vから右上へ長い線を引き、その先(Q)から右へ線(√の上線)を引いて、
 * 線の下に名前(と標高など)を書く。(√の左の小さな出っ張り=払いは付けない)
 */
export function drawLabels(ctx: CanvasRenderingContext2D, o: LabelDrawInput): void {
  const { width: W, height: H } = o;
  const yMin = o.topInset + 4;
  const yMax = H - o.bottomInset - 2;
  type Cand = { it: LabelItem; sx: number; sy: number; v: number; d: number };
  const cands: Cand[] = [];
  for (let i = 0; i < o.items.length; i++) {
    const it = o.items[i];
    if (it.kind === "peak" ? !o.peaksOn : !o.placesOn) continue;
    const v = o.vis[i];
    if (!(v > 0.02)) continue;
    const c = projectPoint(o.vp, [it.x, it.y, it.z]);
    if (c.w <= 1e-6) continue;
    const nx = c.x / c.w;
    const ny = c.y / c.w;
    const sx = (nx * 0.5 + 0.5) * W;
    const sy = (0.5 - ny * 0.5) * H;
    if (sx < -6 || sx > W + 6 || sy < yMin + 18 || sy > yMax) continue;
    cands.push({ it, sx, sy, v, d: Math.hypot(it.x - o.eye[0], it.z - o.eye[2]) });
  }
  cands.sort((a, b) => b.it.rank - a.it.rank || a.d - b.d);

  // 置いたラベルの「文字の枠」と「√の斜めの線の枠」。文字どうしが重ならず、線が他の文字を横切らないように置く
  const placedText: Box[] = [];
  const placedStem: Box[] = [];
  let nPeak = 0;
  let nPlace = 0;
  ctx.save();
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  for (const c of cands) {
    const peak = c.it.kind === "peak";
    if (peak ? nPeak >= MAX_PEAKS : nPlace >= MAX_PLACES) continue;
    const nameFont = peak ? `700 14px ${FONT_FAMILY}` : `600 12.5px ${FONT_FAMILY}`;
    const subFont = `500 10.5px ${FONT_FAMILY}`;
    const nameW = textW(ctx, nameFont, c.it.text);
    const subText = c.it.sub;
    const subW = subText ? textW(ctx, subFont, subText) : 0;
    const bw = Math.max(nameW, subW);
    const bh = subText ? (peak ? 29 : 27) : peak ? 17 : 16;
    const baseH = bh + 8;
    if (c.sx + 10 + 5 > W - 24) continue;
    // 低い方から、重ならない高さを探す
    let stem = 0;
    let found = false;
    for (let k = 0; k < 6 && !found; k++) {
      stem = baseH + k * (bh + 4);
      const qy = c.sy - stem;
      if (qy < yMin) break;
      const tb: Box = { x0: c.sx + 9, y0: qy - 2, x1: c.sx + 10 + 5 + bw + 7, y1: qy + bh + 5 };
      const sb: Box = { x0: c.sx - 1, y0: qy, x1: c.sx + 11, y1: c.sy + 2 };
      if (placedText.some((p) => overlaps(p, tb) || overlaps(p, sb))) continue;
      if (placedStem.some((p) => overlaps(p, tb))) continue;
      placedText.push(tb);
      placedStem.push(sb);
      found = true;
    }
    if (!found) continue;
    if (peak) nPeak++;
    else nPlace++;

    const vx = c.sx;
    const vy = c.sy;
    const qx = vx + 10;
    const qy = vy - stem;
    const lineCol = peak ? "#ffcf5a" : "#d7e0ea";
    const textCol = peak ? "#fff1c9" : "#f4f7fb";
    const subCol = peak ? "#ffd98a" : "#b9c6d4";
    ctx.globalAlpha = c.v;
    // √(まず暗い縁、つぎに色の線)
    const path = () => {
      ctx.beginPath();
      ctx.moveTo(vx, vy);
      ctx.lineTo(qx, qy);
      ctx.lineTo(qx + 5 + bw + 5, qy);
    };
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    path();
    ctx.stroke();
    ctx.lineWidth = peak ? 2 : 1.5;
    ctx.strokeStyle = lineCol;
    path();
    ctx.stroke();
    // 底の点
    ctx.fillStyle = lineCol;
    ctx.beginPath();
    ctx.arc(vx, vy, peak ? 2.6 : 2, 0, Math.PI * 2);
    ctx.fill();
    // 名前・添え書き(上線の下)
    ctx.textAlign = "left";
    ctx.font = nameFont;
    const ty = qy + 3 + (peak ? 13 : 12);
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = "rgba(0,0,0,0.75)";
    ctx.strokeText(c.it.text, qx + 5, ty);
    ctx.fillStyle = textCol;
    ctx.fillText(c.it.text, qx + 5, ty);
    if (subText) {
      ctx.font = subFont;
      ctx.lineWidth = 3;
      ctx.strokeText(subText, qx + 5, ty + 12);
      ctx.fillStyle = subCol;
      ctx.fillText(subText, qx + 5, ty + 12);
    }
  }
  ctx.restore();
}
