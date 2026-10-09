import type { KougenTenkiStation } from "../types";
import { MountainSnow } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  station: KougenTenkiStation;
}

/**
 * `number.toFixed()`を、値が無い(null/NaN)ときにクラッシュせず"—"を返す形で呼ぶ。
 * DEM取得の一時的な失敗などで`station.alt`(まれに`temp`)が`NaN`になることがあり
 * (`JSON.stringify`はNaNを`null`にシリアライズするため、クライアント側では`null`として届く)、
 * 未ガードの`.toFixed()`がそれで丸ごとクラッシュしていた(CurrentTemperaturePopup.tsx参照。
 * このコンポーネントも同じ`KougenTenkiStation`型・同じ生成経路を使うため同じ対策を入れる)。
 */
function formatOrDash(value: number | null | undefined, digits: number): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

/** 「高原天気」計算に使われたアメダス観測地点のポップアップ */
export default function KougenTenkiPopup({ station }: Props) {
  return (
    <div className="camera-popup camera-popup--compact">
      <div className="camera-popup__title">
        <Ico icon={MountainSnow} /> {station.name}
        <span className="camera-popup__elevation"> ({formatOrDash(station.alt, 0)}m)</span>
      </div>
      <div className="camera-popup__route">ID: {station.id}</div>

      <ul className="camera-popup__weather-list">
        <li>気温: {formatOrDash(station.temp, 1)}℃</li>
        {!Number.isNaN(station.humidity) && <li>湿度: {formatOrDash(station.humidity, 0)}%</li>}
      </ul>

      <div className="camera-popup__source">出典: 気象庁アメダス(「高原天気」気温・霧シミュレーター)</div>
    </div>
  );
}
