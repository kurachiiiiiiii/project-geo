import type { LucideIcon, LucideProps } from "../lib/lucide";

/**
 * 画面全体の「絵文字を廃止してLucideアイコンに統一」への対応。文字の中に置く小さなアイコン。
 * 大きさは文字(1em基準)に合わせ、色は文字色(currentColor)を引き継ぐ。装飾なので読み上げ対象にしない。
 */
export function Ico({
  icon: Icon,
  size = "1.15em",
  strokeWidth = 2,
  className,
  ...rest
}: { icon: LucideIcon } & LucideProps) {
  return (
    <Icon
      size={size}
      strokeWidth={strokeWidth}
      className={className ? `ico ${className}` : "ico"}
      aria-hidden="true"
      {...rest}
    />
  );
}

/**
 * 月の満ち欠けのアイコン(Lucideに月相のアイコンが無いため、同じ線の太さ・丸みで描いたもの)。
 * age は月齢(0=新月〜約29.5日=次の新月)。明るい側(北半球から見て、満ちていく間は右側)を塗る。
 */
export function MoonPhaseIcon({ age, size = "1.15em" }: { age: number; size?: number | string }) {
  const a = ((age % 29.530588) + 29.530588) % 29.530588;
  const frac = a / 29.530588; // 0..1
  const waxing = frac < 0.5;
  // 明るい部分の幅。cosで滑らかに(0=新月:欠けのみ、0.5=満月:全面)
  const k = Math.cos(frac * 2 * Math.PI); // 1(新月)→-1(満月)→1
  const R = 9;
  const rx = Math.abs(k) * R; // 欠けの境の楕円の半径
  // 右半分(満ちていく間に明るい側)から、境の楕円で削るか足す
  const lit = waxing ? "right" : "left";
  const sweepOuter = lit === "right" ? 1 : 0;
  // 境の線: 三日月側(k>0)は明るい半円から楕円を引く、凸の側(k<0)は足す
  const sweepInner = k > 0 ? (lit === "right" ? 0 : 1) : lit === "right" ? 1 : 0;
  const d = `M12 ${12 - R} A ${R} ${R} 0 0 ${sweepOuter} 12 ${12 + R} A ${rx.toFixed(2)} ${R} 0 0 ${sweepInner} 12 ${12 - R} Z`;
  return (
    <svg
      className="ico"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r={R} />
      <path d={d} fill="currentColor" stroke="none" />
    </svg>
  );
}
