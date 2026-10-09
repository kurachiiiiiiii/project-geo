import * as L from "leaflet";
import { buildSatelliteTileUrl, parseValidTime } from "../features/satellite/satelliteService";
import type { SatelliteFrame } from "../features/satellite/satelliteService";
import { classify, localContrastAround, type CloudMeshGrid } from "./cloudMesh";

/**
 * 「衛星画像の予測をしたい 過去1時間分の衛星画像をもとに 3時間後まで どのように動くか
 * 予想したい」という指示への対応。
 *
 * 気象庁は将来の衛星画像そのものは配信していない(数値予報の結果ではなく実際の観測画像の
 * ため)。そこで、雲がどちらの方向へ・どれくらいの速さで動くかを推定し、最新画像をその
 * 速度で平行移動(移流)させ続けることで、30分刻みで3時間先まで(=6コマ)を予測する。
 * あくまで「推定した動きが変わらず続いたら」という単純な外挿であり、発達・衰弱や雲の
 * 変形は考慮しない簡易的な予測である(この点は呼び出し側のUIで明示する)。
 *
 * 【動きベクトルの推定方法の変遷】
 * 当初は直近1時間の実測画像2枚(赤外線)を比較し、画像相関(オフセットを総当たりして
 * 最も一致するズレを探す手法。`lib/cloudMesh.ts`のメッシュ位置ズレ検証で使ったのと同じ)
 * で動きベクトルを推定していた。その後「雲の動きは500キロメッシュで 雲がそれぞれどの方向に
 * 動いているのか 計算して もとめてください」という指示により、対象範囲全体で1本だった
 * ベクトルを500km四方のマス目(`MOTION_CELL_KM`)ごとに独立して推定するよう変更した。
 *
 * さらに「高層の風を取得して それを基に 方向を決定することはできますか」という指示を
 * 受け、「画像相関ではなく、高層風データ(500hPa固定)にすべてのマス目を置き換える」
 * という回答を得たため、画像相関はやめて`WIND_PRESSURE_LEVEL_HPA`(500hPa)の風向・風速を
 * Open-Meteo(高原天気の風向取得と同じAPI。気圧面ごとの風データも無料・登録不要で取得できる
 * ことを確認済み)からマス目の中心ごとに取得し、それをそのまま動きベクトルとして使うように
 * 変更した(`fetchUpperWindAtPoints`/`estimateMotionFieldFromWind`)。画像相関は「実際に
 * 観測された動き」を直接測れる利点があった一方、海上の一様な雲など手がかりに乏しい場所では
 * 信頼できるズレを見つけられないことがあった。高層風はこの弱点が無く、また計算量も大幅に
 * 少ない(総当たりの相関探索が不要になった)。500hPa(対流圏中層の目安として天気予報でも
 * 一般的に使われる気圧面)に固定しているため、非常に低い雲・非常に高い雲では実際の動きと
 * ずれることがある(この簡略化もUIで明示する)。
 *
 * 【風向の向きに関する注意】気象学の「風向」は風が「吹いてくる」方向(例: 西風=風向270度は
 * 西から東へ吹く)。雲が「動いていく」方向(=このモジュールの`azimuthDeg`)はその180度
 * 反対になるため、`fetchUpperWindAtPoints`で変換している。ここを取り違えると雲が逆方向に
 * 動く予測になってしまうため、風向データを扱うたびに毎回注意が必要な点。
 *
 * 【気圧面を350hPaに変更】「350hpaにできますか」という指示により、当初の500hPa固定から
 * 350hPaに変更した(Open-Meteoが350hPaの気圧面データにも対応していることを実機相当の
 * ブラウザで確認済み)。
 *
 * 【350hPaと500hPaの平均に変更】「350hpaと500hpaを平均した値を移動量にしてください」
 * という指示への対応。単一の気圧面だけだと対流圏中層のごく一部の高さの風しか見ないことに
 * なるため、`WIND_PRESSURE_LEVELS_HPA`(350hPa・500hPa)の2つを取得し、それぞれ雲が
 * 「動いていく」方向のEast/North成分(km/h)に変換してから平均する(`windToVector`/
 * `fetchUpperWindAtPoints`)。風向(角度)のまま平均すると、例えば10度と350度の平均が
 * 本来近い(ほぼ0度=北風)はずなのに単純平均では180度(逆向きの南風)になってしまう
 * 「circular mean」の問題があるため、必ず成分に変換してから平均する。どちらか一方の
 * 気圧面しか値が取れなかった場合はその1つをそのまま使い、両方とも取れなかった地点のみ
 * nullとして扱う(致命的にはしない)。
 *
 * 【既知の改善: マス目の間を補完する】
 * 「メッシュの間を補完することはできますか」という指示への対応。以前は`advectMosaic`が
 * マス目ごとの速度でそのマス目の中身をまるごと平行移動する「ブロック単位の移流」だった
 * ため、マス目の境界で隣接マスの速度差による重なり・隙間が目立つことがあった。マス目の
 * 中心の値を双線形補間(bilinear interpolation)して、任意の地点の速度を連続的に(なめらか
 * に)求められるようにし(`sampleVelocityAt`)、移動先の各ピクセルごとに「hoursAhead時間前は
 * どこにあったか」を逆算してその色を持ってくる「後方参照(backward warping)」方式に
 * 書き換えた(`advectMosaic`)。マス目の境界がなめらかになる一方、対象範囲の外周(最初/
 * 最後のマス目のさらに外側)は一番近いマス目の値をそのまま使う(外挿はしない)。
 *
 * 【予測コマでも雲判定メッシュを使えるようにする】
 * 「衛星画像の予測の際も メッシュでできるようにしてください」という指示への対応。
 * `lib/cloudMesh.ts`の判定基準(`classify`/`localContrastAround`、しきい値の重複管理を
 * 避けるためexportしてもらったものをそのまま使う)を、予測画像のモザイクcanvasに対して
 * ピクセル単位でそのまま適用する(`classifyMosaicToCloudMeshGrid`)。実測コマは緯度経度
 * ベースの3kmグリッドで判定しているのに対し、予測コマはモザイクのネイティブ解像度
 * (z=5、赤道上で約4.9km/px、この地域ではその8割程度)でそのままセルにしている
 * (対象範囲・タイルズームが実測コマと同じため、見た目上ほぼ同等の細かさになる)。
 *
 * 【対象範囲・タイルズームについて】`lib/cloudMesh.ts`と同じ日本周辺(緯度25〜46度・
 * 経度122〜150度)・z=5タイルに揃えている(同じ考え方: 全球配信だがそのまま使うと計算量が
 * 大きくなりすぎるため、対象を絞っている)。
 *
 * 【予測画像に赤外線バンドを使う理由】可視画像は夜間真っ暗になり、トゥルーカラー・水蒸気は
 * 加工済みで雲の輪郭が薄れることがあるため、`cloudMesh.ts`と同じく生の雲頂温度(B13/TBB、
 * 昼夜を問わず雲の分布が分かる)を使う。予測画像として表示するのも同じ赤外線バンドの合成
 * 画像(選択中の表示バンドが可視/トゥルーカラー等でも、予測コマだけは赤外線になる。
 * バンドごとに移流をやり直すのは計算量に見合わないための簡略化)。
 *
 * 【動きベクトルのメッシュを100kmに変更】「衛星の雲の予測メッシュも 本土あたりは100キロ
 * メッシュにしてください」という指示への対応。当初500kmだった`MOTION_CELL_KM`を100kmに
 * 変更した(対象範囲全体で25×23=575マス目程度に増える)。Open-Meteoへのリクエストは
 * マス目が増えても1回のままだが、地点数が500hPa/350hPa1本ずつのときの数十地点から
 * 575地点まで増えるため、実際に1回のリクエストで正常に応答が返ること(URL長7,671文字、
 * 約1.6秒、200 OK、575地点すべて有効なデータ)を事前に確認した上で変更している。
 *
 * 【予測を6時間まで延長、風向を時間によって変化させる】「予測を6時間まで延長して 予測の
 * 方向も 時間によって 変化するようにして」という指示への対応。`FORECAST_STEPS`を6→12
 * (30分刻みで6時間先まで)に増やした。それまでは「最新コマの観測時刻」1点だけの風で
 * 動きベクトルを求め、その同じベクトルを`hoursAhead`倍してcanvasを移流させていたため、
 * 6時間先まで延ばすと後半のコマほど「本来なら変わっているはずの風向」を無視した動きに
 * なってしまう問題があった。そこで、
 * 1. Open-Meteoから1回のリクエストで対象時刻ぶん(1時間ごと、最大6時間先まで)の風の
 *    時系列をまとめて取得するようにし(`fetchUpperWindSeriesAtPoints`)、
 * 2. 予測コマを1枚ずつ、直前のコマ(最初は実測コマ)から`FORECAST_STEP_HOURS`(30分)分だけ、
 *    その30分の終わりに最も近い時刻(1時間単位に丸め)の風で移流させる、という処理を
 *    12回繰り返して積み重ねる(`computeSatelliteForecast`)ように変更した。
 * これは実際の風の変化を追いかけながら経路を辿る「semi-Lagrangian」的な移流の考え方で、
 * 1時間ごとに風向・風速が更新されるため、時間が経つにつれて予測の向きも変わるようになる
 * (逆に言えば、以前の実装は「風が6時間ずっと変わらない」という前提の簡略化だった)。
 * 動きベクトルの矢印表示も、選択中のコマに応じてそのコマ用の風(`PredictedSatelliteFrame.
 * motionField`)を表示するようにし、時間による向きの変化を矢印でも確認できるようにした。
 */

export const SATELLITE_FORECAST_BOUNDS = L.latLngBounds([25, 122], [46, 150]);

const TILE_Z = 5;
const TILE_SIZE = 256;
const TILE_LOAD_TIMEOUT_MS = 15_000; // cloudMesh.tsと同じ考え方

/**
 * 予測する時間刻み・コマ数。「予測を6時間まで延長して」という指示により、当初の3時間
 * (6コマ)から30分刻みで6時間先(12コマ)に変更した。
 */
export const FORECAST_STEP_HOURS = 0.5;
export const FORECAST_STEPS = 12;

/**
 * 動きベクトルを求めるマス目の目標一辺(km)。当初は「雲の動きは500キロメッシュで」という
 * 指示により500kmだったが、「衛星の雲の予測メッシュも 本土あたりは100キロメッシュにして
 * ください」という指示により100kmに変更した。`cloudMesh.ts`のCELL_KM(3km、雲の判定その
 * もの)とは全く別の目的・スケールのため、混同しないよう別の定数にしている。
 */
const MOTION_CELL_KM = 100;
const KM_PER_DEG_LAT = 110.574; // server/kougenTenkiGenerate.mjs・cloudMesh.tsと同じ値
const KM_PER_DEG_LON_AT_EQUATOR = 111.32;
/** 赤道の全周(km)。km/h⇔ピクセル/時の換算に使う(Web Mercatorの標準的な値)。 */
const EARTH_CIRCUMFERENCE_KM = 40_075.017;

/**
 * 「高層の風を取得して それを基に 方向を決定することはできますか」「どの気圧面を使うか」
 * への回答(当初500hPa固定)による。対流圏中層の目安として天気予報でも一般的に使われる
 * 気圧面。その後「350hpaにできますか」という指示により350hPaに変更した(Open-Meteoが
 * 350hPaの気圧面データにも対応していることを実機相当のブラウザで確認済み)。
 */

interface TileMosaic {
  canvas: HTMLCanvasElement;
  /** モザイク画像が実際にカバーする範囲(タイル境界ぴったり。指定した緯度経度の範囲そのものではない) */
  bounds: L.LatLngBounds;
  txMin: number;
  tyMin: number;
  cols: number;
  rows: number;
}

function loadTileImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // ひまわりのタイル配信はAccess-Control-Allow-Origin: *(cloudMesh.tsで確認済み)
    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      reject(new Error(`タイル画像の取得が${TILE_LOAD_TIMEOUT_MS / 1000}秒以内に終わりませんでした(タイムアウト)`));
    }, TILE_LOAD_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ひまわりタイルの取得に失敗しました"));
    };
    img.src = url;
  });
}

/**
 * `SATELLITE_FORECAST_BOUNDS`をカバーするz=5赤外線タイルをすべて並行取得し、1枚のcanvasに
 * つなぎ合わせる。`bounds`はタイル境界ぴったりの実際のカバー範囲(`<ImageOverlay>`にそのまま
 * 渡せば、後で移流させても位置がずれない。`cloudMesh.ts`の「北に80kmずれていた」不具合と
 * 同じ轍を踏まないよう、独自の緯度経度計算はせずLeaflet自身の投影を使っている)。
 */
async function buildTileMosaic(frame: SatelliteFrame): Promise<TileMosaic> {
  const crs = L.CRS.EPSG3857;
  const south = SATELLITE_FORECAST_BOUNDS.getSouth();
  const north = SATELLITE_FORECAST_BOUNDS.getNorth();
  const west = SATELLITE_FORECAST_BOUNDS.getWest();
  const east = SATELLITE_FORECAST_BOUNDS.getEast();

  const nw = crs.latLngToPoint(L.latLng(north, west), TILE_Z);
  const se = crs.latLngToPoint(L.latLng(south, east), TILE_Z);
  const txMin = Math.floor(nw.x / TILE_SIZE);
  const txMax = Math.floor((se.x - 1) / TILE_SIZE);
  const tyMin = Math.floor(nw.y / TILE_SIZE);
  const tyMax = Math.floor((se.y - 1) / TILE_SIZE);
  const cols = txMax - txMin + 1;
  const rows = tyMax - tyMin + 1;

  const canvas = document.createElement("canvas");
  canvas.width = cols * TILE_SIZE;
  canvas.height = rows * TILE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D contextを取得できませんでした");

  const template = buildSatelliteTileUrl(frame, "infrared");
  const loads: Promise<void>[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const url = template.replace("{z}", String(TILE_Z)).replace("{x}", String(tx)).replace("{y}", String(ty));
      loads.push(
        loadTileImage(url)
          .then((img) => {
            ctx.drawImage(img, (tx - txMin) * TILE_SIZE, (ty - tyMin) * TILE_SIZE);
          })
          .catch(() => {
            // 取得できなかったタイルは透明のまま(cloudMesh.tsと同じ、致命的にはしない方針)
          }),
      );
    }
  }
  await Promise.all(loads);

  const nwLatLng = crs.pointToLatLng(L.point(txMin * TILE_SIZE, tyMin * TILE_SIZE), TILE_Z);
  const seLatLng = crs.pointToLatLng(L.point((txMax + 1) * TILE_SIZE, (tyMax + 1) * TILE_SIZE), TILE_Z);
  const bounds = L.latLngBounds([nwLatLng, seLatLng]);

  return { canvas, bounds, txMin, tyMin, cols, rows };
}

export interface MotionCell {
  /** マス目の範囲(モザイクのネイティブピクセル座標) */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** マス目の中心の緯度経度(矢印表示などに使う) */
  centerLat: number;
  centerLon: number;
  /** 1時間あたりの移動量(モザイクのネイティブピクセル単位、東方向がプラス) */
  vxPerHour: number;
  /** 1時間あたりの移動量(モザイクのネイティブピクセル単位、南方向がプラス) */
  vyPerHour: number;
  /**
   * 「雲がそれぞれどの方向に動いているのか」への対応。実世界の速さ(km/h)・方位角
   * (0=北、90=東、時計回り。雲が「動いていく」方向であり、気象学の「風向」(吹いてくる
   * 方向)とは180度異なることに注意)。矢印表示など、ピクセル単位の値より実世界の値が
   * 欲しい呼び出し側向けにここで換算しておく。
   */
  speedKmh: number;
  azimuthDeg: number;
}

export interface MotionField {
  gw: number;
  gh: number;
  /**
   * グリッドが実際にカバーする範囲(モザイクのネイティブピクセル座標、canvasローカル)。
   * `SATELLITE_FORECAST_BOUNDS`に対応する範囲で、モザイク全体(タイル境界の都合で実際には
   * これより広いことがある)より狭いことがある。`sampleVelocityAt`はこの範囲を基準に
   * ピクセル位置をマス目のインデックスへ変換する。
   */
  gridX0: number;
  gridY0: number;
  gridX1: number;
  gridY1: number;
  /** 北西→南東、行優先(gy*gw+gx) */
  cells: MotionCell[];
}


/** 雲が「動いていく」方向のEast/North成分(km/h)。複数気圧面の平均もこの形で持つ。 */
interface WindVectorKmh {
  vEastKmh: number;
  vNorthKmh: number;
}


/** Open-Meteoの`hourly.time`の書式("2026-09-05T22:00"、Asia/Tokyoのローカル時刻)に合わせて、msから同じ形の文字列を作る */
function formatHourKeyJst(ms: number): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:00`;
}

/** ある1地点の、複数時刻ぶんの風の時系列(hourKeys[i]の時刻にvectors[i]の風、が対応する) */
interface WindSeriesEntry {
  hourKeys: string[];
  vectors: WindVectorKmh[];
}

/**
 * 指定した地点群それぞれについて、`pastHours`時間前から`forecastHours`時間先までの風の
 * 時系列(`WIND_PRESSURE_LEVELS_HPA`の各気圧面をEast/North成分に変換してから平均したもの)
 * を、1回のリクエストにまとめて取得する。
 *
 * 「予測の方向も 時間によって 変化するようにして」という指示への対応。以前は対象時刻
 * 1点だけの風を取得していたが(`estimateMotionFieldFromWind`が直接targetMsを渡していた)、
 * 予測コマ(30分刻み)ごとにその時刻に近い予報風を使えるよう、時系列をまるごと返すように
 * した(呼び出し側は`pickWindVectorAt`で必要な時刻の値を取り出す)。地点数が増えても
 * 1回のリクエストで済むのは以前と同じ(取得する時刻数が増えてもhourlyパラメータの中身が
 * 増えるだけで、リクエスト自体・URLに含む地点数は変わらないため)。取得に失敗した地点
 * (いずれの時刻・気圧面も値が無い場合)はnullを返す(致命的にはしない)。
 *
 * 「予測コマの計算に失敗しました: 高層風(Open-Meteo)の取得に失敗しました (HTTP 429)」への
 * 対応。Open-Meteoの無料枠には分単位のリクエスト数上限があり(検証中に実際に確認済み)、
 * 「衛星画像予測は常にonにしてください」という指示で予測が常時・自動で計算されるように
 * なったことで、以前(手動でチェックボックスをONにしたときだけ)より高頻度にリクエストする
 * ようになり、429(Too Many Requests)に当たりやすくなっている。429は一時的な混雑である
 * ことが多いため、429のときだけ短い間隔を空けて自動的に再試行する(429以外のエラーは
 * 再試行しても直らないことが多いため、すぐに諦める)。
 */

async function fetchUpperWindSeriesAtPoints(
  _points: Array<{ lat: number; lon: number }>,
  _pastHours: number,
  _forecastHours: number,
): Promise<Array<WindSeriesEntry | null>> {
  // スマホ版では、高層風(Open-Meteo)の取得を廃止した(「openmeteoの演算からの削除」への対応)。
  // 衛星画像の予測(`isSatelliteForecastEnabled`)も常に無効なので、ここは呼ばれない
  throw new Error("スマホ版では、高層風(Open-Meteo)の取得を廃止しました");
}

/**
 * `series`(ある1地点の風の時系列)から、`targetMs`に最も近い時刻の風を取り出す。
 * 完全一致する時刻が無い場合は前後1時間の時刻を探し、それでも見つからなければ取得できた
 * 中で最後(=一番未来寄り)の値で代用する(致命的にはしない。以前の`fetchUpperWindAtPoints`
 * の「完全一致が無ければ末尾で代用」というフォールバックと同じ考え方)。
 */
function pickWindVectorAt(series: WindSeriesEntry | null, targetMs: number): WindVectorKmh | null {
  if (!series || series.hourKeys.length === 0) return null;
  for (const candidateMs of [targetMs, targetMs - 3_600_000, targetMs + 3_600_000]) {
    const idx = series.hourKeys.indexOf(formatHourKeyJst(candidateMs));
    if (idx !== -1) return series.vectors[idx];
  }
  return series.vectors[series.vectors.length - 1];
}

interface MotionCellDef {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  centerLat: number;
  centerLon: number;
}

/** `MotionField`のうち、風(=時刻)に依存しない部分(マス目の並び・範囲そのもの) */
interface MotionGridGeometry {
  gw: number;
  gh: number;
  gridX0: number;
  gridY0: number;
  gridX1: number;
  gridY1: number;
  cellDefs: MotionCellDef[];
}

/**
 * `nowMosaic`(最新の赤外線モザイク)を`MOTION_CELL_KM`(100km)メッシュに分割し、マス目
 * ごとの範囲・中心緯度経度を確定させる(風には依存しない、純粋にジオメトリだけの処理)。
 * 「予測の方向も 時間によって 変化するようにして」という指示への対応で、以前は風の取得
 * (`estimateMotionFieldFromWind`)とジオメトリの計算が1つの関数にまとまっていたが、
 * 予測コマごとに(同じジオメトリのまま)違う時刻の風で`MotionField`を何度も作り直せる
 * よう、ジオメトリの計算だけを切り出した。
 */
function buildMotionGridGeometry(nowMosaic: TileMosaic): MotionGridGeometry {
  const crs = L.CRS.EPSG3857;

  // クエリ範囲は`nowMosaic.bounds`(タイル境界の都合で`SATELLITE_FORECAST_BOUNDS`より広い
  // ことがある)ではなく、`SATELLITE_FORECAST_BOUNDS`そのものを使う。「衛星の雲の予測メッシュ
  // も 本土あたりは100キロメッシュにしてください」という指示でメッシュを500km→100kmに
  // 変更した際、`nowMosaic.bounds`のまま100km格子を敷くと(タイル境界の広がり分)マス目数が
  // 約1,230個まで増え、Open-Meteoへの1回のリクエストがURL長超過で失敗する(実測でURL長
  // 約16,000文字を境に`fetch`自体が失敗する。600地点・約8,000文字までは成功を確認)ことが
  // 分かったため、範囲を`SATELLITE_FORECAST_BOUNDS`(約25×23=575マス目)に絞っている。
  // 複数リクエストに分割するのではなく範囲を絞る方式にしたのは、Open-Meteoの無料枠には
  // 分単位のリクエスト数上限があり(実測で確認済み)、1回のリクエストで済ませたほうが安全なため。
  const north = SATELLITE_FORECAST_BOUNDS.getNorth();
  const south = SATELLITE_FORECAST_BOUNDS.getSouth();
  const west = SATELLITE_FORECAST_BOUNDS.getWest();
  const east = SATELLITE_FORECAST_BOUNDS.getEast();
  const centerLat = (north + south) / 2;
  const latStepDegTarget = MOTION_CELL_KM / KM_PER_DEG_LAT;
  const lonStepDegTarget = MOTION_CELL_KM / (KM_PER_DEG_LON_AT_EQUATOR * Math.cos((centerLat * Math.PI) / 180));
  const gw = Math.max(1, Math.round((east - west) / lonStepDegTarget));
  const gh = Math.max(1, Math.round((north - south) / latStepDegTarget));

  // クエリ範囲(SATELLITE_FORECAST_BOUNDS)の四隅を、モザイクと同じネイティブピクセル座標系
  // (z=5のWeb Mercator投影)に変換し、モザイクcanvas上のローカル座標(nowMosaic.txMin/tyMin
  // の分だけ引く。buildTileMosaicがタイルを並べたのと同じ考え方)にする。
  const nwNative = crs.latLngToPoint(L.latLng(north, west), TILE_Z);
  const seNative = crs.latLngToPoint(L.latLng(south, east), TILE_Z);
  const gridX0 = nwNative.x - nowMosaic.txMin * TILE_SIZE;
  const gridY0 = nwNative.y - nowMosaic.tyMin * TILE_SIZE;
  const gridX1 = seNative.x - nowMosaic.txMin * TILE_SIZE;
  const gridY1 = seNative.y - nowMosaic.tyMin * TILE_SIZE;

  const cellDefs: MotionCellDef[] = [];
  for (let gy = 0; gy < gh; gy++) {
    const y0 = gridY0 + (gy / gh) * (gridY1 - gridY0);
    const y1 = gridY0 + ((gy + 1) / gh) * (gridY1 - gridY0);
    for (let gx = 0; gx < gw; gx++) {
      const x0 = gridX0 + (gx / gw) * (gridX1 - gridX0);
      const x1 = gridX0 + ((gx + 1) / gw) * (gridX1 - gridX0);
      const centerXNative = nowMosaic.txMin * TILE_SIZE + (x0 + x1) / 2;
      const centerYNative = nowMosaic.tyMin * TILE_SIZE + (y0 + y1) / 2;
      const centerLatLng = crs.pointToLatLng(L.point(centerXNative, centerYNative), TILE_Z);
      cellDefs.push({ x0, y0, x1, y1, centerLat: centerLatLng.lat, centerLon: centerLatLng.lng });
    }
  }

  return { gw, gh, gridX0, gridY0, gridX1, gridY1, cellDefs };
}

/**
 * `geometry`(マス目のジオメトリ、時刻には依存しない)と`windSeries`(マス目ごとの風の
 * 時系列、`fetchUpperWindSeriesAtPoints`で1回だけ取得したものを使い回す)から、`targetMs`
 * 時点の`MotionField`を作る。「予測の方向も 時間によって 変化するようにして」という指示
 * への対応で、`computeSatelliteForecast`から予測コマ(30分)ごとに違う`targetMs`で呼ばれる。
 */
function buildMotionFieldAt(
  geometry: MotionGridGeometry,
  windSeries: Array<WindSeriesEntry | null>,
  targetMs: number,
): MotionField {
  const { gw, gh, gridX0, gridY0, gridX1, gridY1, cellDefs } = geometry;
  const cells: MotionCell[] = cellDefs.map((c, i) => {
    const wind = pickWindVectorAt(windSeries[i], targetMs);
    const vEastKmh = wind?.vEastKmh ?? 0;
    const vNorthKmh = wind?.vNorthKmh ?? 0;
    const speedKmh = Math.hypot(vEastKmh, vNorthKmh);
    // East/North成分から方位角(0=北・90=東、時計回り)を求める。windToVectorの時点で
    // 「動いていく」方向へ変換済みなので、ここでは180度反転しない。
    const azimuthDeg = ((Math.atan2(vEastKmh, vNorthKmh) * 180) / Math.PI + 360) % 360;

    // km/h → ネイティブピクセル/時 の換算(estimateMotionFieldの旧実装と逆向きの換算)。
    // z=5・256pxタイルでの1pxあたりの実距離は、赤道上でEARTH_CIRCUMFERENCE_KM/(256*2^5)km、
    // そこから緯度による圧縮(Web Mercatorはconformalなので、実距離は赤道上の値×cos(緯度)に
    // なる。cloudMesh.ts・kougenTenkiGenerate.mjsで使っているのと同じ考え方)。
    const kmPerNativePx = (EARTH_CIRCUMFERENCE_KM / (TILE_SIZE * 2 ** TILE_Z)) * Math.cos((c.centerLat * Math.PI) / 180);
    const vxPerHour = kmPerNativePx > 0 ? vEastKmh / kmPerNativePx : 0;
    const vyPerHour = kmPerNativePx > 0 ? -vNorthKmh / kmPerNativePx : 0; // 南方向がプラスなので北成分の符号を反転

    return {
      x0: c.x0,
      y0: c.y0,
      x1: c.x1,
      y1: c.y1,
      centerLat: c.centerLat,
      centerLon: c.centerLon,
      vxPerHour,
      vyPerHour,
      speedKmh,
      azimuthDeg,
    };
  });

  return { gw, gh, gridX0, gridY0, gridX1, gridY1, cells };
}

/** aとbの間をt(0〜1)で線形補間する */
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 「メッシュの間を補完することはできますか」という指示への対応。
 *
 * 以前はマス目ごとの速度でそのマス目の中身をまるごと平行移動する「ブロック単位の移流」
 * だったため、マス目の境界で隣接マスの速度差による重なり・隙間が目立つことがあった。
 * この関数は、ある地点(モザイクのネイティブピクセル座標)の速度を、その地点を囲む
 * 4つのマス目の中心の値から双線形補間(bilinear interpolation)で求める。これにより
 * マス目の境界でも速度が連続的に(なめらかに)変化するようになる。
 *
 * マス目は`buildMotionGridGeometry`で`motionField.gridX0〜gridX1`(`SATELLITE_FORECAST_
 * BOUNDS`に対応する範囲。モザイク全体より狭いことがある)を`(gx+0.5)/gw`で均等に分けた
 * 位置を中心として並んでいるため、その逆算(`((px-gridX0)/(gridX1-gridX0))*gw - 0.5`)で
 * その地点が「どのマス目とどのマス目の間の、どれくらいの位置か」を連続値(gxFrac/gyFrac)
 * として求められる。対象範囲の外周(最初/最後のマス目のさらに外側。モザイクのタイル境界の
 * 余白部分を含む)は、一番近いマス目の値をそのまま使う(外挿はしない。`clamp`で範囲内に
 * 収めている)。
 */
function sampleVelocityAt(motionField: MotionField, px: number, py: number): { vx: number; vy: number } {
  const { gw, gh, gridX0, gridY0, gridX1, gridY1, cells } = motionField;
  const gridWidth = gridX1 - gridX0;
  const gridHeight = gridY1 - gridY0;
  const gxFrac = Math.min(gw - 1, Math.max(0, ((px - gridX0) / gridWidth) * gw - 0.5));
  const gyFrac = Math.min(gh - 1, Math.max(0, ((py - gridY0) / gridHeight) * gh - 0.5));
  const gx0 = Math.floor(gxFrac);
  const gy0 = Math.floor(gyFrac);
  const gx1 = Math.min(gw - 1, gx0 + 1);
  const gy1 = Math.min(gh - 1, gy0 + 1);
  const tx = gxFrac - gx0;
  const ty = gyFrac - gy0;

  const c00 = cells[gy0 * gw + gx0];
  const c10 = cells[gy0 * gw + gx1];
  const c01 = cells[gy1 * gw + gx0];
  const c11 = cells[gy1 * gw + gx1];

  const vx = lerp(lerp(c00.vxPerHour, c10.vxPerHour, tx), lerp(c01.vxPerHour, c11.vxPerHour, tx), ty);
  const vy = lerp(lerp(c00.vyPerHour, c10.vyPerHour, tx), lerp(c01.vyPerHour, c11.vyPerHour, tx), ty);
  return { vx, vy };
}

/**
 * `sourceCanvas`(赤外線モザイク。実測コマ、または直前の予測コマ)を`motionField`に従って
 * `hoursAhead`時間ぶん移流させた画像を作る。移動先の各ピクセルについて、その地点の速度
 * (`sampleVelocityAt`でマス目の間を補完した値)から「`hoursAhead`時間前はどこにあったか」を
 * 逆算し、そこの色をそのまま持ってくる(後方参照、backward warping。ゲームや動画の動き
 * 補償と同じ考え方で、マス目ごとに丸ごと動かす前バージョンと違い隙間や重なりが生じない)。
 * 参照元が対象範囲の外(=データが無い側)になった場合は透明のままにする(実際には分から
 * ない領域を、あたかも分かっているかのように埋めない)。
 *
 * 「予測の方向も 時間によって 変化するようにして」という指示への対応で、以前は`TileMosaic`
 * (常に最新の実測コマ)を受け取っていたが、`computeSatelliteForecast`が予測コマを1枚ずつ
 * 直前のコマから積み重ねて作るようになったため、素の`HTMLCanvasElement`を受け取るように
 * 単純化した(この関数自体は元々canvasの中身しか使っていなかった)。
 */
function advectMosaic(sourceCanvas: HTMLCanvasElement, motionField: MotionField, hoursAhead: number): HTMLCanvasElement {
  const w = sourceCanvas.width;
  const h = sourceCanvas.height;
  const srcCtx = sourceCanvas.getContext("2d");
  if (!srcCtx) throw new Error("2D contextを取得できませんでした");
  const srcData = srcCtx.getImageData(0, 0, w, h).data;

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D contextを取得できませんでした");
  const dstImageData = ctx.createImageData(w, h);
  const dst = dstImageData.data;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const { vx, vy } = sampleVelocityAt(motionField, px, py);
      const srcX = Math.round(px - vx * hoursAhead);
      const srcY = Math.round(py - vy * hoursAhead);
      if (srcX < 0 || srcX >= w || srcY < 0 || srcY >= h) continue; // 透明のまま(dstは既定で0初期化)
      const di = (py * w + px) * 4;
      const si = (srcY * w + srcX) * 4;
      dst[di] = srcData[si];
      dst[di + 1] = srcData[si + 1];
      dst[di + 2] = srcData[si + 2];
      dst[di + 3] = srcData[si + 3];
    }
  }
  ctx.putImageData(dstImageData, 0, 0);
  return canvas;
}

/**
 * 「衛星画像の予測の際も メッシュでできるようにしてください」への対応。`lib/cloudMesh.ts`と
 * 同じ判定基準(`classify`/`localContrastAround`)を、モザイクcanvasの各ピクセルへそのまま
 * 適用する(実測コマは緯度経度ベースの3kmグリッドで判定しているのに対し、こちらはモザイクの
 * ネイティブ解像度そのものをセルにする。対象範囲・タイルズームが同じため、見た目上ほぼ同等の
 * 細かさになる)。
 */
function classifyMosaicToCloudMeshGrid(mosaic: HTMLCanvasElement): CloudMeshGrid {
  const ctx = mosaic.getContext("2d");
  if (!ctx) throw new Error("2D contextを取得できませんでした");
  const w = mosaic.width;
  const h = mosaic.height;
  const imageData = ctx.getImageData(0, 0, w, h);
  const cells = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const value = imageData.data[(y * w + x) * 4];
      const contrast = localContrastAround(imageData, x, y, w, h);
      cells[y * w + x] = classify(value, contrast);
    }
  }
  return { gw: w, gh: h, cells };
}

/** 白/グレー/透明の3色(cloudMesh.tsのrenderCloudMeshDataUrlと同じ配色) */
function renderCloudMeshCanvasDataUrl(grid: CloudMeshGrid): string {
  const canvas = document.createElement("canvas");
  canvas.width = grid.gw;
  canvas.height = grid.gh;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D contextを取得できませんでした");
  const imageData = ctx.createImageData(grid.gw, grid.gh);
  const data = imageData.data;
  for (let i = 0; i < grid.cells.length; i++) {
    const v = grid.cells[i];
    // CLOUD_FULL=2, CLOUD_PARTIAL=1, CLOUD_NONE=0(cloudMesh.tsと同じ数値)
    const color = v === 2 ? [255, 255, 255, 235] : v === 1 ? [170, 170, 170, 190] : [0, 0, 0, 0];
    const o = i * 4;
    data[o] = color[0];
    data[o + 1] = color[1];
    data[o + 2] = color[2];
    data[o + 3] = color[3];
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}

export interface PredictedSatelliteFrame {
  kind: "predicted";
  hoursAhead: number;
  dataUrl: string;
  bounds: L.LatLngBounds;
  /** 「衛星画像の予測の際も メッシュでできるようにしてください」への対応 */
  cloudMeshDataUrl: string;
  /**
   * このコマの移流に実際に使った動きベクトル。「予測の方向も 時間によって 変化するように
   * してください」という指示への対応で、コマごとに使う風が変わるようになったため、矢印
   * 表示(SatelliteMotionArrowsLayer)も選択中のコマに応じてこれを表示できるようにした。
   */
  motionField: MotionField;
}

/**
 * `nowFrame`(最新の実測コマ)と高層風(350hPa・500hPaの平均)の時系列から、100kmメッシュ
 * ごとの動きベクトルを推定し、`FORECAST_STEPS`ぶんの予測コマ(30分刻み)をまとめて作る。
 * 各コマには雲判定メッシュ(`cloudMeshDataUrl`)も添えて返す。
 *
 * 「予測の方向も 時間によって 変化するようにして」という指示への対応。以前はコマ全部
 * (最大6時間先まで)で同じ1つの動きベクトルを使い回していたが、それだと後半のコマほど
 * 「本来なら変わっているはずの風向」を無視した動きになってしまう。そこで、1時間ごとの
 * 風の時系列を1回のリクエストでまとめて取得しておき(`fetchUpperWindSeriesAtPoints`)、
 * 予測コマを1枚ずつ、直前のコマ(最初は実測コマ)から`FORECAST_STEP_HOURS`(30分)ぶんだけ、
 * その時刻に近い(1時間単位に丸めた)風で移流させる処理を繰り返して積み重ねる
 * (実際の風の変化を追いかけながら経路を辿るsemi-Lagrangian的な移流)。
 */
export async function computeSatelliteForecast(
  nowFrame: SatelliteFrame,
): Promise<{ frames: PredictedSatelliteFrame[]; motionField: MotionField }> {
  const nowMosaic = await buildTileMosaic(nowFrame);
  // 風の取得は「最新コマの実際の観測時刻」を基準にする(このコマをその時刻の風でこれから
  // 移流させていく、という考え方に揃えるため。ブラウザの現在時刻ではなく、あくまで
  // このコマ自身の観測時刻を使う)。
  const nowMs = parseValidTime(nowFrame.validtime).getTime();
  const geometry = buildMotionGridGeometry(nowMosaic);
  // forecast_hoursは必要な最大時間(FORECAST_STEPS*FORECAST_STEP_HOURS時間先)より1時間分
  // 余裕を持たせている(端数の丸め・Open-Meteo側の時刻境界のずれに対する安全マージン。
  // past_hours=1も同じ理由の安全マージン)。
  const forecastHours = Math.ceil(FORECAST_STEPS * FORECAST_STEP_HOURS) + 1;
  const windSeries = await fetchUpperWindSeriesAtPoints(
    geometry.cellDefs.map((c) => ({ lat: c.centerLat, lon: c.centerLon })),
    1,
    forecastHours,
  );

  let currentCanvas: HTMLCanvasElement = nowMosaic.canvas;
  const frames: PredictedSatelliteFrame[] = [];
  let firstMotionField: MotionField | null = null;
  for (let i = 1; i <= FORECAST_STEPS; i++) {
    const hoursAhead = i * FORECAST_STEP_HOURS;
    // Open-Meteoの風は1時間刻みのため、30分単位の各コマは「そのコマの時刻に一番近い
    // 1時間単位の時刻」の風を使う(例: 0.5時間後・1時間後はどちらも+1時間の風、
    // 1.5時間後・2時間後はどちらも+2時間の風、という具合に1時間ごとに切り替わる)。
    const stepTargetMs = nowMs + Math.round(hoursAhead) * 3_600_000;
    const motionField = buildMotionFieldAt(geometry, windSeries, stepTargetMs);
    if (i === 1) firstMotionField = motionField;
    currentCanvas = advectMosaic(currentCanvas, motionField, FORECAST_STEP_HOURS);
    frames.push({
      kind: "predicted",
      hoursAhead,
      dataUrl: currentCanvas.toDataURL(),
      bounds: nowMosaic.bounds,
      cloudMeshDataUrl: renderCloudMeshCanvasDataUrl(classifyMosaicToCloudMeshGrid(currentCanvas)),
      motionField,
    });
  }
  // firstMotionFieldはFORECAST_STEPS>=1である限り必ず設定される(ループが最低1回は回るため)。
  return { frames, motionField: firstMotionField as MotionField };
}
