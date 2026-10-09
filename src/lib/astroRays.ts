import { Moon, Sunrise, Sunset, type LucideIcon } from "./lucide";
/**
 * 日の出没・月の出没それぞれの方角の線の見た目定義。
 * AstroPanel(ボタンの色分け)とAstroPointPopup(地図に引く線の色分け)の両方から参照するため、
 * 循環importを避けてここに切り出している。
 */
export type SunMoonRayKey = "sunrise" | "sunset" | "moonrise" | "moonset";

export const SUN_MOON_RAY_STYLE: Record<
  SunMoonRayKey,
  { color: string; label: string; icon: LucideIcon; dashArray?: string }
> = {
  sunrise: { color: "#ffb454", label: "日の出", icon: Sunrise },
  sunset: { color: "#ffb454", label: "日の入り", icon: Sunset, dashArray: "7 7" },
  moonrise: { color: "#7fd6ff", label: "月の出", icon: Moon },
  moonset: { color: "#7fd6ff", label: "月の入り", icon: Moon, dashArray: "7 7" },
};

export const MILKY_WAY_RAY_COLOR = "#c084fc";

/** スライダーで選んだ任意の時刻の太陽・月の方角の線の色(日の出没の線とは点線で区別する) */
export const SUN_TIME_RAY_COLOR = "#ffb454";
export const MOON_TIME_RAY_COLOR = "#7fd6ff";
export const SUN_MOON_TIME_RAY_DASH = "2 6";
