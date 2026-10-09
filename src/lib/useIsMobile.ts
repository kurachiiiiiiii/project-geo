import { useEffect, useState } from "react";

/**
 * 画面幅がスマホサイズかどうかの分かれ目(px)。`App.tsx`の`controlsOpen`初期値
 * (レイヤー一覧を既定で畳むかどうか)と同じ基準に揃えている。
 */
export const MOBILE_BREAKPOINT_PX = 720;

/**
 * 画面幅がスマホサイズ(720px未満)かどうか。画面回転などでの変化にも追従する
 * (スマホの横向きは720pxを超えることがあるため、マウント時の1回きりの判定では不十分)。
 */
/** `window.innerWidth`が0(レイアウト確定前などで未計測)のときは、素直にPC相当として扱う */
function computeIsMobile(): boolean {
  const w = window.innerWidth;
  if (w <= 0) return false;
  return w < MOBILE_BREAKPOINT_PX;
}

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(computeIsMobile);
  useEffect(() => {
    const onResize = () => setIsMobile(computeIsMobile());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return isMobile;
}
