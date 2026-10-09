import { Capacitor } from "@capacitor/core";

/**
 * Android版(Capacitor)アプリとして動いているかどうか。
 * PWA/デスクトップブラウザでは常にfalse(`@capacitor/core`自体はどちらでも読み込めるが、
 * ネイティブランタイムが無い環境では`isNativePlatform()`がfalseを返す)。
 *
 * `src/lib/extProxy.ts`などで、ネイティブアプリだけ`/api/*`プロキシを経由せず外部サイトへ
 * 直接アクセスする(CapacitorHttpプラグインによりCORSの対象外になる)ための分岐に使う。
 */
export function isNativeApp(): boolean {
  return Capacitor.isNativePlatform();
}

/**
 * 衛星画像予測(雲の動きを高層風で移流させる独自予測、`src/lib/satelliteForecast.ts`)を
 * 有効にするかどうか。「自分用では実装して 発表用では 廃止することはできますか」という
 * 指示への対応。
 *
 * 気象業務法第17条の予報業務許可は「不特定多数へ反復・継続的に提供」する場合に必要になる
 * ため、逆に言えば「自分しか使わないビルド」であれば該当しない。そこで、この機能を
 * ビルド時の環境変数(`VITE_ENABLE_SATELLITE_FORECAST`)で分岐できるようにした。
 * - 既定(この変数を設定しない場合): 無効。Play Storeに提出するAndroidビルドや、
 *   公開URLへデプロイするWeb版のビルドはこちらになる(=リポジトリをそのまま
 *   `npm run build`してもこの機能は含まれない)。
 * - 自分専用に使いたい場合: プロジェクト直下に`.env.local`(Gitには追跡されない、
 *   `.gitignore`の`*.local`で除外済み)を作り、`VITE_ENABLE_SATELLITE_FORECAST=true`
 *   と書いてから`npm run dev`/`npm run build`する。この状態で作ったビルド(APK含む)を
 *   他人に配布・公開しないこと。
 *
 * 無効時は、予測コマの計算(Open-Meteoへの問い合わせや移流処理)自体を行わない
 * (`App.tsx`のuseEffect側で分岐、単にUIを隠すだけではない)。
 */
export function isSatelliteForecastEnabled(): boolean {
  // スマホ版では、衛星画像の予測を廃止した(高層風にOpen-Meteoを使うため。「openmeteoの演算からの削除」への対応)。
  // VITE_ENABLE_SATELLITE_FORECAST を設定しても有効にならない(PC版はそのまま)
  return false;
}
