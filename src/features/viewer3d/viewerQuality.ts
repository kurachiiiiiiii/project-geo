/**
 * 3Dビューワー: 「処理」の低・中・高。建物・木・水を、どこまで遠くまで立体にするかの設定。
 *   ・低 = 従来どおり(建物 約1.3km・木 約1.6km・水 約4km)
 *   ・中 = 建物 約12km・木 約6km・水 約12km。地形(標高タイル)・衛星画像も細かくする
 *   ・高 = すべての範囲(地形の半径 約25km)で、建物・木・水を表示する。建物は約20kmまでズーム16のデータ、その先は推定の箱。地形・衛星画像はさらに細かくする
 * 建物はズーム16のタイルにしか、ほぼ入っていないので、建物の範囲はズーム16で読む(水は遠くほど粗いズーム)。
 * 木は間隔をあけて簡単な形にして、通信量・描く数を抑える。
 */

/**
 * 3Dビューの植生の色(地面の紅葉メッシュと、木の色)の彩度の倍率。「全体的に植生地面の彩度を20%さげて」で0.8
 * (地図の紅葉マップ・凡例の色は変えない)。
 */
export const VEG_SATURATION = 0.8;

export type Quality = "low" | "mid" | "high";

/**
 * スマホ版の3Dビューワーの「処理」は「低」「高」の2つから選ぶ(既定は「高」)。
 * スマホ版の「高」の中身は、PC版の「中」と同じ(建物・木・水を表示する距離、地形・衛星画像の細かさ)。
 * PC版の「高」(足もとの最も細かい衛星画像・5mメッシュの標高・山の影など)・描画範囲の拡張・高画質の追加効果は、
 * PC版(別フォルダ)の機能で、スマホ版では選べない(メモリ・GPU・通信量を抑えるため)。
 */
export const MOBILE_QUALITY: Quality = "mid";
/** スマホ版の「処理」の選択肢(中身の Quality と、画面に出す名前) */
export const MOBILE_QUALITY_LIST: { id: Quality; label: string }[] = [
  { id: "low", label: "低" },
  { id: "mid", label: "高" },
];
/** スマホ版で画面に出す「処理」の名前(中身が「中」なら「高」) */
export const mobileQualityLabel = (q: Quality): string => (q === "low" ? "低" : "高");
/** スマホ版の3D描画の解像度の上限(画面の画素密度に対する倍率)。画素密度が3倍前後の機種でも、描く画素数を約1/4にする */
export const MOBILE_MAX_DPR = 1.5;

export const QUALITY_LIST: { id: Quality; label: string }[] = [
  { id: "low", label: "低" },
  { id: "mid", label: "中" },
  { id: "high", label: "高" },
];

/** 建物のベクトルタイルを読む帯(原点からの距離 rMin〜rMax m。ズームごとの粗さで読む) */
export interface BuildingBand {
  zoom: number;
  rMin: number;
  rMax: number;
}

/** 木を立てる帯。step=間隔(m)、lod=木の形の細かさ(0=細かい・1=簡単・2=最も簡単) */
export interface TreeRing {
  rMin: number;
  rMax: number;
  step: number;
  lod: 0 | 1 | 2;
}

export interface QualitySpec {
  /** 建物。最初の帯(ズーム16)は川・池も同じタイルから読む(足もとの細かい水の地図用) */
  buildingBands: BuildingBand[];
  /** 近く(約2.5kmまで)の、形を押し出した建物の数の上限(原点に近いものから) */
  buildingMax: number;
  /** 遠く(約2.5km〜)の、箱にした建物の数の上限(原点に近いものから。1棟32バイト。`viewerBuildings.ts` の `BoxCollector`) */
  boxMax: number;
  /**
   * この距離(m)より遠くは、建物のデータ(ズーム16)を読まず、標準地図の市街地の色・人口集中地区から推定した箱(推定の建物)を置く。
   * null なら置かない(建物は buildingBands の範囲まで)
   */
  proxyFromM: number | null;
  /** 遠くの水の地図(ズームと範囲)。無ければ作らない */
  waterFar: { zoom: number; half: number } | null;
  treeRings: TreeRing[];
  /** 説明用(km) */
  buildingKm: number;
  treeKm: number;
  waterKm: number;
}

/** 近くの細かい水・建物(ズーム16)の範囲(m)。どの設定でも同じ */
export const NEAR_GEO_ZOOM = 16;
export const NEAR_GEO_HALF_M = 1300;
/**
 * 処理「高」の建物の帯。**建物はズーム16のタイルにしか、ほぼ入っていない**(国土地理院の最適化ベクトルタイルを実際に数えると、
 * 同じ範囲で、ズーム16は約1万3千棟、ズーム15は約190棟、ズーム14は約60棟。ズーム14・15は大きな建物だけ)。
 * 以前は約6kmから先をズーム15・14で読んでいたので、そこから先に建物がほとんど無かった。
 * いまは、約20kmまで全部ズーム16で読む(タイルは約5,200枚。帯を分けて、近い帯から順に読んで出していく)。
 * その先(拡張では50kmまで)は、ズーム16では多すぎるので、標準地図の市街地の色・人口集中地区から推定した箱を置く(`proxyFromM`)。
 */
export const HIGH_DETAIL_M = 20_000;
const highBuildingBands = (): BuildingBand[] => [
  { zoom: NEAR_GEO_ZOOM, rMin: 0, rMax: NEAR_GEO_HALF_M },
  { zoom: NEAR_GEO_ZOOM, rMin: NEAR_GEO_HALF_M, rMax: 6000 },
  // 遠くは細かい帯に分けて、近い帯から読み終えたものを順に出す(1帯 約600〜1,900枚)
  { zoom: NEAR_GEO_ZOOM, rMin: 6000, rMax: 9000 },
  { zoom: NEAR_GEO_ZOOM, rMin: 9000, rMax: 12_000 },
  { zoom: NEAR_GEO_ZOOM, rMin: 12_000, rMax: 16_000 },
  { zoom: NEAR_GEO_ZOOM, rMin: 16_000, rMax: HIGH_DETAIL_M },
];
/**
 * 遠くの箱の建物の上限。メモリの少ない端末は約1/3にする。
 * (1棟32バイト。80万棟でGPUのメモリ約26MB。描く頂点は1棟12個)
 */
const boxCap = (n: number): number => (isLowMemoryDevice() ? Math.round(n * 0.35) : n);
/** 広い範囲の水(ズーム15)の範囲(m)。どの設定でも同じ */
export const WIDE_GEO_ZOOM = 15;
export const WIDE_GEO_HALF_M = 4200;

// スマホ版は、木の数を約6割に減らした間隔にする(5m→6m・8m→10m・12m→16m。木は間隔があくほど大きく描くので、森の見た目はほぼ同じ)
const LOW_TREES: TreeRing[] = [
  { rMin: 0, rMax: 350, step: 6, lod: 0 },
  { rMin: 350, rMax: 900, step: 10, lod: 1 },
  { rMin: 900, rMax: 1600, step: 16, lod: 2 },
];
const MID_TREES: TreeRing[] = [
  ...LOW_TREES,
  { rMin: 1600, rMax: 3500, step: 18, lod: 2 },
  { rMin: 3500, rMax: 6000, step: 28, lod: 2 },
];
const HIGH_TREES: TreeRing[] = [
  ...MID_TREES,
  { rMin: 6000, rMax: 12_000, step: 45, lod: 2 },
  { rMin: 12_000, rMax: 24_000, step: 80, lod: 2 },
];

export const QUALITY_SPECS: Record<Quality, QualitySpec> = {
  low: {
    buildingBands: [{ zoom: NEAR_GEO_ZOOM, rMin: 0, rMax: NEAR_GEO_HALF_M }],
    buildingMax: 20_000,
    boxMax: 0,
    proxyFromM: null,
    waterFar: null,
    treeRings: LOW_TREES,
    buildingKm: 1.3,
    treeKm: 1.6,
    waterKm: 4.2,
  },
  mid: {
    // 建物はズーム16にしか、ほぼ入っていないので、12kmまでズーム16で読む(タイル約1,900枚)
    buildingBands: [
      { zoom: NEAR_GEO_ZOOM, rMin: 0, rMax: NEAR_GEO_HALF_M },
      { zoom: NEAR_GEO_ZOOM, rMin: NEAR_GEO_HALF_M, rMax: 6000 },
      { zoom: NEAR_GEO_ZOOM, rMin: 6000, rMax: 9000 },
      { zoom: NEAR_GEO_ZOOM, rMin: 9000, rMax: 12_000 },
    ],
    buildingMax: 40_000,
    boxMax: boxCap(300_000),
    proxyFromM: null,
    waterFar: { zoom: 13, half: 12_000 },
    treeRings: MID_TREES,
    buildingKm: 12,
    treeKm: 6,
    waterKm: 12,
  },
  high: {
    buildingBands: highBuildingBands(),
    buildingMax: 120_000,
    boxMax: boxCap(800_000),
    proxyFromM: HIGH_DETAIL_M,
    waterFar: { zoom: 12, half: 25_000 },
    treeRings: HIGH_TREES,
    buildingKm: 25,
    treeKm: 24,
    waterKm: 25,
  },
};

/**
 * 描画範囲の拡張(ボタン)。地形・下地の画像・紅葉メッシュの半径を、通常の約25kmから約50kmへ広げる。
 * 木・水は処理「高」(=すべての範囲)のときに50kmまで広がる(「低」「中」はそれぞれの距離のまま)。
 * 建物も50kmまで広がる(ベクトルタイルの数が約4倍になるので、読み込みに時間がかかる)。遠くの建物は、画面で点より小さくなるので、
 * 距離に応じて大きく・まばらにして描く(`viewerBuildings.ts`)。
 */
export const RANGE_NORMAL_KM = 25;
export const RANGE_WIDE_KM = 50;

const WIDE_HIGH: QualitySpec = {
  ...QUALITY_SPECS.high,
  buildingBands: highBuildingBands(),
  buildingMax: 120_000,
  boxMax: boxCap(1_000_000),
  // 拡張しても通常の「高」と同じ細かさ(水の地図はズーム12、木は間隔を詰める。画像・地形メッシュは terrainSpec)
  waterFar: { zoom: 12, half: 52_000 },
  treeRings: [...HIGH_TREES, { rMin: 24_000, rMax: 50_000, step: 110, lod: 2 }],
  buildingKm: RANGE_WIDE_KM,
  treeKm: RANGE_WIDE_KM,
  waterKm: RANGE_WIDE_KM,
};

/** 処理の低・中・高と、描画範囲の拡張(wide)から、使う設定を返す */
export function qualitySpec(q: Quality, wide: boolean): QualitySpec {
  return wide && q === "high" ? WIDE_HIGH : QUALITY_SPECS[q];
}

/** 木の大きさの倍率: 間隔があくほど大きく描いて隙間を埋める(5mおきで1倍、約45m以上で3倍) */
export function treeScaleOfStep(step: number): number {
  return Math.min(3, 1 + Math.max(0, step - 5) / 12);
}

// ---------------------------------------------------------------------------
// 地形・衛星画像の細かさ(処理の低・中・高)
// ---------------------------------------------------------------------------

/**
 * 地形(標高タイル)と、地面の画像(標準地図・衛星画像)の細かさ。
 *   ・低 = 従来どおり(標高 遠景ズーム11/近景ズーム13、画像は標高タイルと同じズーム)
 *   ・中 = 標高の遠景ズーム12・近景ズーム14(約7m/画素)、地形メッシュを細かく、画像は1段細かいズーム
 *   ・高 = 近景の標高を半径約10kmに広げ、地形メッシュをさらに細かく、画像は最大2段細かいズーム(近景で約3m/画素)
 * 画像は、紅葉メッシュと同じ範囲(遠景・近景)のまま、より細かいズームのタイルを読んで貼る(画像の一辺が groundMaxPx を超えない範囲で)。
 */
export interface TerrainSpec {
  /** 標高(遠景): ズームと、読む半径(m) */
  heightFar: { zoom: number; half: number };
  /** 標高(近景): ズームと、読む半径(m)。遠景との切り替えはこの半径の7割〜95%の間でなめらかにつなぐ */
  heightNear: { zoom: number; half: number };
  /** 標高(足もと): ズーム15(5mメッシュ。約4m/画素)で読む半径(m)。無ければ null。近景(ズーム14)とは、この半径の7割〜95%の間でなめらかにつなぐ */
  heightDetail: { zoom: number; half: number } | null;
  /** 地形メッシュ(中心から外側へ輪を並べる): 最も細かい輪の間隔(m)・外側ほど間隔を広げる割合・1周の分割数 */
  mesh: { minStep: number; growth: number; segs: number };
  /** 地面の画像を、標高タイルのズームより最大で何段細かく読むか */
  groundMaxZoomUp: number;
  /** 地面の画像の一辺の上限(px。メモリの上限) */
  groundMaxPx: number;
}

/**
 * 端末のメモリが少ない(ブラウザが約4GB以下と報告する)か。Chrome系の navigator.deviceMemory(GB)を使う。
 * 分からないときは、少なくないものとする。少ない端末では、地面の画像の大きさの上限を下げて、メモリ不足で落ちにくくする。
 */
export function isLowMemoryDevice(): boolean {
  if (typeof navigator === "undefined") return false;
  const m = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return typeof m === "number" && m <= 4;
}

const FAR_HALF_NORMAL_M = 26_000;
const FAR_HALF_WIDE_M = 52_000;
const NEAR_HALF_LOW_M = 7_000;

export function terrainSpec(q: Quality, wide: boolean): TerrainSpec {
  const farHalf = wide ? FAR_HALF_WIDE_M : FAR_HALF_NORMAL_M;
  if (q === "mid") {
    return {
      heightFar: { zoom: wide ? 11 : 12, half: farHalf },
      heightNear: { zoom: 14, half: NEAR_HALF_LOW_M },
      heightDetail: null,
      mesh: { minStep: 10, growth: 0.014, segs: 1080 },
      groundMaxZoomUp: 1,
      groundMaxPx: 4096,
    };
  }
  if (q === "high") {
    return {
      heightFar: { zoom: 12, half: farHalf },
      heightNear: { zoom: 14, half: 10_000 },
      // 足もと約±3.5kmは、5mメッシュ標高(ズーム15)で、従来(ズーム14)の2倍の細かさにする
      heightDetail: { zoom: 15, half: 3500 },
      // 地形メッシュも約2倍に細かくする(最も細かい輪の間隔 6m→3m、1周の分割 1440→2160)。
      // 拡張(50km)のときは、遠くの地形の角が目立たないよう、輪の間隔の広がりと1周の分割を細かくする。メモリの少ない端末は従来の細かさ
      mesh: isLowMemoryDevice()
        ? wide
          ? { minStep: 6, growth: 0.005, segs: 1800 }
          : { minStep: 6, growth: 0.008, segs: 1440 }
        : wide
          ? { minStep: 4, growth: 0.0045, segs: 2160 }
          : { minStep: 3, growth: 0.006, segs: 2160 },
      groundMaxZoomUp: 2,
      groundMaxPx: isLowMemoryDevice() ? 4096 : 5120,
    };
  }
  return {
    heightFar: { zoom: 11, half: farHalf },
    heightNear: { zoom: 13, half: NEAR_HALF_LOW_M },
    heightDetail: null,
    mesh: { minStep: 16, growth: 0.022, segs: 720 },
    groundMaxZoomUp: 0,
    groundMaxPx: 4096,
  };
}

/**
 * 描画範囲の拡張+処理「高」のときだけ、地面の画像を3段にする(足もと=近景、約26kmまで=中景、約50kmまで=遠景)。
 * 中景は、拡張しない「高」の遠景と同じ細かさ(ズーム13・約15m/画素)で、遠景(ズーム12・約30m/画素)の上に重ねる。
 */
export const MID_GROUND = { zoom: 11, half: 26_000 };
export const hasMidGround = (q: Quality, wide: boolean): boolean => wide && q === "high";

/**
 * 処理「高」のときだけ、カメラのまわりに、近景よりさらに細かい地面の画像を2段、重ねる。どちらも、カメラが動くと、
 * 中心を動かして読み直す(カメラが中心から recenterM 以上離れたら)ので、歩いて行った先でも細かい。
 *   ・足もと = ズーム17(約1m/画素)、カメラの約±2km(メモリの少ない端末は約±1.3km)
 *   ・最も細かい = ズーム18(約0.5m/画素。国土地理院の写真・地図の最大のズーム)、カメラの約±320m
 * 近景は一辺の上限(groundMaxPx)があって全体を約3m/画素までにしか細かくできないが、カメラのまわりだけなら、メモリ約50MB・約13MBで済む。
 * タイルの無い所は透明にして、下の近景の画像のままにする。
 */
/** 足もとの画像の半分の幅(m)。カメラが動いたとき、この範囲の外へ出る前に読み直す(recenterM) */
const FOOT_HALF_M = 2000;
/** 足もとの画像も、向いている方向へ半幅の3割だけずらす(前方約2.6km・うしろ約1.4km。移動中に前の画像が間に合うように) */
export const footGround = (): { zoom: number; half: number; recenterM: number; ahead: number } => {
  const half = isLowMemoryDevice() ? NEAR_GEO_HALF_M : FOOT_HALF_M;
  return { zoom: 17, half, recenterM: Math.round(half / 3), ahead: Math.round(half * 0.3) };
};
export const FINE_GROUND = { zoom: 18, half: 320, recenterM: 110 };
/**
 * 向いている方向へ広げる下地(カメラについていく。カメラの向きが変わる・動くと、読み直す)。
 *   ・広い足もと = ズーム15(約3.8m/画素)。向いている方向へ約10km・うしろへ約1kmの窓(半幅5.5km、中心を向きへ4.5km)。
 *     足もと(ズーム17・約±2km)の外から約10km先までを、遠景(約15〜30m/画素)よりずっと細かくする。移動中に、先の地面の画像が間に合わない・
 *     原点から離れると近景(原点を中心)の外で粗くなる、を防ぐ。
 *   ・遠く = ズーム14(約7.7m/画素)。向いている方向へ約19km・うしろへ約1kmの窓(半幅10km、中心を向きへ9km)。
 *     広い足もと(約3.8m/画素)と遠景(約15m/画素)の間を埋め、約20km先まで「ある程度の解像度」にする(境目が急にならない)。
 * 画像は約3,300px四方・約3,100px四方(GPUメモリ約58MB・約50MB)。テクスチャユニットを増やせないので、最も細かい下地(ズーム18)と
 * 1枚に並べて貼る(`TerrainRenderer.reserveFineAtlas`)。「遠く」はメモリの少ない端末では作らない(`hasAheadGround`)。
 * ahead = 窓の中心をカメラの向きへずらす距離(m)。recenterM = 窓の中心が、いまの向き・位置での中心から、これ以上ずれたら読み直す。
 * 移動中は、さらに進んでいく方向へ、約4秒ぶん先へずらす(`Viewer3D.tsx` の wantedCenter)。
 */
export const WIDE_FOOT = { zoom: 15, half: 5500, recenterM: 1000, ahead: 4500 };
export const AHEAD_GROUND = { zoom: 14, half: 10_000, recenterM: 2500, ahead: 9000 };
export const hasWideFoot = (q: Quality): boolean => q === "high";
export const hasAheadGround = (q: Quality): boolean => q === "high" && !isLowMemoryDevice();
export const hasFootGround = (q: Quality): boolean => q === "high";
export const hasFineGround = (q: Quality): boolean => q === "high";

/** 地面の画像を、基準の範囲(タイルnx×ny枚)に対して何段細かく読むか(上限を超えない最大の段数) */
export function groundZoomUp(spec: TerrainSpec, nx: number, ny: number, tilePx: number, maxTexture: number): number {
  const cap = Math.min(spec.groundMaxPx, maxTexture);
  let up = 0;
  while (up < spec.groundMaxZoomUp && Math.max(nx, ny) * tilePx * 2 ** (up + 1) <= cap) up++;
  return up;
}
