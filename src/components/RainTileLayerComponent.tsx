import { createElementObject, createTileLayerComponent, updateGridLayer, withPane } from "@react-leaflet/core";
import type { TileLayer as LeafletTileLayer } from "leaflet";
import type { TileLayerProps } from "react-leaflet";
import { RainTileLayer as LeafletRainTileLayer } from "../lib/rainTileLayer";

/**
 * react-leaflet の <TileLayer> は内部で必ず素の L.TileLayer を生成するため、
 * ズーム4/6/8/10にしか丸めない挙動(src/lib/rainTileLayer.ts)を使わせるには
 * react-leafletと同じ仕組み(@react-leaflet/core の createTileLayerComponent)を使って
 * 自前のコンポーネントを用意する必要がある。実装はreact-leaflet本体のTileLayer.jsとほぼ同じ。
 */
export const RainTileLayerComponent = createTileLayerComponent<LeafletTileLayer, TileLayerProps>(
  function createRainTileLayer({ url, ...options }, context) {
    const layer = new LeafletRainTileLayer(url, withPane(options, context));
    return createElementObject(layer, context);
  },
  function updateRainTileLayer(layer, props, prevProps) {
    updateGridLayer(layer, props, prevProps);
    const { url } = props;
    if (url != null && url !== prevProps.url) {
      layer.setUrl(url);
    }
  },
);
