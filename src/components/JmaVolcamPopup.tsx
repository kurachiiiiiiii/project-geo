import { useEffect, useState } from "react";
import { fetchLatestVolcamImage } from "../features/jmaVolcam/jmaVolcamService";
import type { JmaVolcanoCamera, JmaVolcanoCameraImage } from "../types";
import { Mountain } from "../lib/lucide";
import { Ico } from "./Ico";

const REFRESH_MS = 3 * 60_000; // 現地の更新頻度(数分おき)に合わせる

function formatTimestamp(ts: string): string {
  if (ts.length !== 14) return "";
  return `${ts.slice(0, 4)}/${ts.slice(4, 6)}/${ts.slice(6, 8)} ${ts.slice(8, 10)}:${ts.slice(10, 12)} JST`;
}

interface Props {
  camera: JmaVolcanoCamera;
}

export default function JmaVolcamPopup({ camera }: Props) {
  const [image, setImage] = useState<JmaVolcanoCameraImage | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetchLatestVolcamImage(camera.vc)
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
  }, [camera.vc]);

  return (
    <div className="camera-popup">
      <div className="camera-popup__title"><Ico icon={Mountain} /> {camera.name}</div>
      {status === "loading" && <div className="camera-popup__status">読み込み中...</div>}
      {status === "error" && <div className="camera-popup__status">画像を取得できませんでした</div>}
      {status === "ready" && image && (
        <>
          <img className="camera-popup__image" src={image.imageUrl} alt={camera.name} />
          <div className="camera-popup__gifu-caption">{formatTimestamp(image.timestamp)}</div>
        </>
      )}
      <div className="camera-popup__source">
        出典:{" "}
        <a
          href={`https://www.data.jma.go.jp/vois/data/obs/volcam/volcam.php?VC=${camera.vc}`}
          target="_blank"
          rel="noreferrer"
        >
          気象庁 火山監視カメラ
        </a>
      </div>
    </div>
  );
}
