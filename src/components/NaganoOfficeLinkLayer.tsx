import { dotIcon } from "../lib/dotIcon";
import type { NaganoOfficeLink } from "../types";
import NaganoOfficeLinkPopup from "./NaganoOfficeLinkPopup";
import LazyClusterLayer from "./LazyClusterLayer";

const naganoOfficeIcon = dotIcon("#a1a1aa", undefined, "circle");

interface Props {
  offices: NaganoOfficeLink[];
  visible: boolean;
}

/** 座標が判明していない長野県建設事務所への代表リンクマーカー(8箇所程度) */
export default function NaganoOfficeLinkLayer({ offices, visible }: Props) {
  return (
    <LazyClusterLayer
      items={offices}
      visible={visible}
      maxClusterRadius={40}
      disableClusteringAtZoom={9}
      getPosition={(o) => [o.lat, o.lng]}
      getIcon={() => naganoOfficeIcon}
      renderPopup={(o) => <NaganoOfficeLinkPopup office={o} />}
    />
  );
}
