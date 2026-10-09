import type { KougenTenkiStation } from "../types";
import { Thermometer } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  station: KougenTenkiStation;
}

/** id の付け方(`server/kougenTenkiGenerate.mjs`)から観測点の種別を判定し、出典を出し分ける */
function sourceLabel(id: string): string {
  // (道路情報提供システムの観測局 "road_" は、スマホ版では使わなくなった)
  if (id === "inuyama_aws") return "犬山自動気象観測所";
  return "気象庁アメダス";
}

/**
 * `number.toFixed()`を、値が無い(null/NaN)ときにクラッシュせず"—"を返す形で呼ぶ。
 *
 * 「小さい青の丸の点を 現在の気温を表示しているときにクリックすると なにも表示されなく
 * なります」というバグ調査で、DEM取得の一時的な失敗などにより`station.alt`(まれに`temp`)が
 * `NaN`になることがあり(`JSON.stringify`はNaNを`null`にシリアライズするため、クライアント側
 * では`null`として届く)、それを未然にガードしていなかった`station.alt.toFixed(0)`が
 * `TypeError: Cannot read properties of null`で丸ごとクラッシュし、それを受けて(エラー境界が
 * 無かったため)Reactアプリ全体がアンマウントされ画面が真っ白になっていたことを確認した。
 */
function formatOrDash(value: number | null | undefined, digits: number): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "—";
}

/** 「現在の気温」に使われた観測地点のポップアップ(KougenTenkiPopup.tsxと似ているが、
 *  道路情報提供システムの観測局も混ざるため出典を観測点ごとに出し分ける) */
export default function CurrentTemperaturePopup({ station }: Props) {
  return (
    <div className="camera-popup camera-popup--compact">
      <div className="camera-popup__title">
        <Ico icon={Thermometer} /> {station.name}
        <span className="camera-popup__elevation"> ({formatOrDash(station.alt, 0)}m)</span>
      </div>

      <ul className="camera-popup__weather-list">
        <li>気温: {formatOrDash(station.temp, 1)}℃</li>
        {!Number.isNaN(station.humidity) && <li>湿度: {formatOrDash(station.humidity, 0)}%</li>}
      </ul>

      <div className="camera-popup__source">出典: {sourceLabel(station.id)}</div>
    </div>
  );
}
