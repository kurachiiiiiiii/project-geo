import AutoRefreshImage from "./AutoRefreshImage";
import type { TakayamaCamera } from "../types";
import { CarFront } from "../lib/lucide";
import { Ico } from "./Ico";

const IMAGE_REFRESH_MS = 3 * 60_000;

interface Props {
  camera: TakayamaCamera;
}

export default function TakayamaCameraPopup({ camera }: Props) {
  return (
    <div className="camera-popup">
      <div className="camera-popup__title"><Ico icon={CarFront} /> {camera.name}</div>
      <div className="camera-popup__route">
        {camera.area}
        {camera.direction && ` / ${camera.direction}`}
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
        <a href="https://www.cbr.mlit.go.jp/takayama/cctv/index.html" target="_blank" rel="noreferrer">
          高山国道事務所 道路状況ライブカメラ
        </a>
      </div>
    </div>
  );
}
