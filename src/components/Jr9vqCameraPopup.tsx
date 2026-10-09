import { useEffect, useState } from "react";
import { fetchJr9vqImage, formatJr9vqTimestamp } from "../features/jr9vqCameras/jr9vqCameraService";
import type { Jr9vqCamera } from "../types";
import type { Jr9vqImage } from "../features/jr9vqCameras/jr9vqCameraService";
import { Mountain } from "../lib/lucide";
import { Ico } from "./Ico";

/** 現地は毎時00/20/40分頃に更新されるため、それに合わせて数分おきに読み直す */
const REFRESH_MS = 5 * 60_000;

interface Props {
  camera: Jr9vqCamera;
}

export default function Jr9vqCameraPopup({ camera }: Props) {
  const [image, setImage] = useState<Jr9vqImage | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchJr9vqImage(camera)
        .then((result) => {
          if (cancelled) return;
          if (result) {
            setImage(result);
            setStatus("ready");
          } else {
            setStatus("error");
          }
        })
        .catch(() => {
          if (!cancelled) setStatus("error");
        });
    };
    load();
    const id = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [camera]);

  return (
    <div className="camera-popup">
      <div className="camera-popup__title">
        <Ico icon={Mountain} /> {camera.name}
        <span className="camera-popup__elevation"> (3,003m)</span>
      </div>
      <div className="camera-popup__route">{camera.direction}</div>

      {status === "loading" && <div className="camera-popup__status">読み込み中...</div>}
      {status === "error" && <div className="camera-popup__status">画像を取得できませんでした</div>}
      {status === "ready" && image && (
        <>
          <img className="camera-popup__image" src={image.imageUrl} alt={camera.direction} />
          {/* サイト側の条件により、出典と撮影日付の表示は必須 */}
          <div className="camera-popup__gifu-caption">撮影 {formatJr9vqTimestamp(image.timestamp)}</div>
        </>
      )}

      <div className="camera-popup__source">
        出典:{" "}
        <a href="http://www.jr9vq.org/" target="_blank" rel="noreferrer">
          JR9VQ 雄山山頂ライブカメラ
        </a>
      </div>
    </div>
  );
}
