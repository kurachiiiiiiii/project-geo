import { dotIcon } from "../lib/dotIcon";
import type { JmaVolcanoCamera } from "../types";
import JmaVolcamPopup from "./JmaVolcamPopup";
import LazyClusterLayer from "./LazyClusterLayer";

const volcanoIcon = dotIcon("#ef4444", undefined, "circle");

interface Props {
  cameras: JmaVolcanoCamera[];
  visible: boolean;
}

/** 気象庁 火山監視カメラをクラスタ表示するレイヤー */
export default function JmaVolcamLayer({ cameras, visible }: Props) {
  return (
    <LazyClusterLayer
      items={cameras}
      visible={visible}
      maxClusterRadius={50}
      disableClusteringAtZoom={12}
      getPosition={(c) => [c.lat, c.lng]}
      getIcon={() => volcanoIcon}
      renderPopup={(c) => <JmaVolcamPopup camera={c} />}
    />
  );
}
