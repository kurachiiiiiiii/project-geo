import { useMemo } from "react";
import { CircleMarker, ImageOverlay, Popup, useMapEvents } from "react-leaflet";
import { kougenTenkiBounds, lookupKougenTenkiValue, renderKougenTenkiDataUrl } from "../lib/kougenTenkiGrid";
import type { KougenTenkiGrid, KougenTenkiValue } from "../types";
import CurrentTemperaturePopup from "./CurrentTemperaturePopup";

const STATION_COLOR = "#0ea5e9";
/** このグリッドは常に「現在」1コマだけを持つ(server/kougenTenkiGenerate.mjsのgenerateCurrentTemperature参照) */
const HOUR_INDEX = 0;

interface Props {
  grid: KougenTenkiGrid | null;
  visible: boolean;
  opacity: number;
  fogOpacity: number;
  showStations: boolean;
  onHover: (value: (KougenTenkiValue & { lat: number; lon: number }) | null) => void;
}

function HoverReporter({ grid, onHover }: { grid: KougenTenkiGrid; onHover: Props["onHover"] }) {
  useMapEvents({
    mousemove(e) {
      const v = lookupKougenTenkiValue(grid, HOUR_INDEX, e.latlng.lat, e.latlng.lng);
      onHover(v ? { ...v, lat: e.latlng.lat, lon: e.latlng.lng } : null);
    },
    mouseout() {
      onHover(null);
    },
  });
  return null;
}

/**
 * 「高層天気とは別に 現在の気温の推定値のみを表示するボタン」のレイヤー。
 *
 * KougenTenkiLayer.tsxとほぼ同じ構造(気温分布・霧リスクをcanvasでその場に描き、画像オーバーレイ
 * として表示する)だが、①時刻は常に1コマ(生成=現在)、②観測地点のポップアップは道路情報提供
 * システムの観測局も混ざるため専用の`CurrentTemperaturePopup`を使う、という2点が異なるため、
 * 共通化せず単純な専用コンポーネントにしている(KougenTenkiLayer.tsx自体は変更していない)。
 */
export default function CurrentTemperatureLayer({ grid, visible, opacity, fogOpacity, showStations, onHover }: Props) {
  const bounds = useMemo(() => (grid ? kougenTenkiBounds(grid) : null), [grid]);
  const tempUrl = useMemo(
    () => (grid ? renderKougenTenkiDataUrl(grid, HOUR_INDEX, "temp") : null),
    [grid],
  );
  const fogUrl = useMemo(
    () => (grid ? renderKougenTenkiDataUrl(grid, HOUR_INDEX, "fog") : null),
    [grid],
  );

  if (!visible || !grid || !bounds) return null;

  return (
    <>
      <HoverReporter grid={grid} onHover={onHover} />

      {tempUrl && opacity > 0 && <ImageOverlay url={tempUrl} bounds={bounds} opacity={opacity} zIndex={349} />}
      {fogUrl && fogOpacity > 0 && (
        <ImageOverlay url={fogUrl} bounds={bounds} opacity={fogOpacity} zIndex={350} />
      )}

      {showStations &&
        grid.stations.map((s) => (
          <CircleMarker
            key={s.id}
            center={[s.lat, s.lon]}
            radius={5}
            weight={2}
            color="#ffffff"
            fillColor={STATION_COLOR}
            fillOpacity={0.9}
          >
            <Popup minWidth={200} maxWidth={260}>
              <CurrentTemperaturePopup station={s} />
            </Popup>
          </CircleMarker>
        ))}
    </>
  );
}
