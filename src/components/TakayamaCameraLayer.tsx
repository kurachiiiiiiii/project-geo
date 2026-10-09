import { dotIcon } from "../lib/dotIcon";
import type { TakayamaCamera } from "../types";
import TakayamaCameraPopup from "./TakayamaCameraPopup";
import LazyClusterLayer from "./LazyClusterLayer";

// #0ea5e9(シアン)は川の防災情報カメラで既に使っているため、区別できる色にしている
const takayamaIcon = dotIcon("#ec4899", undefined, "circle");

interface Props {
  cameras: TakayamaCamera[];
  visible: boolean;
}

/** 国交省 高山国道事務所(飛騨地域)のライブカメラをクラスタ表示するレイヤー */
export default function TakayamaCameraLayer({ cameras, visible }: Props) {
  return (
    <LazyClusterLayer
      items={cameras}
      visible={visible}
      maxClusterRadius={50}
      disableClusteringAtZoom={13}
      getPosition={(c) => [c.lat, c.lng]}
      getIcon={() => takayamaIcon}
      renderPopup={(c) => <TakayamaCameraPopup camera={c} />}
    />
  );
}
