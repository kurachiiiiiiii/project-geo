// 「高原天気」気温・霧シミュレーターのライブ生成。
// 元は C:\Users\krctk\Desktop\高原天気 の Java製ツール(Tenki.java)の計算ロジックを
// Node(サーバーレス関数から呼べる形)に移植したもの。以下は元実装からの意図的な簡略化:
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
//   - 上空(850/700hPa)観測は取得しない。霧判定は地上の推定湿度・露点差のみで決めており、
//     上空データへの依存が無い(元Javaの`calcFogRisk`相当のロジックは移植済み。詳細は後述)。
// 【スマホ版での廃止(2026年10月)】「openmeteoの演算からの削除」「信州山の環境研究のカメラと気象情報取得も削除」
// 「(高原天気の未来12時間は)未来は削除し実況のみ」への対応で、未来12時間の「予測」(Open-Meteoの予報・実測トレンドの延長)、
// 「現在の気温」のOpen-Meteoの高層データ(800/700hPa)、信州大学 山岳観測所の取得を取り除いた(PC版はそのまま)。
// 過去12時間〜現在の実況の推定だけを作る(アプリが自分で予報を作らない)。
// vite.config.ts (dev/preview) と api/kougen-tenki-generate.js (Vercel本番) の両方から読み込む。
import fs_promises from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import https from "node:https";

const LAT_MIN = 35.1;
const LAT_MAX = 37.05;
const LON_MIN = 136.2;
const LON_MAX = 138.7;
const ZOOM = 11;
const GRID_STEP = 16;

/** 高原天気(上記)の対象範囲・DEMズームを1つのオブジェクトにまとめたもの。GRID_STEPは両者で共通。 */
const KOUGEN_TENKI_REGION = { zoom: ZOOM, latMin: LAT_MIN, latMax: LAT_MAX, lonMin: LON_MIN, lonMax: LON_MAX };

/**
 * 「現在の気温」用の拡大対象範囲(「現在気温の推定の際は エリアを 陸上の本土5島まで
 * 範囲を拡大してください」への対応。全国(本土5島)は計算量(セル数×観測点数のIDW補間)が
 * 現実的でないため、「東海地方より東に範囲を限定すれば可能か」という提案を受け、
 * 中部+関東+東北+北海道(概ね東海地方より東側)に限定した)。
 *
 * 境界は各地方の実際の範囲(北海道: 宗谷岬45.52°N・納沙布岬145.82°E、中部: 伊豆半島南端
 * 34.6°N、中部西端(岐阜・福井県境付近)136.2°E=高原天気のLON_MINと同じ)に、近畿地方
 * (大阪135.5°E・京都135.7°E等)を含めない程度の余裕を持たせて決めた。
 *
 * 【DEMズームの変遷】当初は高原天気の小さい高解像度範囲(zoom11・約1km間隔)とは別に、
 * 範囲が約12倍(緯度経度の面積比)に広がることに合わせてDEMズームを9まで落とし
 * (約3.5〜4km間隔)、タイル数・グリッドセル数を高原天気と同程度(高原天気57,600セルに
 * 対し84,480セル)に抑えていた。「気温予測の解像度を2倍にすることはできる? 処理時間は
 * 構いません」という指示を受け、処理時間を犠牲にしてでも解像度を優先する方針に変更し、
 * ズーム10(約1.75〜2km間隔、セル数は面積比でおよそ4倍)まで上げた。処理時間が延びる分は
 * `api/current-temperature-generate.js`のmaxDuration(300秒)の範囲内に収まることを
 * 実測で確認している(README参照)。
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
 * 名前のとおり山岳・高原地帯を対象にした気温分布のため、対象範囲(緯度35.1〜37.05度・
 * 経度136.2〜138.7度)の縁に含まれる海沿い・低地のアメダス観測所(標高20m以下)は、
 * 気候が大きく異なり気温分布(IDW補間・逓減率の推定)を歪める恐れがあるため、
 * 取得地点そのものから除外する(loadAmedasTable参照)。
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
 * 「高地の湿度が低いように感じられます」という指摘への対応。
 *
 * `gammaHum`(湿度の標高別逓減率)は、実在する観測所ペア(標高差`dz`。実測では最高でも
 * 標高1,300〜1,500m程度の観測所までしか無く、ペア自体はおおむねこの範囲内の標高差で
 * 作られている)から推定した「その範囲内での平均的な変化率」に過ぎない。しかし
 * `computeCellFast`はこの同じ変化率を、標高差が観測範囲をはるかに超える対象セル
 * (北アルプスの3,000m級の山頂など、実測ペアが存在しない標高)にまでそのまま線形に
 * 投影していたため、標高差が大きいセルほど(たとえgammaHumがわずかに正=標高が高いほど
 * 乾燥する方向の値でも)投影がどんどん効いてしまい、実測データに全く裏付けの無い
 * 標高域で不自然に低い(または不自然に高い)湿度を出してしまう恐れがあった
 * (線形回帰を学習範囲より大きく外挿すると誤差が拡大する、という典型的な問題)。
 * 投影に使う標高差だけをこの値で頭打ちにし(距離・標高差による重みwAltHum自体は
 * 実際の標高差のまま計算し、遠い観測所の影響力自体はこれまで通り小さくする)、
 * 実測ペアの標高差の範囲を大きく超えて外挿しすぎないようにする。
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
 * 湿度の標高別逓減率(gammaHum)専用の半径。「アメダスの湿度を周辺100キロの観測地点の
 * 標高と湿度を基に逓減率を計算するようにしてください」への対応で、気温(50km)より
 * 広い100kmに分離した。
 *
 * 背景: アメダスは湿度計を備える観測所が気温計より少なく、50km圏内では湿度ペアが
 * 1つも見つからないことが珍しくなかった(下記`estimateLapseRatesAtLon`の「既知の不具合と
 * 対策」参照)。この場合、以前は圏の制限そのものを撤廃して全サンプルから推定し直す
 * フォールバックで対応していたが、それでは近隣かどうかを問わず対象範囲全体の平均的な
 * 値になってしまい、局地性が失われる。50kmと無制限の中間として100kmを湿度専用の
 * 既定の圏内とすることで、通常はこの範囲内で局地的なペアが見つかるようにしつつ、
 * それでも見つからない極端に観測点の少ない地域向けにフォールバックは残す。
 */
const LAPSE_RADIUS_KM_HUM = 100;
const LAPSE_RADIUS_KM_HUM2 = LAPSE_RADIUS_KM_HUM * LAPSE_RADIUS_KM_HUM;

/**
 * 過去・未来それぞれ何時間分を生成するか(1時間刻み)。
 * 過去はHOURS_COUNT時間前〜現在(現在を含む)の実測、未来は現在の1時間後〜HOURS_COUNT時間後の
 * 予測(既定でOpen-Meteo、取得失敗時のみ直近の実測トレンドの単純外挿)を、合わせて
 * HOURS_COUNT*2 コマ生成する。「演算時間を24時間に延長してください」という指示により
 * 6→12に変更した(過去12時間+未来12時間=合計24時間ぶん)。
 */
const HOURS_COUNT = 12;

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const AMEDAS_BASE = "https://www.jma.go.jp/bosai/amedas";
const DEM_BASE = "https://cyberjapandata.gsi.go.jp/xyz/dem";

// DEMタイルは実質的に不変のデータなので、一度取得したら再利用する。
// Vercel(本番)はサーバーレス関数の永続ディスクが無いため /tmp を使う(ウォームインスタンス間でのみ有効、
// コールドスタート後は消える)。ローカル開発では server/cache 配下に永続保存されるので、
// 2回目以降の生成はDEM取得なしでほぼ即座に終わる。
const CACHE_DIR = process.env.VERCEL
  ? "/tmp/kougenTenkiDem"
  : path.join(process.cwd(), "server", "cache", "kougenTenkiDem");

function demCacheFile(z, x, y) {
  return path.join(CACHE_DIR, String(z), String(x), `${y}.txt`);
}

/**
 * URLの先頭で`http`/`https`モジュールを使い分ける。`encoding`(既定utf-8)は犬山AWS
 * (Shift_JIS配信)のように文字コードがutf-8でないソース向け(`server/externalProxy.mjs`の
 * `encoding`指定と同じ考え方。NodeのTextDecoderは主要文字コードを標準サポートしている)。
 *
 * 【既知の不具合と修正】信州大学 山岳観測所(`SHINSHU_BASE`)は以前HTTPS非対応でHTTP配信
 * だったが、2026年9月にHTTPS対応した(HTTPは301リダイレクトを返すのみになった)。
 * `fetchShinshuLapseStations`はステータスが200以外なら例外を投げず警告ログのみでこの
 * ステップを黙ってスキップする(「失敗しても生成全体を失敗させたくない」設計)ため、
 * SHINSHU_BASEを更新し忘れると、外向きにはエラーも出ないまま信州大学の観測所データ
 * (14地点、高標高の気温逓減率推定に使う)が使われなくなるだけ、という気付きにくい劣化に
 * なっていた(`server/externalProxy.mjs`の`shinshu`エントリと同じ原因)。
 */
function fetchText(url, encoding = "utf-8") {
  const mod = url.startsWith("https:") ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { headers: { "User-Agent": BROWSER_UA }, timeout: 20_000 }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const body = encoding === "utf-8" ? buf.toString("utf-8") : new TextDecoder(encoding).decode(buf);
        resolve({ status: res.statusCode ?? 502, body });
      });
    });
    req.on("timeout", () => req.destroy(new Error(`upstream timeout: ${url}`)));
    req.on("error", reject);
    req.end();
  });
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
 * この値のセルは`computeGridFrame`側でIDW補間そのものをスキップする(海洋部分は本来
 * DEMの標高別逓減率モデルの対象外でもあり、計算をスキップすることで正しさと速度の
 * 両方が向上する)。以前はこのセルも標高0として埋めていた(実在する海抜0m付近の陸地
 * (海岸平野等)と区別できていなかった)ため、`alt<=0`のセルが範囲拡大後の実測で全体の
 * 約79%(陸地は約21%)を占めていた。
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
      // "e"は国土地理院DEMタイルの「データなし」マーカーで、ほぼ海上を意味する。それ以外にも、
      // まれに数値化できない断片(通信途中で切れた応答など)が来ることがある。Number(v)がNaNの
      // まま標高グリッドに残ると、それを参照する道路情報の観測局
      // (fetchRoadWeatherStationsWithElevation)のaltがNaNになり、JSON.stringifyでnullに
      // 化けた末にポップアップの.toFixed()がクラッシュしていた(「小さい青の丸の点をクリック
      // すると なにも表示されなくなります」バグの根本原因の1つ)。どちらもALT_NO_DATA扱いにする。
      const n = Math.round(Number(v));
      sampled.push(v === "e" || v === "" || !Number.isFinite(n) ? ALT_NO_DATA : n);
    }
    rows.push(sampled);
  }
  return rows;
}

/** データが存在しないタイル(海上など)をキャッシュファイル上で表すマーカー */
const NO_DATA_MARKER = "NODATA";

function blankTileRows() {
  const perTile = 256 / GRID_STEP;
  return Array.from({ length: perTile }, () => Array.from({ length: perTile }, () => ALT_NO_DATA));
}

async function fetchDemTile(z, x, y) {
  const file = demCacheFile(z, x, y);
  try {
    const cached = await fs_promises.readFile(file, "utf-8");
    return cached === NO_DATA_MARKER ? blankTileRows() : sampleTileRows(cached);
  } catch {
    // キャッシュ無し。取得してから保存する。
  }

  const url = `${DEM_BASE}/${z}/${x}/${y}.txt`;
  const res = await fetchText(url);

  if (res.status !== 200 || !res.body.includes(",")) {
    // データが存在しない領域(海上など)。ALT_NO_DATAのタイルとしてキャッシュしておく
    // (毎回404を踏みに行かないようにするため)。
    await ensureDirAndWrite(file, NO_DATA_MARKER);
    return blankTileRows();
  }

  await ensureDirAndWrite(file, res.body);
  return sampleTileRows(res.body);
}

async function ensureDirAndWrite(file, content) {
  try {
    await fs_promises.mkdir(path.dirname(file), { recursive: true });
    await fs_promises.writeFile(file, content, "utf-8");
  } catch (e) {
    // 書き込み失敗(読み取り専用ファイルシステムなど)は致命的ではないので無視する。
    // 次回リクエストでまた取得し直すだけになる。
    console.warn(`kougenTenki: DEMキャッシュ書き込み失敗: ${file}: ${e}`);
  }
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

/**
 * 「気温観測地点を追加してください」という指示により追加した個人運用の自動気象観測所
 * (https://www.ma.ccnw.ne.jp/jan/ 、愛知県犬山市)。座標・標高はサイトのプロフィール表示
 * (北緯35度23.3分・東経136度59分.9分・標高130m)を書き写したもの(専用APIが無いため)。
 * ページはShift_JIS配信・1分ごとに現在値を更新するだけの単一地点表示で、過去の時系列は
 * 提供されていないため、実測12コマ(過去)のうち**最新(=現在時刻)のコマにのみ**追加する
 * (それより前のコマに"現在"の値を遡って使うと不正確なため)。取得・パースに失敗しても
 * 例外を投げず null を返し、追加無しで続行する(信州大学と同じ考え方)。
 */
const INUYAMA_AWS_URL = "https://www.ma.ccnw.ne.jp/jan/weather/main.html";
const INUYAMA_AWS_STATION = {
  id: "inuyama_aws",
  name: "犬山自動気象観測所",
  lat: 35 + 23.3 / 60,
  lon: 136 + 59.9 / 60,
  alt: 130,
};

/**
 * 犬山自動気象観測所の取得結果は`{station, error}`で返す(単に`null`を返すだけだと、
 * 生成後にUI側から「追加されたのか失敗したのか」を判別できず、「犬山の気温が追加されて
 * いません」という報告があっても原因を切り分けられなかったため)。成功時は
 * `{station: {...}, error: null}`、失敗時は`{station: null, error: "理由の文字列"}`。
 * `openMeteoError`と同じ考え方で`KougenTenkiGrid.inuyamaAwsError`としてAPIレスポンスに
 * 含め、UI側(KougenTenkiControl.tsx)で成功/失敗をその場で確認できるようにする。
 */
async function fetchInuyamaAwsStation() {
  try {
    const res = await fetchText(INUYAMA_AWS_URL, "shift_jis");
    if (res.status !== 200) {
      const error = `犬山自動気象観測所の取得に失敗しました (HTTP ${res.status})`;
      console.warn(`kougenTenki: ${error}`);
      return { station: null, error };
    }

    // 区切り文字は「：」(全角コロン)ではなく「；」(全角セミコロン)、℃ではなく「°C」
    // (度記号+C)で書かれている(見た目がよく似ているため、実際にShift_JISデコードした
    // テキストを確認して初めて気づいた)。念のため全角コロン・半角コロン・℃も許容しておく。
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

// km/度(緯度)はほぼ一定、km/度(経度)は緯度に応じて変わる。
const KM_PER_DEG_LAT = 110.574;
const KM_PER_DEG_LON_AT_EQUATOR = 111.32;

/**
 * グリッド計算のホットパス専用、正距円筒(equirectangular)近似による距離の2乗。
 * 対象範囲が南北2°×東西2.5°程度と狭いため、球面三角法(sin/cos/atan2)を使う正確な
 * Haversine距離の代わりにこの近似を使うと、ピクセル数×観測所数ぶん呼ばれるこの関数から
 * 三角関数呼び出しを事実上ゼロにでき(呼び出し側で緯度1行につき1回だけ cos を計算して渡す)、
 * 大幅に高速化できる。IDW補間の重み計算に使うだけなので、この程度の近似誤差(既存範囲内で
 * 最大でも数百m程度)は結果に実質的な影響を与えない。
 */
function distanceKm2Fast(dLat, dLon, kmPerDegLon) {
  const dy = dLat * KM_PER_DEG_LAT;
  const dx = dLon * kmPerDegLon;
  return dx * dx + dy * dy;
}

/**
 * 観測所の全ペアから、気温・湿度それぞれの標高別逓減率のサンプルを作る
 * (どちらも同じペア列挙・同じ距離/標高差フィルタを共用するため、1回のループでまとめて作る)。
 * 湿度は欠測(NaN)のことがあるため、`gammaHum`はどちらかが欠測なら`null`にする
 * (呼び出し側で湿度サンプルとしては使わない)。
 */
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

/**
 * 1グリッドセル分の気温・湿度・霧かさ上げ量をまとめて計算する。
 * 気温・湿度どちらも「距離ベースの重み(wDist)」の式が同じなので、観測所ごとの距離計算を
 * 1回にまとめて共用することで、単純に別関数で計算する場合の約半分の計算量にしている。
 * `gamma`(気温逓減率)・`gammaHum`(湿度の標高別逓減率)は、呼び出し側で(粗いサブグリッドで、
 * 対象地点から半径`LAPSE_RADIUS_KM`(気温50km)・`LAPSE_RADIUS_KM_HUM`(湿度100km)km以内の
 * 観測所ペアから)計算済みのものを受け取る(下記 buildGammaGrid / estimateLapseRatesAtLon の
 * コメント参照)。気温と同様に、
 * 湿度も観測所の実測値をそのまま補間するのではなく、`gammaHum`を使って観測所の標高から
 * 対象セルの標高(DEM由来)へ投影してから重み付け平均する
 * (「その逓減率を基にDEMにあてはめて気温と湿度の計算をしてください」という指示による)。
 *
 * `station.fogBoost`(任意、既定0)は、その観測点で最後に雨が降ってからの経過時間から求めた
 * 霧判定用の湿度かさ上げ量(%)。湿度と同じ重み(wHum)でIDW補間することで、雨上がりの
 * 地点の近くほどかさ上げが効くようにする(詳細は `rainFogBoostForHoursSinceRain` 付近の
 * コメント参照)。
 * アメダス実測の観測点オブジェクトには`fogBoost`フィールド自体が無いため、常に0として扱われ
 * 実測コマの結果には影響しない。
 */
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
      // 気温のpredと同じ考え方で、観測所の湿度をgammaHum(湿度の標高別逓減率)を使って
      // 対象セルの標高(DEM由来)へ投影してから重み付けする。ただし投影に使う標高差だけは
      // HUM_PROJECTION_MAX_ALT_DIFF_Mで頭打ちにする(実測ペアの標高差の範囲を大きく超えて
      // 外挿しすぎないようにするため。重みwAltHum自体は実際の標高差のまま計算するので、
      // 標高差が大きい観測所の影響力自体はこれまで通り小さい)。
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

/** 露点温度(℃)。Magnus式(元Java実装の `dewPointC()` と同じ) */
function dewPointC(tempC, rh) {
  const rhClamped = clamp(rh, 1, 100);
  const a = 17.62;
  const b = 243.12;
  const gamma = Math.log(rhClamped / 100) + (a * tempC) / (b + tempC);
  return (b * gamma) / (a - gamma);
}

/** 霧リスクが発生し始める湿度のしきい値(%)。「湿度97%から霧リスクありにしてください」という指示による */
const FOG_RH_THRESHOLD = 97;

/**
 * 気温・湿度から霧リスク(0〜1の段階値)を求める。元Javaツールにも実装されていたが
 * 既定では無効化されていた(`FOG_RH100_ONLY=true`。湿度が四捨五入で100%かどうかのみで判定)
 * 露点差(気温−露点)による判定を、このNode移植では有効にしている。
 *
 * 湿度が`FOG_RH_THRESHOLD`(97%)以上なら必ず何らかのリスクを返す(湿度がこのしきい値を
 * 超えているのに露点差が原因でリスク0になる、という以前の挙動を修正)。気温と露点の差
 * (spread)が小さいほど霧が発生しやすいため、spreadは段階を上げる方向にだけ働く
 * (下げる=リスクを打ち消す方向には使わない)。
 */
function calcFogRisk(tempC, rh) {
  if (Number.isNaN(tempC) || Number.isNaN(rh) || rh < FOG_RH_THRESHOLD) return 0;

  const dew = dewPointC(tempC, rh);
  const spread = tempC - dew;

  if (rh >= 100 || spread <= 0.3) return 1.0;
  if (rh >= 99 || spread <= 0.8) return 0.6;
  return 0.3; // rh は FOG_RH_THRESHOLD(97%)以上
}

/**
 * 対象地点(lat, lon, alt)における気温・湿度の標高別逓減率を、周辺の観測所ペア
 * (`lapseSamples`)から推定する。「周辺50キロ圏内のものを計算して出す」という指示により、
 * 気温(gamma)は対象地点から半径`LAPSE_RADIUS_KM`(50km)以内のペアだけを使う
 * (圏外のペアは無視する)。
 *
 * 湿度(gammaHum)は「アメダスの湿度を周辺100キロの観測地点の標高と湿度を基に逓減率を
 * 計算するようにしてください」という指示により、気温より広い半径`LAPSE_RADIUS_KM_HUM`
 * (100km)を使う(下記「既知の不具合と対策」参照)。気温・湿度は同じ距離・標高差の
 * 重み(wDist・wAlt)を共用するため、d2の計算自体は1回のループでまとめて行い、
 * それぞれの半径に収まっているかだけを別々に判定する。
 *
 * **既知の不具合と対策: 実測コマ(アメダス)で湿度の逓減率がうまく推定できていなかった**。
 * アメダスは湿度計を備える観測所が気温計より少なく、対象範囲・50km圏内であっても
 * 湿度ペアが1つも見つからないことが珍しくなかった(Open-Meteo予報コマは全地点が
 * 常に湿度を持つため、この問題は実測コマ特有だった)。気温より広い100km圏を湿度専用に
 * 設けることで、通常はこの範囲内で湿度ペアが見つかるようになった。それでも100km圏内に
 * 湿度ペアが1つも無い場合のみ、圏の制限を外して全サンプルを対象に(距離減衰の重みは
 * 効かせたまま)湿度の逓減率を推定し直す(気温は50km圏内縛りのまま。圏内にペアそのものが
 * 無ければ標準大気`GAMMA_STD`にフォールバックする)。それでも湿度ペアが1つも無ければ、
 * 標高による変化なし(0)にフォールバックする。
 */
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

  // 100km圏内に湿度ペアが1つも無かった場合のみ、圏の制限を外して全サンプルから
  // 推定し直す(距離減衰の重み付けはそのまま効くため、近いペアほど影響は大きい)。
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

  // 「800hPa・700hPaの湿度を追加で200キロメッシュごとに取得して 湿度の逓減率も
  // 計算してください」への対応(fetchUpperAirLapseSamples参照)。地上観測所ペア(境界層内、
  // 上でLAPSE_RADIUS_KM_HUM=100km圏に限定)とは別のスケールの、自由対流圏の湿度勾配を表す
  // 高層データを、地上ペアの有無に関わらず常に距離・標高差で重み付けして混ぜる(気温=gammaは
  // 対象外。指示が湿度に限られているため、既存の地上ペアのみから求めた値をそのまま使う)。
  // 半径の制限は設けない(メッシュ間隔自体が100kmよりずっと粗いため、圏内縛りにすると
  // 常にゼロ件になってしまう)。
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

/** 気温・湿度の標高別逓減率を計算するサブグリッドの間引き間隔(グリッドセル単位) */
const LAPSE_GRID_STRIDE = 8;

/**
 * 気温・湿度の標高別逓減率を、フルの計算グリッドより粗いサブグリッド上でだけ計算し、
 * 最近傍のサブグリッド点の値をそのまま使い回すためのルックアップを作る。
 *
 * 逓減率の重み関数(距離の2乗+20 [km²]、標高差/700 [m]の指数減衰、半径50km圏内)はもともと
 * 数km〜数十kmスケールでなだらかに変化する量で、フルグリッド(zoom11・GRID_STEP=16で
 * 約1.2km間隔)ほどの解像度は本来不要。逓減率の計算はグリッドセル数に比例するコストがかかり
 * (全観測所ペアの逓減率サンプルをなめる必要がある)、実測でも気温・湿度本体の計算より
 * 重かったため、この間引きだけでライブ生成の所要時間を大きく短縮できた。
 */
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

/**
 * 「霧リスクを標高データも駆使して気温の逓減率も考慮したものにしてください」という指示を
 * 受けて追加した、気温逓減率を使った霧リスクの補正。
 *
 * 当初は地形(標高)から求めた「谷・盆地度」による補正も実装していた(周囲より低い地点ほど
 * 冷気がたまりやすく霧が出やすい、という考え方。元Javaツールにも同種の未使用関数
 * `valleyFactor()`があった)が、「谷盆地のブーストは削除してください」という指示により
 * 撤去した。
 */

/** 気温逓減率(gamma)の「標準大気からのズレ(安定側・逆転層寄りかどうか)」を
 *  霧判定にどれだけ反映するか(判定に使う湿度換算、%) */
const GAMMA_FOG_BOOST_MAX = 10;
/**
 * 標高がこの値(m)以下のセルは、霧判定用の湿度を`LOW_ALT_FOG_PENALTY_PCT`だけ
 * かさ下げする。「霧リスクは標高100m以下は1%減らす演算にしてください」という指示による。
 */
const LOW_ALT_FOG_PENALTY_THRESHOLD_M = 100;
const LOW_ALT_FOG_PENALTY_PCT = 1;

/**
 * 気温逓減率(gamma)が標準大気(`GAMMA_STD`)よりどれだけ安定側(逆転層に近い、
 * =`GAMMA_MIN`寄り)かを0〜1で表す。地表付近の気温が上空とあまり変わらない
 * (もしくは上空の方が暖かい=接地逆転)ほど大気が安定し、霧が発生・維持されやすいという
 * 傾向の簡易的なモデル化。gammaが標準以上(=`GAMMA_STD`以上、対流混合が強い)なら0を返す。
 */
function gammaStabilityFactor(gamma) {
  if (gamma >= GAMMA_STD) return 0;
  return clamp((GAMMA_STD - gamma) / (GAMMA_STD - GAMMA_MIN), 0, 1);
}

/**
 * 「上昇流があり山に風があたる場合、標高差が300m/1km以上の場所で霧の発生確率を2%上げて
 * ください。同じ条件で風向が山から下に降りる場合は霧の確立を1%下げてください」という
 * 指示による、地形の傾斜と風向を組み合わせた霧リスク補正(地形性上昇流・吹き下ろしの
 * 簡易的なモデル化)。
 *
 * - 傾斜(標高の変化率)が急な地点(`SLOPE_GRADIENT_THRESHOLD_M_PER_KM`=300m/km以上)でのみ
 *   働く。グリッド1マスがおよそ1〜1.2km間隔なので、隣接セルとの標高差がそのまま
 *   「m/km」の近似値として使える。
 * - 風が「谷側から尾根側へ」吹いている(=斜面に正面から吹き付け、強制的に上昇気流が
 *   生まれて雲・霧が発生しやすい、いわゆる地形性上昇流)とみなせる場合に+2%。
 * - 風が「尾根側から谷側へ」吹いている(=斜面を吹き下ろし、下降気流による断熱圧縮で
 *   乾燥・霧が消えやすい)とみなせる場合に-1%。
 * - 風の情報はOpen-Meteo予報コマにしかない(アメダス実測・信州大学・犬山AWSはいずれも
 *   風を取得していない)ため、この補正が効くのは予測コマのみ。
 */
const SLOPE_GRADIENT_THRESHOLD_M_PER_KM = 300;
/** 風の吹いてくる方角が、斜面の傾斜方向(または真逆)からこの角度以内なら「正面から吹き付け/吹き下ろし」とみなす */
const OROGRAPHIC_ANGLE_TOLERANCE_DEG = 60;
/** これ未満の風速(m/s)は「風があたる」とみなさない(無風に近いと方角自体が無意味なため) */
const OROGRAPHIC_MIN_WIND_SPEED_MS = 1.5;
const OROGRAPHIC_UPSLOPE_BOOST_PCT = 2;
const OROGRAPHIC_DOWNSLOPE_PENALTY_PCT = 1;


/** 角度差(0〜180°)を返す(方位角どうしの、向きを問わない最短角度差) */
function angularDiffDeg(a, b) {
  let d = Math.abs(a - b) % 360;
  if (d > 180) d = 360 - d;
  return d;
}



/**
 * 傾斜(m/km)・傾斜方位・風向風速から、霧リスクへの地形性の補正を求める。
 * `boost`(上昇流による加算、ゲート通過後にのみ効かせる)と`penalty`(吹き下ろしによる
 * 減算、ゲート判定にも先に効かせてよい)を分けて返す(「湿度95%でも霧リスクが有りになって
 * いた」不具合の教訓により、リスクを上げる方向の補正はゲート通過後にのみ適用する設計を
 * 踏襲している。下げる方向の補正はゲート前に適用しても安全なため先に効かせる)。
 */
function orographicFogAdjustment(slopeMagnitudePerKm, slopeAspectDeg, wind) {
  if (slopeMagnitudePerKm < SLOPE_GRADIENT_THRESHOLD_M_PER_KM) return { boost: 0, penalty: 0 };
  if (!wind || wind.windSpeedMs < OROGRAPHIC_MIN_WIND_SPEED_MS) return { boost: 0, penalty: 0 };

  // 「風があたる(上昇流)」= 風が谷側(下り坂の向き=aspect)から吹いてきて斜面に正面衝突する。
  const diffToUpslope = angularDiffDeg(wind.windDirDeg, slopeAspectDeg);
  if (diffToUpslope <= OROGRAPHIC_ANGLE_TOLERANCE_DEG) {
    return { boost: OROGRAPHIC_UPSLOPE_BOOST_PCT, penalty: 0 };
  }
  // 「山から下に降りる」= 風が尾根側(aspectの真逆=上り坂の向き)から吹いてきて斜面を吹き下ろす。
  const diffToDownslope = angularDiffDeg(wind.windDirDeg, (slopeAspectDeg + 180) % 360);
  if (diffToDownslope <= OROGRAPHIC_ANGLE_TOLERANCE_DEG) {
    return { boost: 0, penalty: OROGRAPHIC_DOWNSLOPE_PENALTY_PCT };
  }
  return { boost: 0, penalty: 0 };
}

// ---------------------------------------------------------------
// 6. 生成本体
// ---------------------------------------------------------------

/**
 * 観測所の状態からグリッド1コマ分(気温×10・湿度・霧リスク)を計算する。
 *
 * `extraLapseStations`(信州大学山岳観測所など)は気温逓減率(gamma)の推定にだけ使い、
 * 気温・湿度そのもののIDW補間(`computeCellFast`)には混ぜない(指示により対象を限定)。
 *
 * このセルのgamma(気温逓減率)が標準大気よりどれだけ安定側(逆転層寄り)かを
 * `gammaStabilityFactor()`で霧リスクの判定に加味する(「霧リスクを標高データも駆使して
 * 気温の逓減率も考慮したものにしてください」という指示。谷・盆地度による地形補正も
 * 当初は実装していたが、「谷盆地のブーストは削除してください」という指示により撤去した)。
 *
 * `slopeGrid`(`buildSlopeGrid`。地形のみから決まり時刻に依存しないため呼び出し側で1回だけ
 * 計算して使い回す)・`windGrid`(`buildWindGrid`。風はOpen-Meteo予報コマにしか無いため、
 * それ以外のコマではnullを渡す)が両方揃っている場合のみ、地形性上昇流・吹き下ろしによる
 * 霧リスク補正(`orographicFogAdjustment`)を効かせる。
 */
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
    // 経度1度あたりのkm換算は緯度に依存するが、同じ行(緯度)内では一定なので1回だけ計算する
    // (ホットパスの三角関数呼び出しを大幅に減らすための最適化。distanceKm2Fast 参照)。
    const kmPerDegLon = KM_PER_DEG_LON_AT_EQUATOR * Math.cos((lat * Math.PI) / 180);

    for (let gx = 0; gx < gw; gx++) {
      const lon = tileXtoLon(tile.xMin + (gx * GRID_STEP) / 256, zoom);
      const idx = gy * gw + gx;
      const a = alt[idx];

      // 「海の部分は計算しなくて大丈夫です」への対応。海上(DEMの"e"=データ無し)のセルは
      // IDW補間そのものをスキップする(観測点数ぶんの距離計算がまるごと不要になるため、
      // 海の割合が大きい対象範囲ほど効果が大きい。「現在の気温」の拡大範囲では実測で
      // 全体の約79%が該当した)。欠測と同じ値(-9999/-1)を入れておけば、クライアント側
      // (lookupKougenTenkiValue・renderKougenTenkiDataUrl)は既存の欠測判定でそのまま
      // 「対象範囲外」「透明(色を塗らない)」として扱ってくれる。
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

      // 表示用の湿度(hum)自体はかさ上げしない。霧リスクの判定は2段階で行う。
      //
      // 【既知の不具合と修正】以前は「生の湿度」に雨・逓減率のかさ上げをすべて加算した
      // 値をそのまましきい値判定に使っていたため、生の湿度が97%未満(例: 95%)でも、
      // 逓減率(逆転層)のブーストだけで97%を超えてしまい、「湿度95%なのに霧リスクあり」に
      // 見えるケースがあった。「湿度が95%でも霧リスクが有りになっているのを修正してください」
      // という指摘を受け、①まずゲート判定(97%のしきい値)は生の湿度(標高100m以下の1%かさ下げ・
      // 地形の吹き下ろしによる1%かさ下げのみ反映。どちらもリスクを下げる方向の補正なので、
      // ゲート自体を通過しやすくする心配が無い)で行い、②ゲートを通過した場合に限り、
      // 雨・逓減率・地形性上昇流のブーストで霧リスクの段階(0.3/0.6/1.0)を押し上げる、
      // という順序に変更した。
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

/**
 * `perHourStations`(実測12時刻ぶん、それぞれ`fetchAmedasObsAt`が返す配列)を、
 * 「観測所1件につき12時刻ぶんの気温・湿度配列を持つ」形にまとめ直す。
 * `mergeForecastStationsAcrossHours`(Open-Meteo予報コマ、5b節)と同じ考え方だが、
 * アメダス観測所は緯度経度ではなく安定した観測所コード(`id`)を持つため、そちらをキーにする。
 *
 * アメダス実測はOpen-Meteo予報と異なり、時刻によって観測所が有効/無効(その時刻に気温を
 * 取得できたかどうか)で出入りする(`fetchAmedasObsAt`が該当時刻に値の無い観測所を配列から
 * 除外するため)。また犬山自動気象観測所(3c節)は最新コマにしか含まれない。
 * どちらも「その時刻の配列にその観測所が存在しない」という形で表れるため、`id`をキーにして
 * 無い時刻はNaNのままにしておく、という`mergeForecastStationsAcrossHours`と同じ仕組みで
 * そのまま扱える。
 */
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

/**
 * 実測(アメダス)有効時刻ぶんのグリッドをまとめて計算する。
 *
 * 【最適化: 観測コマのグリッド計算を、Open-Meteo予報コマ(5b節・`generateOpenMeteoForecastFrames`)
 * と同じ考え方で高速化】
 * 「高層天気の処理時間を短縮することはかのうでしょうか」という指摘を受けて実際に計測したところ、
 * 生成全体(未キャッシュ時、約4分42秒)のうち観測12コマぶんのグリッド計算だけで約15.4秒
 * かかっていた(Open-Meteo取得の約4分25秒に比べれば小さいが、Open-Meteoの結果は24時間
 * キャッシュされるため、キャッシュ命中時はこの観測コマの計算がほぼ全体を占める)。
 * 原因は`generateOpenMeteoForecastFrames`最適化前と全く同じで、`computeGridFrame`を
 * 時刻ごとに独立して(=12回)呼んでいたため、`computeCellFast`が持つ距離・標高差ベースの
 * 重み(wTemp/wHum。Math.exp()を含み最も重い部分)がセル×観測所の組み合わせごとに12回
 * 計算されていた。しかし観測所の位置は12時刻を通して変わらない(値=気温・湿度・在/不在
 * だけが時刻ごとに異なる)ため、重みを1回だけ計算して12時刻ぶんへの加算だけをその場で
 * まとめて行うようループを再構成した(`mergeObservedStationsAcrossHours`で観測所を
 * 12時刻ぶんの値配列を持つ形に束ね、セルのループの中で観測所ごとに重みを1回計算してから
 * 12時刻ぶん加算する)。地形逓減率(gamma/gammaHum)は時刻ごとに異なる値を使うため
 * (`computeGridFrame`と同じ考え方)、時刻ごとのgammaGridは従来どおり時刻ごとに作る
 * (粗いサブグリッドのみの計算で元々軽く、ボトルネックではない)。
 * 数値としては元の実装(`computeGridFrame`を時刻ごとに独立に呼ぶ)と同じ計算式をそのまま
 * 踏襲しており、重複計算を無くすための高速化であって挙動を変えるものではない
 * (実際に全セル・全コマで結果が完全一致することを確認済み。README参照)。
 *
 * アメダス実測コマには風の情報が無いため、地形性上昇流・吹き下ろしの補正(orographic)は
 * 常に効かせない(`computeGridFrame`にwindGridを渡さない場合と同じ挙動)。同様にfogBoost
 * (雨上がりの霧かさ上げ)もアメダス実測の観測点オブジェクトには存在しないため常に0として
 * 扱う(`computeCellFast`の`s.fogBoost ?? 0`と同じ挙動)。
 */
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

  // セルごとに使い回す、時刻別の一時累積バッファ(Float64Array。GC負荷を抑えるためループの外で確保)
  const tempSum = new Float64Array(hoursN);
  const tempWsum = new Float64Array(hoursN);
  const humSum = new Float64Array(hoursN);
  const humWsum = new Float64Array(hoursN);
  // そのセルの、時刻ごとのgamma/gammaHum(観測所のループに入る前に1回だけ取り出しておく。
  // 【既知の非効率と修正】当初`gammaGrids[k].get(gx, gy)`を観測所のループの内側(=観測所数×
  // 12時刻ぶん)で呼んでいたところ、`.get()`はオブジェクトを新規に割り当てるため、その回数が
  // 観測所数(100〜160件程度)倍に増え、GC負荷が重みの使い回しによる削減分を大きく相殺して
  // しまい、狙ったほどの高速化にならなかった(実測: 14.3秒。旧実装の15.2秒からほぼ変わらず)。
  // `.get()`はセル×時刻ごとに1回で足りるため(値はどの観測所についても同じ)、観測所ループの
  // 外側で1回だけ呼んでプレーンな配列に取り出しておくよう修正した。)
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
        // ここから4行(距離・標高差ベースの重み)が、複数時刻ぶん使い回せる「重い」計算部分。
        const d2 = distanceKm2Fast(lat - s.lat, lon - s.lon, kmPerDegLon);
        const wDist = 1 / (d2 + 8);
        const altDiff = Math.abs(a - s.alt);
        const wTemp = wDist * Math.exp(-altDiff / 1000);
        const wHumBase = wDist * Math.exp(-altDiff / 700) * (s.alt >= 1800 && a >= 1800 ? 2.2 : 1.0);
        // 「高地の湿度が低いように感じられます」への対応(HUM_PROJECTION_MAX_ALT_DIFF_Mの
        // コメント参照)。湿度の標高投影に使う標高差だけを頭打ちにする(重みwHumBase自体は
        // 実際の標高差altDiffのまま)。
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

  const hourOffsets = Array.from({ length: HOURS_COUNT }, (_, i) => i).reverse(); // 古い→新しい順
  const hours = [];
  const observedPerHourStations = []; // computeObservedGridFramesFast に渡す、有効な時刻ぶんの観測所配列
  const observedHourTimeKeys = []; // 同上、有効な時刻ぶんのtimeKey(observedPerHourStationsと1:1対応)
  let latestStations = [];

  for (const i of hourOffsets) {
    const t = latestMs - i * 3_600_000;
    const obsStations = await fetchAmedasObsAt(t, tableStations);
    if (!obsStations || obsStations.length < 4) continue; // データ不十分な時刻はスキップ

    // 犬山自動気象観測所は現在値のみ提供のページのため、最新(=現在時刻)のコマにのみ加える
    // (i===0が最新。3c節のコメント参照)。
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

// 道路情報提供システムの道路気象観測局(fetchRoadWeatherStationsWithElevation)は、スマホ版では使わない
// (2026年10月廃止。配信元の「ご利用に際して」に「国土交通省に無断で転載等を行うことはできません」とあるため)。

/**
 * 「高層天気とは別に 現在の気温の推定値のみを表示するボタンを追加してほしい」への対応。
 *
 * `generateKougenTenki`と同じDEM地形補正+標高別逓減率+IDW補間のロジック(`computeGridFrame`)
 * をそのまま使うが、以下の点で意図的に軽量化している:
 * - 過去12時間・未来12時間ぶんの複数コマではなく、「現在」1コマだけを計算する
 *   (Open-Meteo予報は使わないため、未キャッシュ時に数分かかることもない)
 * - 湿度・霧リスクも`computeGridFrame`の戻り値に含まれるため(気温と同じ経路で計算する方が
 *   実装が単純)、クライアント側(`CurrentTemperatureLayer.tsx`等)でも気温と同様に表示する
 * - (道路情報提供システムの観測局・信州大学山岳観測所は、スマホ版では使わない(廃止))。
 * - 「現在気温の推定の際は エリアを 陸上の本土5島まで 範囲を拡大してください」への対応として、
 *   高原天気より広い`CURRENT_TEMP_REGION`(中部+関東+東北+北海道、DEMズーム9)を対象とする。
 *   高原天気(小さく高解像度な範囲)とは完全に独立した範囲・DEMズームで計算するため、
 *   このファイルの主要な関数(`getTileInfo`・`buildAltGrid`・`buildGammaGrid`・
 *   `computeGridFrame`・`loadAmedasTable`)はすべて対象範囲・ズームを引数で受け取る形に
 *   なっている(`generateKougenTenki`は`KOUGEN_TENKI_REGION`を、こちらは
 *   `CURRENT_TEMP_REGION`を渡す。共有するのは関数のロジックのみで、実際の計算結果は
 *   完全に分離されている)。
 *
 * レスポンスは`KougenTenkiGrid`型と同じ形(`hours`配列の要素数が1)にしているため、
 * クライアント側は`kougenTenkiGrid.ts`の各関数(`renderKougenTenkiDataUrl`・
 * `lookupKougenTenkiValue`・`kougenTenkiBounds`)をそのまま再利用できる。
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
