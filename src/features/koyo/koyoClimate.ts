/**
 * 紅葉マップ: 各地域の気温の平年値(気候値)と、予報区(地域)の定義。
 *
 * 「日本の各地域の平均気温を取得し 北から南へ 紅葉の標高差を計算」への対応。
 * 気温の平年値は気象庁の「平年値(1991〜2020年)」の月平均気温(全国の代表38地点)を
 * そのまま同梱している(取得元: https://www.data.jma.go.jp/stats/etrn/view/nml_sfc_ym.php)。
 * 全地点で「12か月の平均 ≒ 年平均」になることを取り込み時に確認済み。
 *
 * 標高の影響は、観測所の気温を海面(標高0m)に換算した値(海面換算気温)で扱い、地図上の各点では
 * その値を周辺の観測所から距離で重み付け補間(IDW)してから、その点の標高ぶん(逓減率×標高)を
 * 差し引く。これにより「同じ日・同じ気温でも、北の地域ほど低い標高で紅葉が進む」という
 * 北→南の標高差が気温から自動的に出てくる。
 */

export type KoyoRegionId =
  | "hk_sea"
  | "hk_okhotsk"
  | "hk_pacific"
  | "th_sea"
  | "th_pacific"
  | "kanto_koshin"
  | "hokuriku"
  | "tokai"
  | "kinki"
  | "sanin"
  | "sanyo"
  | "shikoku"
  | "kyushu_n"
  | "kyushu_s"
  | "okinawa";

export interface KoyoRegion {
  id: KoyoRegionId;
  name: string;
  /**
   * 気象庁「確率予測資料」(2週間気温予報・1か月予報)のCSVの地域番号。
   * 先頭から順に試し、取得できなかったら次(=親の地方)にフォールバックする。
   * 番号は https://ds.data.jma.go.jp/risk/probability/info/number.html の地域番号表による。
   */
  csvCodes: number[];
}

export const KOYO_REGIONS: readonly KoyoRegion[] = [
  { id: "hk_sea", name: "北海道日本海側", csvCodes: [12, 11] },
  { id: "hk_okhotsk", name: "北海道オホーツク海側", csvCodes: [13, 11] },
  { id: "hk_pacific", name: "北海道太平洋側", csvCodes: [14, 11] },
  { id: "th_sea", name: "東北日本海側", csvCodes: [16, 15] },
  { id: "th_pacific", name: "東北太平洋側", csvCodes: [17, 15] },
  { id: "kanto_koshin", name: "関東甲信", csvCodes: [20] },
  { id: "hokuriku", name: "北陸", csvCodes: [21] },
  { id: "tokai", name: "東海", csvCodes: [22] },
  { id: "kinki", name: "近畿", csvCodes: [23] },
  { id: "sanin", name: "山陰", csvCodes: [27, 26] },
  { id: "sanyo", name: "山陽", csvCodes: [28, 26] },
  { id: "shikoku", name: "四国", csvCodes: [29] },
  { id: "kyushu_n", name: "九州北部", csvCodes: [30] },
  { id: "kyushu_s", name: "九州南部", csvCodes: [32, 31] },
  { id: "okinawa", name: "沖縄", csvCodes: [34] },
];

export interface ClimateStation {
  id: string;
  name: string;
  lat: number;
  lon: number;
  /** 観測所の標高(m)。小数点以下は省略した概数 */
  elevM: number;
  regionId: KoyoRegionId;
  /** 月平均気温の平年値(℃、1991〜2020年)。1月〜12月 */
  monthlyMeanC: readonly number[];
}

export const CLIMATE_STATIONS: readonly ClimateStation[] = [
  { id: "wakkanai", name: "稚内", lat: 45.415, lon: 141.678, elevM: 3, regionId: "hk_sea", monthlyMeanC: [-4.3, -4.3, -0.6, 4.5, 9.1, 13.0, 17.2, 19.5, 17.2, 11.3, 3.8, -2.1] },
  { id: "asahikawa", name: "旭川", lat: 43.756, lon: 142.373, elevM: 116, regionId: "hk_sea", monthlyMeanC: [-7.0, -6.0, -1.4, 5.6, 12.3, 17.0, 20.7, 21.2, 16.4, 9.4, 2.3, -4.2] },
  { id: "sapporo", name: "札幌", lat: 43.06, lon: 141.329, elevM: 17, regionId: "hk_sea", monthlyMeanC: [-3.2, -2.7, 1.1, 7.3, 13.0, 17.0, 21.1, 22.3, 18.6, 12.1, 5.2, -0.9] },
  { id: "hakodate", name: "函館", lat: 41.816, lon: 140.757, elevM: 35, regionId: "hk_sea", monthlyMeanC: [-2.4, -1.8, 1.9, 7.3, 12.3, 16.2, 20.3, 22.1, 18.8, 12.5, 6.0, -0.1] },
  { id: "abashiri", name: "網走", lat: 44.017, lon: 144.28, elevM: 38, regionId: "hk_okhotsk", monthlyMeanC: [-5.1, -5.4, -1.3, 4.5, 9.8, 13.5, 17.6, 19.6, 16.8, 10.9, 4.0, -2.4] },
  { id: "kushiro", name: "釧路", lat: 42.985, lon: 144.38, elevM: 5, regionId: "hk_pacific", monthlyMeanC: [-4.8, -4.3, -0.4, 4.0, 8.6, 12.2, 16.1, 18.2, 16.5, 11.0, 4.7, -1.9] },
  { id: "obihiro", name: "帯広", lat: 42.918, lon: 143.218, elevM: 76, regionId: "hk_pacific", monthlyMeanC: [-6.9, -5.7, -0.4, 6.0, 11.6, 15.2, 18.9, 20.3, 16.9, 10.3, 3.5, -3.8] },
  { id: "aomori", name: "青森", lat: 40.822, lon: 140.769, elevM: 3, regionId: "th_sea", monthlyMeanC: [-0.9, -0.4, 2.8, 8.5, 13.7, 17.6, 21.8, 23.5, 19.9, 13.5, 7.2, 1.4] },
  { id: "akita", name: "秋田", lat: 39.717, lon: 140.098, elevM: 6, regionId: "th_sea", monthlyMeanC: [0.4, 0.8, 4.0, 9.6, 15.2, 19.6, 23.4, 25.0, 21.0, 14.5, 8.3, 2.8] },
  { id: "yamagata", name: "山形", lat: 38.255, lon: 140.346, elevM: 153, regionId: "th_sea", monthlyMeanC: [-0.1, 0.4, 4.0, 10.2, 16.2, 20.3, 23.9, 25.0, 20.6, 14.1, 7.7, 2.4] },
  { id: "morioka", name: "盛岡", lat: 39.703, lon: 141.168, elevM: 155, regionId: "th_pacific", monthlyMeanC: [-1.6, -0.9, 2.6, 8.7, 14.5, 18.8, 22.4, 23.5, 19.3, 12.6, 6.2, 0.8] },
  { id: "sendai", name: "仙台", lat: 38.261, lon: 140.897, elevM: 39, regionId: "th_pacific", monthlyMeanC: [2.0, 2.4, 5.5, 10.7, 15.6, 19.2, 22.9, 24.4, 21.2, 15.7, 9.8, 4.5] },
  { id: "fukushima", name: "福島", lat: 37.76, lon: 140.47, elevM: 67, regionId: "th_pacific", monthlyMeanC: [1.9, 2.5, 5.9, 11.7, 17.2, 20.7, 24.3, 25.5, 21.6, 15.6, 9.5, 4.3] },
  { id: "nagano", name: "長野", lat: 36.659, lon: 138.195, elevM: 418, regionId: "kanto_koshin", monthlyMeanC: [-0.4, 0.4, 4.3, 10.6, 16.4, 20.4, 24.3, 25.4, 21.0, 14.4, 7.9, 2.3] },
  { id: "matsumoto", name: "松本", lat: 36.246, lon: 137.968, elevM: 610, regionId: "kanto_koshin", monthlyMeanC: [-0.3, 0.6, 4.6, 10.8, 16.5, 20.2, 24.2, 25.1, 20.4, 13.9, 7.8, 2.5] },
  { id: "kofu", name: "甲府", lat: 35.665, lon: 138.554, elevM: 273, regionId: "kanto_koshin", monthlyMeanC: [3.1, 4.7, 8.6, 14.0, 18.8, 22.3, 26.0, 27.1, 23.2, 17.1, 10.8, 5.4] },
  { id: "utsunomiya", name: "宇都宮", lat: 36.548, lon: 139.867, elevM: 119, regionId: "kanto_koshin", monthlyMeanC: [2.8, 3.8, 7.4, 12.8, 17.8, 21.2, 24.8, 26.0, 22.4, 16.7, 10.6, 5.1] },
  { id: "maebashi", name: "前橋", lat: 36.403, lon: 139.065, elevM: 112, regionId: "kanto_koshin", monthlyMeanC: [3.7, 4.5, 7.9, 13.4, 18.6, 22.1, 25.8, 26.8, 22.9, 17.1, 11.2, 6.1] },
  { id: "mito", name: "水戸", lat: 36.38, lon: 140.467, elevM: 29, regionId: "kanto_koshin", monthlyMeanC: [3.3, 4.1, 7.4, 12.3, 17.0, 20.3, 24.2, 25.6, 22.1, 16.6, 10.8, 5.6] },
  { id: "tokyo", name: "東京", lat: 35.692, lon: 139.75, elevM: 6, regionId: "kanto_koshin", monthlyMeanC: [5.4, 6.1, 9.4, 14.3, 18.8, 21.9, 25.7, 26.9, 23.3, 18.0, 12.5, 7.7] },
  { id: "niigata", name: "新潟", lat: 37.912, lon: 139.062, elevM: 2, regionId: "hokuriku", monthlyMeanC: [2.5, 3.1, 6.2, 11.3, 16.7, 20.9, 24.9, 26.5, 22.5, 16.7, 10.5, 5.3] },
  { id: "toyama", name: "富山", lat: 36.696, lon: 137.205, elevM: 9, regionId: "hokuriku", monthlyMeanC: [3.0, 3.4, 6.9, 12.3, 17.5, 21.4, 25.5, 26.9, 22.8, 17.0, 11.2, 5.7] },
  { id: "kanazawa", name: "金沢", lat: 36.588, lon: 136.633, elevM: 6, regionId: "hokuriku", monthlyMeanC: [4.0, 4.2, 7.3, 12.6, 17.7, 21.6, 25.8, 27.3, 23.2, 17.6, 11.9, 6.8] },
  { id: "takayama", name: "高山", lat: 36.15, lon: 137.256, elevM: 560, regionId: "tokai", monthlyMeanC: [-1.2, -0.6, 3.4, 9.7, 15.6, 19.7, 23.5, 24.4, 20.0, 13.5, 7.1, 1.6] },
  { id: "shizuoka", name: "静岡", lat: 34.975, lon: 138.404, elevM: 15, regionId: "tokai", monthlyMeanC: [6.9, 7.7, 10.7, 15.2, 19.2, 22.4, 26.1, 27.4, 24.5, 19.4, 14.3, 9.3] },
  { id: "nagoya", name: "名古屋", lat: 35.168, lon: 136.966, elevM: 57, regionId: "tokai", monthlyMeanC: [4.8, 5.5, 9.2, 14.6, 19.4, 23.0, 26.9, 28.2, 24.5, 18.6, 12.6, 7.2] },
  { id: "kyoto", name: "京都", lat: 35.012, lon: 135.732, elevM: 41, regionId: "kinki", monthlyMeanC: [4.8, 5.4, 8.8, 14.4, 19.5, 23.3, 27.3, 28.5, 24.4, 18.4, 12.5, 7.2] },
  { id: "osaka", name: "大阪", lat: 34.682, lon: 135.519, elevM: 23, regionId: "kinki", monthlyMeanC: [6.2, 6.6, 9.9, 15.2, 20.1, 23.6, 27.7, 29.0, 25.2, 19.5, 13.8, 8.7] },
  { id: "matsue", name: "松江", lat: 35.455, lon: 133.068, elevM: 17, regionId: "sanin", monthlyMeanC: [4.6, 5.0, 8.0, 13.1, 18.0, 21.7, 25.8, 27.1, 22.9, 17.4, 12.0, 7.0] },
  { id: "tottori", name: "鳥取", lat: 35.485, lon: 134.241, elevM: 7, regionId: "sanin", monthlyMeanC: [4.2, 4.7, 7.9, 13.2, 18.1, 22.0, 26.2, 27.3, 22.9, 17.2, 11.9, 6.8] },
  { id: "hiroshima", name: "広島", lat: 34.397, lon: 132.465, elevM: 3, regionId: "sanyo", monthlyMeanC: [5.4, 6.2, 9.5, 14.8, 19.6, 23.2, 27.2, 28.5, 24.7, 18.8, 12.9, 7.5] },
  { id: "matsuyama", name: "松山", lat: 33.842, lon: 132.776, elevM: 32, regionId: "shikoku", monthlyMeanC: [6.2, 6.8, 9.9, 14.8, 19.4, 22.9, 27.1, 28.1, 24.6, 19.1, 13.6, 8.5] },
  { id: "kochi", name: "高知", lat: 33.567, lon: 133.548, elevM: 1, regionId: "shikoku", monthlyMeanC: [6.7, 7.8, 11.2, 15.8, 20.0, 23.1, 27.0, 27.9, 25.0, 19.9, 14.2, 8.8] },
  { id: "fukuoka", name: "福岡", lat: 33.582, lon: 130.375, elevM: 3, regionId: "kyushu_n", monthlyMeanC: [6.9, 7.8, 10.8, 15.4, 19.9, 23.3, 27.4, 28.4, 24.7, 19.6, 14.2, 9.1] },
  { id: "kumamoto", name: "熊本", lat: 32.815, lon: 130.708, elevM: 38, regionId: "kyushu_n", monthlyMeanC: [6.0, 7.4, 10.9, 15.8, 20.5, 23.7, 27.5, 28.4, 25.2, 19.6, 13.5, 8.0] },
  { id: "kagoshima", name: "鹿児島", lat: 31.553, lon: 130.549, elevM: 4, regionId: "kyushu_s", monthlyMeanC: [8.7, 9.9, 12.8, 17.1, 21.0, 24.0, 28.1, 28.8, 26.3, 21.6, 16.2, 10.9] },
  { id: "miyazaki", name: "宮崎", lat: 31.938, lon: 131.413, elevM: 9, regionId: "kyushu_s", monthlyMeanC: [7.8, 8.9, 12.1, 16.4, 20.3, 23.2, 27.3, 27.6, 24.7, 20.0, 14.7, 9.7] },
  { id: "naha", name: "那覇", lat: 26.207, lon: 127.686, elevM: 28, regionId: "okinawa", monthlyMeanC: [17.3, 17.5, 19.1, 21.5, 24.2, 27.2, 29.1, 29.0, 27.9, 25.5, 22.5, 19.0] },
];

/** 標準的な秋の気温逓減率(℃/m)。画面の設定で変えられる(既定は0.55℃/100m) */
export const DEFAULT_LAPSE_C_PER_M = 0.0055;

/** 日平均気温と日最低気温の差の目安(℃)。山地の秋の気温の平年値(月平均と月平均最低)から概算 */
export const MEAN_MINUS_MIN_C = 4;

// ---------------------------------------------------------------------------
// 月平均 → 日別の平年値(周期的なCatmull-Rom補間)
// ---------------------------------------------------------------------------

/** 各月の中日(平年・1月1日を1とした通算日) */
const MONTH_MID_DOY = [15.5, 45, 74.5, 105, 135.5, 166, 196.5, 227.5, 258, 288.5, 319, 349.5];

/** 月平均(12個)から、通算日 doy(1〜365)の日平均気温を補間する */
export function interpolateDailyMean(monthly: readonly number[], doy: number): number {
  const n = 12;
  // doy が属する区間 [i, i+1] を探す(年をまたぐ区間は周期境界として扱う)
  // (1月の中旬より前は、前年12月の中旬〜1月の中旬の区間。ここを見落とすと1月上旬の気温が大きく外れる)
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (doy >= MONTH_MID_DOY[k]) i = k;
  }
  const i1 = (i + 1) % n;
  const x0 = MONTH_MID_DOY[i];
  let x1 = MONTH_MID_DOY[i1];
  if (x1 <= x0) x1 += 365;
  const xCur = doy >= x0 ? doy : doy + 365;
  const t = (xCur - x0) / (x1 - x0);

  const im1 = (i + n - 1) % n;
  const i2 = (i + 2) % n;
  const p0 = monthly[im1];
  const p1 = monthly[i];
  const p2 = monthly[i1];
  const p3 = monthly[i2];
  // Catmull-Rom(等間隔近似)
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

/** 暦日(UTC 0時基準のDate)の通算日(1〜366)。閏日は365に丸める */
export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  const doy = Math.floor((date.getTime() - start) / 86_400_000) + 1;
  return Math.min(doy, 365);
}

/** 観測所ごとの日別平年値(通算日1〜365)を作る。起動時に1回だけ計算 */
const STATION_DAILY_NORMAL: Float32Array[] = CLIMATE_STATIONS.map((s) => {
  const a = new Float32Array(366);
  for (let d = 1; d <= 365; d++) a[d] = interpolateDailyMean(s.monthlyMeanC, d);
  a[366] = a[365];
  return a;
});

export function stationDailyNormalC(stationIndex: number, doy: number): number {
  return STATION_DAILY_NORMAL[stationIndex][doy];
}

/** 観測所ごとの年平均気温(℃) */
export const STATION_ANNUAL_MEAN_C: Float32Array = Float32Array.from(
  CLIMATE_STATIONS.map((s) => s.monthlyMeanC.reduce((a, b) => a + b, 0) / 12),
);

/** 観測所ごとの海面換算の年平均気温(℃) */
export function stationAnnualSeaLevelC(stationIndex: number, lapseCPerM: number): number {
  return STATION_ANNUAL_MEAN_C[stationIndex] + lapseCPerM * CLIMATE_STATIONS[stationIndex].elevM;
}

// ---------------------------------------------------------------------------
// 地図上の任意の点 → 周辺観測所の重み(IDW)
// ---------------------------------------------------------------------------

/** 補間に使う近隣観測所の数 */
export const IDW_K = 5;
/** 距離の2乗に足す下駄(km²)。観測所の真上でも重みが発散しないようにする */
const IDW_EPS_KM2 = 25;

const KM_PER_DEG_LAT = 111.2;

export interface StationWeights {
  /** CLIMATE_STATIONS 内のindex(近い順) */
  idx: Int16Array;
  /** 正規化済みの重み(合計1) */
  w: Float32Array;
  /** 最も近い観測所までの距離(km) */
  nearestKm: number;
}

/**
 * 緯度経度から、近い順に`IDW_K`個の観測所とその重みを求める(重み=1/(d²+ε)を正規化)。
 * 結果は呼び出し側の使い回し用バッファ`out`に書き込む(タイルあたり数千回呼ぶホットパスのため)。
 */
export function stationWeightsAt(lat: number, lon: number, out: StationWeights): StationWeights {
  const kmPerDegLon = KM_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
  const idx = out.idx;
  const w = out.w;
  const best = new Float64Array(IDW_K).fill(Infinity);
  idx.fill(-1);

  for (let s = 0; s < CLIMATE_STATIONS.length; s++) {
    const st = CLIMATE_STATIONS[s];
    const dy = (st.lat - lat) * KM_PER_DEG_LAT;
    const dx = (st.lon - lon) * kmPerDegLon;
    const d2 = dx * dx + dy * dy;
    if (d2 >= best[IDW_K - 1]) continue;
    // 挿入ソート
    let p = IDW_K - 1;
    while (p > 0 && best[p - 1] > d2) {
      best[p] = best[p - 1];
      idx[p] = idx[p - 1];
      p--;
    }
    best[p] = d2;
    idx[p] = s;
  }

  let sum = 0;
  for (let k = 0; k < IDW_K; k++) {
    w[k] = idx[k] >= 0 ? 1 / (best[k] + IDW_EPS_KM2) : 0;
    sum += w[k];
  }
  for (let k = 0; k < IDW_K; k++) w[k] /= sum;
  out.nearestKm = Math.sqrt(best[0]);
  return out;
}

export function createStationWeights(): StationWeights {
  return { idx: new Int16Array(IDW_K), w: new Float32Array(IDW_K), nearestKm: 0 };
}

/** 周辺観測所の値(観測所ごとの配列)を、重みで補間した値 */
export function interpolate(values: ArrayLike<number>, wts: StationWeights): number {
  let v = 0;
  for (let k = 0; k < IDW_K; k++) {
    const s = wts.idx[k];
    if (s >= 0) v += wts.w[k] * values[s];
  }
  return v;
}

/** 最も近い観測所の地域ID */
export function nearestRegionId(wts: StationWeights): KoyoRegionId {
  return CLIMATE_STATIONS[wts.idx[0]].regionId;
}

// ---------------------------------------------------------------------------
// 地域ごとの代表値(北→南の並べ替え・一覧表用)
// ---------------------------------------------------------------------------

export interface RegionInfo {
  region: KoyoRegion;
  /** 地域内の観測所のindex */
  stationIdx: number[];
  /** 地域内の観測所の平均緯度(北→南の並べ替えに使う) */
  meanLat: number;
}

export const REGION_INFOS: readonly RegionInfo[] = KOYO_REGIONS.map((region) => {
  const stationIdx: number[] = [];
  CLIMATE_STATIONS.forEach((s, i) => {
    if (s.regionId === region.id) stationIdx.push(i);
  });
  const meanLat = stationIdx.reduce((a, i) => a + CLIMATE_STATIONS[i].lat, 0) / Math.max(1, stationIdx.length);
  return { region, stationIdx, meanLat };
});

/** 北から南の順に並べた地域情報 */
export const REGION_INFOS_NORTH_TO_SOUTH: readonly RegionInfo[] = [...REGION_INFOS].sort(
  (a, b) => b.meanLat - a.meanLat,
);

export function regionInfoById(id: KoyoRegionId): RegionInfo {
  const info = REGION_INFOS.find((r) => r.region.id === id);
  if (!info) throw new Error(`unknown region: ${id}`);
  return info;
}
