import { useEffect } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";
import CameraPopup from "./CameraPopup";
import JmaVolcamLayer from "./JmaVolcamLayer";
import AmedasLayer from "./AmedasLayer";
import MapSizeWatcher from "./MapSizeWatcher";
import Jr9vqCameraPopup from "./Jr9vqCameraPopup";
import AstroPointPopup from "./AstroPointPopup";
import { RainTileLayerComponent } from "./RainTileLayerComponent";
import TakayamaCameraLayer from "./TakayamaCameraLayer";
import KokudoCameraLayer from "./KokudoCameraLayer";
import NaganoOfficeLinkLayer from "./NaganoOfficeLinkLayer";
import LazyClusterLayer from "./LazyClusterLayer";
import KougenTenkiLayer from "./KougenTenkiLayer";
import CurrentTemperatureLayer from "./CurrentTemperatureLayer";
import KoyoLayer from "./KoyoLayer";
import CloudMeshLayer from "./CloudMeshLayer";
import SatelliteForecastLayer from "./SatelliteForecastLayer";
import SatelliteMotionArrowsLayer from "./SatelliteMotionArrowsLayer";
import PrefectureBoundaryLayer from "./PrefectureBoundaryLayer";
import type { MotionField, PredictedSatelliteFrame } from "../lib/satelliteForecast";
import type { KoyoVegetationGrid } from "../features/koyo/koyoVegetation";
import type { KoyoSeasonContext } from "../features/koyo/koyoSeason";
import type { AstroKoyoInfo } from "./AstroKoyoSection";
import { JR9VQ_CAMERAS } from "../features/jr9vqCameras/jr9vqCameraService";
import type { GeoPoint } from "../lib/geolocation";
import { dotIcon } from "../lib/dotIcon";
import { CAMERA_POPUP_MAX_WIDTH, CAMERA_POPUP_MIN_WIDTH } from "../lib/popupSize";
import { isNativeApp } from "../lib/platform";
import { pushBackLayer } from "../lib/backStack";
import type {
  AmedasStation,
  CameraConfig,
  JmaVolcanoCamera,
  KokudoCamera,
  KougenTenkiGrid,
  KougenTenkiValue,
  NaganoOfficeLink,
  TakayamaCamera,
  WeatherMetric,
} from "../types";

// Vite でバンドルすると leaflet デフォルトアイコンの相対パス解決が壊れるため、
// バンドル後のアセットURLを明示的に差し替える定番の対処。
delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
});

const cameraIcon = dotIcon("#2b6fef", undefined, "circle");
const jr9vqIcon = dotIcon("#eab308", undefined, "circle");

/**
 * 現在地マーカー(Googleマップ等でおなじみの「青い点+広がる輪」)。
 * 他のマーカー(dotIcon/valueIcon)と違って情報を持たない単純な現在地表示のため、
 * ここだけ直接 L.divIcon を組み立てている。
 */
const currentLocationIcon = L.divIcon({
  className: "current-location-marker",
  html: '<span class="current-location-marker__pulse"></span><span class="current-location-marker__dot"></span>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

interface LatLng {
  lat: number;
  lng: number;
}

/** 背景の地図の種類 */
export type BaseMap = "pale" | "photo";

interface Props {
  cameras: CameraConfig[];
  /**
   * 「青色のアイコンがチェックリストで消えないようになっているのを改善してください」への
   * 対応。メインの`cameras.json`(青色、STV・SURF&SNOW・飯田国道事務所など)だけ、
   * 表示レイヤーの「カメラ」チェックボックスに一切つながっていなかった(常時表示のまま)。
   */
  camerasVisible: boolean;
  jmaVolcamCameras: JmaVolcanoCamera[];
  jmaVolcamVisible: boolean;
  takayamaCameras: TakayamaCamera[];
  takayamaVisible: boolean;
  /** 「岐阜国道事務所と多治見国道事務所のライブカメラの位置を特定し表示してください」への対応 */
  kokudoCameras: KokudoCamera[];
  kokudoVisible: boolean;
  /**
   * 座標が判明していない長野県建設事務所の代表リンク(佐久・上田・諏訪・飯田・木曽・大町・
   * 長野・須坂)。画像は埋め込まずリンクのみのため規約上問題ない(NaganoOfficeLinkPopup.tsx
   * 参照)。「確認して 規約違反の機能やライブカメラは削除してください」への対応で、実座標
   * つきで画像を直接埋め込んでいた松本・北信建設事務所分(`NaganoRoadCameraLayer`)は削除した。
   */
  naganoOfficeLinks: NaganoOfficeLink[];
  naganoOfficeLinksVisible: boolean;
  jr9vqVisible: boolean;
  amedasStations: AmedasStation[];
  amedasVisible: boolean;
  amedasObservedAt: string | null;
  weatherMetric: WeatherMetric;
  satelliteTileUrl: string | null;
  satelliteOpacity: number;
  /** 選択中のコマが予測コマのときだけ非null。詳細はlib/satelliteForecast.ts参照 */
  satelliteForecastFrame: PredictedSatelliteFrame | null;
  /** 「雲がそれぞれどの方向に動いているのか」への対応。100kmメッシュごとの動きベクトル */
  satelliteMotionField: MotionField | null;
  /** 「雲のある部分を5キロメッシュで判定して...」への対応。詳細はlib/cloudMesh.ts参照 */
  cloudMeshVisible: boolean;
  cloudMeshDataUrl: string | null;
  cloudMeshOpacity: number;
  cloudMeshBounds: L.LatLngBounds;
  /** 「現在地を取得」ボタンで取得した現在地(未取得ならnull) */
  currentLocation: GeoPoint | null;
  /** 検索で選んだ地点(地図をそこへ寄せる)。選ぶたびに新しいオブジェクト */
  focusPoint?: { lat: number; lng: number; zoom: number } | null;
  kougenTenkiGrid: KougenTenkiGrid | null;
  kougenTenkiVisible: boolean;
  kougenTenkiHourIndex: number;
  kougenTenkiTempOpacity: number;
  kougenTenkiFogOpacity: number;
  kougenTenkiShowStations: boolean;
  onKougenTenkiHover: (value: (KougenTenkiValue & { lat: number; lon: number }) | null) => void;
  /** 「高層天気とは別に 現在の気温の推定値のみを表示するボタン」への対応 */
  currentTempGrid: KougenTenkiGrid | null;
  currentTempVisible: boolean;
  currentTempOpacity: number;
  currentTempFogOpacity: number;
  currentTempShowStations: boolean;
  onCurrentTempHover: (value: (KougenTenkiValue & { lat: number; lon: number }) | null) => void;
  /** 「紅葉マップ」(`features/koyo/`)。標高タイルから描くので、気温は観測所ごとの値(stationT0)で渡す */
  koyoVisible: boolean;
  koyoOpacity: number;
  koyoStationT0: Float32Array;
  /** 同・`LOWLAND_ADVANCE_DAYS`日先の値(低標高の前倒し補正用) */
  koyoStationT0Ahead: Float32Array;
  /** 紅葉マップ: 2週間前の値(落葉して2週間たった所を白にする) */
  koyoStationT0Past: Float32Array;
  /** 紅葉マップ: 通年モデル(新緑・雪・雪解け)の気温などの束 */
  koyoSeason?: KoyoSeasonContext;
  koyoLapseCPerM: number;
  koyoVeg: KoyoVegetationGrid | null;
  /** 紅葉マップに描かない植生クラス(左上のチェックリストで外された樹種) */
  koyoHiddenClasses: ReadonlySet<number>;
  /** 天文情報パネルに出す、選択地点の植生と紅葉の見頃(推定) */
  koyoAstro: AstroKoyoInfo | null;
  selectedPoint: LatLng | null;
  selectedDate: Date;
  onDateChange: (d: Date) => void;
  onCloseAstro: () => void;
  /** 天文情報パネルの「3Dで見渡す」ボタン(地点・おおまかな住所を渡す) */
  onOpen3D: (address: string | null) => void;
  onMapClick: (lat: number, lng: number) => void;
  rainTileTemplate: string | null;
  rainOpacity: number;
  /** 背景の地図: 地図(淡色地図)か、衛星写真(地理院の全国最新写真) */
  baseMap: BaseMap;
}

function ClickHandler({ onMapClick }: { onMapClick: (lat: number, lng: number) => void }) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

/**
 * 「現在地を取得するボタン」で新しい地点が来るたびに、地図をその地点へ寄せる。
 * ボタンを押すたびに App.tsx 側で新しいオブジェクトが作られる(=参照が変わる)ので、
 * それをそのままeffectの依存に使えばよい(同じ座標を再取得した場合も含め、毎回寄せ直す)。
 */
/** 検索で選んだ地点へ地図を寄せる(いまのズームより引いて見ているときは、指定のズームまで寄る) */
function FlyToFocus({ focus }: { focus: { lat: number; lng: number; zoom: number } | null | undefined }) {
  const map = useMap();
  useEffect(() => {
    if (!focus) return;
    map.flyTo([focus.lat, focus.lng], Math.max(map.getZoom(), focus.zoom), { duration: 1.2 });
  }, [focus, map]);
  return null;
}

/**
 * 地図の吹き出し(カメラ・観測所など)が開いているあいだ、「戻る」(Androidの戻るボタン・ブラウザの戻る)で
 * その吹き出しを閉じる(アプリごと閉じない。`lib/backStack.ts`)。
 */
function PopupBackHandler() {
  const map = useMap();
  useEffect(() => {
    let release: (() => void) | null = null;
    const onOpen = () => {
      release?.();
      release = pushBackLayer(() => map.closePopup());
    };
    const onClose = () => {
      release?.();
      release = null;
    };
    map.on("popupopen", onOpen);
    map.on("popupclose", onClose);
    return () => {
      map.off("popupopen", onOpen);
      map.off("popupclose", onClose);
      release?.();
    };
  }, [map]);
  return null;
}

function FlyToPoint({ point }: { point: GeoPoint | null }) {
  const map = useMap();
  useEffect(() => {
    if (!point) return;
    map.flyTo([point.lat, point.lng], Math.max(map.getZoom(), 11), { duration: 1.2 });
  }, [point, map]);
  return null;
}

export default function MapView({
  cameras,
  camerasVisible,
  jmaVolcamCameras,
  jmaVolcamVisible,
  takayamaCameras,
  takayamaVisible,
  kokudoCameras,
  kokudoVisible,
  naganoOfficeLinks,
  naganoOfficeLinksVisible,
  jr9vqVisible,
  amedasStations,
  amedasVisible,
  amedasObservedAt,
  weatherMetric,
  satelliteTileUrl,
  satelliteOpacity,
  satelliteForecastFrame,
  satelliteMotionField,
  cloudMeshVisible,
  cloudMeshDataUrl,
  cloudMeshOpacity,
  cloudMeshBounds,
  currentLocation,
  focusPoint,
  kougenTenkiGrid,
  kougenTenkiVisible,
  kougenTenkiHourIndex,
  kougenTenkiTempOpacity,
  kougenTenkiFogOpacity,
  kougenTenkiShowStations,
  onKougenTenkiHover,
  currentTempGrid,
  currentTempVisible,
  currentTempOpacity,
  currentTempFogOpacity,
  currentTempShowStations,
  onCurrentTempHover,
  koyoVisible,
  koyoOpacity,
  koyoStationT0,
  koyoStationT0Ahead,
  koyoStationT0Past,
  koyoSeason,
  koyoLapseCPerM,
  koyoVeg,
  koyoHiddenClasses,
  koyoAstro,
  selectedPoint,
  selectedDate,
  onDateChange,
  onCloseAstro,
  onOpen3D,
  onMapClick,
  rainTileTemplate,
  rainOpacity,
  baseMap,
}: Props) {
  return (
    <MapContainer
      center={[35.6812, 139.7671]}
      zoom={10}
      className="map-view"
      worldCopyJump
      zoomControl={false}
    >
      {/*
        ベースマップは国土地理院タイル(淡色地図)。
        OpenStreetMapの公式タイルはタイル利用ポリシー上アプリからの大量取得が想定されておらず、
        実際に多数のタイルを同時要求すると接続を拒否された。地理院タイルは出典表示のみで
        利用でき、日本国内の詳細さも十分なためこちらを採用している。
      */}
      <TileLayer
        key={baseMap}
        attribution={
          baseMap === "photo"
            ? // 全国最新写真は、一部にLandsat-8(NASA/USGS)・GRUS画像を使っている(地理院タイル一覧の注記)。
              // GRUS画像を含むタイルを使う場合は「GRUS画像(© Axelspace)」の明示も求められている
              '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル(全国最新写真)</a>' +
              "(一部 Landsat-8: NASA/USGS、GRUS画像(© Axelspace))"
            : '<a href="https://maps.gsi.go.jp/development/ichiran.html" target="_blank" rel="noreferrer">地理院タイル(淡色地図)</a>'
        }
        url={
          baseMap === "photo"
            ? "https://cyberjapandata.gsi.go.jp/xyz/seamlessphoto/{z}/{x}/{y}.jpg"
            : "https://cyberjapandata.gsi.go.jp/xyz/pale/{z}/{x}/{y}.png"
        }
        maxZoom={18}
      />
      {/*
        衛星画像はベースマップの上・雨雲の下に敷く。常時表示(「表示レイヤーからなくして
        画面の下に常に表示されるようにしてください」という指示により、表示ON/OFFの
        トグル自体を廃止した)。ひまわりのタイルはズーム3〜5しか配信されていないため、
        maxNativeZoom を 5 にして、それ以上に拡大したときは z=5 の画像を
        引き伸ばして表示させる(指定しないと存在しないタイルを要求して何も出ない)。

        「ai画像向上は廃止」という指示により、AI超解像(SatelliteEnhanceTileLayerComponent/
        satelliteEnhanceTileLayer.ts/satelliteAiUpscale.ts)は削除し、常に素のTileLayerを使う。
      */}
      {satelliteTileUrl && (
        <TileLayer
          key={satelliteTileUrl}
          url={satelliteTileUrl}
          opacity={satelliteOpacity}
          zIndex={400}
          minNativeZoom={3}
          maxNativeZoom={5}
        />
      )}
      {/*
        「衛星画像の予測をしたい 過去1時間分の衛星画像をもとに 3時間後まで どのように動くか
        予想したい」への対応。選択中のコマが予測コマのとき(=satelliteTileUrlがnullになる)
        だけ表示する(実測コマとは排他)。zIndexは実測コマのTileLayerと同じ400にしている
        (どちらか一方しか表示されないため重ならない)。
      */}
      <SatelliteForecastLayer frame={satelliteForecastFrame} opacity={satelliteOpacity} />
      {/*
        「雲の動きは500キロメッシュで 雲がそれぞれどの方向に動いているのか 計算して
        もとめてください」への対応。「衛星画像予測は常にonにしてください」という指示により
        表示ON/OFFのトグルは廃止したため、motionFieldが計算できていれば常に表示する。
      */}
      <SatelliteMotionArrowsLayer motionField={satelliteMotionField} />
      {/*
        「衛星画像で雲のある部分を5キロメッシュで判定して...」への対応。衛星画像本体
        (上のTileLayer)とは独立した表示のため常に表示できる。zIndexは衛星画像(400)より上、
        高原天気(350〜351)より上にして見やすくする。
      */}
      <CloudMeshLayer
        visible={cloudMeshVisible}
        dataUrl={cloudMeshDataUrl}
        opacity={cloudMeshOpacity}
        bounds={cloudMeshBounds}
      />
      {/*
        「県境と海岸線を、グリッドや雲の中、気温からでも視認できるようにして」への対応。
        雲判定メッシュ・衛星画像・アメダスマーカーなど不透明度の高いレイヤーより手前
        (z-index=620、詳細はPrefectureBoundaryLayer.tsx参照)に県境・海岸線の線を描く。
        表示/非表示のチェックボックスは設けず常時表示にしている(理由も同ファイル参照)。
      */}
      <PrefectureBoundaryLayer />
      {/*
        「高原天気」気温・霧シミュレーターの画像オーバーレイ(気温分布・霧リスク)。
        衛星画像と同じくベースマップの上、雨雲の下に敷く。
        「アンドロイド版では 高層天気の趣味レーターは削除してください」という指示により、
        Android版(ネイティブアプリ)ではこのレイヤー自体を描画しない(App.tsx側でUIの
        トグルも隠しているためkougenTenkiVisibleは常にfalseのはずだが、念のためここでも
        分岐しておく)。
      */}
      {!isNativeApp() && (
        <KougenTenkiLayer
          grid={kougenTenkiGrid}
          visible={kougenTenkiVisible}
          hourIndex={kougenTenkiHourIndex}
          tempOpacity={kougenTenkiTempOpacity}
          fogOpacity={kougenTenkiFogOpacity}
          showStations={kougenTenkiShowStations}
          onHover={onKougenTenkiHover}
        />
      )}
      {/*
        「高層天気とは別に 現在の気温の推定値のみを表示するボタン」のレイヤー。
        「現在の気温は表示できるようにしてください」への対応により、高原天気(上の
        KougenTenkiLayer)と異なりAndroid版でも描画する(kougenTenkiNativeGenerate.tsに
        ネイティブ移植版を用意したため。currentTemperatureService.ts参照)。
      */}
      <CurrentTemperatureLayer
        grid={currentTempGrid}
        visible={currentTempVisible}
        opacity={currentTempOpacity}
        fogOpacity={currentTempFogOpacity}
        showStations={currentTempShowStations}
        onHover={onCurrentTempHover}
      />
      {/* 「紅葉マップ」: 標高(国土地理院DEM)×植生(環境省植生図)×気温から紅葉の段階を色分けする */}
      <KoyoLayer
        visible={koyoVisible}
        opacity={koyoOpacity}
        stationT0={koyoStationT0}
        stationT0Ahead={koyoStationT0Ahead}
        stationT0Past={koyoStationT0Past}
        season={koyoSeason}
        lapseCPerM={koyoLapseCPerM}
        veg={koyoVeg}
        hiddenClasses={koyoHiddenClasses}
      />
      {/*
        JMA高解像度降水ナウキャストのタイルはズーム4/6/8/10でしか配信されておらず、
        素のTileLayerだと歯抜けのズーム(3,5,7,9や11以上)で何も表示されない。
        RainTileLayerComponent は最も近い配信ズームに丸めてから拡大縮小表示するので、
        全ズームレベルで雨雲を表示できる(詳細は src/lib/rainTileLayer.ts)。
      */}
      {rainTileTemplate && (
        <RainTileLayerComponent
          key={rainTileTemplate}
          url={rainTileTemplate}
          opacity={rainOpacity}
          zIndex={500}
        />
      )}
      <ClickHandler onMapClick={onMapClick} />
      <MapSizeWatcher />
      <FlyToPoint point={currentLocation} />
      <FlyToFocus focus={focusPoint} />
      <PopupBackHandler />
      {/*
        現在地マーカーは非インタラクティブにしておく(クリックを奪って、その場所の天文情報
        ポップアップを開けなくなるのを防ぐため。地図クリックはClickHandlerで別途処理している)。
      */}
      {currentLocation && (
        <Marker
          position={[currentLocation.lat, currentLocation.lng]}
          icon={currentLocationIcon}
          interactive={false}
          zIndexOffset={1000}
        />
      )}

      {/* 川の防災情報のカメラ(KawabouCameraLayer)は、スマホ版では廃止した(App.tsxのコメント参照) */}
      <TakayamaCameraLayer cameras={takayamaCameras} visible={takayamaVisible} />
      <KokudoCameraLayer cameras={kokudoCameras} visible={kokudoVisible} />
      <NaganoOfficeLinkLayer offices={naganoOfficeLinks} visible={naganoOfficeLinksVisible} />
      <JmaVolcamLayer cameras={jmaVolcamCameras} visible={jmaVolcamVisible} />
      <AmedasLayer
        stations={amedasStations}
        visible={amedasVisible}
        metric={weatherMetric}
        observedAt={amedasObservedAt}
      />
      {/* 道路情報提供システムの道路気象(RoadWeatherLayer)は、スマホ版では廃止した(App.tsxのコメント参照) */}

      {/*
        「青色のアイコンがチェックリストで消えないようになっているのを改善してください」で
        表示・非表示の対応はしたが、「青色アイコンも縮小したとき数字にしてください」への
        対応として、他のカメラレイヤーと同じLazyClusterLayer(縮小時に件数バブルへまとまる)
        に変更した(それまでは1件ずつ<Marker>を並べるだけで、ズームアウトすると236件が
        重なって表示されていた)。
      */}
      <LazyClusterLayer
        items={cameras}
        visible={camerasVisible}
        maxClusterRadius={50}
        disableClusteringAtZoom={13}
        getPosition={(c) => [c.lat, c.lng]}
        getIcon={() => cameraIcon}
        renderPopup={(c) => <CameraPopup camera={c} />}
      />

      {jr9vqVisible &&
        JR9VQ_CAMERAS.map((cam) => (
          <Marker key={cam.id} position={[cam.lat, cam.lng]} icon={jr9vqIcon}>
            <Popup minWidth={CAMERA_POPUP_MIN_WIDTH} maxWidth={CAMERA_POPUP_MAX_WIDTH}>
              <Jr9vqCameraPopup camera={cam} />
            </Popup>
          </Marker>
        ))}

      {/*
        トグルが非表示中のデータはAstroPointPopupへ渡さない。渡しっぱなしにすると、「現在の気温」を
        見ているのに(前回生成して残っている)高原天気の値が天文情報パネルに出てしまうバグになる
        (逆に、高原天気を見ているときに現在の気温が出てしまうのも同様)。
      */}
      {selectedPoint && (
        <AstroPointPopup
          key={`${selectedPoint.lat},${selectedPoint.lng}`}
          point={selectedPoint}
          date={selectedDate}
          onDateChange={onDateChange}
          onClose={onCloseAstro}
          kougenTenkiGrid={kougenTenkiVisible ? kougenTenkiGrid : null}
          currentTempGrid={currentTempVisible ? currentTempGrid : null}
          koyo={koyoAstro}
          onOpen3D={onOpen3D}
        />
      )}
    </MapContainer>
  );
}
