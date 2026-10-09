import { useEffect, useState } from "react";

interface Props {
  src: string;
  alt: string;
  refreshMs: number;
  className?: string;
}

/** 定期的にクエリパラメータを付け替えて再読み込みする、監視カメラ用のスナップショット画像 */
export default function AutoRefreshImage({ src, alt, refreshMs, className }: Props) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => window.clearInterval(id);
  }, [refreshMs]);

  const separator = src.includes("?") ? "&" : "?";
  const bustedSrc = `${src}${separator}_t=${tick}`;

  return <img className={className} src={bustedSrc} alt={alt} />;
}
