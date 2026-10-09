import type { NaganoOfficeLink } from "../types";
import { CarFront, ExternalLink } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  office: NaganoOfficeLink;
}

/**
 * 座標が判明していない長野県建設事務所の代表マーカー。個々のカメラ位置が分からないため、
 * 事務所所在地に1つだけマーカーを置き、その事務所のカメラ一覧ページへのリンクを出す
 * (features/naganoRoadCameras/naganoRoadCameraService.ts 参照)。
 */
export default function NaganoOfficeLinkPopup({ office }: Props) {
  return (
    <div className="camera-popup">
      <div className="camera-popup__title"><Ico icon={CarFront} /> {office.name}</div>
      <div className="camera-popup__note">
        このシステムではカメラごとの正確な位置が取得できなかったため、事務所の代表地点に表示しています。
      </div>
      <a className="camera-popup__link" href={office.url} target="_blank" rel="noreferrer">
        カメラ一覧を見る <Ico icon={ExternalLink} />
      </a>
      <div className="camera-popup__source">
        出典:{" "}
        <a
          href="https://www.pref.nagano.lg.jp/michikanri/infra/doro/joho/hiroba/index.html#camera"
          target="_blank"
          rel="noreferrer"
        >
          道路情報広場Nagano
        </a>
      </div>
    </div>
  );
}
