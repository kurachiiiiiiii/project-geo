// @ts-nocheck
// このファイルは server/kougenTenkiGenerate.mjs (型注釈の無い素のJS) をほぼそのまま複製した
// ものなので、型チェックも対象外にしている(全関数に型注釈を付け直すと、複雑な数値計算
// ロジックへ手を入れることになり、既存の検証済みロジックを壊すリスクの方が大きいと判断した)。
// 実行時の型崩れは呼び出し元(kougenTenkiService.ts・currentTemperatureService.ts)側でtry/catchしている。
//
// 「高原天気」気温・霧シミュレーター、および「現在の気温」(高原天気とは別範囲・別ズームの
// 軽量版)のライブ生成。元は C:\Users\krctk\Desktop\高原天気 の Java製ツール(Tenki.java)の
// 計算ロジックをNode(サーバーレス関数から呼べる形)に移植したもの。以下は元実装からの
// 意図的な簡略化:
//
// 気温・湿度は、DEM(標高)から求めたセルごとの標高に、周辺の観測所ペアから推定した
// 標高別逓減率(気温はgamma、湿度はgammaHum)を当てはめて求める。逓減率の推定には、
// 対象セルから半径`LAPSE_RADIUS_KM`(50km)以内の観測所ペアだけを使う
// (`estimateLapseRatesAtLon`。「周辺50キロ圏内のものを計算して逓減率を出し、それを基に
// DEMにあてはめて気温と湿度を計算する」という指示による)。湿度の逓減率は元Javaツールには
// 無い概念で、今回気温と同じ仕組みを湿度にも適用する形で追加した。その後「アメダスの湿度を
// 周辺100キロの観測地点の標高と湿度を基に逓減率を計算するようにしてください」という指示により、
// 湿度(gammaHum)だけ気温より広い半径`LAPSE_RADIUS_KM_HUM`(100km)を使うよう分離した。
//   - 風(風速・風向)は使わない。指示により気温計算の風補正・観測所データの風フィールドを廃止した。
//
// 【スマホ版での廃止(2026年10月)】「openmeteoの演算からの削除」「信州山の環境研究のカメラと気象情報取得も削除」
// 「(高原天気の未来12時間は)未来は削除し実況のみ」への対応で、次のものを取り除いた(PC版はそのまま):
//   - 未来12時間の「予測」(Open-Meteoの予報から作るコマ・実測トレンドを延ばすコマ)。過去12時間〜現在の実況の推定だけを作る
//     (アプリが自分で予報を作らない。気象業務法の予報業務に当たらないようにするため)
//   - 「現在の気温」の湿度の逓減率に使っていた、Open-Meteoの高層データ(800hPa/700hPa)
//   - 気温逓減率の推定に使っていた、信州大学 山岳科学研究拠点(METIMS)の山岳観測所
//   これに伴い、予測コマでしか使わない風・傾斜の格子(地形性の霧の補正)も外した。
//
// 【このファイルについて: server/kougenTenkiGenerate.mjsのAndroidネイティブ移植版】
// 「サーバー(プロキシ)が無いと動かない機能は、スマホ内で演算して自己完結させることは
// 可能でしょうか」という指示への対応。計算ロジック(DEM地形補正・IDW補間・霧リスク判定など)
// は`server/kougenTenkiGenerate.mjs`と完全に同一で、そちらからの複製をベースにしている。
// 違うのはNode専用のI/O部分だけ:
//   - `fetchText`: `node:http`/`node:https` → `fetch()`(CapacitorHttpによりネイティブ通信、
//     CORSの対象外)。シグネチャ(`{status, body}`を返す)は変えていないため、他の全呼び出し
//     箇所は無修正のまま動く。
//   - DEMタイルのキャッシュ: `node:fs`のファイル保存 →
//     `src/lib/nativeKougenTenkiCache.ts`のIndexedDB保存(サーバー版の「キャッシュキー」を
//     そのままIndexedDBのキーとして流用)。
//   - (道路情報提供システムの道路気象観測局は、スマホ版では使わない(2026年10月廃止。配信元の
//     「ご利用に際して」に「国土交通省に無断で転載等を行うことはできません」とあるため)。)
// **なぜ共有モジュールにせず複製したか**: server/kougenTenkiGenerate.mjsは元々Node専用の
// `import`(`node:fs`等)を静的に持っており、そのままではブラウザ/Android向けバンドルに
// 含められない(Viteが解決できずビルドが壊れる)。かといってNode側の実装を丸ごとI/O注入方式に
// 書き換えるのは、既に検証済み・最適化済みのサーバー実装に手を入れることになりリスクが
// 大きいと判断し、既存のサーバー実装は一切変更せず、この専用ファイルとして複製する方式にした。
// **そのため、計算ロジック自体に変更を加える場合は両方のファイルを直すこと。**
//
// このファイルはAndroidネイティブアプリ(`src/lib/platform.ts`の`isNativeApp()`がtrue)から
// だけ呼ばれる。「高原天気」はWeb(PWA)版が`/api/kougen-tenki-generate`を使うのに対し
// ネイティブはこちらの`generateKougenTenki`を、「現在の気温」も同様にWeb版が
// `/api/current-temperature-generate`を使うのに対しネイティブはこちらの
// `generateCurrentTemperature`を使う(いずれも`isNativeApp()`で分岐。各serviceファイル参照)。
import { readNativeCache, writeNativeCache } from "../../lib/nativeKougenTenkiCache";

const LAT_MIN = 35.1;
const LAT_MAX = 37.05;
const LON_MIN = 136.2;
const LON_MAX = 138.7;
const ZOOM = 11;
const GRID_STEP = 16;

/** 高原天気(上記)の対象範囲・DEMズームを1つのオブジェクトにまとめたもの。GRID_STEPは両者で共通。 */
const KOUGEN_TENKI_REGION = { zoom: ZOOM, latMin: LAT_MIN, latMax: LAT_MAX, lonMin: LON_MIN, lonMax: LON_MAX };

/**
 * 「現在の気温」用の拡大対象範囲。server/kougenTenkiGenerate.mjsのCURRENT_TEMP_REGIONと同じ
 * (中部+関東+東北+北海道、DEMズーム10。詳しい経緯・境界の決め方はサーバー版のコメント参照)。
 */
const CURRENT_TEMP_ZOOM = 10;
const CURRENT_TEMP_LAT_MIN = 34.5;
const CURRENT_TEMP_LAT_MAX = 46.0;
const CURRENT_TEMP_LON_MIN = 136.2;
const CURRENT_TEMP_LON_MAX = 146.0;
const CURRENT_TEMP_REGION = {
  zoom: CURRENT_TEMP_ZOOM,
  latMin: CURRENT_TEMP_LAT_MIN,
  latMax: CURRENT_TEMP_LAT_MAX,
  lonMin: CURRENT_TEMP_LON_MIN,
  lonMax: CURRENT_TEMP_LON_MAX,
};

/**
 * 「高層天気の取得地点から 標高20m以下を除外して」という指示による。「高原天気」という
 * 名前のとおり山岳・高原地帯を対象にした気温分布のため、対象範囲の縁に含まれる海沿い・
 * 低地のアメダス観測所(標高20m以下)は気候が大きく異なり気温分布を歪める恐れがあるため、
 * 取得地点そのものから除外する(loadAmedasTable参照。server/kougenTenkiGenerate.mjsと
 * 同じ修正)。
 */
const MIN_STATION_ALT_M = 20;

const P_LAT = 0.7;
const GAMMA_STD = 0.0065; // 気温逓減率(℃/m)。標準大気 ≒ 6.5℃/km
const GAMMA_MIN = -0.004;
const GAMMA_MAX = 0.012;
// 湿度の標高別逓減率(%/m)の安全クランプ範囲。気温と違い物理的な「標準値」が無いため、
// 既定(サンプルが無い場合)は0(標高による湿度変化なしと仮定)とする。
const GAMMA_HUM_MIN = -0.03;
const GAMMA_HUM_MAX = 0.03;

/**
 * 「高地の湿度が低いように感じられます」への対応。湿度の標高投影に使う標高差だけを
 * この値で頭打ちにし、実測ペアの標高差の範囲を大きく超えて外挿しすぎないようにする
 * (詳細はserver/kougenTenkiGenerate.mjsの同名定数のコメント参照)。
 */
const HUM_PROJECTION_MAX_ALT_DIFF_M = 1500;

/**
 * 「現在の気温の湿度の逓減度をもう少しあげてください」への対応。
 *
 * 「現在の気温」(generateCurrentTemperature)でのみ、推定した湿度の標高別逓減率`gammaHum`(%/m。
 * 正=標高が高いほど湿度が下がる)にこの値を加算する(=標高が高いセルほど、観測所の湿度から
 * 余計に下げて投影する)。0.005%/m = 標高差100mあたり0.5%、標高差1,000mで5%、標高差が
 * `HUM_PROJECTION_MAX_ALT_DIFF_M`で頭打ちになる1,500mで7.5%の追加低下。
 * 乗算(×倍)でなく加算にしているのは、`gammaHum`が負(標高が高いほど湿度が上がる)や
 * 0付近のときでも、符号によらず必ず「逓減が強まる」方向に働かせるため。加算後も
 * `GAMMA_HUM_MIN/MAX`の範囲に収める。高原天気(観測コマ・予測コマ)には適用しない。
 * さらに強めたいときは、この値だけを大きくする。
 */
const CURRENT_TEMP_HUM_LAPSE_BIAS = 0.005;
/**
 * 気温の標高別逓減率(gamma)を推定する際、対象地点から半径何km以内の観測所ペアだけを
 * 使うか。「周辺50キロ圏内のものを計算して出す」という指示による
 * (`estimateLapseRatesAtLon`参照)。
 */
const LAPSE_RADIUS_KM = 50;
const LAPSE_RADIUS_KM2 = LAPSE_RADIUS_KM * LAPSE_RADIUS_KM;

/**
 * 湿度の標高別逓減率(gammaHum)専用の半径(server/kougenTenkiGenerate.mjsの同名定数と同じ。
 * 詳細はそちらのコメント参照)。
 */
const LAPSE_RADIUS_KM_HUM = 100;
const LAPSE_RADIUS_KM_HUM2 = LAPSE_RADIUS_KM_HUM * LAPSE_RADIUS_KM_HUM;

/**
 * 過去・未来それぞれ何時間分を生成するか(1時間刻み)。高原天気のみで使う(現在の気温は常に1コマ)。
 */
const HOURS_COUNT = 12;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const AMEDAS_BASE = "https://www.jma.go.jp/bosai/amedas";
const DEM_BASE = "https://cyberjapandata.gsi.go.jp/xyz/dem";

// DEMタイルは実質的に不変のデータなので、一度取得したら再利用する(IndexedDBに永続保存。
// 2回目以降の生成はDEM取得なしでほぼ即座に終わる。サーバー版のCACHE_DIR/demCacheFileに相当)。
function demCacheKey(z, x, y) {
  return `dem/${z}/${x}/${y}`;
}

/**
 * サーバー版(`node:http`/`node:https`)のネイティブ移植版。`fetch()`はCapacitorHttpにより
 * ネイティブ通信(CORSの対象外)になるため、`server/kougenTenkiGenerate.mjs`のように
 * サーバー側で中継する必要がない。シグネチャ(`{status, body}`を返す、`encoding`引数)は
 * サーバー版と同じにしてあるため、他の全呼び出し箇所は無修正のまま動く。
 */
async function fetchText(url, encoding = "utf-8") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`upstream timeout: ${url}`)), 20_000);
  try {
    const res = await fetch(url, { headers: { "User-Agent": BROWSER_UA }, signal: controller.signal });
    const buf = await res.arrayBuffer();
    const body = encoding === "utf-8" ? new TextDecoder("utf-8").decode(buf) : new TextDecoder(encoding).decode(buf);
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

/** 同時実行数を制限しながら並列実行する簡易ヘルパー */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ---------------------------------------------------------------
// 1. タイル範囲・グリッド座標
// ---------------------------------------------------------------

function asinh(x) {
  return Math.log(x + Math.sqrt(x * x + 1));
}

/** `region`(`{zoom,latMin,latMax,lonMin,lonMax}`)からタイル範囲を求める。高原天気・現在の気温で共通。 */
function getTileInfo(region) {
  const n = 1 << region.zoom;
  return {
    xMin: Math.floor(((region.lonMin + 180) / 360) * n),
    xMax: Math.floor(((region.lonMax + 180) / 360) * n),
    yMin: Math.floor(((1 - asinh(Math.tan((region.latMax * Math.PI) / 180)) / Math.PI) / 2) * n),
    yMax: Math.floor(((1 - asinh(Math.tan((region.latMin * Math.PI) / 180)) / Math.PI) / 2) * n),
  };
}

function tileXtoLon(x, z) {
  return (x / (1 << z)) * 360 - 180;
}

function tileYtoLat(y, z) {
  const n = Math.PI - (2 * Math.PI * y) / (1 << z);
  return (Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))) * 180) / Math.PI;
}

// (経度・緯度→タイル座標の lonToTileX/latToTileY は、Open-Meteoのサンプル地点・道路気象観測局の標高を
// 引くのに使っていたが、どちらも廃止したので削除した)

// ---------------------------------------------------------------
// 2. DEM(標高) — タイルごとにキャッシュしつつ、グリッド解像度分だけ抽出する
// ---------------------------------------------------------------

/**
 * 標高グリッド上で「海上・データ無し」を表すセル値。`temp10`の欠測マーカー(-9999)と
 * 揃えた値にしている。「海の部分は計算しなくて大丈夫です」という指示への対応として、
 * この値のセルは`computeGridFrame`側でIDW補間そのものをスキップする
 * (server/kougenTenkiGenerate.mjsのALT_NO_DATAと同じ)。
 */
const ALT_NO_DATA = -9999;

/** 1タイル(256x256)のCSVテキストから、GRID_STEP間隔の行・列だけを取り出す */
function sampleTileRows(text) {
  const lines = text.split(/\r?\n/);
  const rows = [];
  for (let r = 0; r < 256; r += GRID_STEP) {
    const line = lines[r];
    if (!line) {
      rows.push(null);
      continue;
    }
    const cells = line.split(",");
    const sampled = [];
    for (let c = 0; c < 256; c += GRID_STEP) {
      const v = (cells[c] ?? "").trim();
      const n = Math.round(Number(v));
      sampled.push(v === "e" || v === "" || !Number.isFinite(n) ? ALT_NO_DATA : n);
    }
    rows.push(sampled);
  }
  return rows;
}

/** データが存在しないタイル(海上など)をキャッシュ上で表すマーカー */
const NO_DATA_MARKER = "NODATA";

function blankTileRows() {
  const perTile = 256 / GRID_STEP;
  return Array.from({ length: perTile }, () => Array.from({ length: perTile }, () => ALT_NO_DATA));
}

async function fetchDemTile(z, x, y) {
  const key = demCacheKey(z, x, y);
  const cached = await readNativeCache(key);
  if (cached !== null) {
    return cached === NO_DATA_MARKER ? blankTileRows() : sampleTileRows(cached);
  }

  const url = `${DEM_BASE}/${z}/${x}/${y}.txt`;
  const res = await fetchText(url);

  if (res.status !== 200 || !res.body.includes(",")) {
    // データが存在しない領域(海上など)。ALT_NO_DATAのタイルとしてキャッシュしておく
    // (毎回404を踏みに行かないようにするため)。
    await writeNativeCache(key, NO_DATA_MARKER);
    return blankTileRows();
  }

  await writeNativeCache(key, res.body);
  return sampleTileRows(res.body);
}

/**
 * 対象範囲全体のグリッド標高(`gw × gh`、行優先)を返す。
 * タイル単位でキャッシュ済みなら再取得しない。
 */
async function buildAltGrid(tile, zoom) {
  const tilesX = tile.xMax - tile.xMin + 1;
  const tilesY = tile.yMax - tile.yMin + 1;
  const perTile = 256 / GRID_STEP; // 1タイルあたりのグリッド数(片辺)
  const gw = tilesX * perTile;
  const gh = tilesY * perTile;

  const alt = new Array(gw * gh).fill(ALT_NO_DATA);

  const jobs = [];
  for (let ty = tile.yMin; ty <= tile.yMax; ty++) {
    for (let tx = tile.xMin; tx <= tile.xMax; tx++) {
      jobs.push({ tx, ty });
    }
  }

  await mapWithConcurrency(jobs, 16, async ({ tx, ty }) => {
    const rows = await fetchDemTile(zoom, tx, ty);
    const baseGx = (tx - tile.xMin) * perTile;
    const baseGy = (ty - tile.yMin) * perTile;
    for (let r = 0; r < perTile; r++) {
      const row = rows[r];
      if (!row) continue;
      const gy = baseGy + r;
      for (let c = 0; c < perTile; c++) {
        const gx = baseGx + c;
        alt[gy * gw + gx] = row[c] ?? ALT_NO_DATA;
      }
    }
  });

  return { alt, gw, gh };
}

// ---------------------------------------------------------------
// 3. アメダス観測所・過去12時間分の観測値
// ---------------------------------------------------------------

let rawTableCache = null;

/**
 * アメダス観測所マスタ全国分を取得し、標高20m以下を除外しただけの(対象範囲による絞り込み
 * 前の)一覧をキャッシュする。「高原天気」「現在の気温」は対象範囲が異なる(後者の方が広い)ため、
 * 対象範囲による絞り込みは`loadAmedasTable(region)`側で行う(このキャッシュ自体は両者で共用)。
 */
async function loadRawAmedasTable() {
  if (rawTableCache) return rawTableCache;
  const res = await fetchText(`${AMEDAS_BASE}/const/amedastable.json`);
  if (res.status !== 200) throw new Error(`アメダス観測所マスタの取得に失敗しました (HTTP ${res.status})`);
  const table = JSON.parse(res.body);

  const stations = [];
  for (const [id, entry] of Object.entries(table)) {
    const name = entry.kjName;
    const alt = entry.alt;
    const lat = entry.lat;
    const lon = entry.lon;
    if (!name || typeof alt !== "number" || !Array.isArray(lat) || !Array.isArray(lon)) continue;
    if (alt <= MIN_STATION_ALT_M) continue; // 「標高20m以下を除外して」という指示による
    const la = lat[0] + Math.sign(lat[0] || 1) * (lat[1] / 60);
    const lo = lon[0] + Math.sign(lon[0] || 1) * (lon[1] / 60);
    stations.push({ id, name, alt, lat: la, lon: lo });
  }
  rawTableCache = stations;
  return stations;
}

/** 「境界付近の内挿を安定させるため、範囲外も少し候補に入れる」余裕(度)。高原天気・現在の気温で共通。 */
const AMEDAS_REGION_MARGIN = 0.45;

/** `region`内(+margin)のアメダス観測所だけに絞り込む。 */
async function loadAmedasTable(region) {
  const raw = await loadRawAmedasTable();
  const stations = raw.filter(
    ({ lat: la, lon: lo }) =>
      la >= region.latMin - AMEDAS_REGION_MARGIN &&
      la <= region.latMax + AMEDAS_REGION_MARGIN &&
      lo >= region.lonMin - AMEDAS_REGION_MARGIN &&
      lo <= region.lonMax + AMEDAS_REGION_MARGIN,
  );
  return stations;
}

/** "2026-08-30T18:20:00+09:00" のような文字列の数値部分を、TZに依存しない形で ms 化する */
function parseJstIsoAsFakeUtc(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/);
  if (!m) throw new Error(`unexpected time format: ${iso}`);
  const [, y, mo, d, h, mi, s] = m.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

function formatAmedasKey(fakeUtcMs) {
  const d = new Date(fakeUtcMs);
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/** yyyy-mm-ddTHH:mm:ss 形式(JST)の表示用文字列に整形する */
function formatDisplayTime(fakeUtcMs) {
  const d = new Date(fakeUtcMs);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

async function fetchAmedasObsAt(fakeUtcMs, tableStations) {
  const key = formatAmedasKey(fakeUtcMs);
  const res = await fetchText(`${AMEDAS_BASE}/data/map/${key}.json`);
  if (res.status !== 200) return null;

  let raw;
  try {
    raw = JSON.parse(res.body);
  } catch {
    return null;
  }

  const stations = [];
  for (const meta of tableStations) {
    const entry = raw[meta.id];
    if (!entry) continue;
    const temp = Array.isArray(entry.temp) && entry.temp[1] === 0 ? entry.temp[0] : null;
    if (temp === null) continue;
    const humidity = Array.isArray(entry.humidity) && entry.humidity[1] === 0 ? entry.humidity[0] : null;
    stations.push({ ...meta, temp, humidity: humidity ?? Number.NaN });
  }
  return stations;
}

// ---------------------------------------------------------------
// 3c. 犬山自動気象観測所(追加の気温観測地点)
// ---------------------------------------------------------------

const INUYAMA_AWS_URL = "https://www.ma.ccnw.ne.jp/jan/weather/main.html";
const INUYAMA_AWS_STATION = {
  id: "inuyama_aws",
  name: "犬山自動気象観測所",
  lat: 35 + 23.3 / 60,
  lon: 136 + 59.9 / 60,
  alt: 130,
};

async function fetchInuyamaAwsStation() {
  try {
    const res = await fetchText(INUYAMA_AWS_URL, "shift_jis");
    if (res.status !== 200) {
      const error = `犬山自動気象観測所の取得に失敗しました (HTTP ${res.status})`;
      console.warn(`kougenTenki: ${error}`);
      return { station: null, error };
    }

    const tempMatch = res.body.match(/気温[；：:]\s*(-?\d+(?:\.\d+)?)\s*(?:°C|℃)/);
    const humMatch = res.body.match(/湿度[；：:]\s*(\d+(?:\.\d+)?)\s*%/);
    if (!tempMatch || !humMatch) {
      const error = "犬山自動気象観測所のページから気温・湿度を読み取れませんでした(ページ構造の変更の可能性)";
      console.warn(`kougenTenki: ${error}`);
      return { station: null, error };
    }

    const temp = Number(tempMatch[1]);
    const humidity = Number(humMatch[1]);
    if (!Number.isFinite(temp) || !Number.isFinite(humidity)) {
      return { station: null, error: "犬山自動気象観測所の気温・湿度の値が不正でした" };
    }

    return { station: { ...INUYAMA_AWS_STATION, temp, humidity }, error: null };
  } catch (e) {
    const error = `犬山自動気象観測所の取得でエラーが発生しました: ${e}`;
    console.warn(`kougenTenki: ${error}`);
    return { station: null, error };
  }
}

// ---------------------------------------------------------------
// 4. 気温逓減率・気温/湿度/霧リスクの推定(風は使わない)
// ---------------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** 正確な測地距離(前処理の観測所ペア列挙など、呼び出し回数が少ない箇所専用) */
function distanceKm(lat1, lon1, lat2, lon2) {
  const r = 6371;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = ((lat2 - lat1) * Math.PI) / 180;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_AT_EQUATOR = 111.32;

function distanceKm2Fast(dLat, dLon, kmPerDegLon) {
  const dy = dLat * KM_PER_DEG_LAT;
  const dx = dLon * kmPerDegLon;
  return dx * dx + dy * dy;
}

function computeLapseSamples(stations) {
  const samples = [];
  for (let i = 0; i < stations.length; i++) {
    for (let j = i + 1; j < stations.length; j++) {
      const a = stations[i];
      const b = stations[j];
      if (Number.isNaN(a.temp) || Number.isNaN(b.temp)) continue;

      const low = a.alt <= b.alt ? a : b;
      const high = a.alt <= b.alt ? b : a;
      const dz = high.alt - low.alt;
      if (dz < 80) continue;

      const dKm = distanceKm(low.lat, low.lon, high.lat, high.lon);
      if (dKm > 180) continue;

      let gamma = (low.temp - high.temp - P_LAT * (high.lat - low.lat)) / dz;
      gamma = clamp(gamma, GAMMA_MIN, GAMMA_MAX);

      let gammaHum = null;
      if (!Number.isNaN(low.humidity) && !Number.isNaN(high.humidity)) {
        gammaHum = clamp((low.humidity - high.humidity) / dz, GAMMA_HUM_MIN, GAMMA_HUM_MAX);
      }

      samples.push({
        lat: (low.lat + high.lat) / 2,
        lon: (low.lon + high.lon) / 2,
        altMid: (low.alt + high.alt) / 2,
        gamma,
        gammaHum,
      });
    }
  }
  return samples;
}

function computeCellFast(lat, lon, alt, gamma, gammaHum, kmPerDegLon, stations) {
  let tempSum = 0;
  let tempWsum = 0;
  let humSum = 0;
  let humWsum = 0;
  let fogBoostSum = 0;

  for (const s of stations) {
    const d2 = distanceKm2Fast(lat - s.lat, lon - s.lon, kmPerDegLon);
    const wDist = 1 / (d2 + 8);

    const altDiff = Math.abs(alt - s.alt);
    const wAltTemp = Math.exp(-altDiff / 1000);
    const pred = s.temp - gamma * (alt - s.alt) - P_LAT * (lat - s.lat);
    const wTemp = wDist * wAltTemp;
    tempSum += pred * wTemp;
    tempWsum += wTemp;

    if (!Number.isNaN(s.humidity)) {
      const wAltHum = Math.exp(-altDiff / 700);
      const wMountain = s.alt >= 1800 && alt >= 1800 ? 2.2 : 1.0;
      const wHum = wDist * wAltHum * wMountain;
      const altDiffForProjection = clamp(alt - s.alt, -HUM_PROJECTION_MAX_ALT_DIFF_M, HUM_PROJECTION_MAX_ALT_DIFF_M);
      const predHum = clamp(s.humidity - gammaHum * altDiffForProjection, 0, 100);
      humSum += predHum * wHum;
      humWsum += wHum;
      fogBoostSum += (s.fogBoost ?? 0) * wHum;
    }
  }

  return {
    temp: tempWsum > 0 ? tempSum / tempWsum : Number.NaN,
    humidity: humWsum > 0 ? clamp(humSum / humWsum, 0, 100) : Number.NaN,
    fogBoost: humWsum > 0 ? fogBoostSum / humWsum : 0,
  };
}

/** 露点温度(℃)。Magnus式 */
function dewPointC(tempC, rh) {
  const rhClamped = clamp(rh, 1, 100);
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(rhClamped / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

const FOG_RH_THRESHOLD = 97;

function calcFogRisk(tempC, rh) {
  if (Number.isNaN(tempC) || Number.isNaN(rh) || rh < FOG_RH_THRESHOLD) return 0;

  const dew = dewPointC(tempC, rh);
  const spread = tempC - dew;

  if (rh >= 100 || spread <= 0.3) return 1.0;
  if (rh >= 99 || spread <= 0.8) return 0.6;
  return 0.3;
}

function estimateLapseRatesAtLon(lat, lon, alt, kmPerDegLon, lapseSamples, upperAirSamples = []) {
  let sum = 0;
  let wsum = 0;
  let sumHum = 0;
  let wsumHum = 0;

  for (const ls of lapseSamples) {
    const d2 = distanceKm2Fast(lat - ls.lat, lon - ls.lon, kmPerDegLon);
    // 湿度の方が半径が広いため、まずそちらで足切りする(両方とも圏外なら何もしない)。
    if (d2 > LAPSE_RADIUS_KM_HUM2) continue;

    const wDist = 1 / (d2 + 20);
    const wAlt = Math.exp(-Math.abs(alt - ls.altMid) / 700);
    const w = wDist * wAlt;

    if (d2 <= LAPSE_RADIUS_KM2) {
      sum += ls.gamma * w;
      wsum += w;
    }

    if (ls.gammaHum !== null) {
      sumHum += ls.gammaHum * w;
      wsumHum += w;
    }
  }

  if (wsumHum === 0) {
    for (const ls of lapseSamples) {
      if (ls.gammaHum === null) continue;
      const d2 = distanceKm2Fast(lat - ls.lat, lon - ls.lon, kmPerDegLon);
      const wDist = 1 / (d2 + 20);
      const wAlt = Math.exp(-Math.abs(alt - ls.altMid) / 700);
      const w = wDist * wAlt;
      sumHum += ls.gammaHum * w;
      wsumHum += w;
    }
  }

  // 「現在の気温」用: 800hPa/700hPaの高層データ(100kmメッシュ、陸地のみ)から求めた湿度逓減率を
  // 地上ペアの有無に関わらず常に混ぜる(半径制限なし。詳細はserver/kougenTenkiGenerate.mjsの同名関数コメント参照)。
  for (const ua of upperAirSamples) {
    const d2 = distanceKm2Fast(lat - ua.lat, lon - ua.lon, kmPerDegLon);
    const wDist = 1 / (d2 + 20);
    const wAlt = Math.exp(-Math.abs(alt - ua.altMid) / 700);
    const w = wDist * wAlt;
    sumHum += ua.gammaHum * w;
    wsumHum += w;
  }

  const gamma = wsum > 0 ? clamp(sum / wsum, GAMMA_MIN, GAMMA_MAX) : GAMMA_STD;
  const gammaHum = wsumHum > 0 ? clamp(sumHum / wsumHum, GAMMA_HUM_MIN, GAMMA_HUM_MAX) : 0;
  return { gamma, gammaHum };
}

const LAPSE_GRID_STRIDE = 8;

function buildGammaGrid(tile, alt, gw, gh, lapseSamples, zoom, upperAirSamples = []) {
  const cgw = Math.ceil(gw / LAPSE_GRID_STRIDE);
  const cgh = Math.ceil(gh / LAPSE_GRID_STRIDE);
  const gammaGrid = new Float64Array(cgw * cgh);
  const gammaHumGrid = new Float64Array(cgw * cgh);

  for (let cy = 0; cy < cgh; cy++) {
    const gy = Math.min(cy * LAPSE_GRID_STRIDE, gh - 1);
    const lat = tileYtoLat(tile.yMin + (gy * GRID_STEP) / 256, zoom);
    const kmPerDegLon = KM_PER_DEG_LON_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);

    for (let cx = 0; cx < cgw; cx++) {
      const gx = Math.min(cx * LAPSE_GRID_STRIDE, gw - 1);
      const lon = tileXtoLon(tile.xMin + (gx * GRID_STEP) / 256, zoom);
      const a = alt[gy * gw + gx];
      const { gamma, gammaHum } = estimateLapseRatesAtLon(lat, lon, a, kmPerDegLon, lapseSamples, upperAirSamples);
      const i = cy * cgw + cx;
      gammaGrid[i] = gamma;
      gammaHumGrid[i] = gammaHum;
    }
  }

  return {
    get(gx, gy) {
      const cx = Math.min(Math.round(gx / LAPSE_GRID_STRIDE), cgw - 1);
      const cy = Math.min(Math.round(gy / LAPSE_GRID_STRIDE), cgh - 1);
      const i = cy * cgw + cx;
      return { gamma: gammaGrid[i], gammaHum: gammaHumGrid[i] };
    },
  };
}

const GAMMA_FOG_BOOST_MAX = 10;
const LOW_ALT_FOG_PENALTY_THRESHOLD_M = 100;
const LOW_ALT_FOG_PENALTY_PCT = 1;

function gammaStabilityFactor(gamma) {
  if (gamma >= GAMMA_STD) return 0;
  return clamp((GAMMA_STD - gamma) / (GAMMA_STD - GAMMA_MIN), 0, 1);
}

const SLOPE_GRADIENT_THRESHOLD_M_PER_KM = 300;
const OROGRAPHIC_ANGLE_TOLERANCE_DEG = 60;
const OROGRAPHIC_MIN_WIND_SPEED_MS = 1.5;
const OROGRAPHIC_UPSLOPE_BOOST_PCT = 2;
const OROGRAPHIC_DOWNSLOPE_PENALTY_PCT = 1;


function angularDiffDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}



function orographicFogAdjustment(slopeMagnitudePerKm, slopeAspectDeg, wind) {
  if (slopeMagnitudePerKm < SLOPE_GRADIENT_THRESHOLD_M_PER_KM) return { boost: 0, penalty: 0 };
  if (!wind || wind.windSpeedMs < OROGRAPHIC_MIN_WIND_SPEED_MS) return { boost: 0, penalty: 0 };

  const diffToUpslope = angularDiffDeg(wind.windDirDeg, slopeAspectDeg);
  if (diffToUpslope <= OROGRAPHIC_ANGLE_TOLERANCE_DEG) {
    return { boost: OROGRAPHIC_UPSLOPE_BOOST_PCT, penalty: 0 };
  }
  const diffToDownslope = angularDiffDeg(wind.windDirDeg, (slopeAspectDeg + 180) % 360);
  if (diffToDownslope <= OROGRAPHIC_ANGLE_TOLERANCE_DEG) {
    return { boost: 0, penalty: OROGRAPHIC_DOWNSLOPE_PENALTY_PCT };
  }
  return { boost: 0, penalty: 0 };
}

// ---------------------------------------------------------------
// 6. 生成本体(高原天気・現在の気温で共通)
// ---------------------------------------------------------------

function computeGridFrame(
  tile,
  alt,
  gw,
  gh,
  stations,
  extraLapseStations = [],
  slopeGrid = null,
  windGrid = null,
  zoom = ZOOM,
  upperAirSamples = [],
  humLapseBias = 0,
) {
  const lapseSamples = computeLapseSamples(
    extraLapseStations.length > 0 ? stations.concat(extraLapseStations) : stations,
  );
  const gammaGrid = buildGammaGrid(tile, alt, gw, gh, lapseSamples, zoom, upperAirSamples);
  const temp10 = new Array(gw * gh);
  const hum = new Array(gw * gh);
  const fog = new Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    const lat = tileYtoLat(tile.yMin + (gy * GRID_STEP) / 256, zoom);
    const kmPerDegLon = KM_PER_DEG_LON_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);

    for (let gx = 0; gx < gw; gx++) {
      const lon = tileXtoLon(tile.xMin + (gx * GRID_STEP) / 256, zoom);
      const idx = gy * gw + gx;
      const a = alt[idx];

      // 「海の部分は計算しなくて大丈夫です」への対応。海上セルはIDW補間そのものをスキップする
      // (server/kougenTenkiGenerate.mjsのcomputeGridFrameと同じ)。
      if (a === ALT_NO_DATA) {
        temp10[idx] = -9999;
        hum[idx] = -1;
        fog[idx] = 0;
        continue;
      }

      const { gamma, gammaHum } = gammaGrid.get(gx, gy);
      const { temp, humidity: rh, fogBoost } = computeCellFast(
        lat,
        lon,
        a,
        gamma,
        // 現在の気温のみ湿度の逓減を強める(CURRENT_TEMP_HUM_LAPSE_BIAS参照)。0なら従来どおり。
        humLapseBias === 0 ? gammaHum : clamp(gammaHum + humLapseBias, GAMMA_HUM_MIN, GAMMA_HUM_MAX),
        kmPerDegLon,
        stations,
      );

      temp10[idx] = Number.isNaN(temp) ? -9999 : Math.round(temp * 10);
      hum[idx] = Number.isNaN(rh) ? -1 : Math.round(rh);

      const orographic =
        slopeGrid && windGrid
          ? orographicFogAdjustment(slopeGrid.magnitude[idx], slopeGrid.aspect[idx], windGrid.get(gx, gy))
          : { boost: 0, penalty: 0 };
      const lowAltPenalty = a <= LOW_ALT_FOG_PENALTY_THRESHOLD_M ? LOW_ALT_FOG_PENALTY_PCT : 0;
      const rhForGate = Number.isNaN(rh) ? Number.NaN : clamp(rh - lowAltPenalty - orographic.penalty, 0, 100);

      let rhForFog = Number.NaN;
      if (!Number.isNaN(rhForGate) && rhForGate >= FOG_RH_THRESHOLD) {
        const stabilityBoost = gammaStabilityFactor(gamma) * GAMMA_FOG_BOOST_MAX;
        rhForFog = clamp(rhForGate + fogBoost + stabilityBoost + orographic.boost, 0, 100);
      }
      fog[idx] = calcFogRisk(temp, rhForFog);
    }
  }

  return { temp10, hum, fog };
}

function mergeObservedStationsAcrossHours(perHourStations, hoursN) {
  const byId = new Map();
  for (let k = 0; k < hoursN; k++) {
    for (const s of perHourStations[k]) {
      let merged = byId.get(s.id);
      if (!merged) {
        merged = {
          lat: s.lat,
          lon: s.lon,
          alt: s.alt,
          temp: new Float64Array(hoursN).fill(NaN),
          humidity: new Float64Array(hoursN).fill(NaN),
        };
        byId.set(s.id, merged);
      }
      merged.temp[k] = s.temp;
      merged.humidity[k] = s.humidity;
    }
  }
  return Array.from(byId.values());
}

function computeObservedGridFramesFast(tile, alt, gw, gh, perHourStations, hourTimeKeys, extraLapseStations) {
  const hoursN = perHourStations.length;
  const gammaGrids = perHourStations.map((stations) => {
    const lapseSamples = computeLapseSamples(
      extraLapseStations.length > 0 ? stations.concat(extraLapseStations) : stations,
    );
    return buildGammaGrid(tile, alt, gw, gh, lapseSamples, ZOOM);
  });

  const mergedStations = mergeObservedStationsAcrossHours(perHourStations, hoursN);

  const temp10Frames = Array.from({ length: hoursN }, () => new Array(gw * gh));
  const humFrames = Array.from({ length: hoursN }, () => new Array(gw * gh));
  const fogFrames = Array.from({ length: hoursN }, () => new Array(gw * gh));

  const tempSum = new Float64Array(hoursN);
  const tempWsum = new Float64Array(hoursN);
  const humSum = new Float64Array(hoursN);
  const humWsum = new Float64Array(hoursN);
  const gammaAtCell = new Float64Array(hoursN);
  const gammaHumAtCell = new Float64Array(hoursN);

  for (let gy = 0; gy < gh; gy++) {
    const lat = tileYtoLat(tile.yMin + (gy * GRID_STEP) / 256, ZOOM);
    const kmPerDegLon = KM_PER_DEG_LON_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);

    for (let gx = 0; gx < gw; gx++) {
      const lon = tileXtoLon(tile.xMin + (gx * GRID_STEP) / 256, ZOOM);
      const idx = gy * gw + gx;
      const a = alt[idx];

      tempSum.fill(0);
      tempWsum.fill(0);
      humSum.fill(0);
      humWsum.fill(0);
      for (let k = 0; k < hoursN; k++) {
        const { gamma, gammaHum } = gammaGrids[k].get(gx, gy);
        gammaAtCell[k] = gamma;
        gammaHumAtCell[k] = gammaHum;
      }

      for (const s of mergedStations) {
        const d2 = distanceKm2Fast(lat - s.lat, lon - s.lon, kmPerDegLon);
        const wDist = 1 / (d2 + 8);
        const altDiff = Math.abs(a - s.alt);
        const wTemp = wDist * Math.exp(-altDiff / 1000);
        const wHumBase = wDist * Math.exp(-altDiff / 700) * (s.alt >= 1800 && a >= 1800 ? 2.2 : 1.0);
        const altDiffForHumProjection = clamp(a - s.alt, -HUM_PROJECTION_MAX_ALT_DIFF_M, HUM_PROJECTION_MAX_ALT_DIFF_M);

        for (let k = 0; k < hoursN; k++) {
          const sTemp = s.temp[k];
          if (!Number.isNaN(sTemp)) {
            const pred = sTemp - gammaAtCell[k] * (a - s.alt) - P_LAT * (lat - s.lat);
            tempSum[k] += pred * wTemp;
            tempWsum[k] += wTemp;
          }
          const sHum = s.humidity[k];
          if (!Number.isNaN(sHum)) {
            const predHum = clamp(sHum - gammaHumAtCell[k] * altDiffForHumProjection, 0, 100);
            humSum[k] += predHum * wHumBase;
            humWsum[k] += wHumBase;
          }
        }
      }

      for (let k = 0; k < hoursN; k++) {
        const temp = tempWsum[k] > 0 ? tempSum[k] / tempWsum[k] : Number.NaN;
        const rh = humWsum[k] > 0 ? clamp(humSum[k] / humWsum[k], 0, 100) : Number.NaN;

        const gamma = gammaAtCell[k];
        const lowAltPenalty = a <= LOW_ALT_FOG_PENALTY_THRESHOLD_M ? LOW_ALT_FOG_PENALTY_PCT : 0;
        const rhForGate = Number.isNaN(rh) ? Number.NaN : clamp(rh - lowAltPenalty, 0, 100);

        let rhForFog = Number.NaN;
        if (!Number.isNaN(rhForGate) && rhForGate >= FOG_RH_THRESHOLD) {
          const stabilityBoost = gammaStabilityFactor(gamma) * GAMMA_FOG_BOOST_MAX;
          rhForFog = clamp(rhForGate + stabilityBoost, 0, 100);
        }

        temp10Frames[k][idx] = Number.isNaN(temp) ? -9999 : Math.round(temp * 10);
        humFrames[k][idx] = Number.isNaN(rh) ? -1 : Math.round(rh);
        fogFrames[k][idx] = calcFogRisk(temp, rhForFog);
      }
    }
  }

  return hourTimeKeys.map((timeKey, k) => ({
    timeKey,
    kind: "observed",
    temp10: temp10Frames[k],
    hum: humFrames[k],
    fog: fogFrames[k],
  }));
}

export async function generateKougenTenki() {
  const tile = getTileInfo(KOUGEN_TENKI_REGION);

  const [{ alt, gw, gh }, tableStations, latestTimeText] = await Promise.all([
    buildAltGrid(tile, ZOOM),
    loadAmedasTable(KOUGEN_TENKI_REGION),
    fetchText(`${AMEDAS_BASE}/data/latest_time.txt`).then((r) => r.body.trim()),
  ]);

  const latestMs = parseJstIsoAsFakeUtc(latestTimeText);


  // 信州大学 山岳観測所の取得は廃止した(気温逓減率は、アメダス・犬山自動気象観測所だけから求める)
  const shinshuLapseStations = [];
  const inuyamaAwsResult = await fetchInuyamaAwsStation();
  const inuyamaAwsStation = inuyamaAwsResult.station;
  const inuyamaAwsError = inuyamaAwsResult.error;

  const hourOffsets = Array.from({ length: HOURS_COUNT }, (_, i) => i).reverse();
  const hours = [];
  const observedPerHourStations = [];
  const observedHourTimeKeys = [];
  let latestStations = [];

  for (const i of hourOffsets) {
    const t = latestMs - i * 3_600_000;
    const obsStations = await fetchAmedasObsAt(t, tableStations);
    if (!obsStations || obsStations.length < 4) continue;

    if (i === 0 && inuyamaAwsStation) obsStations.push(inuyamaAwsStation);

    observedPerHourStations.push(obsStations);
    observedHourTimeKeys.push(formatDisplayTime(t));
    latestStations = obsStations;
  }

  const observedFrames =
    observedPerHourStations.length > 0
      ? computeObservedGridFramesFast(tile, alt, gw, gh, observedPerHourStations, observedHourTimeKeys, shinshuLapseStations)
      : [];
  hours.push(...observedFrames);

  if (hours.length === 0) {
    throw new Error("有効なアメダス観測値が得られず、気象情報を生成できませんでした");
  }

  // 未来12時間の「予測」(Open-Meteoの予報・実測トレンドの延長)は廃止した。過去12時間〜現在の実況の推定だけを返す
  // (アプリが自分で予報を作らない。「openmeteoの演算からの削除」「未来は削除し実況のみ」への対応)
  const openMeteoError = null;

  return {
    zoom: ZOOM,
    xMin: tile.xMin,
    yMin: tile.yMin,
    pixelW: (tile.xMax - tile.xMin + 1) * 256,
    pixelH: (tile.yMax - tile.yMin + 1) * 256,
    step: GRID_STEP,
    gw,
    gh,
    alt,
    hours,
    stations: latestStations.map((s) => ({
      name: s.name,
      id: s.id,
      lat: s.lat,
      lon: s.lon,
      alt: s.alt,
      temp: s.temp,
      humidity: s.humidity,
    })),
    generatedAt: formatDisplayTime(latestMs),
    openMeteoError,
    inuyamaAwsError,
  };
}

// ---------------------------------------------------------------
// 7. 「現在の気温の推定値のみ」を表示する軽量ボタン用の生成関数
// ---------------------------------------------------------------

/**
 * 「高層天気とは別に 現在の気温の推定値のみを表示するボタンを追加してほしい」
 * 「現在の気温は表示できるようにしてください」(Android版)への対応。
 * `server/kougenTenkiGenerate.mjs`の`generateCurrentTemperature`のネイティブ版
 * (ロジックは完全に同一。I/O層のみこのファイル内の他の関数と同様に置き換えている)。
 */
export async function generateCurrentTemperature() {
  const region = CURRENT_TEMP_REGION;
  const tile = getTileInfo(region);

  const [{ alt, gw, gh }, tableStations, latestTimeText] = await Promise.all([
    buildAltGrid(tile, region.zoom),
    loadAmedasTable(region),
    fetchText(`${AMEDAS_BASE}/data/latest_time.txt`).then((r) => r.body.trim()),
  ]);
  const latestMs = parseJstIsoAsFakeUtc(latestTimeText);

  // 道路情報提供システムの道路気象観測局は使わない(2026年10月廃止。ファイル先頭のコメント参照)
  const [amedasStations, inuyamaAwsResult] = await Promise.all([
    fetchAmedasObsAt(latestMs, tableStations),
    fetchInuyamaAwsStation(),
  ]);
  // 信州大学 山岳観測所・Open-Meteoの高層データ(800/700hPa)は使わない(廃止)。気温・湿度の逓減率は地上の観測所だけから求める
  const shinshuLapseStations = [];
  const upperAirLapseSamples = [];

  if (!amedasStations || amedasStations.length < 4) {
    throw new Error("有効なアメダス観測値が得られず、気温を計算できませんでした");
  }

  const stations = [...amedasStations];
  if (inuyamaAwsResult.station) stations.push(inuyamaAwsResult.station);

  const frame = computeGridFrame(
    tile,
    alt,
    gw,
    gh,
    stations,
    shinshuLapseStations,
    null,
    null,
    region.zoom,
    upperAirLapseSamples,
    CURRENT_TEMP_HUM_LAPSE_BIAS,
  );

  return {
    zoom: region.zoom,
    xMin: tile.xMin,
    yMin: tile.yMin,
    pixelW: (tile.xMax - tile.xMin + 1) * 256,
    pixelH: (tile.yMax - tile.yMin + 1) * 256,
    step: GRID_STEP,
    gw,
    gh,
    alt,
    hours: [{ timeKey: formatDisplayTime(latestMs), kind: "observed", ...frame }],
    stations: stations.map((s) => ({
      name: s.name,
      id: s.id,
      lat: s.lat,
      lon: s.lon,
      alt: s.alt,
      temp: s.temp,
      humidity: s.humidity,
    })),
    generatedAt: formatDisplayTime(latestMs),
    roadStationCount: 0,
    upperAirLapseSampleCount: upperAirLapseSamples.length,
    openMeteoError: null,
    inuyamaAwsError: inuyamaAwsResult.error,
  };
}
