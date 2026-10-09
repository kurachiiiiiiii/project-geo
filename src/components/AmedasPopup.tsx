import { windDirectionLabel } from "../features/amedas/amedasService";
import type { AmedasStation } from "../types";
import { Thermometer } from "../lib/lucide";
import { Ico } from "./Ico";

function row(label: string, value: number | null, unit: string, digits: number): string | null {
  if (value === null) return null;
  return `${label}: ${value.toFixed(digits)}${unit}`;
}

interface Props {
  station: AmedasStation;
  observedAt: string | null;
}

export default function AmedasPopup({ station, observedAt }: Props) {
  const rows = [
    row("気温", station.temp, "℃", 1),
    row("湿度", station.humidity, "%", 0),
    row("降水量(1h)", station.precipitation1h, "mm", 1),
    row("日照時間(1h)", station.sun1h, "h", 1),
    row("風速", station.wind, "m/s", 1),
  ].filter((v): v is string => v !== null);

  return (
    <div className="camera-popup camera-popup--compact">
      <div className="camera-popup__title">
        <Ico icon={Thermometer} /> {station.name}
        <span className="camera-popup__elevation"> ({station.altitudeM}m)</span>
      </div>
      {observedAt && (
        <div className="camera-popup__route">{observedAt.slice(0, 16).replace("T", " ")} 時点</div>
      )}

      {rows.length > 0 ? (
        <ul className="camera-popup__weather-list">
          {rows.map((line) => (
            <li key={line}>{line}</li>
          ))}
          {station.windDirection !== null && <li>風向: {windDirectionLabel(station.windDirection)}</li>}
        </ul>
      ) : (
        <div className="camera-popup__status">この観測所の観測値がありません</div>
      )}

      <div className="camera-popup__source">
        出典:{" "}
        <a href="https://www.jma.go.jp/bosai/amedas/" target="_blank" rel="noreferrer">
          気象庁 アメダス
        </a>
      </div>
    </div>
  );
}
