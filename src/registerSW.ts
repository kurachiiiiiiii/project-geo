import { registerSW } from "virtual:pwa-register";

/**
 * Service Worker の更新を自動で反映する。
 *
 * これまでは vite-plugin-pwa が自動注入する既定のスクリプトを使っていたが、
 * それは `navigator.serviceWorker.register()` を呼ぶだけで、新しいバージョンを
 * 検知しても「今開いているページ」には反映しなかった(次に新しいSWが有効化されても
 * 既に読み込み済みのJSはそのまま動き続ける)。
 *
 * この開発サイクルではビルドを何度も繰り返すため、デスクトップアイコンから再度開いた
 * つもりでも古いコードのままのタブが残り続け、直したはずの不具合が再現するように
 * 見える事態が実際に起きた。`onNeedRefresh` で新バージョンを検知した瞬間に
 * `updateSW(true)` を呼んでリロードすることで、常に最新のビルドで動くようにする。
 */
export function setupAutoUpdatingServiceWorker() {
  if (!("serviceWorker" in navigator)) return;

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      updateSW(true);
    },
  });
}
