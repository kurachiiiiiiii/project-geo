import { useEffect, useRef } from "react";
import { useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet.markercluster";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "leaflet.markercluster/dist/MarkerCluster.Default.css";
import { createRoot, type Root } from "react-dom/client";
import type { ReactElement } from "react";
import { CAMERA_POPUP_MAX_WIDTH, CAMERA_POPUP_MIN_WIDTH } from "../lib/popupSize";

interface Props<T> {
  items: T[];
  visible: boolean;
  getPosition: (item: T) => [number, number];
  getIcon: (item: T) => L.DivIcon;
  renderPopup: (item: T) => ReactElement;
  maxClusterRadius?: number;
  disableClusteringAtZoom?: number;
  popupMinWidth?: number;
  popupMaxWidth?: number;
}

/**
 * 件数の多いマーカー群をクラスタ表示する共通レイヤー。
 *
 * ポップアップの中身(画像やYouTube埋め込みを含むReactコンポーネント)は、
 * そのマーカーが実際にクリックされて開かれるまで描画しない(popupopenイベントで初回だけ
 * createRootする)。そうしないと、画像/iframeのsrcがマウント時点で即座にネットワーク
 * リクエストを開始してしまい、数百件のカメラのうち誰も見ないものまで一斉に読み込んでしまう。
 */
export default function LazyClusterLayer<T>({
  items,
  visible,
  getPosition,
  getIcon,
  renderPopup,
  maxClusterRadius = 50,
  disableClusteringAtZoom = 13,
  popupMinWidth = CAMERA_POPUP_MIN_WIDTH,
  popupMaxWidth = CAMERA_POPUP_MAX_WIDTH,
}: Props<T>) {
  const map = useMap();
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);

  useEffect(() => {
    // chunkedLoading(マーカー追加の分割実行)は使わない。分割処理は setTimeout で継続するため、
    // 処理中にレイヤーが地図から外されると内部の this._map が null になって
    // "Cannot read properties of null (reading 'getMinZoom')" で落ちる。
    // 一括追加なら同期的に完了するのでこの競合が起きない。
    const cluster = L.markerClusterGroup({ maxClusterRadius, disableClusteringAtZoom });
    const roots: Root[] = [];

    const markers = items.map((item) => {
      const marker = L.marker(getPosition(item), { icon: getIcon(item) });
      const container = document.createElement("div");
      marker.bindPopup(container, { minWidth: popupMinWidth, maxWidth: popupMaxWidth });

      let mounted = false;
      marker.on("popupopen", () => {
        if (mounted) return;
        mounted = true;
        const root = createRoot(container);
        roots.push(root);
        root.render(renderPopup(item));
      });
      return marker;
    });

    // 1件ずつの addLayer より addLayers の一括追加のほうが大幅に速い
    cluster.addLayers(markers);

    clusterRef.current = cluster;
    if (visible) cluster.addTo(map);

    return () => {
      map.removeLayer(cluster);
      clusterRef.current = null;
      // レンダー中のunmountを避けるため、後始末は次のタスクに回す
      queueMicrotask(() => roots.forEach((root) => root.unmount()));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, map]);

  useEffect(() => {
    const cluster = clusterRef.current;
    if (!cluster) return;
    const isOnMap = map.hasLayer(cluster);
    if (visible && !isOnMap) cluster.addTo(map);
    if (!visible && isOnMap) map.removeLayer(cluster);
  }, [visible, map]);

  return null;
}
