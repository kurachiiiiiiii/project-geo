import { Polyline, Tooltip } from "react-leaflet";
import type { MotionField } from "../lib/satelliteForecast";
import { destinationPoint } from "../lib/geo";
import { formatDirection } from "../lib/direction";
import { Wind } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  motionField: MotionField | null;
}

/**
 * 「雲の動きは500キロメッシュで 雲がそれぞれどの方向に動いているのか 計算して もとめて
 * ください」への対応。マス目(`lib/satelliteForecast.ts`の`MotionField`)ごとに推定した
 * 動きベクトルを、その中心から矢印(線+向き・速さのラベル)で地図上に表示する。
 * `AstroPointPopup.tsx`の日の出没・方角の線と同じ「Polyline+Tooltip」の表現を踏襲している。
 *
 * 矢印の長さは速さに比例させつつ、あまり長すぎ/短すぎて見づらくならないよう上下限を設ける。
 * ほぼ動きが検出できなかったマス目(海上の一様な雲や快晴で手がかりが乏しい場合など)は
 * 矢印が煩雑になるだけなので、一定の速さ未満は表示しない。
 */
const MIN_DISPLAY_SPEED_KMH = 3; // これ未満は「動きなし」とみなして矢印を出さない
const ARROW_LENGTH_MIN_KM = 25;
const ARROW_LENGTH_MAX_KM = 140;
const ARROW_KM_PER_KMH = 1.2; // 矢印の長さ(km) = 速さ(km/h) × この係数(上下限内で)
const ARROWHEAD_LENGTH_KM = 18;
const ARROWHEAD_SPREAD_DEG = 28; // 矢印の先端の「ハ」の開き角度

export default function SatelliteMotionArrowsLayer({ motionField }: Props) {
  // 「衛星画像予測は常にonにしてください」という指示により、表示ON/OFFのトグルは廃止した。
  // motionFieldが計算できていれば(=衛星画像のコマが1枚以上あれば)常に表示する。
  if (!motionField) return null;

  return (
    <>
      {motionField.cells.flatMap((cell, i) => {
        if (cell.speedKmh < MIN_DISPLAY_SPEED_KMH) return [];
        const lengthKm = Math.min(
          ARROW_LENGTH_MAX_KM,
          Math.max(ARROW_LENGTH_MIN_KM, cell.speedKmh * ARROW_KM_PER_KMH),
        );
        const origin = { lat: cell.centerLat, lng: cell.centerLon };
        const tip = destinationPoint(origin, cell.azimuthDeg, lengthKm);
        // 矢印の先端の「ハ」(進行方向の逆・左右にそれぞれ開いた短い線)
        const leftBarb = destinationPoint(tip, cell.azimuthDeg + 180 - ARROWHEAD_SPREAD_DEG, ARROWHEAD_LENGTH_KM);
        const rightBarb = destinationPoint(tip, cell.azimuthDeg + 180 + ARROWHEAD_SPREAD_DEG, ARROWHEAD_LENGTH_KM);

        return [
          <Polyline
            key={`shaft-${i}`}
            positions={[
              [origin.lat, origin.lng],
              [tip.lat, tip.lng],
            ]}
            pathOptions={{ color: "#ffd54a", weight: 3, opacity: 0.9 }}
          >
            <Tooltip direction="center" opacity={0.9}>
              <Ico icon={Wind} /> {Math.round(cell.speedKmh)}km/h {formatDirection(cell.azimuthDeg)}
            </Tooltip>
          </Polyline>,
          <Polyline
            key={`head-${i}`}
            positions={[
              [leftBarb.lat, leftBarb.lng],
              [tip.lat, tip.lng],
              [rightBarb.lat, rightBarb.lng],
            ]}
            pathOptions={{ color: "#ffd54a", weight: 3, opacity: 0.9 }}
          />,
        ];
      })}
    </>
  );
}
