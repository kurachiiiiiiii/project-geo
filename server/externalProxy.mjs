// 複数の外部サイト(CORS非対応)への汎用プロキシ。
// vite.config.ts (dev/preview) と api/ext/[source].js (Vercel本番) の両方から読み込む。
// 新しいデータソース(将来追加する都道府県サイトなど)は EXTERNAL_SOURCES に追記するだけでよい。
//
// 「確認して 規約違反の機能やライブカメラは削除してください」への対応で、都道府県公式サイトの
// 著作権ページに「無断で複製・転用することはできません」等の明記があったライブカメラ
// (岐阜県・石川県・島根県・群馬県・福井県・富山県)は EXTERNAL_SOURCES から削除した
// (岐阜県専用の server/gifuProxy.mjs も削除)。詳細はREADME.md参照。
import http from "node:http";
import https from "node:https";

// 一部のサイト(川の防災情報など)はブラウザ以外のUser-Agentを403で弾くため、
// 既定でブラウザ相当のUAを名乗る。
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

// 「川の防災情報」のカメラ(kawabou・kawabouCam)と「道路情報提供システム」の道路気象(roadKisho)は、
// スマホ版では廃止した(2026年10月)。川の防災情報には都道府県が管理するカメラ(国以外の第三者の権利)も
// 含まれ、道路情報提供システムは「国土交通省に無断で転載等を行うことはできません」としているため
// (README「法令適合・著作権の確認(2026年10月)」参照)。

export const EXTERNAL_SOURCES = {
  jmaVolcam: {
    origin: "https://www.data.jma.go.jp",
    // 火山監視カメラ一覧(geojson)と、個別カメラの詳細ページ(HTML, 最新画像ファイル名を含む)
    allow: (path) =>
      /^\/vois\/data\/obs\/volcam\/param\/geojson\/cam(name|icon)\.geojson$/.test(path) ||
      /^\/vois\/data\/obs\/volcam\/volcam\.php\?VC=\d+$/.test(path),
  },
  jmaProb: {
    origin: "https://ds.data.jma.go.jp",
    // 「紅葉マップ」の長期予報(気温の平年差)への対応。気象庁「確率予測資料」の2週間気温予報・
    // 1か月予報のCSV(地域番号は2桁)。CORS未対応のためプロキシが必要
    // (`src/features/koyo/koyoForecast.ts`参照)。
    allow: (path) =>
      /^\/risk\/probability\/guidance\/download2w\.php\?2week_t_\d{2}\.csv$/.test(path) ||
      /^\/risk\/probability\/guidance\/download\.php\?month1_t_\d{2}\.csv$/.test(path),
  },
  gsiReverseGeocode: {
    origin: "https://mreversegeocoder.gsi.go.jp",
    // 「天文情報を表示する際 座標ではなく おおまかな住所を表示してください」への対応。
    // 国土地理院の逆ジオコーディングAPI(緯度経度→市区町村コード+大字名)。CORS未対応の
    // ためプロキシが必要(`src/features/geocode/reverseGeocodeService.ts`参照)。
    allow: (path) => /^\/reverse-geocoder\/LonLatToAddress\?lat=-?\d{1,3}(\.\d+)?&lon=-?\d{1,3}(\.\d+)?$/.test(path),
  },
  inuyama: {
    origin: "https://www.ma.ccnw.ne.jp",
    // 犬山自動気象観測所(https://www.ma.ccnw.ne.jp/jan/)の現在値ページ。CORS未対応の
    // ためプロキシが必要。ページはShift_JISなので、UTF-8へデコードしてから返す
    // (server/kougenTenkiGenerate.mjs の犬山AWS取得と同じサイト・同じページ)。
    allow: (path) => path === "/jan/weather/main.html",
    encoding: "shift_jis",
  },
  jr9vq: {
    origin: "http://www.jr9vq.org",
    // 立山(雄山)山頂ライブカメラの2ページ。最新画像のファイル名がHTML内に埋め込まれている。
    // ページはShift_JISなので、UTF-8へデコードしてから返す。
    allow: (path) => path === "/lcam/lcam.html" || path === "/lcams/lcam.html",
    encoding: "shift_jis",
  },
};

/** @returns {Promise<{status: number, body: string}>} */
export function fetchExternal(sourceKey, path) {
  const cfg = EXTERNAL_SOURCES[sourceKey];
  if (!cfg || !cfg.allow(path)) {
    return Promise.reject(new Error(`not allowed: ${sourceKey} ${path}`));
  }
  if (cfg.aggregate) return cfg.aggregate(path);
  return requestUrl(cfg.origin + path, cfg);
}

/** 単一URLを取得する。cfg で method/body/encoding/insecureHTTPParser/timeout を指定できる。 */
function requestUrl(url, cfg = {}) {
  const mod = url.startsWith("https:") ? https : http;
  const method = cfg.method ?? "GET";
  const body = cfg.body;

  const headers = { "User-Agent": BROWSER_UA };
  if (body) {
    headers["Content-Type"] = cfg.contentType ?? "application/x-www-form-urlencoded";
    headers["Content-Length"] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const options = {
      method,
      headers,
      insecureHTTPParser: !!cfg.insecureHTTPParser,
      timeout: cfg.timeout ?? 30_000,
    };
    const req = mod.request(url, options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => {
        const buf = Buffer.concat(chunks);
        const text = cfg.encoding
          ? new TextDecoder(cfg.encoding).decode(buf)
          : buf.toString("utf-8");
        resolve({ status: res.statusCode ?? 502, body: text });
      });
    });
    req.on("timeout", () => {
      req.destroy(new Error(`upstream timeout: ${url}`));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
