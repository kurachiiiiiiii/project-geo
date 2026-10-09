import * as Astronomy from "astronomy-engine";
import { DEG, clamp, smoothstep, type Vec3 } from "./viewerMath";

/**
 * 3Dビューワー: 太陽・月の位置(地平座標)と、その位置から決める空・光の色。
 * 位置の計算は天文情報パネルと同じ astronomy-engine(大気差あり "normal")を使う。
 */

export interface BodyPos {
  azimuthDeg: number;
  altitudeDeg: number;
}

export type BodyName = "Sun" | "Moon";

function bodyOf(name: BodyName): Astronomy.Body {
  return name === "Sun" ? Astronomy.Body.Sun : Astronomy.Body.Moon;
}

/** 緯度経度・時刻での太陽/月の方位角(北=0・東=90)と仰角 */
export function bodyHorizon(name: BodyName, time: Date, lat: number, lon: number): BodyPos {
  const observer = new Astronomy.Observer(lat, lon, 0);
  const eq = Astronomy.Equator(bodyOf(name), time, observer, true, true);
  const hor = Astronomy.Horizon(time, observer, eq.ra, eq.dec, "normal");
  return { azimuthDeg: hor.azimuth, altitudeDeg: hor.altitude };
}

export interface MoonPhase {
  /** 輝面比(0〜1) */
  illumination: number;
  /** 月齢(直近の新月からの日数)。求められなければNaN */
  ageDays: number;
}

/** その時刻の月の輝面比(0〜1)。スライダーを動かすたびに呼んでも軽い */
export function moonIlluminationAt(time: Date): number {
  return Astronomy.Illumination(Astronomy.Body.Moon, time).phase_fraction;
}

export function moonPhaseAt(time: Date): MoonPhase {
  const illumination = Astronomy.Illumination(Astronomy.Body.Moon, time).phase_fraction;
  const prevNewMoon = Astronomy.SearchMoonPhase(0, time, -40);
  const ageDays = prevNewMoon ? (time.getTime() - prevNewMoon.date.getTime()) / 86_400_000 : NaN;
  return { illumination, ageDays };
}

export interface RiseSetTimes {
  sunrise: Date | null;
  sunset: Date | null;
  solarNoon: Date | null;
  moonrise: Date | null;
  moonset: Date | null;
}

/** その日(端末のローカル暦日の0時から)の日の出・日の入り・南中・月の出・月の入り */
export function riseSetTimes(lat: number, lon: number, dayStart: Date): RiseSetTimes {
  const observer = new Astronomy.Observer(lat, lon, 0);
  const find = (body: Astronomy.Body, dir: 1 | -1): Date | null => {
    try {
      return Astronomy.SearchRiseSet(body, observer, dir, dayStart, 1)?.date ?? null;
    } catch {
      return null;
    }
  };
  let solarNoon: Date | null = null;
  try {
    solarNoon = Astronomy.SearchHourAngle(Astronomy.Body.Sun, observer, 0, dayStart)?.time.date ?? null;
  } catch {
    solarNoon = null;
  }
  const endMs = dayStart.getTime() + 86_400_000;
  const inDay = (d: Date | null): Date | null => (d && d.getTime() < endMs ? d : null);
  return {
    sunrise: inDay(find(Astronomy.Body.Sun, +1)),
    sunset: inDay(find(Astronomy.Body.Sun, -1)),
    solarNoon: inDay(solarNoon),
    moonrise: inDay(find(Astronomy.Body.Moon, +1)),
    moonset: inDay(find(Astronomy.Body.Moon, -1)),
  };
}

export interface PathSample {
  time: Date;
  azimuthDeg: number;
  altitudeDeg: number;
}

/** その日の0時から24時まで、stepMinutes刻みの太陽/月の位置(軌跡の描画用) */
export function pathSamples(
  name: BodyName,
  lat: number,
  lon: number,
  dayStart: Date,
  stepMinutes = 10,
): PathSample[] {
  const out: PathSample[] = [];
  const n = Math.round((24 * 60) / stepMinutes);
  for (let i = 0; i <= n; i++) {
    const time = new Date(dayStart.getTime() + i * stepMinutes * 60_000);
    const p = bodyHorizon(name, time, lat, lon);
    out.push({ time, azimuthDeg: p.azimuthDeg, altitudeDeg: p.altitudeDeg });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 天の川(銀河座標の向きと、銀河中心の位置)
// ---------------------------------------------------------------------------

/** 銀河中心(いて座A*)の赤道座標(J2000)。天文情報パネル(`features/astro/astro.ts`)と同じ値 */
const GC_RA_DEG = 266.4168;
const GC_DEC_DEG = -29.0078;
/** 銀河座標の基準(IAU1958): 銀河の北極 と 銀河中心方向(l=0,b=0)の赤道座標(J2000) */
const NGP_RA_DEG = 192.85948;
const NGP_DEC_DEG = 27.12825;
const GX_RA_DEG = 266.40499;
const GX_DEC_DEG = -28.93617;

function eqjUnit(raDeg: number, decDeg: number): Astronomy.Vector {
  const ra = raDeg * DEG;
  const dec = decDeg * DEG;
  return new Astronomy.Vector(Math.cos(dec) * Math.cos(ra), Math.cos(dec) * Math.sin(ra), Math.sin(dec), Astronomy.MakeTime(new Date(0)));
}

/** 地平座標(x=北・y=西・z=天頂)のベクトル → このビューワーの座標(X東・Y上・Z南) */
function horToLocal(v: Astronomy.Vector): Vec3 {
  return [-v.y, v.z, -v.x];
}

export interface MilkyWayFrame {
  /** 銀河中心の方向、銀河座標のl=90°の方向、銀河の北極の方向(どれもX東・Y上・Z南の単位ベクトル) */
  gx: Vec3;
  gy: Vec3;
  gz: Vec3;
  /** 銀河中心の方位角・仰角(度) */
  center: BodyPos;
}

/** その時刻・場所での、天の川(銀河面)の向きと銀河中心の位置 */
export function milkyWayFrame(time: Date, lat: number, lon: number): MilkyWayFrame {
  const observer = new Astronomy.Observer(lat, lon, 0);
  const rot = Astronomy.Rotation_EQJ_HOR(time, observer);
  const gx = horToLocal(Astronomy.RotateVector(rot, eqjUnit(GX_RA_DEG, GX_DEC_DEG)));
  const gz = horToLocal(Astronomy.RotateVector(rot, eqjUnit(NGP_RA_DEG, NGP_DEC_DEG)));
  // gy = gz × gx
  const gy: Vec3 = [
    gz[1] * gx[2] - gz[2] * gx[1],
    gz[2] * gx[0] - gz[0] * gx[2],
    gz[0] * gx[1] - gz[1] * gx[0],
  ];
  const c = horToLocal(Astronomy.RotateVector(rot, eqjUnit(GC_RA_DEG, GC_DEC_DEG)));
  const altitudeDeg = Math.asin(clamp(c[1], -1, 1)) / DEG;
  const azimuthDeg = ((Math.atan2(c[0], -c[2]) / DEG) % 360 + 360) % 360;
  return { gx, gy, gz, center: { azimuthDeg, altitudeDeg } };
}

/** 銀河中心の位置だけ(軌跡の描画用) */
export function galacticCenterHorizon(time: Date, lat: number, lon: number): BodyPos {
  return milkyWayFrame(time, lat, lon).center;
}

/** その日の0時から24時まで、stepMinutes刻みの銀河中心の位置(軌跡の描画用) */
export function galacticCenterPath(lat: number, lon: number, dayStart: Date, stepMinutes = 10): PathSample[] {
  const out: PathSample[] = [];
  const n = Math.round((24 * 60) / stepMinutes);
  for (let i = 0; i <= n; i++) {
    const time = new Date(dayStart.getTime() + i * stepMinutes * 60_000);
    const p = galacticCenterHorizon(time, lat, lon);
    out.push({ time, azimuthDeg: p.azimuthDeg, altitudeDeg: p.altitudeDeg });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 空と光の色(太陽の高さで決める)
// ---------------------------------------------------------------------------

/** 太陽の高さ(度)ごとの、天頂・地平線付近の空の色(0〜1のRGB) */
const SKY_KEYS: { alt: number; zenith: Vec3; horizon: Vec3 }[] = [
  { alt: -20, zenith: [0.008, 0.012, 0.04], horizon: [0.03, 0.04, 0.09] },
  { alt: -14, zenith: [0.02, 0.03, 0.09], horizon: [0.1, 0.11, 0.19] },
  { alt: -8, zenith: [0.05, 0.07, 0.17], horizon: [0.28, 0.24, 0.35] },
  { alt: -4, zenith: [0.1, 0.14, 0.3], horizon: [0.6, 0.38, 0.4] },
  { alt: 0, zenith: [0.2, 0.28, 0.5], horizon: [0.98, 0.6, 0.35] },
  { alt: 3, zenith: [0.28, 0.4, 0.65], horizon: [0.95, 0.75, 0.55] },
  { alt: 10, zenith: [0.25, 0.45, 0.78], horizon: [0.78, 0.8, 0.85] },
  { alt: 30, zenith: [0.2, 0.45, 0.85], horizon: [0.7, 0.82, 0.95] },
];

function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export interface SkyLook {
  zenith: Vec3;
  horizon: Vec3;
  /** 地面より下(地形の外)に見える色 */
  ground: Vec3;
  /** 地形を照らす環境光 */
  ambient: Vec3;
  sunColor: Vec3;
  /** 太陽の直射の強さ(0〜1。地平線の下では0) */
  sunStrength: number;
  moonColor: Vec3;
  /** 月明かりの強さ(0〜1。月が出ていて、太陽が沈んでいるほど強い。輝面比にも比例) */
  moonStrength: number;
  /** 夜の度合い(0=昼、1=夜)。星の表示に使う */
  night: number;
  /** 空の中で太陽の円盤を描く明るさ(地平線の少し下まで残す) */
  sunVisible: number;
  /** 天の川の見え方(0=見えない、1=最もよく見える)。空が暗い夜ほど、月明かりが弱いほど強い */
  milkyWay: number;
}

export function skyLook(sunAltDeg: number, moonAltDeg: number, moonIllumination: number): SkyLook {
  const a = clamp(sunAltDeg, SKY_KEYS[0].alt, SKY_KEYS[SKY_KEYS.length - 1].alt);
  let i = 0;
  while (i < SKY_KEYS.length - 2 && a > SKY_KEYS[i + 1].alt) i++;
  const k0 = SKY_KEYS[i];
  const k1 = SKY_KEYS[i + 1];
  const t = (a - k0.alt) / (k1.alt - k0.alt);
  let zenith = lerp3(k0.zenith, k1.zenith, t);
  let horizon = lerp3(k0.horizon, k1.horizon, t);

  const dayFactor = smoothstep(-8, 8, sunAltDeg);
  const night = 1 - smoothstep(-16, -4, sunAltDeg);
  const moonUp = smoothstep(-2, 6, moonAltDeg);
  const moonGlow = moonUp * moonIllumination * night;
  // 月明かりで夜空をほんの少し明るく青くする
  zenith = [zenith[0] + 0.01 * moonGlow, zenith[1] + 0.025 * moonGlow, zenith[2] + 0.06 * moonGlow];
  horizon = [horizon[0] + 0.02 * moonGlow, horizon[1] + 0.04 * moonGlow, horizon[2] + 0.07 * moonGlow];

  const ground = lerp3([0.02, 0.03, 0.04], [0.32, 0.34, 0.3], dayFactor);
  const ambient = lerp3([0.07, 0.08, 0.13], [0.5, 0.54, 0.62], dayFactor);
  const sunColor = lerp3([1.0, 0.55, 0.3], [1.0, 0.96, 0.88], smoothstep(0, 25, sunAltDeg));
  const sunStrength = smoothstep(-1, 7, sunAltDeg);
  const moonStrength = moonUp * moonIllumination * (1 - dayFactor);

  return {
    zenith,
    horizon,
    ground,
    ambient,
    sunColor,
    sunStrength,
    moonColor: [0.55, 0.65, 1.0],
    moonStrength,
    night,
    sunVisible: smoothstep(-4, 0, sunAltDeg),
    milkyWay: (1 - smoothstep(-18, -10, sunAltDeg)) * (1 - 0.85 * moonUp * moonIllumination),
  };
}
