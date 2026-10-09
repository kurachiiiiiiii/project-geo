import { useMemo } from "react";
import { CircleMarker, ImageOverlay, Popup, useMapEvents } from "react-leaflet";
import { kougenTenkiBounds, lookupKougenTenkiValue, renderKougenTenkiDataUrl } from "../lib/kougenTenkiGrid";
import type { KougenTenkiGrid, KougenTenkiValue } from "../types";
import KougenTenkiPopup from "./KougenTenkiPopup";

const STATION_COLOR = "#f43f5e";

interface Props {
  grid: KougenTenkiGrid | null;
  visible: boolean;
  hourIndex: number;
  tempOpacity: number;
  fogOpacity: number;
  showStations: boolean;
  onHover: (value: (KougenTenkiValue & { lat: number; lon: number }) | null) => void;
}

/** 地図上でのマウス移動を拾い、グリッド値をホバー表示用に親へ伝える */
function HoverReporter({
  grid,
  hourIndex,
  onHover,
}: {
  grid: KougenTenkiGrid;
  hourIndex: number;
  onHover: Props["onHover"];
}) {
  useMapEvents({
    mousemove(e) {
      const v = lookupKougenTenkiValue(grid, hourIndex, e.latlng.lat, e.latlng.lng);
      onHover(v ? { ...v, lat: e.latlng.lat, lon: e.latlng.lng } : null);
    },
    mouseout() {
      onHover(null);
    },
  });
  return null;
}

/**
 * 「高原天気」気温・霧シミュレーターのレイヤー。
 * 「気象情報を生成」ボタンで取得したグリッドデータから、選択中の時刻の気温分布・霧リスクを
 * canvasでその場に描き(サーバー側でのPNG事前生成はしていない)、画像オーバーレイとして表示する。
 */
export default function KougenTenkiLayer({
  grid,
  visible,
  hourIndex,
  tempOpacity,
  fogOpacity,
  showStations,
  onHover,
}: Props) {
  const bounds = useMemo(() => (grid ? kougenTenkiBounds(grid) : null), [grid]);
  const tempUrl = useMemo(
    () => (grid ? renderKougenTenkiDataUrl(grid, hourIndex, "temp") : null),
    [grid, hourIndex],
  );
  const fogUrl = useMemo(() => (grid ? renderKougenTenkiDataUrl(grid, hourIndex, "fog") : null), [grid, hourIndex]);

  if (!visible || !grid || !bounds) return null;

  return (
    <>
      <HoverReporter grid={grid} hourIndex={hourIndex} onHover={onHover} />

      {tempUrl && tempOpacity > 0 && (
        <ImageOverlay url={tempUrl} bounds={bounds} opacity={tempOpacity} zIndex={350} />
      )}
      {fogUrl && fogOpacity > 0 && <ImageOverlay url={fogUrl} bounds={bounds} opacity={fogOpacity} zIndex={351} />}

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
              <KougenTenkiPopup station={s} />
            </Popup>
          </CircleMarker>
        ))}
    </>
  );
}
