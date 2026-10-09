/**
 * 方位角(0〜360°, 北=0/東=90/南=180/西=270)を16方位の日本語名に変換する。
 * アメダスの風向コード(0〜16の整数値)とは別物で、こちらは連続値の角度を扱う。
 */
const COMPASS_LABELS_16 = [
  "北",
  "北北東",
  "北東",
  "東北東",
  "東",
  "東南東",
  "南東",
  "南南東",
  "南",
  "南南西",
  "南西",
  "西南西",
  "西",
  "西北西",
  "北西",
  "北北西",
] as const;

export function azimuthLabel(azimuthDeg: number): string {
  const normalized = ((azimuthDeg % 360) + 360) % 360;
  const index = Math.round(normalized / 22.5) % 16;
  return COMPASS_LABELS_16[index];
}

/** 「南東 135°」のような、方位名と度数を併記した表示用文字列を作る */
export function formatDirection(azimuthDeg: number): string {
  return `${azimuthLabel(azimuthDeg)} ${Math.round(azimuthDeg)}°`;
}
