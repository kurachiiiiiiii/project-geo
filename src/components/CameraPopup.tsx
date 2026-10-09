import type { CameraConfig } from "../types";
import { youtubeChannelEmbedUrl, youtubeEmbedUrl } from "../features/cameras/cameraService";
import AutoRefreshImage from "./AutoRefreshImage";
import { ExternalLink } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  camera: CameraConfig;
}

export default function CameraPopup({ camera }: Props) {
  // 以前はカメラの近くの道路気象観測局(道路情報提供システム)の気温も出していたが、スマホ版では
  // 道路情報提供システムのデータを使わないことにした(2026年10月。App.tsxのコメント参照)。
  return (
    <div className="camera-popup">
      <div className="camera-popup__title">{camera.name}</div>
      <div className="camera-popup__media">
        {camera.type === "youtube" && (
          <iframe
            className="camera-popup__frame"
            src={youtubeEmbedUrl(camera.url)}
            title={camera.name}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        )}
        {camera.type === "iframe" && (
          <iframe
            className="camera-popup__frame"
            src={camera.url}
            title={camera.name}
            allowFullScreen
          />
        )}
        {camera.type === "youtubeChannel" && (
          <iframe
            className="camera-popup__frame"
            src={youtubeChannelEmbedUrl(camera.url)}
            title={camera.name}
            allow="autoplay; encrypted-media; picture-in-picture"
            allowFullScreen
          />
        )}
        {camera.type === "image" && (
          <AutoRefreshImage
            className="camera-popup__image"
            src={camera.url}
            alt={camera.name}
            refreshMs={camera.refreshMs ?? 30_000}
          />
        )}
        {/* 転載を禁止しているサイトは映像を埋め込まず、配信元へのリンクだけを出す */}
        {camera.type === "link" && (
          <a className="camera-popup__link" href={camera.url} target="_blank" rel="noreferrer">
            配信元ページでライブ映像を見る <Ico icon={ExternalLink} />
          </a>
        )}
      </div>
      {camera.note && <div className="camera-popup__note">{camera.note}</div>}
      {camera.source && (
        <div className="camera-popup__source">
          出典:{" "}
          {camera.sourceUrl ? (
            <a href={camera.sourceUrl} target="_blank" rel="noreferrer">
              {camera.source}
            </a>
          ) : (
            camera.source
          )}
        </div>
      )}
    </div>
  );
}
