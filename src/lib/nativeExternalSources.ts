/**
 * `server/externalProxy.mjs` の `EXTERNAL_SOURCES` と同じ取得先を、Androidネイティブアプリが
 * (プロキシを経由せず)直接fetch()するために複製したもの。
 *
 * 【なぜ複製か】`server/externalProxy.mjs`は素のNode.js(`node:http`/`node:https`)前提の
 * `.mjs`で、ブラウザ/Androidアプリのバンドルには持ち込めない(`node:*`はブラウザに存在しない)。
 * 一方こちらは`fetch()`だけで完結するため、内容をここに複製している。
 * **取得先が増えた・変わった場合は、両方直すこと。**
 *
 * 【方式】Web版(PWA)は引き続き`/api/ext/<source>`経由(CORS制約があるため)。
 * ネイティブAndroid版は`capacitor.config.ts`で有効化した`CapacitorHttp`プラグインが
 * `window.fetch()`を横取りしてAndroidのネイティブ通信(OkHttp)で送るため、CORSの対象外になり
 * 直接外部サイトを叩ける(`src/lib/extProxy.ts`の`fetchExt()`がプラットフォームで分岐する)。
 *
 * (川の防災情報`kawabou`/`kawabouCam`・道路情報提供システム`roadKisho`は、スマホ版では廃止した(2026年10月)。)
 */
export interface NativeExternalSource {
  origin: string;
  method?: "GET" | "POST";
  body?: string;
  contentType?: string;
  /** Shift_JISなど、UTF-8以外へのデコードが必要な場合(`server/externalProxy.mjs`のencodingと同じ) */
  encoding?: string;
  /**
   * サーバー側(Node)は応答ヘッダーの非標準な折り返しをNode標準の緩い解析モード
   * (`insecureHTTPParser`)で回避しているが、ネイティブ側(Android OkHttp)に同等の
   * 回避策は無い。OkHttpの方が寛容で問題なく取得できる可能性はあるが、実機で確認する
   * まで未確認(「サーバーなしでスマホ完結化」の指示時点での既知の制約。README参照)。
   */
  headerRiskUnverified?: boolean;
}

export const NATIVE_EXTERNAL_SOURCES: Record<string, NativeExternalSource> = {
  jmaVolcam: {
    origin: "https://www.data.jma.go.jp",
  },
  jmaProb: {
    // 気象庁 確率予測資料(紅葉マップの長期予報)。server/externalProxy.mjsの同じsourceと揃える
    origin: "https://ds.data.jma.go.jp",
  },
  gsiReverseGeocode: {
    origin: "https://mreversegeocoder.gsi.go.jp",
  },
  inuyama: {
    origin: "https://www.ma.ccnw.ne.jp",
    encoding: "shift_jis",
  },
  jr9vq: {
    origin: "http://www.jr9vq.org",
    encoding: "shift_jis",
  },
};
