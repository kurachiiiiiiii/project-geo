import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_LAPSE_C_PER_M, type KoyoRegionId } from "./koyoClimate";
import { demLoadProblem, elevationAt } from "./koyoDem";
import {
  dayNumber,
  isForecastFresh,
  loadCachedKoyoForecast,
  loadKoyoForecast,
  type KoyoForecastBundle,
} from "./koyoForecast";
import {
  buildStationT0,
  buildStationT0Ahead,
  buildStationT0Past,
  classAtPoint,
  pointTimeline,
  type KoyoClimateInput,
  type PointClass,
  type PointTimelineRow,
} from "./koyoModel";
import {
  EARLY_SPECIES_ID,
  KOYO_SPECIES,
  KOYO_SPECIES_BY_ID,
  VEG_CLASS,
  earlyMixApplies,
  type KoyoSpeciesId,
} from "./koyoSpecies";
import { makeSeasonContext, type KoyoSeasonContext } from "./koyoSeason";
import { loadKoyoSnowZones, type KoyoSnowZoneLoad } from "./koyoSnowZones";
import { loadKoyoVegetation, type KoyoVegetationLoad } from "./koyoVegetation";
import { errorMessage } from "../../lib/errorMessage";

/**
 * 紅葉マップの状態管理(App.tsxに状態を増やしすぎないよう、1つのフックにまとめている)。
 * 表示のON/OFF・日付・不透明度・地域別補正・逓減率、長期予報と植生グリッドの読み込み、
 * 地図でクリックした地点の樹種別の見頃までを扱う。
 */

const SETTINGS_KEY = "koyoSettingsV1";

interface StoredSettings {
  opacity: number;
  /** 長期予報の補正を反映するか(なしにすると、平年並みで計算する) */
  useForecast: boolean;
  /** チェックリストで外した(表示しない)植生クラスのコード */
  hiddenClasses: number[];
}

/**
 * 地域別の気温補正と気温逓減率の調整は、画面から撤去した(「長期予報の補正 あり/なし」だけにした)。
 * 以前の版で保存された補正値が見えないまま効き続けないよう、保存値は読まずに、常に補正なし・既定の逓減率にする。
 */
const NO_ADJUST: Partial<Record<KoyoRegionId, number>> = {};

/** チェックリストで出し入れできる植生クラス(樹種+常緑樹林)。`none`(森林以外)は対象外 */
const TOGGLEABLE_CLASS_CODES: readonly number[] = [
  ...KOYO_SPECIES.map((s) => s.classCode),
  VEG_CLASS.evergreen,
];

function loadSettings(): StoredSettings {
  const fallback: StoredSettings = { opacity: 0.75, useForecast: true, hiddenClasses: [] };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const s = JSON.parse(raw) as Partial<StoredSettings>;
    return {
      opacity: typeof s.opacity === "number" ? Math.min(1, Math.max(0.1, s.opacity)) : fallback.opacity,
      useForecast: typeof s.useForecast === "boolean" ? s.useForecast : fallback.useForecast,
      hiddenClasses: Array.isArray(s.hiddenClasses)
        ? s.hiddenClasses.filter((c): c is number => typeof c === "number" && TOGGLEABLE_CLASS_CODES.includes(c))
        : [],
    };
  } catch {
    return fallback;
  }
}

/** 日本時間の今日(暦日)を「1970年1月1日からの日数」で返す */
export function todayDayJst(now = new Date()): number {
  const jst = new Date(now.getTime() + 9 * 3_600_000);
  return dayNumber(jst.getUTCFullYear(), jst.getUTCMonth() + 1, jst.getUTCDate());
}

/**
 * 日付スライダーの範囲: その年の1月1日〜12月31日。春(雪解け・新緑)・夏・秋(紅葉)・冬(雪)の通年を見られるようにした
 * (かつては9月1日〜12月31日の紅葉の時期だけだった)。
 */
export function koyoDayRange(today: number): { start: number; end: number } {
  const year = new Date(today * 86_400_000).getUTCFullYear();
  return { start: dayNumber(year, 1, 1), end: dayNumber(year, 12, 31) };
}

/** 紅葉の見頃などを調べる期間: その年の9月1日〜12月31日(紅葉の時期をおおよそ覆う) */
export function koyoAutumnRange(today: number): { start: number; end: number } {
  const year = new Date(today * 86_400_000).getUTCFullYear();
  return { start: dayNumber(year, 9, 1), end: dayNumber(year, 12, 31) };
}

export interface KoyoPointInfo {
  lat: number;
  lng: number;
  /** 標高(m)。取得できなければnull */
  elevM: number | null;
  loading: boolean;
  cls: PointClass | null;
  rows: PointTimelineRow[];
  /**
   * この地点が落葉広葉樹林の「混生帯」にあたるとき、ナナカマドなど早く紅葉する種類の見頃
   * (`rows`のうち`EARLY_SPECIES_ID`の行)。当てはまらなければnull(`koyoSpecies.ts`の`earlyMixApplies`参照)
   */
  earlyRow: PointTimelineRow | null;
}

export interface KoyoController {
  visible: boolean;
  setVisible: (v: boolean) => void;
  day: number;
  setDay: (d: number) => void;
  today: number;
  /** 日付スライダーの範囲(通年) */
  dayRange: { start: number; end: number };
  /** 紅葉の見頃・色づき始め・落葉を調べる期間(9/1〜12/31)。「見頃は〇月〇日ごろ」の表示に使う */
  autumnRange: { start: number; end: number };
  opacity: number;
  setOpacity: (v: number) => void;
  lapseCPerM: number;
  /** 長期予報の補正を反映するか(false=平年並みで計算) */
  useForecast: boolean;
  setUseForecast: (v: boolean) => void;
  /** 取得した長期予報(補正のあり/なしにかかわらず、取得済みのもの) */
  forecast: KoyoForecastBundle | null;
  forecastLoading: boolean;
  forecastError: string | null;
  reloadForecast: () => void;
  veg: KoyoVegetationLoad | null;
  /** 豪雪地帯・特別豪雪地帯のグリッド(雪解けの時期の前倒しに使う) */
  snowZones: KoyoSnowZoneLoad | null;
  /** 通年モデル(新緑・雪・雪解け)の気温などの束。地図と3Dの描画に渡す */
  season: KoyoSeasonContext;
  /** 地図が描画に使うもの */
  stationT0: Float32Array;
  /** 同・低標高の前倒し補正に使う、`LOWLAND_ADVANCE_DAYS`日先の値 */
  stationT0Ahead: Float32Array;
  /** 同・`WHITE_AFTER_FALL_DAYS`日前の値(落葉して2週間たった所を白にするのに使う) */
  stationT0Past: Float32Array;
  /** 標高タイルが1枚も読めない状態のときのメッセージ */
  demProblem: string | null;
  climateInput: KoyoClimateInput;
  /** チェックリスト(左上)で外された植生クラスのコード(=地図に描かない樹種) */
  hiddenClasses: ReadonlySet<number>;
  /** 樹種(植生クラス)の表示ON/OFFを切り替える */
  setClassShown: (classCode: number, shown: boolean) => void;
  /** 全樹種をまとめてON(true)/OFF(false)にする */
  setAllClassesShown: (shown: boolean) => void;
  /** 表の「基準にする樹種」 */
  tableSpeciesId: KoyoSpeciesId;
  setTableSpeciesId: (id: KoyoSpeciesId) => void;
  point: KoyoPointInfo | null;
}

export function useKoyo(selectedPoint: { lat: number; lng: number } | null): KoyoController {
  const initial = useMemo(() => loadSettings(), []);
  const today = useMemo(() => todayDayJst(), []);
  const dayRange = useMemo(() => koyoDayRange(today), [today]);
  const autumnRange = useMemo(() => koyoAutumnRange(today), [today]);

  const [visible, setVisible] = useState(false);
  const [day, setDay] = useState(() => Math.min(dayRange.end, Math.max(dayRange.start, today)));
  const [opacity, setOpacity] = useState(initial.opacity);
  const lapseCPerM = DEFAULT_LAPSE_C_PER_M;
  const adjustC = NO_ADJUST;
  const [useForecast, setUseForecast] = useState(initial.useForecast);
  const [tableSpeciesId, setTableSpeciesId] = useState<KoyoSpeciesId>("maple");
  const [hiddenClassList, setHiddenClassList] = useState<number[]>(initial.hiddenClasses);
  const hiddenClasses = useMemo<ReadonlySet<number>>(() => new Set(hiddenClassList), [hiddenClassList]);

  const [forecast, setForecast] = useState<KoyoForecastBundle | null>(() => loadCachedKoyoForecast());
  // 補正「あり」のときだけ、取得した長期予報を計算に使う(「なし」は平年並み)
  const activeForecast = useForecast ? forecast : null;
  const [forecastLoading, setForecastLoading] = useState(false);
  const [forecastError, setForecastError] = useState<string | null>(null);
  const [veg, setVeg] = useState<KoyoVegetationLoad | null>(null);
  const [snowZones, setSnowZones] = useState<KoyoSnowZoneLoad | null>(null);
  const [demProblem, setDemProblem] = useState<string | null>(null);

  // 設定の保存(補正・不透明度・逓減率は次回起動時にも残す)
  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ opacity, useForecast, hiddenClasses: hiddenClassList }));
    } catch {
      // 保存できなくても動作に支障はない
    }
  }, [opacity, useForecast, hiddenClassList]);

  const forecastStarted = useRef(false);
  const loadForecast = useCallback((force: boolean) => {
    setForecastLoading(true);
    setForecastError(null);
    loadKoyoForecast(force)
      .then((b) => setForecast(b))
      .catch((e: unknown) => setForecastError(errorMessage(e)))
      .finally(() => setForecastLoading(false));
  }, []);

  // 植生グリッド・長期予報・地点の標高は、紅葉マップを表示しているときだけでなく、天文情報パネルに
  // 「紅葉のピーク時期・植生の種類」を出すために地点を選んだときにも必要になる。
  const needed = visible || selectedPoint !== null;

  // 初めて必要になったときに、植生グリッドと長期予報を読み込む
  const vegStarted = useRef(false);
  useEffect(() => {
    if (!needed) return;
    if (!vegStarted.current) {
      vegStarted.current = true;
      loadKoyoVegetation().then(setVeg);
      loadKoyoSnowZones().then(setSnowZones);
    }
    if (!forecastStarted.current) {
      forecastStarted.current = true;
      // 取得中の表示(setState)をeffectの同期処理で行わないよう、次のマイクロタスクで始める
      if (!isForecastFresh(loadCachedKoyoForecast())) queueMicrotask(() => loadForecast(false));
    }
  }, [needed, loadForecast]);

  // 標高タイルの取得状況(1枚も読めていないときだけ画面に出す)
  useEffect(() => {
    if (!visible) return;
    const id = window.setInterval(() => setDemProblem(demLoadProblem()), 2000);
    return () => window.clearInterval(id);
  }, [visible]);

  const climateInput = useMemo<KoyoClimateInput>(
    () => ({ day, forecast: activeForecast, adjustC, lapseCPerM }),
    [day, activeForecast, adjustC, lapseCPerM],
  );
  const stationT0 = useMemo(() => buildStationT0(climateInput), [climateInput]);
  const stationT0Ahead = useMemo(() => buildStationT0Ahead(climateInput), [climateInput]);
  const stationT0Past = useMemo(() => buildStationT0Past(climateInput), [climateInput]);
  const zoneGrid = snowZones?.status === "ok" ? snowZones.grid : null;
  const season = useMemo(() => makeSeasonContext(climateInput, zoneGrid), [climateInput, zoneGrid]);

  const setClassShown = useCallback((classCode: number, shown: boolean) => {
    setHiddenClassList((prev) => {
      const without = prev.filter((c) => c !== classCode);
      return shown ? without : [...without, classCode];
    });
  }, []);
  const setAllClassesShown = useCallback((shown: boolean) => {
    setHiddenClassList(shown ? [] : [...TOGGLEABLE_CLASS_CODES]);
  }, []);

  // --- クリックした地点: 標高を取得 → 樹種グループ判定 → 樹種別の見頃 ---
  const [pointElev, setPointElev] = useState<{ lat: number; lng: number; elevM: number | null; done: boolean } | null>(
    null,
  );
  useEffect(() => {
    if (!needed || !selectedPoint) return;
    let cancelled = false;
    // 前の地点の結果を残さないよう、読み込み中の状態にしてから取得する
    queueMicrotask(() => {
      if (!cancelled) setPointElev({ lat: selectedPoint.lat, lng: selectedPoint.lng, elevM: null, done: false });
    });
    elevationAt(selectedPoint.lat, selectedPoint.lng)
      .then((elevM) => {
        if (!cancelled) setPointElev({ lat: selectedPoint.lat, lng: selectedPoint.lng, elevM, done: true });
      })
      .catch(() => {
        if (!cancelled) setPointElev({ lat: selectedPoint.lat, lng: selectedPoint.lng, elevM: null, done: true });
      });
    return () => {
      cancelled = true;
    };
  }, [needed, selectedPoint]);

  const vegGrid = veg?.status === "ok" ? veg.grid : null;
  const point = useMemo<KoyoPointInfo | null>(() => {
    if (!selectedPoint || !pointElev) return null;
    if (pointElev.lat !== selectedPoint.lat || pointElev.lng !== selectedPoint.lng) return null;
    const { elevM, done } = pointElev;
    if (elevM === null) {
      return {
        lat: selectedPoint.lat,
        lng: selectedPoint.lng,
        elevM: null,
        loading: !done,
        cls: null,
        rows: [],
        earlyRow: null,
      };
    }
    const cls = classAtPoint(selectedPoint.lat, selectedPoint.lng, elevM, vegGrid, lapseCPerM);
    const rows = pointTimeline(
      selectedPoint.lat,
      selectedPoint.lng,
      elevM,
      KOYO_SPECIES,
      { forecast: activeForecast, adjustC, lapseCPerM },
      autumnRange.start,
      autumnRange.end,
    );
    const earlyRow =
      earlyMixApplies(cls.classCode, cls.annualMeanC) && cls.classCode !== KOYO_SPECIES_BY_ID[EARLY_SPECIES_ID].classCode
        ? (rows.find((r) => r.species.id === EARLY_SPECIES_ID) ?? null)
        : null;
    return { lat: selectedPoint.lat, lng: selectedPoint.lng, elevM, loading: false, cls, rows, earlyRow };
  }, [selectedPoint, pointElev, vegGrid, activeForecast, adjustC, lapseCPerM, autumnRange]);

  return {
    visible,
    setVisible,
    day,
    setDay,
    today,
    dayRange,
    autumnRange,
    opacity,
    setOpacity,
    lapseCPerM,
    useForecast,
    setUseForecast,
    forecast,
    forecastLoading,
    forecastError,
    reloadForecast: () => loadForecast(true),
    veg,
    snowZones,
    season,
    stationT0,
    stationT0Ahead,
    stationT0Past,
    demProblem,
    climateInput,
    hiddenClasses,
    setClassShown,
    setAllClassesShown,
    tableSpeciesId,
    setTableSpeciesId,
    point,
  };
}

/** 表の基準にする樹種(選択中) */
export function tableSpecies(c: KoyoController) {
  return KOYO_SPECIES_BY_ID[c.tableSpeciesId];
}
