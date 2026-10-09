import type { CapacitorConfig } from '@capacitor/cli';

// geo watcher(Android版)は、Webアセット(dist)をそのまま端末に同梱し、外部データは
// アプリが直接取得する「スマホ完結型」の方式にしている。
//
// 【経緯】当初はこのPWAをデプロイ済みのURLへ向けるだけの薄いラッパー(`server.url`)にする
// 案で進めていたが、「サーバー(プロキシ)が無いと動かない機能は、スマホ内で演算して
// 自己完結させることは可能でしょうか」という指示を受けて方針転換した。
//
// このアプリの大半の機能(降水・アメダス・衛星画像・天文計算)はもともと外部サイトへ
// 直接 fetch() しており、サーバーを必要としない。サーバー(`/api/*`)が必要だったのは、
// 一部のカメラ中継・高原天気生成など「相手サイトがCORSに対応していない」ものだけで、
// CORSはブラウザのJS(fetch/XHR)だけに課される制限であり通信そのものが不可能なわけでは
// ない。そこで `CapacitorHttp` プラグイン(下記)でネイティブ通信(Android実機では
// OkHttp)へ切り替えることでCORSの対象外にし、サーバー無しで直接取得できるようにした
// (詳細は `src/lib/extProxy.ts`・`src/lib/platform.ts` 参照。README「Android アプリ
// (geo watcher): サーバーレス化」の節も参照)。
const config: CapacitorConfig = {
  appId: 'com.geowatcher.app',
  appName: 'geo watcher',
  webDir: 'dist',
  plugins: {
    // window.fetch() / XMLHttpRequest をネイティブ通信に置き換えるプラグイン。
    // Web(PWA)側では効かない(=このプラグインが無いのと同じ挙動)ため、
    // ブラウザ版は今まで通りCORS制約を受け、/api/*プロキシに頼る経路を維持できる。
    CapacitorHttp: {
      enabled: true,
    },
  },
};

export default config;
