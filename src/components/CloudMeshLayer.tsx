import { ImageOverlay } from "react-leaflet";
import { CLOUD_MESH_BOUNDS } from "../lib/cloudMesh";
import type { LatLngBounds } from "leaflet";

interface Props {
  visible: boolean;
  dataUrl: string | null;
  opacity: number;
  /**
   * 表示範囲。既定は実測コマ用の`CLOUD_MESH_BOUNDS`。「衛星画像の予測の際も メッシュで
   * できるようにしてください」への対応で、予測コマを見ているときはApp.tsxからそのコマ
   * 自身のモザイク範囲(`lib/satelliteForecast.ts`の`PredictedSatelliteFrame.bounds`)を渡す。
   */
  bounds?: LatLngBounds;
}

/**
 * 「衛星画像で雲のある部分を5キロメッシュで判定して...」への対応。実際のグリッド計算は
 * `cloudMesh.ts`(App.tsx側で呼び出し)で行い、このコンポーネントは出来上がったdata URLを
 * 画像オーバーレイとして表示するだけ(`KougenTenkiLayer.tsx`と同じ構成)。
 *
 * `className="cloud-mesh-overlay"`で`image-rendering: pixelated`(App.css)を効かせ、
 * 拡大時ににじませず、メッシュのマス目がくっきり見えるようにしている。
 */
export default function CloudMeshLayer({ visible, dataUrl, opacity, bounds = CLOUD_MESH_BOUNDS }: Props) {
  if (!visible || !dataUrl) return null;

  return (
    <ImageOverlay url={dataUrl} bounds={bounds} opacity={opacity} zIndex={410} className="cloud-mesh-overlay" />
  );
}
