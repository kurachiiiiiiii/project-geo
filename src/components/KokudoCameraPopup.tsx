import AutoRefreshImage from "./AutoRefreshImage";
import type { KokudoCamera } from "../types";
import { CarFront } from "../lib/lucide";
import { Ico } from "./Ico";

const IMAGE_REFRESH_MS = 3 * 60_000;

interface Props {
  camera: KokudoCamera;
}

export default function KokudoCameraPopup({ camera }: Props) {
  return (
    <div className="camera-popup">
      <div className="camera-popup__title"><Ico icon={CarFront} /> {camera.name}</div>
      <div className="camera-popup__route">
        {camera.office} / {camera.route}
      </div>
      <AutoRefreshImage
        className="camera-popup__image"
        src={camera.imageUrl}
        alt={camera.name}
        refreshMs={IMAGE_REFRESH_MS}
      />
      {camera.note && <div className="camera-popup__note">{camera.note}</div>}
      <div className="camera-popup__source">
        出典:{" "}
        <a href={camera.officeUrl} target="_blank" rel="noreferrer">
          {camera.office} 道路状況ライブカメラ
        </a>
      </div>
    </div>
  );
}
