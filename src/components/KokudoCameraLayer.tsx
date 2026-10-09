import { dotIcon } from "../lib/dotIcon";
import type { KokudoCamera } from "../types";
import KokudoCameraPopup from "./KokudoCameraPopup";
import LazyClusterLayer from "./LazyClusterLayer";

// 他レイヤーのドット色(高山#ec4899・富山道路#f97316・川の防災#0ea5e9 等)と重複しない
// ライム系の色にしている
const kokudoIcon = dotIcon("#84cc16", undefined, "circle");

interface Props {
  cameras: KokudoCamera[];
  visible: boolean;
}

/** 国交省 岐阜国道事務所・多治見砂防国道事務所のライブカメラをクラスタ表示するレイヤー */
export default function KokudoCameraLayer({ cameras, visible }: Props) {
  return (
    <LazyClusterLayer
      items={cameras}
      visible={visible}
      maxClusterRadius={50}
      disableClusteringAtZoom={13}
      getPosition={(c) => [c.lat, c.lng]}
      getIcon={() => kokudoIcon}
      renderPopup={(c) => <KokudoCameraPopup camera={c} />}
    />
  );
}
