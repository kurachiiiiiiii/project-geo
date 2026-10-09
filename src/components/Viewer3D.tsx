import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { dateFromDayNumber, dayNumber } from "../features/koyo/koyoForecast";
import {
  buildStationT0,
  buildStationT0Ahead,
  buildStationT0Past,
  type KoyoClimateInput,
} from "../features/koyo/koyoModel";
import type { KoyoTileContext } from "../features/koyo/koyoRender";
import { makeSeasonContext } from "../features/koyo/koyoSeason";
import type { KoyoSnowZoneGrid } from "../features/koyo/koyoSnowZones";
import { VEG_UNKNOWN, dataUrl, loadVegDetail, vegClassAtFine, type KoyoVegetationGrid, type VegDetail } from "../features/koyo/koyoVegetation";
import { BoxCollector, FOOTPRINT_MAX_M, LightCollector, addUrbanProxies, buildBoxInstances, buildBuildingMesh, prepareBuilding } from "../features/viewer3d/viewerBuildings";
import {
  describeError,
  diagClose,
  diagCodes,
  diagContextLost,
  diagHeartbeat,
  diagNote,
  diagOpen,
  diagPreviousCrash,
  diagRender,
  diagSettings,
  diagText,
  diagVisibility,
  gpuBudgetMB,
} from "../features/viewer3d/viewerDiag";
import { constellationFrame, type ConstLabel } from "../features/viewer3d/viewerConst";
import {
  GEO_LAYER_BUILDING,
  GEO_LAYER_RIVER,
  GEO_LAYER_WATER,
  BuildingCollector,
  bandTileRefs,
  emptyGeo,
  loadGeoSet,
  type GeoBuilding,
  type GeoData,
} from "../features/viewer3d/viewerGeo";
import {
  FINE_GROUND,
  WIDE_FOOT,
  AHEAD_GROUND,
  hasWideFoot,
  hasAheadGround,
  footGround,
  MID_GROUND,
  NEAR_GEO_HALF_M,
  MOBILE_QUALITY,
  MOBILE_QUALITY_LIST,
  MOBILE_MAX_DPR,
  mobileQualityLabel,
  groundZoomUp,
  hasFineGround,
  hasFootGround,
  hasMidGround,
  isLowMemoryDevice,
  qualitySpec,
  terrainSpec,
  RANGE_NORMAL_KM,
  RANGE_WIDE_KM,
  WIDE_GEO_HALF_M,
  WIDE_GEO_ZOOM,
  type Quality,
} from "../features/viewer3d/viewerQuality";
import { TerrainRenderer, type FrameParams } from "../features/viewer3d/viewerGl";
import { SHADE_SIZE, SHADE_SIZE_LOWMEM, buildShadeBase, computeSunShadow, type ShadeBase } from "../features/viewer3d/viewerShade";
import { buildGlowTable, buildGroundLightMap, loadLightSource, loadUrbanGrid, type LightSource } from "../features/viewer3d/viewerLight";
import {
  SEA_H_DEFAULT_M,
  SEA_H_MAX_M,
  SEA_H_MIN_M,
  SEA_H_STEP_M,
  SEA_MAP_SIZE,
  SEA_POINT_SPACING_M,
  SEA_SIGMA,
  SEA_THICK_M,
  buildSeaRefMap,
  seaHalfM,
  seaRect,
  seaRefAt,
} from "../features/viewer3d/viewerSea";
import { computeVisibility, drawLabels, loadLabels, type LabelItem } from "../features/viewer3d/viewerLabels";
import type { TreeSetData } from "../features/viewer3d/viewerObjectsGl";
import { DEG, TILE_PX, cameraBasis, clamp, compass8, dirFromAzAlt, normAz, type Vec3 } from "../features/viewer3d/viewerMath";
import {
  FOG_LAYER_TOP_M,
  FOG_MAP_SIZE,
  FOG_RECT,
  FOG_SIGMA,
  HEIGHT_MAP_SIZE,
  buildFogMap,
  buildHeightMap,
  layerFogColor,
  makeLocalToLatLon,
  pickFogSources,
  type ViewerFogData,
} from "../features/viewer3d/viewerFog";
import {
  CLOUD_ALT_DEFAULT_M,
  CLOUD_ALT_MAX_M,
  CLOUD_ALT_MIN_M,
  CLOUD_MAP_SIZE,
  CLOUD_RECT,
  CLOUD_TAU_VERTICAL,
  CLOUD_THICK_M,
  buildCloudMap,
  layerCloudColor,
  loadCloudCells,
  pickCloudFrame,
  type ViewerCloudSource,
} from "../features/viewer3d/viewerCloud";
import { MILKY_COLOR, MOON_COLOR, SUN_COLOR, drawSkyOverlay } from "../features/viewer3d/viewerOverlay";
import {
  bodyHorizon,
  galacticCenterPath,
  milkyWayFrame,
  moonIlluminationAt,
  moonPhaseAt,
  pathSamples,
  riseSetTimes,
  skyLook,
  type BodyPos,
  type PathSample,
  type SkyLook,
} from "../features/viewer3d/viewerSky";
import {
  buildKoyoOverlay,
  buildTerrainMesh,
  curvatureDropM,
  farTileSet,
  TERRAIN_RADIUS_M,
  TERRAIN_RADIUS_WIDE_M,
  loadDemSet,
  loadGroundCanvas,
  makeHeightFn,
  makeTileSet,
  maxTilesAcross,
  nearTileSet,
  NEAR_HALF_M,
  groundTileCount,
  type DemSet,
  type GroundKind,
  type OverlayImage,
} from "../features/viewer3d/viewerTerrain";
import { computeTreeColors, makeOverlaySampler, placeTreeRing, treeKindOf, treeRebuildDistance } from "../features/viewer3d/viewerTrees";
import { rasterizeMask, type WaterMask } from "../features/viewer3d/viewerWater";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronsDown,
  ChevronsUp,
  LocateFixed,
  SlidersHorizontal,
} from "../lib/lucide";
import { Ico } from "./Ico";
import { errorMessage } from "../lib/errorMessage";

/**
 * クリックした地点から360°見渡せる3Dビューワー(全画面)。
 * 地形(標高タイル)を3Dにして、標準地図(または衛星画像)と紅葉メッシュを貼り、太陽・月・天の川の位置を空に描く。
 * 「現在の気温」「高原天気」で霧が出ている場所には、地面から約100mの高さまで霧をかける。
 * 国土地理院のベクトルタイルから、川・池(水面。まわり5mは灰色の岸)・建物の形を読んで立体にし、
 * 植生図に合わせて木を立てる(木の色は紅葉メッシュに連動)。夜には夏の大三角・カシオペヤ座などの星座も重ねる。
 * 一人称(その場に立って見回す)と俯瞰(地点の上空から見下ろして回り込む)を切り替えられる。
 * 描画の中身は `features/viewer3d/` にあり、ここは画面・操作・読み込みの進行だけを受け持つ。
 */

export interface Viewer3DKoyo {
  climateInput: KoyoClimateInput;
  veg: KoyoVegetationGrid | null;
  /** 豪雪地帯・特別豪雪地帯のグリッド(雪解けの時期の前倒しに使う。無ければ全域「指定なし」) */
  zones: KoyoSnowZoneGrid | null;
  hiddenClasses: ReadonlySet<number>;
  /** 紅葉マップの濃さ(初期値に使う) */
  opacity: number;
  dayRange: { start: number; end: number };
  /** 紅葉マップで選んでいる日(3Dビューワーでは上の日付に1本化したので、今は使わない) */
  day: number;
}

export interface Viewer3DProps {
  point: { lat: number; lng: number };
  /** おおまかな住所(取得できていなければnull) */
  address: string | null;
  /** 天文情報で選んでいる日付(この暦日の太陽・月を表示する) */
  date: Date;
  koyo: Viewer3DKoyo;
  /** 霧の元データ(「現在の気温」「高原天気」で作成済みのもの) */
  fog?: ViewerFogData;
  /** 雲の元データ(衛星画像の実測コマ。最新のコマ=現在の雲の雲判定メッシュだけを使う) */
  cloud?: ViewerCloudSource;
  /** 雲を最初から表示するか(地図の衛星画像で「メッシュ」をONにしていたとき) */
  cloudDefaultOn?: boolean;
  /** 「現在の気温」を取得して霧に反映する(未取得のときの案内ボタン用) */
  onRequestCurrentTemp?: () => void;
  currentTempBusy?: boolean;
  onClose: () => void;
}

type Mode = "first" | "orbit";
type Phase = "loading" | "ready" | "error";

/**
 * 「描画設定」(地面・処理 低/中/高・描画範囲・水/建物/木のチェック)は、次に3Dビューを開いたときも同じになるよう、
 * このブラウザ(localStorage)に保存する。保存できない・壊れているときは、既定の設定で開く。
 */
const DRAW_SETTINGS_KEY = "viewer3dDrawSettingsV1";

interface DrawSettings {
  groundKind: GroundKind;
  quality: Quality;
  wide: boolean;
  waterOn: boolean;
  buildingsOn: boolean;
  treesOn: boolean;
  seaOn: boolean;
  seaH: number;
  placesOn: boolean;
  peaksOn: boolean;
  /** 処理「高」の追加効果(山の影・谷の暗がり・高解像度描画・霞の光)。既定ON */
  hqFx: boolean;
  /**
   * スマホ版で選んだ「処理」(low=低・mid=高)。以前のスマホ版は「低」に固定で、quality には常に low が保存されていたので、
   * 利用者が選んだ値はこちらに別に持つ(無ければ既定の「高」)
   */
  qualityMobile?: Quality;
}

function loadDrawSettings(): Partial<DrawSettings> {
  try {
    const raw = localStorage.getItem(DRAW_SETTINGS_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Record<string, unknown>;
    const out: Partial<DrawSettings> = {};
    if (o.groundKind === "std" || o.groundKind === "photo") out.groundKind = o.groundKind;
    if (o.quality === "low" || o.quality === "mid" || o.quality === "high") out.quality = o.quality;
    if (typeof o.wide === "boolean") out.wide = o.wide;
    if (typeof o.waterOn === "boolean") out.waterOn = o.waterOn;
    if (typeof o.buildingsOn === "boolean") out.buildingsOn = o.buildingsOn;
    if (typeof o.treesOn === "boolean") out.treesOn = o.treesOn;
    if (typeof o.seaOn === "boolean") out.seaOn = o.seaOn;
    if (typeof o.seaH === "number" && Number.isFinite(o.seaH)) out.seaH = Math.min(SEA_H_MAX_M, Math.max(SEA_H_MIN_M, o.seaH));
    if (typeof o.placesOn === "boolean") out.placesOn = o.placesOn;
    if (typeof o.peaksOn === "boolean") out.peaksOn = o.peaksOn;
    if (typeof o.hqFx === "boolean") out.hqFx = o.hqFx;
    if (o.qualityMobile === "low" || o.qualityMobile === "mid") out.qualityMobile = o.qualityMobile;
    return out;
  } catch {
    return {};
  }
}

function saveDrawSettings(v: DrawSettings): void {
  try {
    localStorage.setItem(DRAW_SETTINGS_KEY, JSON.stringify(v));
  } catch {
    /* 保存できなくても、そのときの表示には影響しない */
  }
}

/** 処理「高」の追加効果: 描画の解像度の倍率(画面の解像度がこれ未満のときに引き上げる)と、総画素数の上限 */
const HQ_RENDER_SCALE = 1.5;
const HQ_MAX_PIXELS = 6_500_000;

const HEADER_H = 46;
/** 画面下の常時表示バー(設定の開閉・日付・時刻・雲海のスライダー)の高さ。太陽・月の矢印がこの上に収まるようにする */
const BAR_H = 124;
/** WASDで動ける範囲(クリックした地点からの距離、m)。通常は地形(半径25km)の内側の10km、描画範囲を拡張したときは40km(地形は半径50km) */
const MOVE_MAX_M = 10_000;
const MOVE_MAX_WIDE_M = 40_000;
const moveMaxOf = (wide: boolean): number => (wide ? MOVE_MAX_WIDE_M : MOVE_MAX_M);
/** 建物の数の説明に添える、推定の箱(遠くの街)の注記 */
const proxyNote = (q: Quality, wide: boolean): string => {
  const pf = qualitySpec(q, wide).proxyFromM;
  return pf !== null ? `。約${pf / 1000}km先からは市街地の分布からの推定` : "";
};
const EYE_MIN_M = 1.6;
const EYE_MAX_M = 3000;
/** 俯瞰で、見ている中心を持ち上げられる範囲(m。地面から30mの高さが0)。雲(約7km)の上まで上がれるようにする */
const LIFT_MIN_M = -25;
const LIFT_MAX_M = 12_000;
const DIST_MIN_M = 500;
const DIST_MAX_M = 22_000;
const FOV_MIN = 30;
const FOV_MAX = 120;
const VFOV_MAX = 100;

/**
 * 川・池・建物の形を読む範囲(`viewerQuality.ts` の「処理」の低・中・高で変わる)。どの設定でも、
 * 足もとの細かい水と建物は近く(ズーム16・半径1.3km)、川・池は広く(ズーム15・半径4.2km)読む。
 */
const GEO_MASK_SIZE = 2048;
const GEO_WIDE_LAYERS: ReadonlySet<string> = new Set([GEO_LAYER_WATER, GEO_LAYER_RIVER]);
const GEO_NEAR_LAYERS: ReadonlySet<string> = new Set([GEO_LAYER_WATER, GEO_LAYER_RIVER, GEO_LAYER_BUILDING]);
const GEO_BLDG_LAYERS: ReadonlySet<string> = new Set([GEO_LAYER_BUILDING]);
/** ズーム16の帯の建物は、タイルの四角(±1.3km)の角まで使う */
const NEAR_BAND_R_M = NEAR_GEO_HALF_M * Math.SQRT2;

/** 星座が見える強さ(0〜1)。太陽が沈んで薄明が終わるころに全部見える */
const constStrengthOf = (look: SkyLook) => clamp(look.night * 1.6, 0, 1);

/** スライダー(0〜100)と、目線の高さ・俯瞰の距離(どちらも対数目盛り)の変換 */
const eyeHeightOf = (s: number) => EYE_MIN_M * (EYE_MAX_M / EYE_MIN_M) ** (s / 100);
const orbitDistOf = (s: number) => DIST_MIN_M * (DIST_MAX_M / DIST_MIN_M) ** (s / 100);
const distToSlider = (d: number) => (100 * Math.log(d / DIST_MIN_M)) / Math.log(DIST_MAX_M / DIST_MIN_M);
const eyeToSlider = (h: number) => (100 * Math.log(h / EYE_MIN_M)) / Math.log(EYE_MAX_M / EYE_MIN_M);

/** w/a/s/d=前左後右、up/dn=上昇/下降(Shift/Ctrl) */
type MoveKey = "w" | "a" | "s" | "d" | "up" | "dn";

/** 文字を打つ欄(日付など)にいるときは、WASDを移動に使わない */
function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return false;
  if (el.tagName === "TEXTAREA" || el.tagName === "SELECT") return true;
  if (el.tagName === "INPUT") {
    const type = (el as HTMLInputElement).type;
    return !(type === "range" || type === "checkbox" || type === "radio" || type === "button");
  }
  return el.isContentEditable;
}

/** 地点からのずれを「東1.2km 北0.5km」のように */
/** 距離(m)を、1km未満はm、それ以上はkmで */
function distText(m: number): string {
  const a = Math.abs(m);
  return a < 1000 ? `${Math.round(a)}m` : `${(a / 1000).toFixed(1)}km`;
}

function offsetText(x: number, z: number): string {
  if (Math.hypot(x, z) < 1) return "クリックした地点";
  return `${x >= 0 ? "東" : "西"}${distText(x)} ${z <= 0 ? "北" : "南"}${distText(z)}`;
}

interface CamState {
  /** 立っている位置(俯瞰のときは見ている中心)の、クリックした地点からのずれ(X東・Z南、m) */
  x: number;
  z: number;
  yaw: number;
  pitch: number;
  /** 横方向の視野角(度) */
  fov: number;
  eyeS: number;
  distS: number;
  /** 俯瞰: 見ている中心を持ち上げた高さ(m)。カメラがそのぶん上がり、向きは変わらない */
  lift: number;
}

interface MeshInfo {
  /** 地点の地面の標高(m) */
  ground0: number;
  /** 位置(X東・Z南)の地面の高さ(丸みで下がる分を含む) */
  groundAt: (X: number, Z: number) => number;
  farRect: [number, number, number, number];
  nearRect: [number, number, number, number];
  /** 中景の画像の範囲(拡張+処理「高」のときだけ) */
  midRect: [number, number, number, number] | null;
}

interface ViewerData {
  renderer: TerrainRenderer;
  canvas: HTMLCanvasElement;
  ctx2d: CanvasRenderingContext2D | null;
  /** 画面の大きさ(CSS px)と解像度の倍率 */
  w: number;
  h: number;
  dpr: number;
  mesh: MeshInfo | null;
  far: DemSet | null;
  near: DemSet | null;
  nearBase: boolean;
  /** 中景の下地(拡張+処理「高」のとき)を貼り終えたか */
  midBase: boolean;
  /** カメラについていく細かい下地(処理「高」のとき。足もと=ズーム17、最も細かい=ズーム18)を貼り終えたかと、その範囲(原点から見た位置 m) */
  footBase: boolean;
  footRect: [number, number, number, number];
  fineBase: boolean;
  fineRect: [number, number, number, number];
  /** 広い足もとの下地(処理「高」のとき。カメラのまわり約±4km、ズーム15)を貼り終えたかと、その範囲 */
  wfootBase: boolean;
  wfootRect: [number, number, number, number];
  /** 向いている方向の遠く(約20km先まで。ズーム14)を貼り終えたかと、その範囲 */
  aheadBase: boolean;
  aheadRect: [number, number, number, number];
  nearOv: boolean;
  /** 読み込み済みの下地の画像(種類ごと。切り替えのたびに読み直さない) */
  ground: Partial<Record<GroundKind, { far: HTMLCanvasElement; near: HTMLCanvasElement }>>;
  /** 霧用の「地面の高さの地図」を貼り終えたか */
  heightReady: boolean;
  /** 川・池の水の地図(近くの細かい分・広く遠くまでの分)。木を立てない所の判定にも使う */
  masks: { near: WaterMask | null; wide: WaterMask | null; far: WaterMask | null };
  /** 立てた木(帯ごと。色を付け替えるときに使う)。cx,cz はその帯を作ったときの視点の位置(m) */
  treeGroups: Map<number, { sets: TreeSetData[]; cx: number; cz: number }>;
  /** 近景の紅葉メッシュ(木の色の元) */
  nearOvImg: OverlayImage | null;
  /** 遠景の紅葉メッシュ(近景の外にある木の色の元) */
  farOvImg: OverlayImage | null;
  /** 光害の元データ(建物のある所・人口集中地区・道路。夜になって初めて読む) */
  lightSrc: LightSource | null;
  /** この端末のWebGLが扱える画像の一辺の最大(px)。地面の画像の細かさの上限に使う */
  maxTexture: number;
  /** 雲海の「基準の標高」の地図(作ってあれば)と、その範囲(原点から±half m) */
  seaRef: { map: Float32Array; size: number; half: number; veg: KoyoVegetationGrid | null } | null;
  /** 地名・百名山のラベル(読み込み後)と、いまの視点での見え方(山・雲海に隠れるか。視点が動いたときだけ計算し直す) */
  labels: LabelItem[] | null;
  labelsBusy: boolean;
  labelVis: { vis: Float32Array; ex: number; ey: number; ez: number; key: string; n: number; t: number } | null;
  /** 描画(WebGLのcanvas)の解像度の倍率。画面の解像度(dpr)以上。処理「高」の追加効果がONのとき、より細かく描いて縮小する */
  glScale: number;
  /** 山の影・谷の暗がりの元(地形の高さの格子)と、いま貼っている太陽の影の向きのキー */
  shadeBase: ShadeBase | null;
  /** 太陽の影の地図の配列(時刻を動かすたびに作り直さず、使い回す) */
  shadeG: Float32Array | null;
  shadeKey: string;
  /** 画面の大きさ・解像度を測り直して、canvasを作り直す(追加効果の切り替え時に呼ぶ) */
  resize: () => void;
}

interface Live {
  mode: Mode;
  sun: BodyPos;
  moon: BodyPos;
  illum: number;
  look: SkyLook;
  koyoOn: boolean;
  ovOpacity: number;
  showPaths: boolean;
  sunPath: PathSample[];
  moonPath: PathSample[];
  fogOn: boolean;
  milkyOn: boolean;
  lightOn: boolean;
  milky: ReturnType<typeof milkyWayFrame>;
  milkyPath: PathSample[];
  cloudOn: boolean;
  cloudAlt: number;
  seaOn: boolean;
  seaH: number;
  placesOn: boolean;
  peaksOn: boolean;
  waterOn: boolean;
  buildingsOn: boolean;
  treesOn: boolean;
  constOn: boolean;
  constLabels: ConstLabel[];
  /** 描画範囲を拡張しているか(動ける範囲・霞の濃さが変わる) */
  wide: boolean;
  /** 処理「高」の追加効果が有効か(高解像度描画・霞の前方散乱。山の影・谷の暗がりは地図で別に有効にする) */
  hq: boolean;
}

interface GeoInfo {
  state: "idle" | "loading" | "ok";
  text: string | null;
  waters: number;
  buildings: number;
  trees: number;
}

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function localMidnight(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0);
}

function hm(totalMinutes: number): string {
  const m = Math.round(totalMinutes);
  return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`;
}

function hmOfDate(d: Date): string {
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtMeters(h: number): string {
  return h < 10 ? `${h.toFixed(1)}m` : h < 1000 ? `${Math.round(h)}m` : `${(h / 1000).toFixed(1)}km`;
}

const WEEKDAYS = ["日", "月", "火", "水", "木", "金", "土"];

/** その年の元日からの日数(0〜364/365)。日付スライダーの位置 */
function dayOfYear(dateStr: string): number {
  const [y, m, d] = dateStr.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 1)) / 86_400_000);
}

function daysInYear(year: number): number {
  return Math.round((Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 86_400_000);
}

function dateFromDayOfYear(year: number, index: number): string {
  const d = new Date(Date.UTC(year, 0, 1 + index));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function addDays(dateStr: string, delta: number): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + delta));
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/** "2026-10-06" → "10/6(火)" */
function dateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return `${m}/${d}(${WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}

function dayLabel(day: number): string {
  const d = dateFromDayNumber(day);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

function describe(pos: BodyPos): string {
  const alt = pos.altitudeDeg;
  return `方位${Math.round(normAz(pos.azimuthDeg))}°(${compass8(pos.azimuthDeg)}) 高度${alt.toFixed(1)}°${alt < 0 ? "(地平線の下)" : ""}`;
}

export default function Viewer3D({
  point,
  address,
  date,
  koyo,
  fog,
  cloud,
  cloudDefaultOn,
  onRequestCurrentTemp,
  currentTempBusy,
  onClose,
}: Viewer3DProps) {
  const stageRef = useRef<HTMLDivElement>(null);
  const ovRef = useRef<HTMLCanvasElement>(null);
  const dataRef = useRef<ViewerData | null>(null);
  const liveRef = useRef<Live | null>(null);
  const rafRef = useRef(0);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<number | null>(null);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // ---- 最初の日時と向き(太陽が出ていれば太陽、月だけなら月の方を向く) ----
  const [init] = useState(() => {
    const now = new Date();
    const dateStr = ymd(date);
    const minutes = dateStr === ymd(now) ? now.getHours() * 60 + now.getMinutes() : 12 * 60;
    const t = new Date(localMidnight(dateStr).getTime() + minutes * 60_000);
    const sun = bodyHorizon("Sun", t, point.lat, point.lng);
    const moon = bodyHorizon("Moon", t, point.lat, point.lng);
    const target = sun.altitudeDeg > 0 ? sun : moon.altitudeDeg > 0 ? moon : null;
    const portrait = window.innerHeight > window.innerWidth;
    return {
      dateStr,
      minutes,
      yaw: target ? normAz(target.azimuthDeg) : 180,
      pitch: target ? clamp(target.altitudeDeg * 0.4, 0, 25) : 0,
      fov: portrait ? 65 : 80,
    };
  });

  const camRef = useRef<CamState>({ x: 0, z: 0, yaw: init.yaw, pitch: init.pitch, fov: init.fov, eyeS: 0, distS: 73, lift: 0 });
  const moveApiRef = useRef<{ press: (k: MoveKey, down: boolean) => void } | null>(null);
  // 「描画設定」(地面・処理・描画範囲)の欄。上のバーの「描画」ボタンから、設定を開いてここまで送る
  const drawSecRef = useRef<HTMLElement>(null);
  const drawScrollPendingRef = useRef(false);
  const [pos, setPos] = useState<{ x: number; z: number; elev: number | null }>({ x: 0, z: 0, elev: null });
  const [camUi, setCamUi] = useState({ fov: init.fov, eyeS: 0, distS: 73, lift: 0 });

  const [phase, setPhase] = useState<Phase>("loading");
  const [status, setStatus] = useState("準備中…");
  const [failure, setFailure] = useState<string | null>(null);
  // 失敗の「エラーコード」(種類)と詳細(メッセージ・スタックの先頭)。エラー画面に大きく出し、コピーできるようにする
  const [failureInfo, setFailureInfo] = useState<{ code: string; detail: string } | null>(null);
  // 描画が途中で止まった(WebGLのコンテキストが失われた=メモリ不足など)か。そのとき「処理を下げてやり直す」を出す
  const [lostCtx, setLostCtx] = useState(false);
  // WebGLが中断されたとき(GPUのリセット・一時的なメモリ不足など)に、描画器を作り直すための番号と、中断された時刻(作り直しを繰り返さないため)
  const [rebuild, setRebuild] = useState(0);
  const lossTimesRef = useRef<number[]>([]);
  // 落ちたあとの診断(前回タブが落ちていた・今回WebGLが中断された)
  const [prevCrash, setPrevCrash] = useState(() => diagPreviousCrash());
  const [crashText, setCrashText] = useState<string | null>(null);
  const [mapStatus, setMapStatus] = useState<string | null>(null);
  const [ovBusy, setOvBusy] = useState(false);
  const [groundElev, setGroundElev] = useState<number | null>(null);

  // 前回の描画設定(保存してあれば)
  const [drawInit] = useState(loadDrawSettings);
  const [mode, setMode] = useState<Mode>("first");
  const [dateStr, setDateStr] = useState(init.dateStr);
  const [minutes, setMinutes] = useState(init.minutes);
  const [showPaths, setShowPaths] = useState(true);
  const [koyoOn, setKoyoOn] = useState(true);
  const [ovOpacity, setOvOpacity] = useState(koyo.opacity);
  const [panelOpen, setPanelOpen] = useState(false);
  const openDrawSettings = useCallback(() => {
    if (drawSecRef.current) {
      drawSecRef.current.scrollIntoView({ block: "start", behavior: "smooth" });
      return;
    }
    drawScrollPendingRef.current = true;
    setPanelOpen(true);
  }, []);
  useEffect(() => {
    if (!panelOpen || !drawScrollPendingRef.current) return;
    drawScrollPendingRef.current = false;
    drawSecRef.current?.scrollIntoView({ block: "start" });
  }, [panelOpen]);
  const [openedAtMs] = useState(() => Date.now());
  const [groundKind, setGroundKind] = useState<GroundKind>(drawInit.groundKind ?? "photo");
  const [fogOn, setFogOn] = useState(true);
  const [milkyOn, setMilkyOn] = useState(true);
  const [lightOn, setLightOn] = useState(true);
  // 光害の元データを読み終えるたびに増やす(光の表を作り直す合図)
  const [lightVersion, setLightVersion] = useState(0);
  const [lightInfo, setLightInfo] = useState<{ state: "idle" | "loading" | "ok" | "error"; text: string | null }>({
    state: "idle",
    text: null,
  });
  const [cloudOn, setCloudOn] = useState(!!cloudDefaultOn);
  const [cloudAlt, setCloudAlt] = useState(CLOUD_ALT_DEFAULT_M);
  // 雲海(厚さ100m。基準=近くの市街地の標高+この高さ)と、地名・百名山の表示
  const [seaOn, setSeaOn] = useState(drawInit.seaOn ?? false);
  const [seaH, setSeaH] = useState(drawInit.seaH ?? SEA_H_DEFAULT_M);
  // 雲海の基準の標高の地図(いまの場所の基準標高を、設定の欄に出すため。地図そのものはdataRefにも持つ)
  const [seaRefState, setSeaRefState] = useState<{ map: Float32Array; size: number; half: number } | null>(null);
  const [labelInfo, setLabelInfo] = useState<{ state: "idle" | "loading" | "ok" | "error"; text: string | null }>({
    state: "idle",
    text: null,
  });
  const [placesOn, setPlacesOn] = useState(drawInit.placesOn ?? true);
  const [peaksOn, setPeaksOn] = useState(drawInit.peaksOn ?? true);
  // 処理「高」の追加効果(山の影・谷の暗がり・高解像度描画・霞の光)。スマホ版は常にOFF(処理は「低」固定。下の quality 参照)
  const [hqFx] = useState(false);
  const [waterOn, setWaterOn] = useState(drawInit.waterOn ?? true);
  const [buildingsOn, setBuildingsOn] = useState(drawInit.buildingsOn ?? true);
  const [treesOn, setTreesOn] = useState(drawInit.treesOn ?? true);
  const [constOn, setConstOn] = useState(true);
  // 処理: 建物・木・水を、どこまで遠くまで立体にするか。スマホ版は「低」「高」の2つ(「高」の中身はPC版の「中」。既定は「高」)。
  // PC版の「高」・描画範囲の拡張は、PC版(別フォルダ)の機能
  const [quality, setQuality] = useState<Quality>(drawInit.qualityMobile ?? MOBILE_QUALITY);
  // 描画範囲の拡張: スマホ版は常に通常(地形・下地・紅葉メッシュは半径約25km)
  const [wide, setWide] = useState(false);
  // 川・池・建物の形を読み終えるたびに更新する(木の配置し直しの合図。どの設定で読んだかも持つ)
  const [geoLoaded, setGeoLoaded] = useState<{ version: number; quality: Quality; wide: boolean }>({
    version: 0,
    quality: drawInit.qualityMobile ?? MOBILE_QUALITY,
    wide: false,
  });
  const [geoInfo, setGeoInfo] = useState<GeoInfo>({ state: "idle", text: null, waters: 0, buildings: 0, trees: 0 });
  useEffect(() => {
    saveDrawSettings({ groundKind, quality, wide, waterOn, buildingsOn, treesOn, seaOn, seaH, placesOn, peaksOn, hqFx, qualityMobile: quality });
  }, [groundKind, quality, wide, waterOn, buildingsOn, treesOn, seaOn, seaH, placesOn, peaksOn, hqFx]);
  const hq = quality === "high" && hqFx;
  // 太陽の影の再計算の合図(影・暗がりの元の格子を作り終えるたびに増やす)
  const [shadeVersion, setShadeVersion] = useState(0);
  const [cloudInfo, setCloudInfo] = useState<{ state: "idle" | "loading" | "ok" | "clear" | "none" | "error"; label: string | null; message?: string }>({
    state: "idle",
    label: null,
  });
  const [fogInfo, setFogInfo] = useState<{ labels: string[]; any: boolean }>({ labels: [], any: false });

  // ---- 太陽・月 ----
  const dayStart = useMemo(() => localMidnight(dateStr), [dateStr]);
  const time = useMemo(() => new Date(dayStart.getTime() + minutes * 60_000), [dayStart, minutes]);
  const sun = useMemo(() => bodyHorizon("Sun", time, point.lat, point.lng), [time, point.lat, point.lng]);
  const moon = useMemo(() => bodyHorizon("Moon", time, point.lat, point.lng), [time, point.lat, point.lng]);
  const illum = useMemo(() => moonIlluminationAt(time), [time]);
  const look = useMemo(() => skyLook(sun.altitudeDeg, moon.altitudeDeg, illum), [sun, moon, illum]);
  const sunPath = useMemo(() => pathSamples("Sun", point.lat, point.lng, dayStart, 10), [dayStart, point.lat, point.lng]);
  const moonPath = useMemo(() => pathSamples("Moon", point.lat, point.lng, dayStart, 10), [dayStart, point.lat, point.lng]);
  const riseSet = useMemo(() => riseSetTimes(point.lat, point.lng, dayStart), [dayStart, point.lat, point.lng]);
  const moonAge = useMemo(
    () => moonPhaseAt(new Date(dayStart.getTime() + 12 * 3_600_000)).ageDays,
    [dayStart],
  );

  const { climateInput, veg: vegBase, zones, hiddenClasses } = koyo;
  // 植生: 約250mの全国グリッドの上に、この場所のまわりの約50mメッシュ(タイル。あれば)を重ねる。
  // 範囲は、地形を描く半径に合わせる(処理「低」は近くだけ、「高」は約28km・描画範囲の拡張で約53km=地形の半径+3km)。
  // 範囲の外(50km以上の遠く)のタイルは読まない(円の外にかかるだけのタイルも読まない)
  const [vegDetail, setVegDetail] = useState<VegDetail | null>(null);
  useEffect(() => {
    if (!vegBase) return;
    let cancelled = false;
    const radius = quality === "low" ? 4000 : quality === "mid" ? 12_000 : (wide ? TERRAIN_RADIUS_WIDE_M : TERRAIN_RADIUS_M) + 3000;
    void loadVegDetail(point.lat, point.lng, radius, () => cancelled).then((d) => {
      // 同じタイルなら、いまのものを使い続ける(植生を使う木・光・雲海の作り直しを、無駄に走らせない)
      if (!cancelled) {
        setVegDetail((prev) => {
          if (prev && d && prev.tiles.size === d.tiles.size && [...d.tiles.keys()].every((k) => prev.tiles.has(k))) return prev;
          return d;
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [vegBase, point.lat, point.lng, quality, wide]);
  const veg = useMemo(() => (vegBase && vegDetail ? { ...vegBase, detail: vegDetail } : vegBase), [vegBase, vegDetail]);
  const koyoLinkedDay = useMemo(() => {
    const [y, m, d] = dateStr.split("-").map(Number);
    return dayNumber(y, m, d);
  }, [dateStr]);
  // 紅葉の日付は、上の日付(太陽・月と同じ日付)に1本化した(「紅葉の日付は１つに統一してください」)。
  // 紅葉の計算範囲(予報などで決まる)の外の日は、範囲の端の日で表示する。
  const koyoDay = clamp(koyoLinkedDay, koyo.dayRange.start, koyo.dayRange.end);
  const koyoOutOfRange = koyoLinkedDay !== koyoDay;

  // ---- 天の川(銀河面の向きと銀河中心の位置。見え方は空の暗さ・月明かりで決まる) ----
  const milky = useMemo(() => milkyWayFrame(time, point.lat, point.lng), [time, point.lat, point.lng]);
  const milkyPath = useMemo(
    () => galacticCenterPath(point.lat, point.lng, dayStart, 10),
    [dayStart, point.lat, point.lng],
  );

  // ---- 星座(星と線の向き・名前の位置。夜だけ見える) ----
  const constFrame = useMemo(
    () => (constOn ? constellationFrame(time, point.lat, point.lng) : null),
    [constOn, time, point.lat, point.lng],
  );

  // ---- 霧(見ている日時に合う「現在の気温」「高原天気」のコマ) ----
  const fogPick = useMemo(() => pickFogSources(fog ?? { current: null, forecast: null }, time), [fog, time]);
  const fogPickRef = useRef(fogPick);
  useLayoutEffect(() => {
    fogPickRef.current = fogPick;
  }, [fogPick]);
  const fogKey = fogPick.key;

  // ---- 雲(最新の衛星画像のコマ=現在の雲。見ている日時を動かしても変わらない) ----
  const cloudPick = useMemo(() => (cloud ? pickCloudFrame(cloud) : null), [cloud]);
  const cloudPickRef = useRef(cloudPick);
  useLayoutEffect(() => {
    cloudPickRef.current = cloudPick;
  }, [cloudPick]);
  const cloudKey = cloudPick?.key ?? "";

  // ---- 描画(状態はrefから読み、requestAnimationFrameでまとめて1回描く) ----
  const redrawRef = useRef<() => void>(() => {});
  /** 上部バーの実際の高さ(px)。iPhoneでは、ステータスバー・切れ込みの安全領域の分だけ HEADER_H より高い(太陽・月の矢印・星座名・地名をこの下に置く) */
  const [topBarEl, setTopBarEl] = useState<HTMLDivElement | null>(null);
  const topInsetRef = useRef(HEADER_H);
  const draw = useCallback(() => {
    const d = dataRef.current;
    const L = liveRef.current;
    if (!d || !L || !d.mesh || d.w < 2 || d.h < 2) return;
    const cam = camRef.current;
    const mesh = d.mesh;

    let eye: Vec3;
    let near: number;
    if (L.mode === "first") {
      const h = eyeHeightOf(cam.eyeS);
      eye = [cam.x, mesh.groundAt(cam.x, cam.z) + h, cam.z];
      near = clamp(h * 0.25, 1, 50);
    } else {
      const dist = orbitDistOf(cam.distS);
      const b = cameraBasis(cam.yaw, cam.pitch);
      const target: Vec3 = [cam.x, mesh.groundAt(cam.x, cam.z) + 30 + cam.lift, cam.z];
      eye = [target[0] - b.forward[0] * dist, target[1] - b.forward[1] * dist, target[2] - b.forward[2] * dist];
      const floor = mesh.groundAt(eye[0], eye[2]) + 20;
      if (eye[1] < floor) eye[1] = floor;
      near = Math.max(5, dist * 0.02);
    }

    const aspect = d.w / d.h;
    const vfov = clamp((2 * Math.atan(Math.tan((cam.fov * DEG) / 2) / aspect)) / DEG, 8, VFOV_MAX);
    const params: FrameParams = {
      width: d.canvas.width,
      height: d.canvas.height,
      eye,
      yawDeg: cam.yaw,
      pitchDeg: cam.pitch,
      fovDeg: vfov,
      near,
      far: 130_000,
      sunDir: dirFromAzAlt(L.sun.azimuthDeg, L.sun.altitudeDeg),
      moonDir: dirFromAzAlt(L.moon.azimuthDeg, L.moon.altitudeDeg),
      moonIllum: L.illum,
      look: L.look,
      overlayOpacity: L.koyoOn ? L.ovOpacity : 0,
      farRect: mesh.farRect,
      nearRect: mesh.nearRect,
      midRect: mesh.midRect ?? [0, 0, 1, 1],
      midOn: d.midBase && !!mesh.midRect,
      footRect: d.footRect,
      footOn: d.footBase,
      fineRect: d.fineRect,
      fineOn: d.fineBase,
      wfootRect: d.wfootRect,
      wfootOn: d.wfootBase,
      aheadRect: d.aheadRect,
      aheadOn: d.aheadBase,
      nearOn: d.nearBase,
      nearOvOn: d.nearOv,
      layerFog: {
        on: L.fogOn && d.heightReady,
        color: layerFogColor(L.look),
        sigma: FOG_SIGMA,
        top: FOG_LAYER_TOP_M,
        rect: FOG_RECT,
      },
      cloud: {
        on: L.cloudOn,
        color: layerCloudColor(L.look),
        alt: [L.cloudAlt, L.cloudAlt + CLOUD_THICK_M],
        sigma: CLOUD_TAU_VERTICAL / CLOUD_THICK_M,
        rect: CLOUD_RECT,
      },
      sea: { on: L.seaOn, h: L.seaH, col: layerCloudColor(L.look) },
      milky: L.milkyOn
        ? { gx: L.milky.gx, gy: L.milky.gy, gz: L.milky.gz, strength: L.look.milkyWay }
        : undefined,
      skyFrame: { gx: L.milky.gx, gy: L.milky.gy, gz: L.milky.gz },
      glowOn: L.lightOn && L.look.night > 0.01,
      waterOn: L.waterOn,
      showBuildings: L.buildingsOn,
      showTrees: L.treesOn,
      constellation: L.constOn ? { strength: constStrengthOf(L.look) } : undefined,
      dpr: d.glScale,
      hq: L.hq,
      rangeM: L.wide ? TERRAIN_RADIUS_WIDE_M : TERRAIN_RADIUS_M,
    };
    const tRender = performance.now();
    const vp = d.renderer.render(params);
    diagRender(performance.now() - tRender);
    if (d.ctx2d) {
      drawSkyOverlay(d.ctx2d, {
        width: d.w,
        height: d.h,
        vp,
        eye,
        yawDeg: cam.yaw,
        pitchDeg: cam.pitch,
        fovDeg: vfov,
        sun: L.sun,
        moon: L.moon,
        sunPath: L.sunPath,
        moonPath: L.moonPath,
        milky: L.milkyOn && L.look.night > 0.05 ? L.milky.center : null,
        milkyPath: L.milkyOn && L.look.night > 0.05 ? L.milkyPath : [],
        constellation: L.constOn ? { labels: L.constLabels, strength: constStrengthOf(L.look) } : undefined,
        showPaths: L.showPaths,
        topInset: topInsetRef.current,
        bottomInset: BAR_H,
      });
      // 地名・百名山(√の形のラベル)。山・雲海に隠れる所は、視点が動いたときだけ計算し直す
      if (d.labels && d.labels.length > 0 && (L.placesOn || L.peaksOn)) {
        const sea =
          L.seaOn && d.seaRef
            ? { map: d.seaRef.map, size: d.seaRef.size, half: d.seaRef.half, h: L.seaH, thick: SEA_THICK_M, sigma: SEA_SIGMA }
            : null;
        const key = sea ? `s${L.seaH}` : "n";
        const lv = d.labelVis;
        const moved = !lv || Math.hypot(eye[0] - lv.ex, eye[2] - lv.ez) > 20 || Math.abs(eye[1] - lv.ey) > 6;
        const now = performance.now();
        if (!lv || lv.key !== key || lv.n !== d.labels.length || (moved && now - lv.t > 120)) {
          d.labelVis = {
            vis: computeVisibility(d.labels, eye, mesh.groundAt, sea),
            ex: eye[0],
            ey: eye[1],
            ez: eye[2],
            key,
            n: d.labels.length,
            t: now,
          };
        } else if (moved) {
          // 計算を間引いている間に視点が止まっても、最後に見え方を合わせ直す
          window.setTimeout(() => redrawRef.current(), 140);
        }
        drawLabels(d.ctx2d, {
          width: d.w,
          height: d.h,
          vp,
          eye,
          items: d.labels,
          vis: d.labelVis ? d.labelVis.vis : new Float32Array(d.labels.length),
          placesOn: L.placesOn,
          peaksOn: L.peaksOn,
          topInset: topInsetRef.current,
          bottomInset: BAR_H,
        });
      }
    }
  }, []);

  const requestDraw = useCallback(() => {
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      draw();
    });
  }, [draw]);

  useLayoutEffect(() => {
    redrawRef.current = requestDraw;
  }, [requestDraw]);

  // 上部バーの高さ(安全領域込み)を測って、太陽・月・星座・地名の置き場の上端に使う。向きを変えたとき(安全領域が変わる)も追従する
  useLayoutEffect(() => {
    if (!topBarEl) return;
    const measure = () => {
      const h = topBarEl.getBoundingClientRect().height;
      if (h > 0 && Math.abs(h - topInsetRef.current) > 0.5) {
        topInsetRef.current = h;
        requestDraw();
      }
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(topBarEl);
    return () => ro.disconnect();
  }, [topBarEl, requestDraw]);

  useLayoutEffect(() => {
    liveRef.current = {
      mode,
      sun,
      moon,
      illum,
      look,
      koyoOn,
      ovOpacity,
      showPaths,
      sunPath,
      moonPath,
      fogOn,
      milkyOn,
      lightOn,
      milky,
      milkyPath,
      cloudOn,
      cloudAlt,
      seaOn,
      seaH,
      placesOn,
      peaksOn,
      waterOn,
      buildingsOn,
      treesOn,
      constOn,
      constLabels: constFrame ? constFrame.labels : [],
      wide,
      hq,
    };
    requestDraw();
  }, [
    mode,
    sun,
    moon,
    illum,
    look,
    koyoOn,
    ovOpacity,
    showPaths,
    sunPath,
    moonPath,
    fogOn,
    milkyOn,
    lightOn,
    milky,
    milkyPath,
    cloudOn,
    cloudAlt,
    seaOn,
    seaH,
    placesOn,
    peaksOn,
    waterOn,
    buildingsOn,
    treesOn,
    constOn,
    constFrame,
    wide,
    hq,
    requestDraw,
  ]);

  // ---- 読み込み: 標高 → 地形(下地の画像・霧は、地形ができてから別に読む) ----
  // 描画範囲の拡張を切り替えたときは、描画器ごと作り直して、地形から読み込み直す(読んだタイルは使い回される)
  useEffect(() => {
    const stage = stageRef.current;
    const ov = ovRef.current;
    if (!stage || !ov) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    // 作り直し中は「読み込み中」に戻す(これに依存する下地・霧・雲・水・木などの読み込みも、できあがってからやり直す)
    queueMicrotask(() => {
      if (cancelled) return;
      setPhase("loading");
      setLostCtx(false);
      setGeoLoaded((g) => (g.version === 0 ? g : { version: 0, quality: g.quality, wide: g.wide }));
      // 通常の範囲に戻したとき、動ける範囲の外(10km超)にいたら、範囲の内側へ戻す
      const cam = camRef.current;
      const r = Math.hypot(cam.x, cam.z);
      const rMax = moveMaxOf(wide);
      if (r > rMax) {
        cam.x *= rMax / r;
        cam.z *= rMax / r;
      }
    });

    // WebGLのcanvasはここで作る(開発時の二重実行で、破棄済みの描画面を掴まないため)
    const canvas = document.createElement("canvas");
    canvas.className = "viewer3d__gl";
    stage.insertBefore(canvas, stage.firstChild);

    let renderer: TerrainRenderer;
    try {
      renderer = new TerrainRenderer(canvas);
    } catch (e) {
      canvas.remove();
      const message = e instanceof Error ? e.message : String(e);
      const info = describeError(e);
      console.error("[3Dビュー] 描画の初期化に失敗", e);
      // 画面を作り終えてから、失敗の表示に切り替える
      queueMicrotask(() => {
        setFailure(message);
        setFailureInfo(info);
        setPhase("error");
      });
      return;
    }
    const data: ViewerData = {
      renderer,
      canvas,
      ctx2d: ov.getContext("2d"),
      w: 0,
      h: 0,
      dpr: 1,
      mesh: null,
      far: null,
      near: null,
      nearBase: false,
      midBase: false,
      footBase: false,
      footRect: [0, 0, 1, 1],
      fineBase: false,
      fineRect: [0, 0, 1, 1],
      wfootBase: false,
      wfootRect: [0, 0, 1, 1],
      aheadBase: false,
      aheadRect: [0, 0, 1, 1],
      nearOv: false,
      ground: {},
      heightReady: false,
      masks: { near: null, wide: null, far: null },
      treeGroups: new Map(),
      nearOvImg: null,
      farOvImg: null,
      lightSrc: null,
      maxTexture: 4096,
      seaRef: null,
      labels: null,
      labelsBusy: false,
      labelVis: null,
      glScale: 1,
      shadeBase: null,
      shadeG: null,
      shadeKey: "",
      resize: () => {},
    };
    dataRef.current = data;
    // 地面の画像の異方性フィルタ: スマホ版は4倍(PC版は処理「高」で16倍)。メモリの帯域を抑える
    renderer.setAnisoLevel(4);

    // 落ちたときの原因を調べる記録(GPUメモリの見積もり・設定・直前の操作。端末の中にだけ残す)。数秒おきに更新する
    diagOpen(renderer.context, { quality, wide, hq: !!liveRef.current?.hq, cssWidth: 0, cssHeight: 0, scale: 1 }, renderer.mem);
    const diagTimer = window.setInterval(diagHeartbeat, 3000);
    const onPageHide = () => diagClose("ページを閉じた");
    const onVisibility = () => diagVisibility(document.visibilityState === "hidden");
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibility);
    // 拾われなかった非同期の失敗も、落ちたときの手がかりとして記録する
    const onRejection = (e: PromiseRejectionEvent) => {
      const r: unknown = e.reason;
      diagNote(`処理されなかった失敗: ${r instanceof Error ? `${r.name}: ${r.message}` : String(r)}`.slice(0, 160));
    };
    window.addEventListener("unhandledrejection", onRejection);

    const onLost = (e: Event) => {
      e.preventDefault();
      if (cancelled) return;
      const lost = diagContextLost();
      // 3分以内で初めての中断なら、同じ設定のまま、新しい描画面で作り直す(視点はそのまま)。続けて中断されたら、エラーを表示する
      const now = Date.now();
      lossTimesRef.current = lossTimesRef.current.filter((t) => now - t < 180_000);
      lossTimesRef.current.push(now);
      if (lossTimesRef.current.length <= 1) {
        console.warn("[3Dビュー] webglcontextlost: 作り直します", lost?.record);
        diagNote("WebGLが中断されたので、作り直す");
        setStatus("3D表示が中断されたので、作り直しています…");
        setPhase("loading");
        window.setTimeout(() => {
          if (!cancelled) setRebuild((k) => k + 1);
        }, 1200);
        return;
      }
      setFailure(
        "3D表示が中断されました(端末のメモリ不足・GPUの処理時間超過など)。他のアプリを閉じてからもう一度開くか、「描画」の設定で水・建物・木のチェックを外すと軽くなります。" +
          (lost ? ` 原因の手がかり: ${lost.hints.join(" ")}` : ""),
      );
      if (lost) setCrashText(diagText(lost.record, lost.hints));
      setFailureInfo({ code: "WEBGL_CONTEXT_LOST", detail: lost ? diagCodes(lost.record).join(" ") : "WebGLのコンテキストが失われました" });
      console.error("[3Dビュー] webglcontextlost", lost?.record);
      setLostCtx(true);
      setPhase("error");
    };
    canvas.addEventListener("webglcontextlost", onLost);

    const resize = () => {
      const r = stage.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      data.w = Math.max(1, Math.round(r.width));
      data.h = Math.max(1, Math.round(r.height));
      data.dpr = dpr;
      // 描画の解像度: 処理「高」の追加効果がONのときは、画面より細かく描いて縮小する(ぎざぎざ・ちらつきが減る)。
      // 総画素数の上限(HQ_MAX_PIXELS)と、GPUの画像の大きさの上限の範囲で。文字・ラベルの重ね描き(ov)は、画面の解像度のまま
      // 3Dの描画の解像度は、スマホ版では最大 MOBILE_MAX_DPR 倍に抑える(画面の画素密度が3倍前後の機種で、描く画素数を約1/4にする)
      let gs = Math.min(dpr, MOBILE_MAX_DPR);
      if (liveRef.current?.hq) {
        gs = Math.max(dpr, HQ_RENDER_SCALE);
        const px = data.w * data.h * gs * gs;
        if (px > HQ_MAX_PIXELS) gs = Math.max(dpr, Math.sqrt(HQ_MAX_PIXELS / (data.w * data.h)));
        gs = Math.max(1, Math.min(gs, renderer.maxTextureSize / Math.max(data.w, data.h)));
      }
      data.glScale = gs;
      diagSettings({ hq: !!liveRef.current?.hq, cssWidth: data.w, cssHeight: data.h, scale: gs });
      canvas.width = Math.round(data.w * gs);
      canvas.height = Math.round(data.h * gs);
      ov.width = Math.round(data.w * dpr);
      ov.height = Math.round(data.h * dpr);
      data.ctx2d?.setTransform(dpr, 0, 0, dpr, 0, 0);
      requestDraw();
    };
    data.resize = resize;
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    resize();

    void (async () => {
      try {
        // 紅葉メッシュ・下地の画像の範囲(far/near。ズーム11・13)と、地形の高さに使う標高(処理「中・高」では、より細かいズーム)
        const far = farTileSet(point.lat, point.lng, wide);
        const near = nearTileSet(point.lat, point.lng);
        const tspec = terrainSpec(quality, wide);
        const hFar = tspec.heightFar.zoom === far.z ? far : makeTileSet(point.lat, point.lng, tspec.heightFar.zoom, tspec.heightFar.half);
        const hNear =
          tspec.heightNear.zoom === near.z && tspec.heightNear.half === NEAR_HALF_M
            ? near
            : makeTileSet(point.lat, point.lng, tspec.heightNear.zoom, tspec.heightNear.half);
        // 足もとの細かい標高(ズーム15。5mメッシュ。処理「高」だけ)
        const hDetail = tspec.heightDetail
          ? makeTileSet(point.lat, point.lng, tspec.heightDetail.zoom, tspec.heightDetail.half)
          : null;
        const demTotal =
          far.nx * far.ny +
          near.nx * near.ny +
          (hFar === far ? 0 : hFar.nx * hFar.ny) +
          (hNear === near ? 0 : hNear.nx * hNear.ny) +
          (hDetail ? hDetail.nx * hDetail.ny : 0);
        let demDone = 0;
        const onDem = () => {
          demDone++;
          if (!cancelled) setStatus(`標高データを読み込み中 ${demDone}/${demTotal}`);
        };
        const [farDem, nearDem, hFarDem, hNearDem, hDetailDem] = await Promise.all([
          loadDemSet(far, onDem, isCancelled),
          loadDemSet(near, onDem, isCancelled),
          hFar === far ? Promise.resolve(null) : loadDemSet(hFar, onDem, isCancelled),
          hNear === near ? Promise.resolve(null) : loadDemSet(hNear, onDem, isCancelled),
          hDetail ? loadDemSet(hDetail, onDem, isCancelled, true) : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (![...farDem.tiles, ...nearDem.tiles].some((t) => t !== null)) {
          throw new Error("標高データを取得できませんでした。通信状況を確認してから、もう一度開いてください。");
        }
        setStatus("地形を作成中…");
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (cancelled) return;

        const heightAt = makeHeightFn(
          hNearDem ?? nearDem,
          hFarDem ?? farDem,
          tspec.heightNear.half,
          hDetailDem && tspec.heightDetail ? { dem: hDetailDem, half: tspec.heightDetail.half } : null,
        );
        renderer.setMesh(buildTerrainMesh(heightAt, wide ? TERRAIN_RADIUS_WIDE_M : TERRAIN_RADIUS_M, tspec.mesh));
        const ground0 = heightAt(0, 0);
        data.far = farDem;
        data.near = nearDem;
        data.maxTexture = renderer.maxTextureSize;
        data.mesh = {
          ground0,
          groundAt: (X, Z) => heightAt(X, Z) - curvatureDropM(Math.hypot(X, Z)),
          farRect: [far.rect.x0, far.rect.z0, far.rect.sx, far.rect.sz],
          nearRect: [near.rect.x0, near.rect.z0, near.rect.sx, near.rect.sz],
          midRect: hasMidGround(quality, wide)
            ? (() => {
                const m = makeTileSet(point.lat, point.lng, MID_GROUND.zoom, MID_GROUND.half).rect;
                return [m.x0, m.z0, m.sx, m.sz] as [number, number, number, number];
              })()
            : null,
        };
        setGroundElev(ground0);
        setPhase("ready");
        requestDraw();
      } catch (e) {
        if (cancelled) return;
        console.error("[3Dビュー] 地形の作成に失敗", e);
        setFailure(errorMessage(e));
        setFailureInfo(describeError(e));
        setPhase("error");
      }
    })();

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
      ro.disconnect();
      canvas.removeEventListener("webglcontextlost", onLost);
      window.clearInterval(diagTimer);
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("unhandledrejection", onRejection);
      document.removeEventListener("visibilitychange", onVisibility);
      diagClose("閉じた・設定を変えて作り直した");
      renderer.dispose();
      canvas.remove();
      dataRef.current = null;
    };
  }, [point.lat, point.lng, wide, quality, requestDraw, rebuild]);

  // ---- 下地の画像(標準地図 / 衛星画像)。地形はこの間も見られる。読めた分から貼る。一度読んだ種類は使い回す ----
  // 処理「中・高」では、紅葉メッシュと同じ範囲を、より細かいズームのタイルで読み直して貼る(まず粗い画像を貼ってから、細かい画像に置き換える)
  useEffect(() => {
    if (phase !== "ready") return;
    const d = dataRef.current;
    if (!d || !d.far || !d.near) return;
    const farSet = farTileSet(point.lat, point.lng, wide);
    const nearSet = nearTileSet(point.lat, point.lng);
    const tspec = terrainSpec(quality, wide);
    const farUp = groundZoomUp(tspec, farSet.nx, farSet.ny, TILE_PX, d.maxTexture);
    const nearUp = groundZoomUp(tspec, nearSet.nx, nearSet.ny, TILE_PX, d.maxTexture);
    // 拡張+処理「高」: 約26kmまでを、拡張しない「高」の遠景と同じ細かさ(ズーム13)で重ねる中景
    const midSet = hasMidGround(quality, wide) ? makeTileSet(point.lat, point.lng, MID_GROUND.zoom, MID_GROUND.half) : null;
    const midUp = midSet ? groundZoomUp(tspec, midSet.nx, midSet.ny, TILE_PX, d.maxTexture) : 0;
    const cached = d.ground[groundKind];
    if (cached && !midSet) {
      d.renderer.setBase("far", cached.far);
      d.renderer.setBase("near", cached.near);
      d.nearBase = true;
      queueMicrotask(() => setMapStatus(null));
      requestDraw();
      return;
    }
    let cancelled = false;
    const isCancelled = () => cancelled;
    const label = groundKind === "std" ? "地図" : "衛星画像";
    const total =
      groundTileCount(farSet, 0) +
      groundTileCount(nearSet, 0) +
      (farUp > 0 ? groundTileCount(farSet, farUp) : 0) +
      (nearUp > 0 ? groundTileCount(nearSet, nearUp) : 0) +
      (midSet ? groundTileCount(midSet, 0) + (midUp > 0 ? groundTileCount(midSet, midUp) : 0) : 0);
    let done = 0;
    const onTile = () => {
      done++;
      if (!cancelled) setMapStatus(done < total ? `${label}を読み込み中 ${done}/${total}` : null);
    };
    diagNote(`${label}を読み込み(遠景・中景・近景)`);
    queueMicrotask(() => {
      if (!cancelled) setMapStatus(`${label}を読み込み中 0/${total}`);
    });
    // 粗い画像を貼ったあと、細かい画像を作って置き換える(細かいタイルが無い所は、粗い画像が下に敷かれたまま残る)
    // 大きな画像(canvas)は、GPUへ貼ったらすぐ中身を手放す(待っていると、ブラウザが片づけるまで数百MBが残り、メモリ不足で落ちやすい)
    const releaseCanvas = (c: HTMLCanvasElement) => {
      c.width = 0;
      c.height = 0;
    };
    // canvasを作ってGPUへ貼るところは、ほかの大きな画像と重ならないよう順番に行う(`loadGroundCanvas` の consume)
    const load = async (set: typeof farSet, up: number, slot: "far" | "near" | "mid"): Promise<HTMLCanvasElement> => {
      const base = await loadGroundCanvas(groundKind, set, onTile, isCancelled, 0, undefined, false, undefined, (c) => d.renderer.setBase(slot, c));
      if (cancelled) {
        releaseCanvas(base);
        return base;
      }
      if (slot === "near") d.nearBase = true;
      if (slot === "mid") d.midBase = true;
      requestDraw();
      if (up === 0) return base;
      const fine = await loadGroundCanvas(groundKind, set, onTile, isCancelled, up, base, false, undefined, (c) => {
        d.renderer.setBase(slot, c);
        releaseCanvas(c);
      });
      if (!cancelled) requestDraw();
      releaseCanvas(base);
      releaseCanvas(fine);
      return base;
    };
    void (async () => {
      try {
        const [farImg, nearImg] = await Promise.all([
          load(farSet, farUp, "far"),
          load(nearSet, nearUp, "near"),
          ...(midSet ? [load(midSet, midUp, "mid")] : []),
        ]);
        if (!cancelled) {
          // 細かい画像はメモリが大きいので、取り置かない(切り替えたときは、ブラウザの保存分から読み直す)
          if (farUp === 0 && nearUp === 0 && !midSet) d.ground[groundKind] = { far: farImg, near: nearImg };
          setMapStatus(null);
        }
      } catch (e) {
        if (!cancelled) setMapStatus(`${label}を読み込めませんでした: ${errorMessage(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, groundKind, point.lat, point.lng, wide, quality, requestDraw]);

  // ---- カメラについていく細かい下地(処理「高」): 足もと=ズーム17(約±2km)・最も細かい=ズーム18(約±320m)・
  //      広い足もと=ズーム15(向いている方向へ約10km)・遠く=ズーム14(向いている方向へ約20km) ----
  // カメラの向き・位置(移動中は、進んでいく先)から決めた窓の中心がずれたら、読み直して貼り替える
  // (読み終わるまでは、前の画像のまま)。貼ったらすぐ canvas の中身を手放す。画像のない所は透明で、下の画像のまま。
  // 通信の一時的な失敗でタイルが抜けたときは、10秒後に(最大3回)読み直す。読み込み自体が失敗したときは、間をあけて(5秒→15秒→45秒)やり直し、
  // 4回続けて失敗したら、その下地はあきらめる(失敗のたびに大きな画像を作り直して、メモリを使い続けないように)。
  useEffect(() => {
    if (phase !== "ready") return;
    const d = dataRef.current;
    if (!d || !d.mesh) return;
    type TierSlot = "ahead" | "wfoot" | "foot" | "fine";
    type TierSpec = { zoom: number; half: number; recenterM: number; ahead?: number };
    const tiers: { slot: TierSlot; spec: TierSpec }[] = [];
    d.aheadBase = false;
    d.wfootBase = false;
    d.footBase = false;
    d.fineBase = false;
    // 最も細かい下地・広い足もと・遠くは、1枚のテクスチャに縦に並べる(テクスチャユニットを増やせないため)。大きさを先に確保する
    if (hasFineGround(quality)) {
      const side = (spec: { zoom: number; half: number }) => maxTilesAcross(point.lat, spec.zoom, spec.half) * TILE_PX;
      const wantAhead = hasAheadGround(quality);
      const wantWide = hasWideFoot(quality);
      // GPUメモリの目安(`gpuBudgetMB`)から、いま載っている分・足もとの画像(ズーム17)・あとで載る建物や木の分を引いた残りに、
      // アトラスが収まらないときは、省ける部分(遠く→広い足もと)を省く
      const footSide = side(footGround());
      const footMB = (footSide * footSide * 4 * 4) / 3 / (1024 * 1024);
      const freeMB = gpuBudgetMB(d.renderer.context) - d.renderer.mem.report().totalMB - footMB - 160;
      const ok = d.renderer.reserveFineAtlas(
        wantAhead ? { w: side(AHEAD_GROUND), h: side(AHEAD_GROUND) } : null,
        wantWide ? { w: side(WIDE_FOOT), h: side(WIDE_FOOT) } : null,
        { w: side(FINE_GROUND), h: side(FINE_GROUND) },
        Math.max(0, freeMB),
      );
      if ((wantAhead && !ok.ahead) || (wantWide && !ok.wfoot)) {
        diagNote(`GPUメモリの目安のため、先読みの下地を省いた(遠く${ok.ahead ? "あり" : "なし"}・広い足もと${ok.wfoot ? "あり" : "なし"})`);
      }
      // 遠くを先に(粗い順)。読み込みは並行して進む
      if (ok.ahead) tiers.push({ slot: "ahead", spec: AHEAD_GROUND });
      if (ok.wfoot) tiers.push({ slot: "wfoot", spec: WIDE_FOOT });
    }
    if (hasFootGround(quality)) {
      // 足もとの画像のテクスチャは、最大の大きさで先に1度だけ確保する(動くたびに確保し直すと、遠くまで移動したときにGPUのメモリが足りなくなりやすい)
      const fs = maxTilesAcross(point.lat, footGround().zoom, footGround().half) * TILE_PX;
      d.renderer.reserveFoot(fs, fs);
      tiers.push({ slot: "foot", spec: footGround() });
    }
    if (hasFineGround(quality)) tiers.push({ slot: "fine", spec: FINE_GROUND });
    if (tiers.length === 0) {
      requestDraw();
      return;
    }
    let cancelled = false;
    const isCancelled = () => cancelled;
    type TierState = {
      cx: number;
      cz: number;
      busy: boolean;
      loaded: boolean;
      retryAt: number;
      retries: number;
      startedAt: number;
      /** 読み込み自体の失敗(例外)が続いた回数と、次に試してよい時刻 */
      fails: number;
      blockedUntil: number;
      gaveUp: boolean;
    };
    const state = new Map<string, TierState>();
    // カメラの速さ(m/秒。なめらかにした値)。移動中は、窓をさらに進んでいく先へずらす
    const vel = { x: 0, z: 0, px: camRef.current.x, pz: camRef.current.z, t: performance.now() };
    const LEAD_S = 4;
    const updateVelocity = () => {
      const cam = camRef.current;
      const now = performance.now();
      const dt = (now - vel.t) / 1000;
      if (dt < 0.05) return;
      const k = Math.min(1, dt / 0.8);
      vel.x += ((cam.x - vel.px) / dt - vel.x) * k;
      vel.z += ((cam.z - vel.pz) / dt - vel.z) * k;
      vel.px = cam.x;
      vel.pz = cam.z;
      vel.t = now;
    };
    /**
     * 窓の中心にしたい位置: カメラの位置から、向いている方向へ spec.ahead だけ進め(見下ろし(俯瞰)のときは向きでずらさない)、
     * 移動中は、さらに約4秒ぶん進む先へずらした所。ただし、カメラが窓の端から300m以上内側に残るようにする。
     */
    const wantedCenter = (spec: TierSpec): [number, number] => {
      const cam = camRef.current;
      let ox = 0;
      let oz = 0;
      if (spec.ahead && liveRef.current?.mode !== "orbit") {
        const yaw = cam.yaw * DEG;
        ox = Math.sin(yaw) * spec.ahead;
        oz = -Math.cos(yaw) * spec.ahead;
      }
      ox += vel.x * LEAD_S;
      oz += vel.z * LEAD_S;
      // 窓は四角(半幅 spec.half)。カメラが窓の端から300m以上内側に残るよう、ずらす量を縮める
      const lim = Math.max(0, spec.half - 300);
      const m = Math.max(Math.abs(ox), Math.abs(oz));
      if (m > lim) {
        ox *= lim / m;
        oz *= lim / m;
      }
      return [cam.x + ox, cam.z + oz];
    };
    const loadTier = async (t: (typeof tiers)[number], cx: number, cz: number): Promise<void> => {
      const st = state.get(t.slot);
      if (!st) return;
      st.busy = true;
      st.startedAt = performance.now();
      diagNote(`カメラのまわりの地面(ズーム${t.spec.zoom})を読み込み`);
      try {
        let set = makeTileSet(point.lat, point.lng, t.spec.zoom, t.spec.half, cx, cz);
        // 画像の一辺がGPUの上限を超えるときは、範囲を狭める(例: 上限4096の端末)
        let half = t.spec.half;
        while (Math.max(set.nx, set.ny) * TILE_PX > d.maxTexture && half > 300) {
          half *= 0.8;
          set = makeTileSet(point.lat, point.lng, t.spec.zoom, half, cx, cz);
        }
        const stats = { failed: 0 };
        // 貼るのと、範囲(rect)を変えるのは同時に(間に1コマ描くと、ずれた画像が一瞬見える)。貼ったらすぐ canvas を手放す。
        // ほかの大きな画像と重ならないよう、canvasを作るところからここまでを順番に行う(`loadGroundCanvas` の consume)
        const img = await loadGroundCanvas(groundKind, set, () => undefined, isCancelled, 0, undefined, true, stats, (c) => {
          d.renderer.setBase(t.slot, c);
          c.width = 0;
          c.height = 0;
          const rect: [number, number, number, number] = [set.rect.x0, set.rect.z0, set.rect.sx, set.rect.sz];
          if (t.slot === "foot") {
            d.footRect = rect;
            d.footBase = true;
          } else if (t.slot === "fine") {
            d.fineRect = rect;
            d.fineBase = true;
          } else if (t.slot === "wfoot") {
            d.wfootRect = rect;
            d.wfootBase = true;
          } else {
            d.aheadRect = rect;
            d.aheadBase = true;
          }
          st.cx = cx;
          st.cz = cz;
          st.loaded = true;
          st.fails = 0;
          // 通信の一時的な失敗で抜けたタイルがあれば、少し待って読み直す(最大3回)
          if (stats.failed > 0 && st.retries < 3) {
            st.retries++;
            st.retryAt = performance.now() + 10_000;
            diagNote(`地面の画像(ズーム${t.spec.zoom})のタイル${stats.failed}枚を読めなかった(10秒後にやり直す)`);
          } else {
            st.retryAt = 0;
          }
          requestDraw();
        });
        img.width = 0;
        img.height = 0;
      } catch (e) {
        // 画像を作れない(メモリ不足など)・貼れないときは、間をあけてやり直す。続けて失敗したら、この下地はあきらめる
        st.fails++;
        st.blockedUntil = performance.now() + 5000 * 3 ** (st.fails - 1);
        if (st.fails >= 4) st.gaveUp = true;
        console.warn("[3Dビュー] カメラのまわりの地面の読み込みに失敗", t.slot, e);
        diagNote(`カメラのまわりの地面(ズーム${t.spec.zoom})の読み込みに失敗(${e instanceof Error ? e.name : "?"}・${st.fails}回目${st.gaveUp ? "・あきらめた" : ""})`);
      } finally {
        st.busy = false;
      }
    };
    for (const t of tiers) {
      state.set(t.slot, { cx: 0, cz: 0, busy: false, loaded: false, retryAt: 0, retries: 0, startedAt: 0, fails: 0, blockedUntil: 0, gaveUp: false });
    }
    const check = () => {
      if (cancelled) return;
      updateVelocity();
      const now = performance.now();
      for (const t of tiers) {
        const st = state.get(t.slot);
        if (!st || st.busy || st.gaveUp || now < st.blockedUntil) continue;
        // 最初は、(クリックした地点ではなく)いまのカメラの位置・向きから決めた中心にする
        const [wx, wz] = wantedCenter(t.spec);
        // 向きを変えている間に何度も読み直さないよう、前に読み始めてから少しあける(向いている方向へずらす窓だけ)
        const settled = !t.spec.ahead || now - st.startedAt > 1200;
        if (!st.loaded || (settled && Math.hypot(wx - st.cx, wz - st.cz) > t.spec.recenterM)) {
          st.retries = 0;
          void loadTier(t, wx, wz);
        } else if (st.retryAt > 0 && now >= st.retryAt) {
          void loadTier(t, st.cx, st.cz);
        }
      }
    };
    check();
    const timer = setInterval(check, 300);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [phase, groundKind, quality, point.lat, point.lng, requestDraw]);

  // ---- 処理「高」の追加効果の切り替え: 描画の解像度(canvasの大きさ)を測り直す ----
  useEffect(() => {
    if (phase !== "ready") return;
    dataRef.current?.resize();
  }, [phase, hq]);

  // ---- 山の影・谷の暗がり(処理「高」の追加効果): 地形の高さの格子を作る(地形ができたあと、一度だけ。少しずつ作る) ----
  useEffect(() => {
    if (phase !== "ready") return;
    const d = dataRef.current;
    if (!d || !d.mesh) return;
    if (!hq) {
      d.shadeBase = null;
      d.shadeG = null;
      d.shadeKey = "";
      d.renderer.setShade(null, seaRect(wide));
      requestDraw();
      return;
    }
    let cancelled = false;
    const mesh = d.mesh;
    void (async () => {
      const size = isLowMemoryDevice() ? SHADE_SIZE_LOWMEM : SHADE_SIZE;
      diagNote("山の影・暗がりの高さの格子を作成");
      const base = await buildShadeBase(mesh.groundAt, seaHalfM(wide), size, () => cancelled);
      if (cancelled || !base || dataRef.current !== d) return;
      d.shadeBase = base;
      d.shadeG = null;
      d.shadeKey = "";
      d.renderer.setShade({ size: base.size, ao: base.ao, g: null }, seaRect(wide));
      setShadeVersion((v) => v + 1);
      requestDraw();
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, hq, wide, requestDraw]);

  // ---- 山の影: 太陽の向きが変わったとき(時刻・日付・場所)に、影だけを作り直す(スライダーを動かしている間は少し待つ) ----
  useEffect(() => {
    if (phase !== "ready" || !hq || shadeVersion === 0) return;
    const timer = window.setTimeout(() => {
      const d = dataRef.current;
      if (!d || !d.shadeBase) return;
      const key = `${sun.azimuthDeg.toFixed(1)}/${sun.altitudeDeg.toFixed(1)}`;
      if (d.shadeKey === key) return;
      d.shadeKey = key;
      const g = computeSunShadow(d.shadeBase, dirFromAzAlt(sun.azimuthDeg, sun.altitudeDeg), d.shadeG ?? undefined);
      d.shadeG = g;
      d.renderer.setShadeSun(g);
      requestDraw();
    }, 140);
    return () => window.clearTimeout(timer);
  }, [phase, hq, shadeVersion, sun, requestDraw]);

  // ---- 霧: 地面の高さの地図(一度だけ)と、時刻に合う霧の濃さの地図(コマが変わったとき) ----
  useEffect(() => {
    if (phase !== "ready") return;
    const d = dataRef.current;
    if (!d || !d.mesh) return;
    let cancelled = false;
    const mesh = d.mesh;
    void (async () => {
      const heights = await buildHeightMap(mesh.groundAt, () => cancelled);
      if (cancelled || !heights) return;
      d.renderer.setHeightMap(heights, HEIGHT_MAP_SIZE);
      d.heightReady = true;
      requestDraw();
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, requestDraw]);

  useEffect(() => {
    if (phase !== "ready") return;
    const d = dataRef.current;
    if (!d) return;
    const pick = fogPickRef.current;
    const map = pick.sources.length > 0 ? buildFogMap(pick.sources, makeLocalToLatLon(point.lat, point.lng)) : null;
    d.renderer.setFogMap(map, FOG_MAP_SIZE);
    requestDraw();
    const info = { labels: pick.labels, any: map !== null };
    queueMicrotask(() => setFogInfo(info));
  }, [phase, fogKey, point.lat, point.lng, requestDraw]);

  // ---- 雲: 衛星画像の雲判定メッシュ(見ている日時に合うコマが変わったら、少し待ってから読み直して貼る) ----
  useEffect(() => {
    if (phase !== "ready") return;
    const d = dataRef.current;
    if (!d) return;
    if (!cloudOn) {
      d.renderer.setCloudMap(null, CLOUD_MAP_SIZE);
      requestDraw();
      return;
    }
    const pick = cloudPickRef.current;
    if (!pick) {
      d.renderer.setCloudMap(null, CLOUD_MAP_SIZE);
      requestDraw();
      queueMicrotask(() => setCloudInfo({ state: "none", label: null }));
      return;
    }
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setCloudInfo({ state: "loading", label: pick.label });
    });
    const timer = setTimeout(() => {
      loadCloudCells(pick)
        .then((cells) => {
          if (cancelled) return;
          const map = buildCloudMap(cells, makeLocalToLatLon(point.lat, point.lng));
          d.renderer.setCloudMap(map, CLOUD_MAP_SIZE);
          requestDraw();
          setCloudInfo({ state: map ? "ok" : "clear", label: pick.label });
        })
        .catch((e: unknown) => {
          if (cancelled) return;
          setCloudInfo({ state: "error", label: pick.label, message: errorMessage(e) });
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, cloudOn, cloudKey, point.lat, point.lng, requestDraw]);

  // ---- WASDで動く(押している間、向いている方向へ)。Shiftで上昇・Ctrlで下降。画面のパッドも同じ ----
  useEffect(() => {
    const keys = new Set<MoveKey>();
    let raf = 0;
    let last = 0;
    let uiAt = 0;
    const publish = () => {
      const d = dataRef.current;
      const cam = camRef.current;
      const elev = d?.mesh ? d.mesh.groundAt(cam.x, cam.z) + curvatureDropM(Math.hypot(cam.x, cam.z)) : null;
      setPos({ x: cam.x, z: cam.z, elev });
      setCamUi({ fov: cam.fov, eyeS: cam.eyeS, distS: cam.distS, lift: cam.lift });
    };
    const loop = (now: number) => {
      raf = 0;
      if (keys.size === 0) {
        last = 0;
        publish();
        return;
      }
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 0.016;
      last = now;
      const cam = camRef.current;
      const L = liveRef.current;
      const fwd = (keys.has("w") ? 1 : 0) - (keys.has("s") ? 1 : 0);
      const right = (keys.has("d") ? 1 : 0) - (keys.has("a") ? 1 : 0);
      let moving = false;
      if (L && dataRef.current?.mesh && (fwd !== 0 || right !== 0)) {
        const yaw = cam.yaw * DEG;
        const sy = Math.sin(yaw);
        const cy = Math.cos(yaw);
        // 方位角は北0°から時計回り。前=(東sin, 南-cos)、右=(東cos, 南sin)
        let mx = fwd * sy + right * cy;
        let mz = -fwd * cy + right * sy;
        const len = Math.hypot(mx, mz);
        mx /= len;
        mz /= len;
        const base =
          L.mode === "orbit"
            ? clamp(orbitDistOf(cam.distS) * 0.25, 60, 2500)
            : 25 * (1 + eyeHeightOf(cam.eyeS) / 40);
        let nx = cam.x + mx * base * dt;
        let nz = cam.z + mz * base * dt;
        const r = Math.hypot(nx, nz);
        const rMax = moveMaxOf(L.wide);
        if (r > rMax) {
          nx *= rMax / r;
          nz *= rMax / r;
        }
        cam.x = nx;
        cam.z = nz;
        moving = true;
      }
      // 上昇(Shift)・下降(Ctrl)。高いほど速く(高さが約1.7秒で2.7倍になる勢い)。同時に押したときは動かない
      const vert = (keys.has("up") ? 1 : 0) - (keys.has("dn") ? 1 : 0);
      if (L && dataRef.current?.mesh && vert !== 0) {
        if (L.mode === "first") {
          const h = eyeHeightOf(cam.eyeS);
          const nh = clamp(h + vert * (3 + 0.6 * h) * dt, EYE_MIN_M, EYE_MAX_M);
          cam.eyeS = clamp(eyeToSlider(nh), 0, 100);
        } else {
          cam.lift = clamp(cam.lift + vert * (40 + 0.6 * Math.abs(cam.lift)) * dt, LIFT_MIN_M, LIFT_MAX_M);
        }
        moving = true;
      }
      if (moving) {
        requestDraw();
        if (now - uiAt > 150) {
          uiAt = now;
          publish();
        }
      }
      raf = requestAnimationFrame(loop);
    };
    const press = (k: MoveKey, down: boolean) => {
      if (down) {
        keys.add(k);
        if (!raf) raf = requestAnimationFrame(loop);
      } else {
        keys.delete(k);
      }
    };
    const keyOf = (e: KeyboardEvent): MoveKey | null => {
      switch (e.code) {
        case "KeyW":
          return "w";
        case "KeyA":
          return "a";
        case "KeyS":
          return "s";
        case "KeyD":
          return "d";
        case "ShiftLeft":
        case "ShiftRight":
          return "up";
        case "ControlLeft":
        case "ControlRight":
          return "dn";
        default:
          return null;
      }
    };
    const onDown = (e: KeyboardEvent) => {
      const k = keyOf(e);
      if (!k || e.metaKey || e.altKey || isTypingTarget(e.target)) return;
      press(k, true);
      // Ctrl+A(全選択)・Ctrl+S(保存)・Ctrl+D(ブックマーク)などが一緒に動かないようにする。ShiftやCtrlだけのときは何もしない
      if (k !== "up" && k !== "dn") e.preventDefault();
    };
    const onUp = (e: KeyboardEvent) => {
      const k = keyOf(e);
      if (k) press(k, false);
    };
    const onBlur = () => {
      keys.clear();
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    moveApiRef.current = { press };
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
      moveApiRef.current = null;
    };
  }, [requestDraw]);

  const goHome = () => {
    const cam = camRef.current;
    cam.x = 0;
    cam.z = 0;
    cam.lift = 0;
    setCamUi((c) => ({ ...c, lift: 0 }));
    const d = dataRef.current;
    setPos({ x: 0, z: 0, elev: d?.mesh ? d.mesh.ground0 : null });
    requestDraw();
  };

  // ---- 木の色: 近景の紅葉メッシュの色(新緑・紅葉・雪)を、木の根もとの位置で引いて付ける。紅葉メッシュを消していれば夏の緑 ----
  const recolorTrees = useCallback((onlyRing?: number) => {
    const d = dataRef.current;
    if (!d || d.treeGroups.size === 0) return;
    const on = liveRef.current?.koyoOn ?? true;
    const samplers = [];
    if (on && d.nearOvImg && d.near) samplers.push(makeOverlaySampler(d.near.set, d.nearOvImg));
    if (on && d.farOvImg && d.far) samplers.push(makeOverlaySampler(d.far.set, d.farOvImg));
    for (const [ring, g] of d.treeGroups) {
      if (onlyRing !== undefined && ring !== onlyRing) continue;
      for (const set of g.sets) d.renderer.objects.setTreeColors(set.kind, set.lod, computeTreeColors(set, samplers), `r${ring}`);
    }
    requestDraw();
  }, [requestDraw]);

  // ---- 川・池・建物: 国土地理院のベクトルタイルから形を読み、水の地図(岸つき)と建物の立体にする ----
  // 処理の低・中・高で、読む距離が変わる。遠い帯ほど粗いズームのタイルを読む(建物のデータはズーム14以上にだけある)。
  useEffect(() => {
    if (phase !== "ready") return;
    const d = dataRef.current;
    if (!d || !d.mesh) return;
    const groundAt = d.mesh.groundAt;
    const spec = qualitySpec(quality, wide);
    let cancelled = false;
    const isCancelled = () => cancelled;
    const wideSet = makeTileSet(point.lat, point.lng, WIDE_GEO_ZOOM, WIDE_GEO_HALF_M);
    const farSet = spec.waterFar ? makeTileSet(point.lat, point.lng, spec.waterFar.zoom, spec.waterFar.half) : null;
    // 建物の帯。最初(ズーム16)は四角いタイル範囲の全部を読み(足もとの水の地図にも使う)、遠い帯は距離でしぼる
    const bands = spec.buildingBands.map((b, i) =>
      i === 0
        ? { set: makeTileSet(point.lat, point.lng, b.zoom, NEAR_GEO_HALF_M), layers: GEO_NEAR_LAYERS, band: { rMin: 0, rMax: NEAR_BAND_R_M }, all: true }
        : { set: makeTileSet(point.lat, point.lng, b.zoom, b.rMax), layers: GEO_BLDG_LAYERS, band: { rMin: i === 1 ? NEAR_BAND_R_M : b.rMin, rMax: b.rMax }, all: false },
    );
    const total =
      bandTileRefs(wideSet).length +
      (farSet ? bandTileRefs(farSet).length : 0) +
      bands.reduce((a, b) => a + bandTileRefs(b.set, b.all ? undefined : b.band).length, 0);
    let done = 0;
    // 遠くの帯を読んでいる間も、約8秒ごとに、それまでに読んだ箱を出す(帯を読み終えるまで待たない)
    let farLoading = false;
    let showing = false;
    let lastShow = performance.now();
    // 箱が数十万棟になると作り直しに1秒前後かかるので、出す間隔は「前回かかった時間の4倍」以上にする
    let showGap = 8000;
    const onTile = () => {
      done++;
      if (!cancelled && done < total) {
        setGeoInfo((g) => ({ ...g, state: "loading", text: `建物の形を読み込み中 ${done}/${total}` }));
      }
      if (farLoading && !showing && performance.now() - lastShow > showGap) {
        showing = true;
        const t0 = performance.now();
        void showBoxes(false).finally(() => {
          showing = false;
          lastShow = performance.now();
          showGap = Math.max(8000, (lastShow - t0) * 4);
        });
      }
    };
    queueMicrotask(() => {
      if (!cancelled) setGeoInfo((g) => ({ ...g, state: "loading", text: `川・池・建物の形を読み込み中 0/${total}` }));
    });
    // 近く(約2.5kmまで)の建物は形の立体に、原点に近い順に上限の件数までだけ持つ(読みながら遠い建物を捨てる)。
    // 遠く(約2.5km〜)の建物は箱にして、1棟6つの数値で詰めて持つ(20kmまでは間引かない。その先は間引く。`BoxCollector`)
    const collector = new BuildingCollector(spec.buildingMax);
    const boxes = new BoxCollector(spec.boxMax);
    // 夜景の光の点は、立体の上限・間引きとは別に、範囲(約25km・拡張で約50km)のすべての建物から集める。
    // 立体が上限に達して遠いタイルを読まなくなる都市でも、光の点のために遠いタイルまで読む(noSkip)
    const lightCollector = new LightCollector(isLowMemoryDevice() ? 300_000 : 700_000);
    const sink = {
      collector,
      prep: (b: GeoBuilding) => {
        lightCollector.add(b);
        const near = prepareBuilding(b);
        if (!near) boxes.add(b);
        return near;
      },
      noSkip: true,
    };
    const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    // 読み込みの失敗は、そのタイルを空として扱う(全体を止めない)
    const loadBand = (b: (typeof bands)[number], limit = 8) =>
      loadGeoSet(b.set, b.layers, onTile, isCancelled, b.band, sink, limit).catch(() => emptyGeo());
    // 先に、近くの帯(約2.5kmまでの建物を含む帯)と水を読み、近くの建物・水を出す。遠くの帯(箱の建物)は、そのあとで足す
    const nearBands = bands.filter((b, i) => i === 0 || b.band.rMin < FOOTPRINT_MAX_M);
    const farBands = bands.filter((b) => !nearBands.includes(b));
    // 注意: map(loadBand) と書くと、配列の番号が「同時に読む枚数」に渡ってしまう(最初の帯が0枚=何も読まれない)ので、引数を明示する
    const nearP = Promise.all(nearBands.map((b) => loadBand(b, 8)));
    const waterP = Promise.all([
      loadGeoSet(wideSet, GEO_WIDE_LAYERS, onTile, isCancelled).catch(() => emptyGeo()),
      farSet ? loadGeoSet(farSet, GEO_WIDE_LAYERS, onTile, isCancelled).catch(() => emptyGeo()) : Promise.resolve(emptyGeo()),
    ]);
    // 建物のデータ(ズーム16)を読む範囲より遠く(約20km〜)の、推定の箱のための「建物のある割合」(標準地図・人口集中地区)
    const urbanP =
      spec.proxyFromM !== null ? loadUrbanGrid(point.lat, point.lng, spec.buildingKm * 1000, isCancelled).catch(() => null) : Promise.resolve(null);
    /** いまの箱(遠くの建物)をGPUへ渡す。final なら、集めた箱を手放す */
    const showBoxes = async (final: boolean) => {
      const inst = await buildBoxInstances(final ? boxes.result() : boxes.snapshot(), groundAt, isCancelled);
      if (cancelled || !inst) return null;
      d.renderer.objects.setBuildingBoxes(inst.count > 0 ? inst : null);
      requestDraw();
      return inst;
    };
    let nearCount = 0;
    let waters = 0;
    void (async () => {
      try {
        const [nearGeo] = await nearP;
        if (cancelled) return;
        // 近くの建物(形の立体)。遠くの帯を読んでいる間も、近くの建物は先に見える
        const nearBuildings = collector.result();
        const bm = buildBuildingMesh(nearBuildings, groundAt, spec.buildingMax);
        d.renderer.objects.setBuildings(bm.indices.length > 0 ? bm : null);
        nearCount = bm.indices.length > 0 ? bm.count : 0;
        requestDraw();
        // 約2.5〜6kmの建物(箱)も、すぐ出す(以前は、遠くの帯を読み終えるまで出さなかったので、約2.5kmで建物が切れて見えた)
        await showBoxes(false);
        if (cancelled) return;
        lastShow = performance.now();
        const [wideGeo, farGeo] = await waterP;
        if (cancelled) return;
        setGeoInfo((g) => ({ ...g, state: "loading", text: "水面を作成中…" }));
        await tick();
        if (cancelled) return;
        // 足もとの水の地図に写す建物の足もと(木を避ける用)。足もと(約±1.3km)の建物だけ
        const nearMaskGeo: GeoData = { ...nearGeo, buildings: nearBuildings.filter((b) => Math.abs(b.cx ?? 0) < NEAR_GEO_HALF_M + 60 && Math.abs(b.cz ?? 0) < NEAR_GEO_HALF_M + 60) };
        const nearMask = rasterizeMask(nearMaskGeo, NEAR_GEO_HALF_M, GEO_MASK_SIZE, { buildings: true });
        const wideMask = rasterizeMask(wideGeo, WIDE_GEO_HALF_M, GEO_MASK_SIZE, { buildings: false });
        const farMask = spec.waterFar
          ? rasterizeMask(farGeo, spec.waterFar.half, wide && quality === "high" ? Math.min(GEO_MASK_SIZE * 2, d.maxTexture) : GEO_MASK_SIZE, {
              buildings: false,
              banks: false,
            })
          : null;
        d.renderer.setWaterMask("near", nearMask);
        d.renderer.setWaterMask("wide", wideMask);
        d.renderer.setWaterMask("far", farMask);
        d.masks = { near: nearMask, wide: wideMask, far: farMask };
        waters = wideGeo.waters.length + wideGeo.rivers.length + farGeo.waters.length + farGeo.rivers.length;
        // 木は、水・近くの建物の足もとが分かったら立てられる
        setGeoLoaded((g) => ({ version: g.version + 1, quality, wide }));
        requestDraw();
        // 遠くの帯は、近くの帯を読み終えてから、近い帯から順に読む(1帯ずつ、同時に12枚)。読み終えた帯までの箱を、そのつど出す
        farLoading = true;
        for (const b of farBands) {
          await loadBand(b, 16);
          if (cancelled) return;
          while (showing) await new Promise<void>((resolve) => setTimeout(resolve, 100));
          await tick();
          showing = true;
          await showBoxes(false).finally(() => {
            showing = false;
            lastShow = performance.now();
          });
          if (cancelled) return;
        }
        farLoading = false;
        while (showing) await new Promise<void>((resolve) => setTimeout(resolve, 100));
        // その先(約20km〜)は、推定の箱(本物の建物と同じく、遠いほど間引いて大きくする)。夜景の光の点にも入れる
        if (spec.proxyFromM !== null) {
          const urban = await urbanP;
          if (cancelled) return;
          if (urban) {
            setGeoInfo((g) => ({ ...g, state: "loading", text: "遠くの街(推定)を作成中…" }));
            await addUrbanProxies(
              urban,
              spec.proxyFromM,
              spec.buildingKm * 1000,
              (x, z, hx, hz, code, preKept) => {
                boxes.addRect(x, z, hx, hz, code, preKept);
                lightCollector.addRect(x, z, Math.max(hx, hz), code, preKept);
              },
              isCancelled,
              // 箱の上限に達して、それより遠くは入らない区画は作らない(大都市で数百万棟を作らないように。遠くの街の明かりは、人口集中地区の地面の光で出る)
              (dd) => boxes.full(dd),
            );
            if (cancelled) return;
          }
        }
        setGeoInfo((g) => ({ ...g, state: "loading", text: "遠くの建物を作成中…" }));
        await tick();
        if (cancelled) return;
        // 遠くの建物(箱)と、夜景の光の点
        const inst = await showBoxes(true);
        if (cancelled || !inst) return;
        d.renderer.objects.setBuildingLights(lightCollector.result(groundAt));
        setGeoInfo((g) => ({ ...g, state: "ok", text: null, waters, buildings: nearCount + inst.count }));
        requestDraw();
      } catch (e) {
        if (cancelled) return;
        console.error("[3Dビュー] 川・池・建物の作成に失敗", e);
        diagNote(`川・池・建物の作成に失敗(${e instanceof Error ? e.name : "?"})`);
        d.renderer.setWaterMask("near", null);
        d.renderer.setWaterMask("wide", null);
        d.renderer.setWaterMask("far", null);
        d.renderer.objects.setBuildings(null);
        d.renderer.objects.setBuildingBoxes(null);
        d.renderer.objects.setBuildingLights(null);
        d.masks = { near: null, wide: null, far: null };
        setGeoInfo({ state: "ok", text: "川・池・建物の形を読み込めませんでした", waters: 0, buildings: 0, trees: 0 });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [phase, quality, wide, point.lat, point.lng, requestDraw]);

  // ---- 木: 植生図が森林の場所に立てる(川・池・岸・建物の足もとは避ける)。形を読み終えたあと、植生図が届いたときにも ----
  // 木は帯(リング)ごとに「いまの視点(カメラ)」を中心に立てる(近い帯は細かい木、遠い帯は粗い木)。
  // 視点が動いて、ある帯の中心から離れすぎたら、その帯だけを作り直す(近い帯ほど細かく作り直す)ので、
  // 動いた先でも、近くの木は細かく・遠くの木は粗くなる(粗い木が視点のまわりに増えていかない)。
  useEffect(() => {
    if (phase !== "ready" || geoLoaded.version === 0) return;
    const d = dataRef.current;
    if (!d || !d.mesh) return;
    const rings = qualitySpec(geoLoaded.quality, geoLoaded.wide).treeRings;
    const input = {
      lat0: point.lat,
      lon0: point.lng,
      veg,
      groundAt: d.mesh.groundAt,
      toLatLon: makeLocalToLatLon(point.lat, point.lng),
      masks: d.masks,
      quality: geoLoaded.quality,
      wide: geoLoaded.wide,
    };
    let cancelled = false;
    const isCancelled = () => cancelled;
    const publishCount = () => {
      let count = 0;
      for (const g of d.treeGroups.values()) for (const t of g.sets) count += t.count;
      setGeoInfo((g) => ({ ...g, trees: count }));
    };
    // 古い木を外す(処理や範囲を変えたあと・植生図が届いたあとに、帯の数が変わっていても残らないように)
    d.renderer.objects.setTrees([]);
    d.treeGroups = new Map();
    let busy = false;
    const build = async (ring: number) => {
      const cam = camRef.current;
      const cx = cam.x;
      const cz = cam.z;
      diagNote(`木を作成(帯${ring})`);
      const sets = await placeTreeRing(input, ring, cx, cz, isCancelled);
      if (!sets || cancelled) return;
      d.treeGroups.set(ring, { sets, cx, cz });
      d.renderer.objects.setTrees(sets, `r${ring}`);
      recolorTrees(ring);
    };
    const run = async () => {
      if (busy) return;
      busy = true;
      try {
        // 近い帯から順に(最初は全部、あとは離れすぎた帯だけ)
        for (let i = 0; i < rings.length && !cancelled; i++) {
          const g = d.treeGroups.get(i);
          const cam = camRef.current;
          if (g && Math.hypot(cam.x - g.cx, cam.z - g.cz) <= treeRebuildDistance(rings[i])) continue;
          await build(i);
          if (!cancelled) {
            publishCount();
            requestDraw();
          }
        }
      } finally {
        busy = false;
      }
    };
    void run();
    const timer = window.setInterval(() => void run(), 400);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [phase, geoLoaded, veg, point.lat, point.lng, recolorTrees, requestDraw]);

  // ---- 天の川の明るさの地図(実際の天の川の輪郭から作った小さな画像。約70KB)。描画器ができたら1度だけ読む ----
  useEffect(() => {
    if (phase !== "ready") return;
    const d = dataRef.current;
    if (!d) return;
    let cancelled = false;
    void fetch(dataUrl("milkyway_gal.png"))
      .then((res) => (res.ok ? res.blob() : Promise.reject(new Error(String(res.status)))))
      .then((blob) => createImageBitmap(blob))
      .then((bmp) => {
        if (!cancelled) {
          d.renderer.setMilkyWayMap(bmp);
          requestDraw();
        }
        bmp.close();
      })
      .catch(() => {
        // 読めなければ、シェーダーのなめらかな帯のまま
        diagNote("天の川の地図を読めなかった");
      });
    return () => {
      cancelled = true;
    };
  }, [phase, requestDraw]);

  // ---- 光害: 夜になって初めて、建物のある所(標準地図)・人口集中地区・道路を読み、方位ごとの光の強さの表(空)と地面の光の地図にして渡す ----
  const needLight = lightOn && look.night > 0.05;
  useEffect(() => {
    if (phase !== "ready" || !needLight) return;
    const d = dataRef.current;
    if (!d || d.lightSrc) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLightInfo({ state: "loading", text: "建物のある所・人口集中地区(約150km圏)・道路を調べています…" });
    });
    void loadLightSource(
      point.lat,
      point.lng,
      (done, total) => {
        if (!cancelled) setLightInfo({ state: "loading", text: `建物のある所・人口集中地区(約150km圏)・道路を調べています ${done}/${total}` });
      },
      () => cancelled,
    )
      .then((src) => {
        if (cancelled) return;
        d.lightSrc = src;
        setLightVersion((v) => v + 1);
      })
      .catch(() => {
        if (!cancelled) setLightInfo({ state: "error", text: "建物・人口集中地区のデータを読み込めなかったので、光害は表示できません" });
      });
    return () => {
      cancelled = true;
    };
  }, [phase, needLight, point.lat, point.lng]);

  useEffect(() => {
    if (phase !== "ready" || lightVersion === 0) return;
    const d = dataRef.current;
    if (!d || !d.lightSrc) return;
    if (!d.lightSrc.loaded) {
      d.renderer.setGlow(null);
      d.renderer.setGroundLight(null);
      queueMicrotask(() => setLightInfo({ state: "error", text: "この付近の建物・人口集中地区のデータを取得できなかったので、光害は表示できません" }));
      requestDraw();
      return;
    }
    const toLatLon = makeLocalToLatLon(point.lat, point.lng);
    const res = buildGlowTable(d.lightSrc, veg, toLatLon);
    d.renderer.setGlow(res.table, res.dome);
    // 地面の光: 建物のある所(森林以外)を白く、道路をオレンジに光らせる(道路は空の光害には影響しない)
    const ground = buildGroundLightMap(d.lightSrc, veg, toLatLon);
    d.renderer.setGroundLight(ground);
    let strongest = 0;
    for (let i = 0; i < res.table.length; i += 2) strongest = Math.max(strongest, res.table[i]);
    queueMicrotask(() =>
      setLightInfo({
        state: "ok",
        text:
          res.litCells === 0 || strongest < 12
            ? "まわりに建物のある所が少ないので、夜空・地面(道路以外)はほとんど光りません"
            : `光る区画が${res.litCells}か所(約150km圏。近く約40kmは標準地図から、それより遠くは人口集中地区から推定。遠い街ほど距離で弱めます)。その方角の空と地面(まわりの約${(ground.litRatio * 100).toFixed(0)}%)が白く、道路がオレンジに光ります`,
      }),
    );
    requestDraw();
  }, [phase, lightVersion, veg, point.lat, point.lng, requestDraw]);

  // ---- 雲海: 「基準の標高」(森林でない所=市街地の標高から20kmごとに作った基準点を、なめらかにつないだ地図)を作って貼る ----
  useEffect(() => {
    if (phase !== "ready" || !seaOn) return;
    const d = dataRef.current;
    if (!d || !d.mesh) return;
    if (!d.seaRef || d.seaRef.veg !== veg) {
      const half = seaHalfM(wide);
      const toLL = makeLocalToLatLon(point.lat, point.lng);
      const groundAt = d.mesh.groundAt;
      // 地形の標高(海抜。地球の丸みで下がる分を戻す)
      const elevAt = (X: number, Z: number) => groundAt(X, Z) + curvatureDropM(Math.hypot(X, Z));
      const forestAt = veg
        ? (X: number, Z: number): boolean | null => {
            const ll = toLL(X, Z);
            const c = vegClassAtFine(veg, ll.lat, ll.lon);
            return c === VEG_UNKNOWN ? null : treeKindOf(c) !== null;
          }
        : null;
      const map = buildSeaRefMap(elevAt, forestAt, half, SEA_MAP_SIZE);
      d.seaRef = { map, size: SEA_MAP_SIZE, half, veg };
      d.renderer.setSeaMap(map, SEA_MAP_SIZE, seaRect(wide));
    }
    const info = { map: d.seaRef.map, size: d.seaRef.size, half: d.seaRef.half };
    queueMicrotask(() => setSeaRefState(info));
    requestDraw();
  }, [phase, seaOn, wide, veg, point.lat, point.lng, requestDraw]);
  // いまの場所の、雲海の基準の標高(m)
  const seaRefHere = useMemo(
    () => (seaRefState ? seaRefAt(seaRefState.map, seaRefState.size, seaRefState.half, pos.x, pos.z) : null),
    [seaRefState, pos.x, pos.z],
  );

  // ---- 地名・百名山: オンにしたとき、国土地理院の注記タイル(山名・市町村名など)と百名山の一覧から、ラベルの位置を作る ----
  const needLabels = placesOn || peaksOn;
  useEffect(() => {
    if (phase !== "ready" || !needLabels) return;
    const d = dataRef.current;
    if (!d || !d.mesh || d.labels || d.labelsBusy) return;
    d.labelsBusy = true;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) setLabelInfo({ state: "loading", text: "地名・百名山を調べています…" });
    });
    void loadLabels(point.lat, point.lng, wide ? TERRAIN_RADIUS_WIDE_M : TERRAIN_RADIUS_M, wide, d.mesh.groundAt, () => cancelled)
      .then((res) => {
        if (cancelled) return;
        d.labels = res.items;
        d.labelVis = null;
        setLabelInfo({
          state: "ok",
          text: `地名${res.places}か所・百名山${res.peaks}座(描画範囲の中)。山に隠れる所・雲海の下の所は出しません。`,
        });
        requestDraw();
      })
      .catch(() => {
        if (!cancelled) setLabelInfo({ state: "error", text: "地名のデータを読み込めなかったので、地名・百名山は表示できません" });
      })
      .finally(() => {
        if (!cancelled) d.labelsBusy = false;
      });
    return () => {
      cancelled = true;
      d.labelsBusy = false;
    };
  }, [phase, needLabels, wide, point.lat, point.lng, requestDraw]);

  // 紅葉メッシュのON/OFFで、木の色を付け替える
  useEffect(() => {
    if (phase !== "ready") return;
    recolorTrees();
  }, [phase, koyoOn, recolorTrees]);

  // ---- 星座: 時刻・場所が変わるたびに、星と線の向きを貼り直す ----
  useEffect(() => {
    if (phase !== "ready") return;
    const d = dataRef.current;
    if (!d) return;
    d.renderer.objects.setConstellations(constFrame ? constFrame.gl : null);
    requestDraw();
  }, [phase, constFrame, requestDraw]);

  // ---- 紅葉メッシュ: 日付・樹種・気温の設定が変わったら、少し待ってから作り直して貼る ----
  useEffect(() => {
    if (phase !== "ready" || !koyoOn) return;
    let cancelled = false;
    const isCancelled = () => cancelled;
    const timer = setTimeout(() => {
      const d = dataRef.current;
      if (!d || !d.far || !d.near) return;
      const farDem = d.far;
      const nearDem = d.near;
      const input: KoyoClimateInput = { ...climateInput, day: koyoDay };
      const ctx: KoyoTileContext = {
        stationT0: buildStationT0(input),
        stationT0Ahead: buildStationT0Ahead(input),
        stationT0Past: buildStationT0Past(input),
        season: makeSeasonContext(input, zones),
        lapseCPerM: input.lapseCPerM,
        veg,
        hiddenClasses,
      };
      setOvBusy(true);
      diagNote("紅葉メッシュを計算");
      void (async () => {
        try {
          const farImg = await buildKoyoOverlay(farDem.set, farDem, ctx, isCancelled);
          if (cancelled) return;
          d.renderer.setOverlay("far", farImg);
          d.farOvImg = farImg;
          recolorTrees();
          requestDraw();
          const nearImg = await buildKoyoOverlay(nearDem.set, nearDem, ctx, isCancelled);
          if (cancelled) return;
          d.renderer.setOverlay("near", nearImg);
          d.nearOv = true;
          d.nearOvImg = nearImg;
          recolorTrees();
          requestDraw();
        } finally {
          if (!cancelled) setOvBusy(false);
        }
      })();
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [phase, koyoOn, koyoDay, climateInput, veg, zones, hiddenClasses, requestDraw, recolorTrees]);

  // ---- 操作: ドラッグで見回す・ホイール/ピンチで拡大縮小・キーボード ----
  const zoomBy = useCallback(
    (factor: number) => {
      const cam = camRef.current;
      if (liveRef.current?.mode === "orbit") {
        const dist = clamp(orbitDistOf(cam.distS) / factor, DIST_MIN_M, DIST_MAX_M);
        cam.distS = distToSlider(dist);
      } else {
        cam.fov = clamp(cam.fov / factor, FOV_MIN, FOV_MAX);
      }
      setCamUi({ fov: cam.fov, eyeS: cam.eyeS, distS: cam.distS, lift: cam.lift });
      requestDraw();
    },
    [requestDraw],
  );

  const rotateBy = useCallback(
    (dyaw: number, dpitch: number) => {
      const cam = camRef.current;
      const orbit = liveRef.current?.mode === "orbit";
      cam.yaw = normAz(cam.yaw + dyaw);
      cam.pitch = orbit ? clamp(cam.pitch + dpitch, -89, -2) : clamp(cam.pitch + dpitch, -89, 89);
      requestDraw();
    },
    [requestDraw],
  );

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const prev = pointersRef.current.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    if (pointersRef.current.size === 1) {
      const d = dataRef.current;
      const cam = camRef.current;
      const k = liveRef.current?.mode === "orbit" ? 0.3 : cam.fov / Math.max(200, d?.w ?? 600);
      rotateBy(-(cur.x - prev.x) * k, (cur.y - prev.y) * k);
      pointersRef.current.set(e.pointerId, cur);
    } else {
      pointersRef.current.set(e.pointerId, cur);
      if (pointersRef.current.size === 2 && pinchRef.current) {
        const [a, b] = [...pointersRef.current.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (dist > 1) {
          zoomBy(dist / pinchRef.current);
          pinchRef.current = dist;
        }
      }
    }
  };
  const onPointerEnd = (e: ReactPointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(e.pointerId);
    pinchRef.current = null;
  };

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy(Math.exp(-e.deltaY * 0.0015));
    };
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "ArrowLeft") rotateBy(-5, 0);
      else if (e.key === "ArrowRight") rotateBy(5, 0);
      else if (e.key === "ArrowUp") rotateBy(0, 3);
      else if (e.key === "ArrowDown") rotateBy(0, -3);
      else if (e.key === "+" || e.key === "=") zoomBy(1.15);
      else if (e.key === "-") zoomBy(1 / 1.15);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [rotateBy, zoomBy]);

  // ---- 画面の部品の操作 ----
  const changeMode = (m: Mode) => {
    if (m === mode) return;
    const cam = camRef.current;
    cam.pitch = m === "orbit" ? -35 : 0;
    liveRef.current = liveRef.current ? { ...liveRef.current, mode: m } : liveRef.current;
    setMode(m);
  };

  const setCam = (patch: Partial<{ fov: number; eyeS: number; distS: number; lift: number }>) => {
    Object.assign(camRef.current, patch);
    const c = camRef.current;
    setCamUi({ fov: c.fov, eyeS: c.eyeS, distS: c.distS, lift: c.lift });
    requestDraw();
  };

  const jumpTo = (d: Date | null) => {
    if (!d) return;
    const m = Math.round((d.getTime() - dayStart.getTime()) / 60_000);
    setMinutes(clamp(m, 0, 1439));
  };

  const setNow = () => {
    const now = new Date();
    setDateStr(ymd(now));
    setMinutes(now.getHours() * 60 + now.getMinutes());
  };

  // 俯瞰でカメラが雲より低い所にいると、雲は(下から見上げる向きにならないので)見えない。雲の上まで持ち上げる
  const raiseAboveClouds = () => {
    const cam = camRef.current;
    const g = dataRef.current?.mesh?.ground0 ?? 0;
    const eyeAboveTarget = Math.sin(clamp(-cam.pitch, 0, 89) * DEG) * orbitDistOf(cam.distS);
    const want = cloudAlt + CLOUD_THICK_M + 300;
    setCam({ lift: clamp(want - (g + 30 + eyeAboveTarget), 0, LIFT_MAX_M) });
  };

  const faceBody = (pos: BodyPos) => {
    const cam = camRef.current;
    cam.yaw = normAz(pos.azimuthDeg);
    if (mode === "first") cam.pitch = clamp(pos.altitudeDeg * 0.8, -10, 55);
    requestDraw();
  };

  // 星座の名前をタップすると、その方を向く(地平線の上にあるものだけ)
  const faceConst = (lb: ConstLabel) => {
    faceBody({ azimuthDeg: normAz((Math.atan2(lb.dir[0], -lb.dir[2])) / DEG), altitudeDeg: lb.altDeg });
  };
  const constList = useMemo(() => {
    if (!constFrame) return [];
    const seen = new Set<string>();
    return constFrame.labels
      .filter((l) => l.kind !== 2 && l.altDeg > 3)
      .filter((l) => (seen.has(l.text) ? false : (seen.add(l.text), true)))
      .sort((a, b) => b.altDeg - a.altDeg);
  }, [constFrame]);
  const geoText =
    geoInfo.text ??
    (geoInfo.state === "ok"
      ? geoInfo.waters + geoInfo.buildings === 0
        ? `この付近には川・池・建物のデータがないか、取得できませんでした(木${geoInfo.trees.toLocaleString("ja-JP")}本)`
        : `水域${geoInfo.waters.toLocaleString("ja-JP")}か所(半径約${qualitySpec(geoLoaded.quality, geoLoaded.wide).waterKm}km)・建物${geoInfo.buildings.toLocaleString("ja-JP")}棟(半径約${qualitySpec(geoLoaded.quality, geoLoaded.wide).buildingKm}km${proxyNote(geoLoaded.quality, geoLoaded.wide)})・木${geoInfo.trees.toLocaleString("ja-JP")}本(半径約${qualitySpec(geoLoaded.quality, geoLoaded.wide).treeKm}km)`
      : null);

  const eyeH = eyeHeightOf(camUi.eyeS);
  const orbitDist = orbitDistOf(camUi.distS);
  // 俯瞰のカメラの海抜(目安。見下ろす角度は既定の35°として計算)
  const orbitEyeAlt = (groundElev ?? 0) + 30 + camUi.lift + Math.sin(35 * DEG) * orbitDist;
  const title = address ?? `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}`;
  const koyoRangeDays = koyo.dayRange.end - koyo.dayRange.start;
  const toLatLon = useMemo(() => makeLocalToLatLon(point.lat, point.lng), [point.lat, point.lng]);
  const moved = Math.hypot(pos.x, pos.z) > 1;
  const here = moved ? toLatLon(pos.x, pos.z) : { lat: point.lat, lon: point.lng };
  const cloudHasData = !!cloud && cloud.observed.length > 0;
  const cloudText = !cloudOn
    ? null
    : cloudInfo.state === "none"
      ? cloudHasData
        ? "衛星画像のコマを選べませんでした"
        : "衛星画像がまだ届いていません"
      : cloudInfo.state === "loading"
        ? `雲を読み込み中: ${cloudInfo.label ?? ""}`
        : cloudInfo.state === "ok"
          ? `現在の雲を表示中(衛星画像 ${cloudInfo.label ?? ""})。日付・時刻を動かしても、雲は現在のままです`
          : cloudInfo.state === "clear"
            ? `現在、雲はありません(衛星画像 ${cloudInfo.label ?? ""})`
            : cloudInfo.state === "error"
              ? `雲を読み込めませんでした: ${cloudInfo.message ?? ""}`
              : null;
  const year = Number(dateStr.slice(0, 4));
  const milkyNote =
    look.night < 0.05
      ? "昼間は見えません"
      : look.milkyWay > 0.6
        ? "よく見える空です"
        : look.milkyWay > 0.15
          ? "うっすら見える空です(月明かり・薄明)"
          : "月明かり・薄明で見えにくい空です";
  const fogHasData = !!fog && (!!fog.current || !!fog.forecast);
  const hasCurrentFrame = !!fog?.current && fogPick.sources.some((src) => src.grid === fog.current);
  const nearNow = Math.abs(time.getTime() - openedAtMs) < 3_600_000;
  const fogText = !fogOn
    ? null
    : fogPick.sources.length === 0
      ? fogHasData
        ? "この日時に合う気温データがありません(「現在の気温」は現在のみ、「高原天気」は前後約6時間のみ)"
        : "「現在の気温」または「高原天気」を作成すると、霧が出ている場所に霧をかけます"
      : fogInfo.any
        ? `霧を表示中: ${fogPick.labels.join("・")}`
        : `霧が出ている場所はありません(${fogPick.labels.join("・")})`;

  return (
    <div className="viewer3d" role="dialog" aria-label="3Dビューワー">
      <div
        className="viewer3d__stage"
        ref={stageRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <canvas className="viewer3d__ov" ref={ovRef} />
      </div>

      <div className="viewer3d__top" ref={setTopBarEl} style={{ height: `calc(${HEADER_H}px + env(safe-area-inset-top, 0px))` }}>
        <div className="viewer3d__title">
          <div className="viewer3d__title-main">3Dビュー　{title}</div>
          <div className="viewer3d__title-sub">
            {moved ? "移動中　" : ""}
            {(moved ? pos.elev : groundElev) !== null ? `標高 ${Math.round((moved ? pos.elev : groundElev) ?? 0)}m　` : ""}
            {here.lat.toFixed(4)}, {here.lon.toFixed(4)}
          </div>
        </div>
        <button
          type="button"
          className={`viewer3d__btn viewer3d__ground${groundKind === "photo" ? " viewer3d__btn--on" : ""}`}
          onClick={() => setGroundKind((k) => (k === "std" ? "photo" : "std"))}
          aria-pressed={groundKind === "photo"}
          title="地面を衛星画像にする(3D表示のときだけ)"
        >
          衛星
        </button>
        <button
          type="button"
          className="viewer3d__btn viewer3d__draw"
          onClick={openDrawSettings}
          title="描画設定(地面・処理 低/中/高・描画範囲の拡張)を開く"
          aria-label="描画設定を開く"
        >
          <Ico icon={SlidersHorizontal} size="1em" /> <span className="viewer3d__draw-text">描画</span>
        </button>
        <div className="viewer3d__modes" role="group" aria-label="視点">
          <button
            type="button"
            className={`viewer3d__btn${mode === "first" ? " viewer3d__btn--on" : ""}`}
            onClick={() => changeMode("first")}
          >
            一人称
          </button>
          <button
            type="button"
            className={`viewer3d__btn${mode === "orbit" ? " viewer3d__btn--on" : ""}`}
            onClick={() => changeMode("orbit")}
          >
            俯瞰
          </button>
        </div>
        <button type="button" className="viewer3d__close" onClick={onClose} aria-label="3Dビューを閉じる">
          ×
        </button>
      </div>

      {phase === "loading" && (
        <div className="viewer3d__loading">
          <div className="viewer3d__spinner" />
          <div>{status}</div>
          <div className="viewer3d__loading-sub">半径約{wide ? RANGE_WIDE_KM : RANGE_NORMAL_KM}kmの地形を作っています</div>
        </div>
      )}
      {phase === "error" && (
        <div className="viewer3d__loading viewer3d__loading--error" role="alert">
          <div className="viewer3d__err-title">3Dビューを表示できませんでした</div>
          <div className="viewer3d__err-msg">{failure}</div>
          {(failureInfo || crashText) && (
            <>
              <div className="viewer3d__err-label">エラーコード・詳細(長押し・ドラッグで選択、または「コピー」)</div>
              <pre className="viewer3d__err-code" tabIndex={0}>
                {failureInfo ? `エラーコード: ${failureInfo.code}\n${failureInfo.detail}` : ""}
                {failureInfo && crashText ? "\n\n" : ""}
                {crashText ?? ""}
              </pre>
              <button
                type="button"
                className="viewer3d__btn"
                onClick={() => {
                  const text = `${failureInfo ? `エラーコード: ${failureInfo.code}\n${failureInfo.detail}` : ""}${crashText ? `\n\n${crashText}` : ""}`;
                  void navigator.clipboard?.writeText(text).catch(() => undefined);
                }}
              >
                エラーコード・診断情報をコピー
              </button>
            </>
          )}
          {lostCtx && (wide || quality !== "low") && (
            <button
              type="button"
              className="viewer3d__btn viewer3d__btn--on"
              onClick={() => {
                // 描画範囲の拡張 → 通常 → 処理を1段下げる、の順に軽くして、やり直す
                if (wide) setWide(false);
                else setQuality(quality === "high" ? "mid" : "low");
              }}
            >
              {wide ? "描画範囲を通常に戻してやり直す" : "処理を「低」に下げてやり直す"}
            </button>
          )}
          <button type="button" className="viewer3d__btn viewer3d__btn--on" onClick={onClose}>
            閉じる
          </button>
        </div>
      )}

      {prevCrash && phase !== "error" && (
        <div className="viewer3d__diag" role="status">
          <div className="viewer3d__diag-title">前回の3Dビューは、正常に終了していませんでした(タブが落ちた可能性があります)</div>
          <div className="viewer3d__diag-body">
            直前の設定: 処理「{mobileQualityLabel(prevCrash.record.settings.quality === "low" ? "low" : "mid")}」・描画範囲
            {prevCrash.record.settings.wide ? "拡張" : "通常"}。 {prevCrash.hints.join(" ")}
          </div>
          <div className="viewer3d__diag-actions">
            {(wide || quality !== "low") && (
              <button
                type="button"
                className="viewer3d__btn viewer3d__btn--on"
                onClick={() => {
                  if (wide) setWide(false);
                  else setQuality(quality === "high" ? "mid" : "low");
                  setPrevCrash(null);
                }}
              >
                {wide ? "描画範囲を通常にする" : "処理を「低」に下げる"}
              </button>
            )}
            <button
              type="button"
              className="viewer3d__btn"
              onClick={() => {
                const text = diagText(prevCrash.record, prevCrash.hints);
                setCrashText(text);
                void navigator.clipboard?.writeText(text).catch(() => undefined);
              }}
            >
              診断情報をコピー
            </button>
            <button type="button" className="viewer3d__btn" onClick={() => setPrevCrash(null)}>
              閉じる
            </button>
          </div>
          <pre className="viewer3d__diag-text" tabIndex={0}>
            {crashText ?? `エラーコード: ${diagCodes(prevCrash.record).join(" ")}`}
          </pre>
        </div>
      )}

      {phase === "ready" && (mapStatus || ovBusy || (geoInfo.state === "loading" && geoInfo.text)) && (
        <div className="viewer3d__chips">
          {mapStatus && <span className="viewer3d__chip">{mapStatus}</span>}
          {geoInfo.state === "loading" && geoInfo.text && <span className="viewer3d__chip">{geoInfo.text}</span>}
          {ovBusy && <span className="viewer3d__chip">紅葉メッシュを計算中…</span>}
        </div>
      )}

      {phase === "ready" && !panelOpen && (
        <div className="viewer3d__pad" style={{ bottom: BAR_H + 10 }} role="group" aria-label="移動パッド">
          {(["w", "a", "s", "d", "up", "dn"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={`viewer3d__padbtn viewer3d__padbtn--${k}`}
              aria-label={k === "up" ? "上昇" : k === "dn" ? "下降" : `移動 ${k.toUpperCase()}`}
              onPointerDown={(e) => {
                try {
                  e.currentTarget.setPointerCapture(e.pointerId);
                } catch {
                  /* 取れなくても、ボタンから指が外れたとき止まらないだけ */
                }
                moveApiRef.current?.press(k, true);
              }}
              onPointerUp={() => moveApiRef.current?.press(k, false)}
              onPointerCancel={() => moveApiRef.current?.press(k, false)}
              onLostPointerCapture={() => moveApiRef.current?.press(k, false)}
              onContextMenu={(e) => e.preventDefault()}
            >
              <Ico
                size="1.3em"
                icon={
                  k === "w"
                    ? ChevronUp
                    : k === "a"
                      ? ChevronLeft
                      : k === "s"
                        ? ChevronDown
                        : k === "d"
                          ? ChevronRight
                          : k === "up"
                            ? ChevronsUp
                            : ChevronsDown
                }
              />
              <span className="viewer3d__padkey">{k === "up" ? "Shift" : k === "dn" ? "Ctrl" : k.toUpperCase()}</span>
            </button>
          ))}
          <button
            type="button"
            className="viewer3d__padbtn viewer3d__padbtn--home"
            aria-label="クリックした地点に戻る"
            title="クリックした地点に戻る"
            disabled={!moved}
            onClick={goHome}
          >
            <Ico icon={LocateFixed} size="1.3em" />
          </button>
        </div>
      )}

      {phase === "ready" && (
        <div className={`viewer3d__panel${panelOpen ? " viewer3d__panel--open" : ""}`}>
          <button
            type="button"
            className="viewer3d__panel-toggle"
            onClick={() => setPanelOpen((v) => !v)}
            aria-expanded={panelOpen}
          >
            <span>
              <Ico icon={panelOpen ? ChevronDown : ChevronUp} /> {panelOpen ? "設定を閉じる" : "日時・描画・紅葉・霧・視点の設定"}
            </span>
            <span className="viewer3d__panel-time">
              {dateLabel(dateStr)} {hm(minutes)}
            </span>
          </button>

          <div className="viewer3d__bar-row">
            <button
              type="button"
              className="viewer3d__step"
              onClick={() => setDateStr((d) => addDays(d, -1))}
              aria-label="前の日"
            >
              <Ico icon={ChevronLeft} size="1.3em" />
            </button>
            <span className="viewer3d__bar-lbl">{dateLabel(dateStr)}</span>
            <input
              type="range"
              className="viewer3d__range viewer3d__range--bar"
              min={0}
              max={daysInYear(year) - 1}
              step={1}
              value={dayOfYear(dateStr)}
              onChange={(e) => setDateStr(dateFromDayOfYear(year, Number(e.target.value)))}
              aria-label="日付"
            />
            <button
              type="button"
              className="viewer3d__step"
              onClick={() => setDateStr((d) => addDays(d, 1))}
              aria-label="次の日"
            >
              <Ico icon={ChevronRight} size="1.3em" />
            </button>
          </div>
          <div className="viewer3d__bar-row">
            <span className="viewer3d__bar-lbl viewer3d__bar-lbl--time">{hm(minutes)}</span>
            <input
              type="range"
              className="viewer3d__range viewer3d__range--bar"
              min={0}
              max={1439}
              step={1}
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              aria-label="時刻"
            />
          </div>
          {/* 雲海: ON/OFFと高さ(基準の標高から)。時刻のスクロールバーと同じ、常時表示のバーに置く */}
          <div className="viewer3d__bar-row">
            <label className="viewer3d__bar-lbl viewer3d__bar-lbl--time viewer3d__bar-check">
              <input type="checkbox" checked={seaOn} onChange={(e) => setSeaOn(e.target.checked)} aria-label="雲海を表示" />
              雲海
            </label>
            <input
              type="range"
              className="viewer3d__range viewer3d__range--bar"
              min={SEA_H_MIN_M}
              max={SEA_H_MAX_M}
              step={SEA_H_STEP_M}
              value={seaH}
              disabled={!seaOn}
              onChange={(e) => setSeaH(Number(e.target.value))}
              aria-label="雲海の高さ(基準の標高から)"
            />
            <span className="viewer3d__bar-val">+{seaH}m</span>
          </div>

          {panelOpen && (
            <div className="viewer3d__panel-body">
              <section className="viewer3d__sec">
                <div className="viewer3d__row">
                  <label className="viewer3d__lbl">
                    日付
                    <input
                      type="date"
                      value={dateStr}
                      onChange={(e) => {
                        if (e.target.value) setDateStr(e.target.value);
                      }}
                    />
                  </label>
                  <span className="viewer3d__time">{hm(minutes)}</span>
                  <button type="button" className="viewer3d__btn" onClick={setNow}>
                    今
                  </button>
                </div>
                <div className="viewer3d__row viewer3d__row--wrap">
                  {riseSet.sunrise && (
                    <button type="button" className="viewer3d__btn" onClick={() => jumpTo(riseSet.sunrise)}>
                      日の出 {hmOfDate(riseSet.sunrise)}
                    </button>
                  )}
                  {riseSet.solarNoon && (
                    <button type="button" className="viewer3d__btn" onClick={() => jumpTo(riseSet.solarNoon)}>
                      南中 {hmOfDate(riseSet.solarNoon)}
                    </button>
                  )}
                  {riseSet.sunset && (
                    <button type="button" className="viewer3d__btn" onClick={() => jumpTo(riseSet.sunset)}>
                      日の入り {hmOfDate(riseSet.sunset)}
                    </button>
                  )}
                  {riseSet.moonrise && (
                    <button type="button" className="viewer3d__btn" onClick={() => jumpTo(riseSet.moonrise)}>
                      月の出 {hmOfDate(riseSet.moonrise)}
                    </button>
                  )}
                  {riseSet.moonset && (
                    <button type="button" className="viewer3d__btn" onClick={() => jumpTo(riseSet.moonset)}>
                      月の入り {hmOfDate(riseSet.moonset)}
                    </button>
                  )}
                </div>
                <div className="viewer3d__readout">
                  <button type="button" className="viewer3d__link" style={{ color: SUN_COLOR }} onClick={() => faceBody(sun)}>
                    太陽 <Ico icon={ChevronRight} />
                  </button>
                  <span>{describe(sun)}</span>
                </div>
                <div className="viewer3d__readout">
                  <button type="button" className="viewer3d__link" style={{ color: MOON_COLOR }} onClick={() => faceBody(moon)}>
                    月 <Ico icon={ChevronRight} />
                  </button>
                  <span>
                    {describe(moon)}　輝面比{Math.round(illum * 100)}%
                    {Number.isFinite(moonAge) ? `　月齢${moonAge.toFixed(1)}` : ""}
                  </span>
                </div>
                <div className="viewer3d__readout">
                  <button
                    type="button"
                    className="viewer3d__link"
                    style={{ color: MILKY_COLOR }}
                    onClick={() => faceBody(milky.center)}
                  >
                    天の川 <Ico icon={ChevronRight} />
                  </button>
                  <span>
                    銀河中心 {describe(milky.center)}　{milkyNote}
                  </span>
                </div>
                <label className="viewer3d__check">
                  <input type="checkbox" checked={showPaths} onChange={(e) => setShowPaths(e.target.checked)} />
                  太陽(実線)・月(点線)・天の川の中心(点々)のその日の通り道を表示
                </label>
              </section>

              <section className="viewer3d__sec" id="viewer3d-draw-settings" ref={drawSecRef}>
                <div className="viewer3d__sec-title">
                  <Ico icon={SlidersHorizontal} /> 描画設定
                </div>
                <div className="viewer3d__seg" role="group" aria-label="地面の表示">
                  <span className="viewer3d__seg-lbl">地面</span>
                  <button
                    type="button"
                    className={`viewer3d__btn${groundKind === "std" ? " viewer3d__btn--on" : ""}`}
                    onClick={() => setGroundKind("std")}
                  >
                    標準地図
                  </button>
                  <button
                    type="button"
                    className={`viewer3d__btn${groundKind === "photo" ? " viewer3d__btn--on" : ""}`}
                    onClick={() => setGroundKind("photo")}
                  >
                    衛星画像
                  </button>
                </div>
                <div className="viewer3d__seg" role="group" aria-label="処理(建物・木・水を表示する距離)">
                  <span className="viewer3d__seg-lbl">処理</span>
                  {MOBILE_QUALITY_LIST.map((q) => (
                    <button
                      key={q.id}
                      type="button"
                      className={`viewer3d__btn${quality === q.id ? " viewer3d__btn--on" : ""}`}
                      aria-pressed={quality === q.id}
                      onClick={() => setQuality(q.id)}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
                <div className="viewer3d__note viewer3d__note--tight">
                  {quality === "low"
                    ? `軽量表示です(建物は約${qualitySpec(quality, wide).buildingKm}km・木は約${qualitySpec(quality, wide).treeKm}km・水は約${qualitySpec(quality, wide).waterKm}kmまで)。`
                    : `建物は約${qualitySpec(quality, wide).buildingKm}km・木は約${qualitySpec(quality, wide).treeKm}km・水は約${qualitySpec(quality, wide).waterKm}kmまで表示し、地形(標高約7m/画素)と衛星画像も細かくします(PC版の「中」と同じ)。通信量・メモリを多く使います。`}
                  地形・地面の画像は半径約{RANGE_NORMAL_KM}km。処理を変えると、地形から作り直します。重いときは「低」にするか、下の「水・建物・木」のチェックを外すと軽くなります。
                  {quality !== geoLoaded.quality && geoInfo.state === "loading" ? "(読み込み中)" : ""}
                </div>
                <label className="viewer3d__check">
                  <input type="checkbox" checked={waterOn} onChange={(e) => setWaterOn(e.target.checked)} />
                  川・池を水で表示(まわり5mは灰色の岸)
                </label>
                <label className="viewer3d__check">
                  <input type="checkbox" checked={buildingsOn} onChange={(e) => setBuildingsOn(e.target.checked)} />
                  建物を表示
                </label>
                <label className="viewer3d__check">
                  <input type="checkbox" checked={treesOn} onChange={(e) => setTreesOn(e.target.checked)} />
                  木を表示(紅葉メッシュの色に連動: 新緑・紅葉・雪)
                </label>
                {geoText && <div className="viewer3d__note viewer3d__note--tight">{geoText}</div>}
              </section>

              <section className="viewer3d__sec">
                <div className="viewer3d__sec-title">空・霧・雲</div>
                <label className="viewer3d__check">
                  <input type="checkbox" checked={fogOn} onChange={(e) => setFogOn(e.target.checked)} />
                  霧を表示(霧が出ている場所に、地面から約{FOG_LAYER_TOP_M}mまで)
                </label>
                {fogText && <div className="viewer3d__note viewer3d__note--tight">{fogText}</div>}
                {fogOn && onRequestCurrentTemp && !hasCurrentFrame && nearNow && (
                  <div className="viewer3d__row viewer3d__row--wrap">
                    <button
                      type="button"
                      className="viewer3d__btn"
                      onClick={onRequestCurrentTemp}
                      disabled={currentTempBusy}
                    >
                      {currentTempBusy ? "現在の気温を取得中…" : "現在の気温を取得して霧に反映"}
                    </button>
                  </div>
                )}
                <label className="viewer3d__check">
                  <input type="checkbox" checked={milkyOn} onChange={(e) => setMilkyOn(e.target.checked)} />
                  天の川を表示(夜空)
                </label>
                <label className="viewer3d__check">
                  <input type="checkbox" checked={lightOn} onChange={(e) => setLightOn(e.target.checked)} />
                  光害を表示(夜。建物のある所の空と地面が白く、道路がオレンジに光る。建物そのものも光り、遠くからは光の点の夜景に見える。人口集中地区の外は光害を30%弱め、道路は空には影響しない。森林・海・畑・牧草地は光らない)
                </label>
                {lightOn && lightInfo.text && look.night > 0.05 && (
                  <div className="viewer3d__note viewer3d__note--tight">{lightInfo.text}</div>
                )}
                <label className="viewer3d__check">
                  <input type="checkbox" checked={cloudOn} onChange={(e) => setCloudOn(e.target.checked)} />
                  雲を表示(現在の雲。衛星画像の雲判定メッシュ。白=雲あり・グレー=半分くらい)
                </label>
                {cloudText && <div className="viewer3d__note viewer3d__note--tight">{cloudText}</div>}
                {cloudOn && (
                  <div className="viewer3d__slider">
                    <span>雲の高さ(海抜) {fmtMeters(cloudAlt)}</span>
                    <input
                      type="range"
                      className="viewer3d__range"
                      min={CLOUD_ALT_MIN_M}
                      max={CLOUD_ALT_MAX_M}
                      step={100}
                      value={cloudAlt}
                      onChange={(e) => setCloudAlt(Number(e.target.value))}
                      aria-label="雲の高さ"
                    />
                  </div>
                )}
                {seaOn && (
                  <div className="viewer3d__note viewer3d__note--tight">
                    雲海(厚さ{SEA_THICK_M}m)の入り切りと高さは、画面下の時刻バーの下にあります。
                    {seaRefHere === null
                      ? "基準の標高を計算しています…"
                      : `いまの場所の基準の標高(森林でない所=市街地・田畑などの標高。${SEA_POINT_SPACING_M / 1000}kmごとの基準点をなめらかにつないだ高さ)は約${Math.round(seaRefHere)}m。雲海の層は海抜${Math.round(seaRefHere + seaH)}〜${Math.round(seaRefHere + seaH + SEA_THICK_M)}mです。`}
                  </div>
                )}
                <label className="viewer3d__check">
                  <input type="checkbox" checked={placesOn} onChange={(e) => setPlacesOn(e.target.checked)} />
                  地名を表示(市町村・山・湖・峠。√の形のラベル。国土地理院の注記)
                </label>
                <label className="viewer3d__check">
                  <input type="checkbox" checked={peaksOn} onChange={(e) => setPeaksOn(e.target.checked)} />
                  百名山を表示(日本百名山の山名と標高。√の形のラベル)
                </label>
                {(placesOn || peaksOn) && labelInfo.text && (
                  <div className="viewer3d__note viewer3d__note--tight">{labelInfo.text}</div>
                )}
                <label className="viewer3d__check">
                  <input type="checkbox" checked={constOn} onChange={(e) => setConstOn(e.target.checked)} />
                  星座を表示(夜空。夏の大三角・カシオペヤ座など)
                </label>
                {constOn &&
                  (look.night < 0.1 ? (
                    <div className="viewer3d__note viewer3d__note--tight">昼間は星が見えません。時刻を夜に動かしてください。</div>
                  ) : (
                    <div className="viewer3d__row viewer3d__row--wrap">
                      {constList.map((l) => (
                        <button
                          key={l.text}
                          type="button"
                          className="viewer3d__btn"
                          style={{ color: l.kind === 1 ? "#ffd98a" : "#a8d4ff" }}
                          onClick={() => faceConst(l)}
                        >
                          {l.text}
                        </button>
                      ))}
                      {constList.length === 0 && <span className="viewer3d__note">地平線の上に星座がありません</span>}
                    </div>
                  ))}
              </section>

              <section className="viewer3d__sec">
                <label className="viewer3d__check">
                  <input type="checkbox" checked={koyoOn} onChange={(e) => setKoyoOn(e.target.checked)} />
                  紅葉メッシュを表示
                </label>
                {koyoOn && (
                  <>
                    {koyoOutOfRange && (
                      <div className="viewer3d__note viewer3d__note--tight">
                        この日付は紅葉の計算範囲({dayLabel(koyo.dayRange.start)}〜{dayLabel(koyo.dayRange.end)})の外なので、
                        端の日({dayLabel(koyoDay)})の様子を表示しています。
                      </div>
                    )}
                    <div className="viewer3d__note viewer3d__note--tight">
                      雪は気温から描いたイメージで、積雪の予報ではありません。
                    </div>
                    <div className="viewer3d__slider">
                      <span>濃さ {Math.round(ovOpacity * 100)}%</span>
                      <input
                        type="range"
                        className="viewer3d__range"
                        min={0.2}
                        max={1}
                        step={0.05}
                        value={ovOpacity}
                        onChange={(e) => setOvOpacity(Number(e.target.value))}
                        aria-label="紅葉メッシュの濃さ"
                      />
                    </div>
                    {koyoRangeDays <= 0 && <div className="viewer3d__note">紅葉の日付の範囲を取得できませんでした</div>}
                  </>
                )}
              </section>

              <section className="viewer3d__sec">
                <div className="viewer3d__readout">
                  <span className="viewer3d__link">移動</span>
                  <span>
                    {offsetText(pos.x, pos.z)}
                    {moved ? `(地点から${distText(Math.hypot(pos.x, pos.z))})` : ""}
                  </span>
                  {moved && (
                    <button type="button" className="viewer3d__btn" onClick={goHome}>
                      地点に戻る
                    </button>
                  )}
                </div>
                <div className="viewer3d__note viewer3d__note--tight">
                  W前・S後・A左・D右で、地点から{moveMaxOf(wide) / 1000}kmまで動けます。Shiftで上昇・Ctrlで下降します(一人称は目線の高さ、俯瞰はカメラの高さ)。画面のパッドでも動かせます。
                </div>
              </section>

              <section className="viewer3d__sec">
                <div className="viewer3d__slider">
                  <span>視野角(横) {Math.round(camUi.fov)}°</span>
                  <input
                    type="range"
                    className="viewer3d__range"
                    min={FOV_MIN}
                    max={FOV_MAX}
                    step={1}
                    value={camUi.fov}
                    onChange={(e) => setCam({ fov: Number(e.target.value) })}
                    aria-label="視野角"
                  />
                </div>
                {mode === "first" ? (
                  <div className="viewer3d__slider">
                    <span>目線の高さ(地面から) {fmtMeters(eyeH)}</span>
                    <input
                      type="range"
                      className="viewer3d__range"
                      min={0}
                      max={100}
                      step={1}
                      value={camUi.eyeS}
                      onChange={(e) => setCam({ eyeS: Number(e.target.value) })}
                      aria-label="目線の高さ"
                    />
                  </div>
                ) : (
                  <div className="viewer3d__slider">
                    <span>地点からの距離 {fmtMeters(orbitDist)}</span>
                    <input
                      type="range"
                      className="viewer3d__range"
                      min={0}
                      max={100}
                      step={1}
                      value={camUi.distS}
                      onChange={(e) => setCam({ distS: Number(e.target.value) })}
                      aria-label="地点からの距離"
                    />
                  </div>
                )}
                {mode === "orbit" && (
                  <div className="viewer3d__slider">
                    <span>カメラの高さを上げる +{fmtMeters(Math.max(0, camUi.lift))}(Shiftで上昇・Ctrlで下降)</span>
                    <input
                      type="range"
                      className="viewer3d__range"
                      min={0}
                      max={LIFT_MAX_M}
                      step={100}
                      value={Math.max(0, camUi.lift)}
                      onChange={(e) => setCam({ lift: Number(e.target.value) })}
                      aria-label="カメラの高さを上げる"
                    />
                  </div>
                )}
                {mode === "orbit" && cloudOn && orbitEyeAlt < cloudAlt && (
                  <div className="viewer3d__row viewer3d__row--wrap">
                    <span className="viewer3d__note">
                      いまのカメラ(海抜約{fmtMeters(orbitEyeAlt)})は雲(海抜{fmtMeters(cloudAlt)})より低いので、見下ろしても雲は見えません。
                    </span>
                    <button type="button" className="viewer3d__btn" onClick={raiseAboveClouds}>
                      雲の上から見る
                    </button>
                  </div>
                )}
              </section>

              <div className="viewer3d__note">
                ドラッグで見回す・ホイール/ピンチで拡大縮小(矢印キーでも回せます)。WASDで歩き回れます(地点から{moveMaxOf(wide) / 1000}kmまで)。太陽・月の円盤は位置が分かるよう実際の約4倍の大きさで描いています。
                地面は国土地理院の標準地図または全国最新写真(衛星画像・通信が必要)、地形は半径約25kmです。
                雲は衛星画像(ひまわり)の雲判定メッシュを、指定した高さの水平な層として描く目安で、実際の雲の高さ・厚さとは異なります。
                天の川は位置・向きは実際の銀河面に合わせた表現で、星の一つ一つまでは描いていません。星座は主な星の位置(J2000の近似)を結んだもので、細かい星は省いています。
                川・池・建物は国土地理院の最適化ベクトルタイルの形から作ったもので、建物の高さは種類ごとの目安、木は植生図の樹種グループに沿って並べた目安です。霧は「現在の気温」「高原天気」で推定した今の霧(実況の推定。予報ではありません)から作る目安で、実際の霧の厚さとは異なります。
              </div>
              <div className="viewer3d__note">
                出典:{" "}
                <a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">
                  地理院タイル
                </a>
                (標準地図・全国最新写真・標高タイル・最適化ベクトルタイル・人口集中地区(令和2年)。全国最新写真の一部はLandsat-8(NASA/USGS)・GRUS画像(© Axelspace))、
                <a href="https://www.jma.go.jp/" target="_blank" rel="noreferrer">
                  気象庁ホームページ
                </a>
                (ひまわり・平年値・確率予測資料・アメダス)、
                <a href="https://www.biodic.go.jp/kiso/vg/vg_kiso.html" target="_blank" rel="noreferrer">
                  1/25,000植生図GISデータ(環境省生物多様性センター)
                </a>
                、「国土数値情報(豪雪地帯データ)」(国土交通省)、天の川の形はMilky Way Outline Catalog(Jose R. Vieira。d3-celestial © 2015 Olaf Frohn、BSDライセンス経由)。
                地形・建物・水面・木・雲・霧・紅葉・夜空の明るさは、これらをもとにこのアプリが加工して作成したものです。
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
