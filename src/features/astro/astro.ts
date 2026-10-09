import * as Astronomy from "astronomy-engine";
import type {
  DaySummary,
  DirectionSample,
  MilkyWayDirectionSample,
  MilkyWayResult,
  MoonInfo,
  TwilightTimes,
  VisibilityWindow,
} from "../../types";

/** 月齢(直近の新月からの経過日数)と輝面比を計算する。観測地点によらず時刻のみで決まる */
export function getMoonInfo(date: Date): MoonInfo {
  const prevNewMoon = Astronomy.SearchMoonPhase(0, date, -40);
  const ageDays = prevNewMoon ? (date.getTime() - prevNewMoon.date.getTime()) / 86_400_000 : NaN;
  const illumination = Astronomy.Illumination(Astronomy.Body.Moon, date).phase_fraction;
  return { ageDays, illumination };
}

/**
 * 銀河中心(Sgr A*, いて座方向)の J2000 座標。
 * RA: 17h45m40.04s -> 時間(hours)単位で DefineStar に渡す必要がある。
 * Dec: -29°00'28.1"
 * 出典: IAU / 一般的な値。恒星として登録することで歳差・章動を含めた
 * 正しい地平座標(仰角)を astronomy-engine に計算させられる。
 */
const GALACTIC_CENTER_RA_HOURS = 266.4168 / 15;
const GALACTIC_CENTER_DEC_DEG = -29.0078;
const GALACTIC_CENTER_BODY = Astronomy.Body.Star1;

Astronomy.DefineStar(
  GALACTIC_CENTER_BODY,
  GALACTIC_CENTER_RA_HOURS,
  GALACTIC_CENTER_DEC_DEG,
  26000, // 銀河中心までの概算距離(光年)。方向の計算には影響しない。
);

const MILKY_WAY_MIN_ALTITUDE_DEG = 15;
const SAMPLE_STEP_MINUTES = 5;

/** 指定天体の地平座標(仰角・方位角)をまとめて計算する */
function horizonOf(
  body: Astronomy.Body,
  time: Date,
  observer: Astronomy.Observer,
): Astronomy.HorizontalCoordinates {
  const eq = Astronomy.Equator(body, time, observer, true, true);
  return Astronomy.Horizon(time, observer, eq.ra, eq.dec, "normal");
}

function altitudeOf(body: Astronomy.Body, time: Date, observer: Astronomy.Observer): number {
  return horizonOf(body, time, observer).altitude;
}

/** 指定天体の方位角(0〜360°, 北=0/東=90)を計算する */
function azimuthOf(body: Astronomy.Body, time: Date, observer: Astronomy.Observer): number {
  return horizonOf(body, time, observer).azimuth;
}

function isMilkyWayVisibleAt(time: Date, observer: Astronomy.Observer): boolean {
  const gcAlt = altitudeOf(GALACTIC_CENTER_BODY, time, observer);
  if (gcAlt < MILKY_WAY_MIN_ALTITUDE_DEG) return false;
  const moonAlt = altitudeOf(Astronomy.Body.Moon, time, observer);
  if (moonAlt >= 0) return false;
  return true;
}

/** [start, end] を stepMinutes 刻みでサンプリングし、条件を満たす連続区間をまとめて返す */
function sampleWindows(
  observer: Astronomy.Observer,
  start: Date,
  end: Date,
  stepMinutes: number,
): VisibilityWindow[] {
  const windows: VisibilityWindow[] = [];
  if (end.getTime() <= start.getTime()) return windows;

  const stepMs = stepMinutes * 60_000;
  let windowStart: Date | null = null;
  let t = start.getTime();

  while (t <= end.getTime()) {
    const time = new Date(t);
    const ok = isMilkyWayVisibleAt(time, observer);
    if (ok && windowStart === null) {
      windowStart = time;
    } else if (!ok && windowStart !== null) {
      windows.push({ start: windowStart, end: time });
      windowStart = null;
    }
    t += stepMs;
  }
  if (windowStart !== null) {
    windows.push({ start: windowStart, end });
  }
  return windows;
}

/** 指定した暦日(ローカル時刻の 0:00)の 0:00 を返す */
function localDayStart(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0);
}

/** [start, end] の範囲内にある、時刻(分・秒0)ちょうどのタイムスタンプを列挙する */
function hourlyTimestampsInRange(start: Date, end: Date): Date[] {
  const result: Date[] = [];
  if (end.getTime() <= start.getTime()) return result;

  const t = new Date(start);
  t.setMinutes(0, 0, 0);
  if (t.getTime() < start.getTime()) t.setHours(t.getHours() + 1);

  while (t.getTime() <= end.getTime()) {
    result.push(new Date(t));
    t.setHours(t.getHours() + 1);
  }
  return result;
}

/** 天文薄明終了〜翌天文薄明開始の間、1時間ごとの銀河中心の方角・高度・観測可否を求める */
function sampleDirections(
  observer: Astronomy.Observer,
  start: Date,
  end: Date,
): MilkyWayDirectionSample[] {
  return hourlyTimestampsInRange(start, end).map((time) => {
    const hor = horizonOf(GALACTIC_CENTER_BODY, time, observer);
    const moonAlt = altitudeOf(Astronomy.Body.Moon, time, observer);
    return {
      time,
      azimuthDeg: hor.azimuth,
      altitudeDeg: hor.altitude,
      visible: hor.altitude >= MILKY_WAY_MIN_ALTITUDE_DEG && moonAlt < 0,
    };
  });
}

/** [start, end] の間、1時間ごとの指定天体の方角・高度を求める(太陽・月のスライダー表示用) */
function sampleBodyDirections(
  body: Astronomy.Body,
  observer: Astronomy.Observer,
  start: Date,
  end: Date,
): DirectionSample[] {
  return hourlyTimestampsInRange(start, end).map((time) => {
    const hor = horizonOf(body, time, observer);
    return { time, azimuthDeg: hor.azimuth, altitudeDeg: hor.altitude };
  });
}

/**
 * 指定した緯度経度・日付(端末のローカル暦日)について、
 * 日の出没・天文薄明・月の出没・天の川(銀河中心)観測可能時間帯を計算する。
 */
export function computeMilkyWayVisibility(
  lat: number,
  lng: number,
  forDate: Date,
  stepMinutes: number = SAMPLE_STEP_MINUTES,
): MilkyWayResult {
  const observer = new Astronomy.Observer(lat, lng, 0);
  const dayStart = localDayStart(forDate);
  const warnings: string[] = [];

  const sunrise = Astronomy.SearchRiseSet(Astronomy.Body.Sun, observer, +1, dayStart, 1.5);
  const sunset = Astronomy.SearchRiseSet(Astronomy.Body.Sun, observer, -1, dayStart, 1.5);

  const duskSearchStart = sunset?.date ?? dayStart;
  const astroDusk = Astronomy.SearchAltitude(
    Astronomy.Body.Sun,
    observer,
    -1,
    duskSearchStart,
    1.5,
    -18,
  );

  const dawnSearchStart = astroDusk?.date ?? duskSearchStart;
  const astroDawn = Astronomy.SearchAltitude(
    Astronomy.Body.Sun,
    observer,
    +1,
    dawnSearchStart,
    1.5,
    -18,
  );

  const moonrise = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, +1, dayStart, 2);
  const moonset = Astronomy.SearchRiseSet(Astronomy.Body.Moon, observer, -1, dayStart, 2);

  const twilight: TwilightTimes = {
    sunrise: sunrise?.date ?? null,
    sunset: sunset?.date ?? null,
    astroDusk: astroDusk?.date ?? null,
    astroDawn: astroDawn?.date ?? null,
    moonrise: moonrise?.date ?? null,
    moonset: moonset?.date ?? null,
    sunriseAzimuthDeg: sunrise ? azimuthOf(Astronomy.Body.Sun, sunrise.date, observer) : null,
    sunsetAzimuthDeg: sunset ? azimuthOf(Astronomy.Body.Sun, sunset.date, observer) : null,
    moonriseAzimuthDeg: moonrise ? azimuthOf(Astronomy.Body.Moon, moonrise.date, observer) : null,
    moonsetAzimuthDeg: moonset ? azimuthOf(Astronomy.Body.Moon, moonset.date, observer) : null,
  };

  let windows: VisibilityWindow[] = [];
  let directionSamples: MilkyWayDirectionSample[] = [];

  if (!astroDusk || !astroDawn) {
    warnings.push(
      "この地点・時期は天文薄明が終わらない(白夜に近い状態)ため、天の川の観測可能時間帯を算出できません。",
    );
  } else {
    windows = sampleWindows(observer, astroDusk.date, astroDawn.date, stepMinutes);
    directionSamples = sampleDirections(observer, astroDusk.date, astroDawn.date);
    if (windows.length === 0) {
      // 薄明は暗くなるが、銀河中心が十分な高度に上がらない/一晩中月が出ている、等
      let maxAlt = -90;
      const stepMs = stepMinutes * 60_000;
      for (let t = astroDusk.date.getTime(); t <= astroDawn.date.getTime(); t += stepMs) {
        const alt = altitudeOf(GALACTIC_CENTER_BODY, new Date(t), observer);
        if (alt > maxAlt) maxAlt = alt;
      }
      if (maxAlt < MILKY_WAY_MIN_ALTITUDE_DEG) {
        warnings.push(
          `この地点ではこの晩、銀河中心の最大仰角が${maxAlt.toFixed(1)}度までしか上がらず、15度以上になりません。`,
        );
      } else {
        warnings.push("この晩は一晩中月が出ているため、天の川を観測できる時間帯がありません。");
      }
    }
  }

  const moon = getMoonInfo(dayStart);

  // 選択日の0時〜23時、1時間ごとの太陽・月の方角(スライダーで任意の時刻を選べるようにするため)。
  // 天の川と違い観測可能条件は関係ないため、暦日いっぱいをサンプリングする。
  const dayEnd = new Date(dayStart.getTime() + 23 * 60 * 60 * 1000);
  const sunDirectionSamples = sampleBodyDirections(Astronomy.Body.Sun, observer, dayStart, dayEnd);
  const moonDirectionSamples = sampleBodyDirections(Astronomy.Body.Moon, observer, dayStart, dayEnd);

  return {
    lat,
    lng,
    twilight,
    moon,
    windows,
    directionSamples,
    sunDirectionSamples,
    moonDirectionSamples,
    warnings,
  };
}

/** カレンダー表示用に月間サンプリング刻みを粗くして計算負荷を抑える(既定より粗い10分刻み) */
const CALENDAR_SAMPLE_STEP_MINUTES = 10;

/**
 * 指定した年月(0始まり月)の全日について、その晩の天の川観測可能時間の合計をまとめて計算する。
 * カレンダーUIでの一覧表示用。1日ごとの詳細計算より粗いサンプリング間隔を使い、体感速度を優先する。
 */
export function computeMonthSummary(lat: number, lng: number, year: number, month0: number): DaySummary[] {
  const daysInMonth = new Date(year, month0 + 1, 0).getDate();
  const results: DaySummary[] = [];

  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month0, day);
    const { windows } = computeMilkyWayVisibility(lat, lng, date, CALENDAR_SAMPLE_STEP_MINUTES);
    const totalMinutes = windows.reduce(
      (sum, w) => sum + (w.end.getTime() - w.start.getTime()) / 60_000,
      0,
    );
    results.push({ date, totalMinutes, windows });
  }

  return results;
}
