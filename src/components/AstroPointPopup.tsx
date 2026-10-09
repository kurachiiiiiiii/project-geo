import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Marker, Polyline, Popup, Tooltip, useMap, useMapEvent } from "react-leaflet";
import L, { type Marker as LeafletMarker } from "leaflet";
import AstroPanel from "./AstroPanel";
import type { AstroKoyoInfo } from "./AstroKoyoSection";
import BottomSheet from "./BottomSheet";
import { useIsMobile } from "../lib/useIsMobile";
import { computeMilkyWayVisibility } from "../features/astro/astro";
import { reverseGeocodeRough } from "../features/geocode/reverseGeocodeService";
import { destinationPoint } from "../lib/geo";
import { formatDirection } from "../lib/direction";
import { kougenTenkiNowIndex, lookupKougenTenkiValue } from "../lib/kougenTenkiGrid";
import {
  MILKY_WAY_RAY_COLOR,
  MOON_TIME_RAY_COLOR,
  SUN_MOON_RAY_STYLE,
  SUN_MOON_TIME_RAY_DASH,
  SUN_TIME_RAY_COLOR,
  type SunMoonRayKey,
} from "../lib/astroRays";
import type { DirectionSample, KougenTenkiGrid } from "../types";
import { Moon, Sparkles, Sun, type LucideIcon } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  point: { lat: number; lng: number };
  date: Date;
  onDateChange: (d: Date) => void;
  onClose: () => void;
  /**
   * 生成済みかつ表示中(トグルON)なら、地点の気温・霧リスク(高原天気、選択時刻分)をパネルに表示する。
   * 「現在の気温」の方を見ているときにここへ古い高原天気の値が出てしまうバグを防ぐため、
   * 呼び出し側(MapView)でトグルの表示状態に応じて null を渡す(非表示中はここも null)。
   */
  kougenTenkiGrid: KougenTenkiGrid | null;
  /** 生成済みかつ表示中(トグルON)なら、地点の気温・湿度・霧リスク(現在の気温、1コマのみ)をパネルに表示する */
  currentTempGrid: KougenTenkiGrid | null;
  /** この地点の植生と紅葉の見頃(推定)。天文情報パネルに表示する(nullなら表示しない) */
  koyo?: AstroKoyoInfo | null;
  /** 「3Dで見渡す」ボタンが押されたとき(地点とおおまかな住所を渡す)。渡さなければボタンを出さない */
  onOpen3D?: (address: string | null) => void;
}

/**
 * 地図上に方角の線を引く長さ(km)を、現在の表示範囲に合わせて決める。
 * https://hinode.pics/moon のように、ズームレベルによらず画面内に収まる程度の長さの線を引く。
 */
function rayDistanceKmFromMap(map: L.Map): number {
  const bounds = map.getBounds();
  const center = map.getCenter();
  const north = L.latLng(bounds.getNorth(), center.lng);
  const halfHeightKm = map.distance(center, north) / 1000;
  return Math.max(halfHeightKm * 0.9, 0.3);
}

function formatHourMinute(d: Date): string {
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

/** スライダーで選んだ時刻の方角の線(仰角がマイナス=地平線より下のときは引かない) */
function TimeDirectionRay({
  origin,
  sample,
  rayKm,
  color,
  label,
  icon,
  dashArray,
  glowClassName,
}: {
  origin: { lat: number; lng: number };
  sample: DirectionSample | null;
  rayKm: number;
  color: string;
  label: string;
  icon: LucideIcon;
  dashArray?: string;
  /**
   * 「現在の月と太陽の線を光らせてください」への対応。太陽・月の線だけに指定する
   * (天の川の線は対象外)。実体はApp.cssの.astro-ray--glow-sun/moon(SVGのdrop-shadow
   * フィルターをアニメーションさせるCSS)。
   */
  glowClassName?: string;
}) {
  if (!sample || sample.altitudeDeg < 0) return null;
  const end = destinationPoint(origin, sample.azimuthDeg, rayKm);
  return (
    <Polyline
      positions={[
        [origin.lat, origin.lng],
        [end.lat, end.lng],
      ]}
      pathOptions={{ color, weight: 3, opacity: 0.9, dashArray, className: glowClassName }}
    >
      <Tooltip permanent direction="right" className="astro-ray-tooltip" opacity={0.9}>
        <Ico icon={icon} /> {label}({formatHourMinute(sample.time)}) {formatDirection(sample.azimuthDeg)}
      </Tooltip>
    </Polyline>
  );
}

/** 現在時刻の「時」を、選んだ暦日の1時間ごとサンプル(0時始まり24件)のindexとして使う */
function currentHourIndex(): number {
  return Math.min(new Date().getHours(), 23);
}

/**
 * クリックした地点そのものに天文情報を吹き出しで表示する。
 *
 * 以前は画面端に固定表示していたが、パネル内をスクロールすると閉じるボタンが
 * 画面外へ流れてしまい閉じられなくなることがあった。Leaflet のポップアップにすると
 * 閉じるボタンが常に枠の右上に出るうえ、地図上のどこを指しているかも分かりやすい。
 *
 * https://hinode.pics/moon を参考に、日の出没・月の出没・(選んだ時刻の)太陽・月・天の川の方角を
 * 地図上に線で表示できるようにしている。線は Popup の中身ではなく地図の子として描く必要が
 * あるため、天文計算(computeMilkyWayVisibility)と「どの時刻の線を表示中か」の状態は
 * このコンポーネントで持ち、表示用の値だけを AstroPanel に渡す。
 *
 * 日の出没・月の出没の線は、以前はボタンを押してON/OFFする方式だったが、ボタンの絵文字(🧭)が
 * 環境によっては表示されず存在に気づけない、という報告があったため、地点をクリックしたら
 * 常に表示する方式に変更した。天の川・(太陽と月)それぞれの「時刻ごとの方角」は時刻によって変わるため、
 * 代わりにスライダーで選ぶ方式にしている(下の selectedHourIndex / selectedSunMoonHourIndex)。
 * 太陽と月は当初別々のスライダーだったが、どちらも同じ「選択日の0時〜23時」を対象にしており
 * 別々に動かす利点が薄い、との要望を受けて1本のスライダーに統合した
 * (同じ index を sunDirectionSamples / moonDirectionSamples 両方に使う)。
 */
export default function AstroPointPopup({
  point,
  date,
  onDateChange,
  onClose,
  kougenTenkiGrid,
  currentTempGrid,
  koyo = null,
  onOpen3D,
}: Props) {
  const markerRef = useRef<LeafletMarker | null>(null);
  // 一度開ききるまでの内部的な開閉(マウント直後の付け外しなど)で
  // onClose を呼んでしまうと、開いた直後に選択が解除されて消えてしまう。
  // 実際に開いたことを確認してからのみ、閉じるを親に伝える。
  const openedRef = useRef(false);

  const map = useMap();
  // スマホ版は画面下からせり上がるボトムシートで表示する(「天文情報も下からスクロールして
  // でてくるようにして」という指示による)。PC版は従来通り地図の吹き出し(Leaflet Popup)。
  const isMobile = useIsMobile();
  const [rayKm, setRayKm] = useState(() => rayDistanceKmFromMap(map));
  useMapEvent("zoomend", () => setRayKm(rayDistanceKmFromMap(map)));
  useMapEvent("moveend", () => setRayKm(rayDistanceKmFromMap(map)));

  const result = useMemo(
    () => computeMilkyWayVisibility(point.lat, point.lng, date),
    [point.lat, point.lng, date],
  );

  // 天の川・(太陽と月)それぞれの方角スライダーの選択中インデックス。
  // 天の川はその晩の最初の時刻(0)、太陽と月は「今が何時か」を初期値にしておくと
  // 最初から意味のある方角が表示されて分かりやすい。
  const [selectedHourIndex, setSelectedHourIndex] = useState(0);
  const [selectedSunMoonHourIndex, setSelectedSunMoonHourIndex] = useState(currentHourIndex);
  // 高原天気(気温・霧シミュレーター)のスライダー選択中インデックス。生成済みなら
  // 「現在」に相当するコマ(実測の最後)を初期値にする(過去6時間・未来6時間から選べる)。
  const [selectedKougenTenkiHourIndex, setSelectedKougenTenkiHourIndex] = useState(() =>
    kougenTenkiGrid ? kougenTenkiNowIndex(kougenTenkiGrid) : 0,
  );

  // 「天文情報を表示する際 座標ではなく おおまかな住所を表示してください」への対応。
  // 取得できるまで(あるいは失敗した場合)はnullのままで、AstroPanel側が座標表示に
  // フォールバックする。地点キー(下記)ごとに1回だけ取得すればよい。
  const [roughAddress, setRoughAddress] = useState<string | null>(null);

  // 地点や日付を切り替えたら、前の地点で選んでいたスライダーの位置は引き継がない。
  // (useEffectで消すと余分な再レンダーが挟まるため、レンダー中に「キーが変わったか」を
  // 見て直接リセットする定番パターンを使う)
  const pointKey = `${point.lat},${point.lng},${date.getTime()}`;
  const [prevPointKey, setPrevPointKey] = useState(pointKey);
  if (pointKey !== prevPointKey) {
    setPrevPointKey(pointKey);
    setSelectedHourIndex(0);
    setSelectedSunMoonHourIndex(currentHourIndex());
    setSelectedKougenTenkiHourIndex(kougenTenkiGrid ? kougenTenkiNowIndex(kougenTenkiGrid) : 0);
    setRoughAddress(null);
  }

  // 地点(緯度経度)が変わるたびに、おおまかな住所を非同期で取得する。地点を素早く切り替えた
  // 場合に古い問い合わせの結果が後から遅れて反映されないよう、cancelledで無視する。
  useEffect(() => {
    let cancelled = false;
    reverseGeocodeRough(point.lat, point.lng).then((address) => {
      if (!cancelled) setRoughAddress(address);
    });
    return () => {
      cancelled = true;
    };
  }, [point.lat, point.lng]);

  // 高原天気は、選択中のコマにおけるこの地点の値をその都度引く(グリッドの対象範囲外ならnull)。
  const kougenTenkiValue = useMemo(() => {
    if (!kougenTenkiGrid || kougenTenkiGrid.hours.length === 0) return null;
    const hourIndex = Math.min(selectedKougenTenkiHourIndex, kougenTenkiGrid.hours.length - 1);
    const value = lookupKougenTenkiValue(kougenTenkiGrid, hourIndex, point.lat, point.lng);
    const frame = kougenTenkiGrid.hours[hourIndex];
    return value
      ? { ...value, timeKey: frame.timeKey, kind: frame.kind, forecastSource: frame.forecastSource }
      : null;
  }, [kougenTenkiGrid, selectedKougenTenkiHourIndex, point.lat, point.lng]);

  // 「現在の気温」は常に1コマ(hours[0])のみなので、高原天気と違いスライダーは持たない。
  const currentTempValue = useMemo(() => {
    if (!currentTempGrid || currentTempGrid.hours.length === 0) return null;
    const value = lookupKougenTenkiValue(currentTempGrid, 0, point.lat, point.lng);
    const frame = currentTempGrid.hours[0];
    return value
      ? { ...value, timeKey: frame.timeKey, kind: frame.kind, forecastSource: frame.forecastSource }
      : null;
  }, [currentTempGrid, point.lat, point.lng]);

  // 地点が選ばれたら自動で吹き出しを開く(マーカーを改めてクリックさせない)。
  // スマホ版はLeafletの吹き出しを使わない(BottomSheetは常時表示のため不要)。
  useEffect(() => {
    if (!isMobile) markerRef.current?.openPopup();
  }, [point.lat, point.lng, isMobile]);

  // ズームのたびの再レンダー(rayKmの再計算)で毎回新しいオブジェクトを渡すと、
  // react-leafletがMarkerのイベントハンドラを毎回付け替えることになり無駄が多いため、
  // 参照を安定させておく。
  const markerEventHandlers = useMemo(
    () => ({
      popupopen: () => {
        openedRef.current = true;
      },
      popupclose: () => {
        if (openedRef.current) onClose();
      },
    }),
    [onClose],
  );

  const selectHour = useCallback((index: number) => {
    setSelectedHourIndex(index);
  }, []);
  const selectSunMoonHour = useCallback((index: number) => {
    setSelectedSunMoonHourIndex(index);
  }, []);
  const selectKougenTenkiHour = useCallback((index: number) => {
    setSelectedKougenTenkiHourIndex(index);
  }, []);

  const azimuthByRayKey: Record<SunMoonRayKey, number | null> = {
    sunrise: result.twilight.sunriseAzimuthDeg,
    sunset: result.twilight.sunsetAzimuthDeg,
    moonrise: result.twilight.moonriseAzimuthDeg,
    moonset: result.twilight.moonsetAzimuthDeg,
  };

  const selectedMilkyWaySample = result.directionSamples[selectedHourIndex] ?? null;
  const selectedSunSample = result.sunDirectionSamples[selectedSunMoonHourIndex] ?? null;
  const selectedMoonSample = result.moonDirectionSamples[selectedSunMoonHourIndex] ?? null;

  const astroPanelNode = (
    <AstroPanel
      point={point}
      roughAddress={roughAddress}
      date={date}
      onDateChange={onDateChange}
      result={result}
      selectedHourIndex={selectedHourIndex}
      onSelectHour={selectHour}
      selectedSunMoonHourIndex={selectedSunMoonHourIndex}
      onSelectSunMoonHour={selectSunMoonHour}
      kougenTenkiGrid={kougenTenkiGrid}
      kougenTenkiValue={kougenTenkiValue}
      selectedKougenTenkiHourIndex={selectedKougenTenkiHourIndex}
      onSelectKougenTenkiHour={selectKougenTenkiHour}
      currentTempGrid={currentTempGrid}
      currentTempValue={currentTempValue}
      koyo={koyo}
      onOpen3D={onOpen3D ? () => onOpen3D(roughAddress) : undefined}
    />
  );

  return (
    <>
      <Marker ref={markerRef} position={[point.lat, point.lng]} eventHandlers={markerEventHandlers}>
        {/*
          keepInView・autoPan はどちらも付けない。付けると吹き出しを画面内に留めようとして
          地図を動かすたびに勝手に引き戻されてしまう。
          autoPan はポップアップが開いたとき/中身の高さが変わったときに Leaflet が地図を
          自動でパンする機能だが、Leaflet はこの判定を「moveend」のたびにも実行する
          (`Popup._adjustPan` が `moveend` イベントに登録されるため)。このコンポーネントは
          ズーム・移動のたびに `rayKm` を再計算して再レンダーしており、それ自体が親の再レンダー
          →パネルの再レンダー→Leafletの内部update()を誘発するため、パネル内をスクロール中に
          わずかでも地図が動くと、この一連の連鎖でスクロール位置が戻るのと同時に地図側にも
          「引き戻される」ような力が働いていた。開いた瞬間だけ見える位置へ寄せたいだけなので、
          そのための位置調整は Marker 側の offset で十分。

          スマホ版はBottomSheetを使うため、Popup自体を描画しない(Marker自体は地点の
          ピン表示として両方で使う)。
        */}
        {!isMobile && (
          <Popup
            className="astro-popup"
            minWidth={320}
            maxWidth={360}
            maxHeight={520}
            offset={[0, -16]}
            autoPan={false}
          >
            {astroPanelNode}
          </Popup>
        )}
      </Marker>

      {isMobile && (
        <BottomSheet title="天文情報" onClose={onClose} showBackdrop={false}>
          {astroPanelNode}
        </BottomSheet>
      )}

      {/* 日の出・日の入り・月の出・月の入りの方角は、地点を選ぶと常に地図上へ表示する */}
      {(Object.keys(SUN_MOON_RAY_STYLE) as SunMoonRayKey[])
        .filter((key) => azimuthByRayKey[key] !== null)
        .map((key) => {
          const azimuth = azimuthByRayKey[key]!;
          const style = SUN_MOON_RAY_STYLE[key];
          const end = destinationPoint(point, azimuth, rayKm);
          return (
            <Polyline
              key={key}
              positions={[
                [point.lat, point.lng],
                [end.lat, end.lng],
              ]}
              pathOptions={{
                color: style.color,
                weight: 3,
                opacity: 0.85,
                dashArray: style.dashArray,
              }}
            >
              <Tooltip permanent direction="right" className="astro-ray-tooltip" opacity={0.9}>
                <Ico icon={style.icon} /> {style.label} {formatDirection(azimuth)}
              </Tooltip>
            </Polyline>
          );
        })}

      {/*
        太陽・月・天の川(銀河中心)の方角は時刻によって変わるため、パネルのスライダーで
        選んだ時刻の分だけ表示する。仰角がマイナス(地平線より下)のときは線を引かない
        (太陽・月は日の出没の線と区別できるよう点線にしている)。
        「現在の月と太陽の線を光らせてください」への対応で、太陽・月の線にだけ
        glowClassNameを指定している(天の川は対象外)。
      */}
      <TimeDirectionRay
        origin={point}
        sample={selectedSunSample}
        rayKm={rayKm}
        color={SUN_TIME_RAY_COLOR}
        label="太陽"
        icon={Sun}
        dashArray={SUN_MOON_TIME_RAY_DASH}
        glowClassName="astro-ray--glow-sun"
      />
      <TimeDirectionRay
        origin={point}
        sample={selectedMoonSample}
        rayKm={rayKm}
        color={MOON_TIME_RAY_COLOR}
        label="月"
        icon={Moon}
        dashArray={SUN_MOON_TIME_RAY_DASH}
        glowClassName="astro-ray--glow-moon"
      />
      <TimeDirectionRay
        origin={point}
        sample={selectedMilkyWaySample}
        rayKm={rayKm}
        color={MILKY_WAY_RAY_COLOR}
        label="天の川"
        icon={Sparkles}
      />
    </>
  );
}
