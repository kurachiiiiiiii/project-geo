import { ImageOverlay } from "react-leaflet";
import type { PredictedSatelliteFrame } from "../lib/satelliteForecast";

interface Props {
  frame: PredictedSatelliteFrame | null;
  opacity: number;
}

/**
 * 「衛星画像の予測をしたい 過去1時間分の衛星画像をもとに 3時間後まで どのように動くか
 * 予想したい」への対応。実際の予測計算(動きベクトルの推定・移流)は`lib/satelliteForecast.ts`
 * (App.tsx側で呼び出し)で行い、このコンポーネントは出来上がったdata URLを画像オーバーレイ
 * として表示するだけ(`CloudMeshLayer.tsx`と同じ構成)。
 *
 * 選択中のコマが予測コマのときだけ`MapView.tsx`から表示される(実測コマのときは通常通り
 * `<TileLayer>`/`SatelliteEnhanceTileLayerComponent`が使われる)。
 */
export default function SatelliteForecastLayer({ frame, opacity }: Props) {
  if (!frame) return null;

  return <ImageOverlay url={frame.dataUrl} bounds={frame.bounds} opacity={opacity} zIndex={400} />;
}
