import { useCallback, useMemo, useState } from "react";
import { Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import { dotIcon, valueIcon } from "../lib/dotIcon";
import { formatMetricValue } from "../lib/formatMetric";
import { metricColor, readableTextColor } from "../lib/metricColor";
import AmedasPopup from "./AmedasPopup";
import type { AmedasStation, WeatherMetric } from "../types";

const AMEDAS_COLOR = "#f97316";
/** このズームより引いた状態では観測所が多すぎて読めないので描画しない */
const MIN_ZOOM = 7;

interface Props {
  stations: AmedasStation[];
  visible: boolean;
  metric: WeatherMetric;
  observedAt: string | null;
}

/**
 * アメダス観測所レイヤー。
 *
 * 全国約1,300地点あるため、クラスタ表示ではなく「現在の表示範囲内のものだけ描画」する方式にしている。
 * 気象値を地図上のラベルとして読ませるのが目的で、クラスタにまとめると値が見えなくなるため。
 */
export default function AmedasLayer({ stations, visible, metric, observedAt }: Props) {
  const map = useMap();
  const [version, setVersion] = useState(0);

  // 地図の移動・ズーム・サイズ変更のたびに再計算する
  // (bounds自体はstateに持たず、再描画のトリガーだけ持つ)
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  useMapEvents({ moveend: bump, zoomend: bump, resize: bump });

  const visibleStations = useMemo(() => {
    if (!visible) return [];
    if (map.getZoom() < MIN_ZOOM) return [];
    const bounds = map.getBounds();
    return stations.filter((s) => bounds.contains([s.lat, s.lng]));
    // version は地図移動時に再計算するためのトリガー
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stations, visible, map, version]);

  if (!visible) return null;

  return (
    <>
      {visibleStations.map((station) => {
        const value = station[metric as keyof AmedasStation] as number | null;
        const label = formatMetricValue(value, metric);
        const valueColor = metricColor(metric, value);
        return (
          <Marker
            key={station.code}
            position={[station.lat, station.lng]}
            icon={
              label
                ? valueIcon(AMEDAS_COLOR, label, {
                    valueColor: valueColor ?? undefined,
                    textColor: valueColor ? readableTextColor(valueColor) : undefined,
                    shape: "square",
                  })
                : dotIcon(AMEDAS_COLOR, undefined, "square")
            }
          >
            <Popup minWidth={220} maxWidth={300}>
              <AmedasPopup station={station} observedAt={observedAt} />
            </Popup>
          </Marker>
        );
      })}
    </>
  );
}
