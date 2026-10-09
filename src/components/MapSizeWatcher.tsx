import { useEffect } from "react";
import { useMap } from "react-leaflet";

/**
 * 地図コンテナのサイズ変化を監視して Leaflet に伝える。
 *
 * Leaflet は初期化時のコンテナサイズを覚えるため、まだ大きさが確定していない状態
 * (バックグラウンドのタブで開かれた、レイアウトが後から決まる、PWAの起動直後など)で
 * マウントされると、タイルが数枚しか描画されず、表示範囲に依存する処理
 * (アメダスの範囲内フィルタやクラスタ計算)も正しく動かなくなる。
 * ResizeObserver でサイズが変わるたびに invalidateSize() を呼んで追従させる。
 */
export default function MapSizeWatcher() {
  const map = useMap();

  useEffect(() => {
    const container = map.getContainer();

    const sync = () => map.invalidateSize();
    const observer = new ResizeObserver(sync);
    observer.observe(container);

    // マウント直後にサイズが 0 だった場合に備えて一度明示的に反映する
    sync();

    return () => observer.disconnect();
  }, [map]);

  return null;
}
