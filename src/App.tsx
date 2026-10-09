import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import MapView, { type BaseMap } from "./components/MapView";
import BottomSheet from "./components/BottomSheet";
import CreditsSheet from "./components/CreditsSheet";
import { MOBILE_BREAKPOINT_PX, useIsMobile } from "./lib/useIsMobile";
import LayerToggle from "./components/LayerToggle";
import WeatherMetricControl from "./components/WeatherMetricControl";
import SatelliteControl from "./components/SatelliteControl";
import KougenTenkiControl from "./components/KougenTenkiControl";
import PlaceSearch, { type PlaceHit } from "./components/PlaceSearch";
import CurrentTemperatureControl from "./components/CurrentTemperatureControl";
import KoyoControl from "./components/KoyoControl";
import KoyoSpeciesChecklist from "./components/KoyoSpeciesChecklist";
import Viewer3DHost from "./components/Viewer3DHost";
import { useKoyo } from "./features/koyo/useKoyo";
import { loadCameras } from "./features/cameras/cameraService";
import { buildRainTileUrlTemplate, fetchRainFrames } from "./features/rain/rainService";
import { loadJmaVolcanoCameras } from "./features/jmaVolcam/jmaVolcamService";
import { loadTakayamaCameras } from "./features/takayamaCameras/takayamaCameraService";
import { loadKokudoCameras } from "./features/kokudoCameras/kokudoCameraService";
import { loadNaganoOfficeLinks } from "./features/naganoRoadCameras/naganoRoadCameraService";
import {
  generateKougenTenki,
  kougenTenkiCooldownRemainingMs,
  listKougenTenkiHistory,
  loadKougenTenkiFromHistory,
  loadLatestKougenTenkiFromHistory,
  markKougenTenkiGenerated,
  saveKougenTenkiToHistory,
  type KougenTenkiHistoryEntry,
} from "./features/kougenTenki/kougenTenkiService";
import { generateCurrentTemperature } from "./features/currentTemperature/currentTemperatureService";
import { kougenTenkiNowIndex, lookupKougenTenkiValue } from "./lib/kougenTenkiGrid";
import { isNativeApp, isSatelliteForecastEnabled } from "./lib/platform";
import { loadAmedas } from "./features/amedas/amedasService";
import {
  buildSatelliteTileUrl,
  fetchRecentSatelliteFrames,
  parseValidTime as parseJmaValidTime,
  type SatelliteFrame,
} from "./features/satellite/satelliteService";
import { getCurrentPosition, type GeoPoint } from "./lib/geolocation";
import { usePolledResource } from "./lib/usePolledResource";
import { CLOUD_MESH_BOUNDS, computeCloudMeshGrid, renderCloudMeshDataUrl } from "./lib/cloudMesh";
import type { LatLngBounds } from "leaflet";
import {
  computeSatelliteForecast,
  type MotionField,
  type PredictedSatelliteFrame,
} from "./lib/satelliteForecast";
import type { RainFrame } from "./features/rain/rainService";
import type {
  AmedasSnapshot,
  CameraConfig,
  KougenTenkiGrid,
  KougenTenkiValue,
  SatelliteBand,
  WeatherMetric,
} from "./types";
import { ChevronDown, ChevronUp, MapPin } from "./lib/lucide";
import { Ico } from "./components/Ico";
import { errorMessage } from "./lib/errorMessage";

const RAIN_POLL_MS = 5 * 60_000;
const AMEDAS_POLL_MS = 10 * 60_000;
/** ひまわりは10分間隔で更新されるので、それに合わせて取り直す */
const SATELLITE_POLL_MS = 10 * 60_000;

const EMPTY_AMEDAS: AmedasSnapshot = { observedAt: "", stations: [] };

function App() {
  const [cameras, setCameras] = useState<CameraConfig[]>([]);
  const [cameraError, setCameraError] = useState<string | null>(null);

  const [rainFrames, setRainFrames] = useState<RainFrame[]>([]);
  // 「雨雲と衛星は時刻を統合してください」への対応で、雨雲専用のコマ位置は状態として持たず、
  // 衛星画像側のコマ位置(マスター時刻)から一番近い雨雲コマを自動選択する形にした
  // (実際の算出は下のrainFrameIndexのuseMemo、衛星画像のコマ位置が定まる場所より後)。
  const [rainOpacity, setRainOpacity] = useState(0.6);
  // 「地図も衛星画像と切り替えられるようにしてください」への対応: 背景の地図を、地理院の地図(淡色地図)と
  // 衛星写真(地理院の全国最新写真)で切り替える。選んだものは次回も使う
  const [baseMap, setBaseMapState] = useState<BaseMap>(() => {
    try {
      return localStorage.getItem("baseMapV1") === "photo" ? "photo" : "pale";
    } catch {
      return "pale";
    }
  });
  const setBaseMap = (b: BaseMap) => {
    setBaseMapState(b);
    try {
      localStorage.setItem("baseMapV1", b);
    } catch {
      // 保存できなくても動く
    }
  };
  // 「雨雲を表示をデフォルトでは表示されないようにして 代わりに衛星画像が表示されるように
  // してください」という指示により、既定OFFに変更した(以前はtrue)。衛星画像は表示レイヤーの
  // 独立した常時表示バー(App.cssの.app__satellite-bar)になっている。当時は衛星画像が既定ON
  // (表示)で、雨雲がONだと衛星画像より上に重なって隠してしまっていたため雨雲を既定OFFにした。
  // その後「衛星画像は始動時に表示されないようにしてください」により衛星画像も既定OFFになった
  // (下のsatelliteVisible参照)。
  const [rainVisible, setRainVisible] = useState(false);
  const [rainError, setRainError] = useState<string | null>(null);

  // 都道府県ライブカメラ・観測所などのデータソース。件数が増えても定型パターンで管理できるよう
  // usePolledResource に集約している(取得ロジック追加時は下の1行を増やすだけでよい)。
  // 国土交通省「川の防災情報」のカメラ(全国約11,800台)は、スマホ版では廃止した(2026年10月)。
  // 川の防災情報には都道府県が管理するカメラも含まれ、配信元の取り扱い上の注意に「第三者(国以外の者)が
  // 権利を有するものは、利用者の責任で当該第三者から利用の許諾を得てください」とあるため
  // (README「法令適合・著作権の確認(2026年10月)」参照)。

  // 高山国道事務所・長野県道路カメラは静的に同梱したJSONを読むだけなので、起動時に1回でよい
  const takayama = usePolledResource(loadTakayamaCameras, []);

  // 「岐阜国道事務所と多治見国道事務所の ライブカメラの位置を特定し 表示してください」への対応。
  // 高山国道事務所と同様、静的に同梱したJSON(public/kokudoCameras.json)を読むだけなので
  // 起動時に1回でよい。詳細はtypes/index.tsのKokudoCameraのコメント参照。
  const kokudo = usePolledResource(loadKokudoCameras, []);

  // 「長野県建設事務所」のカメラ(松本・北信、実座標つきで画像を直接埋め込んでいた分)は
  // 「確認して 規約違反の機能やライブカメラは削除してください」への対応で削除した。長野県
  // 公式ホームページの著作権ページ(https://www.pref.nagano.lg.jp/koho/kensei/koho/homepage/riyo.html)に
  // 「私的使用のための複製」や「引用」など著作権法上認められた場合を除き、無断で複製・転用
  // することはできません、との明記があり、ライブカメラ画像の直接埋め込みはこれに抵触すると
  // 判断した。座標が分からず事務所代表地点へのリンクのみだった`naganoOfficeLinks`
  // (佐久・上田・諏訪・飯田・木曽・大町・長野・須坂の8事務所)は画像を埋め込んでおらず、
  // 単なるハイパーリンクは各サイトの「リンクについて」で許可されているため、そのまま残した。
  const naganoOfficeLinks = usePolledResource(loadNaganoOfficeLinks, []);

  // 「道路情報提供システムをつかうシステムはなくして」という指示への対応。以前はここに
  // 国交省「道路情報提供システム」(北海道開発局・北陸地方整備局)分もあったが、配信元自身の
  // 利用規約(https://www.road-info-prvs.mlit.go.jp/roadinfo/sp/spWhenUsing_00_0.html)に
  // 「各画像への直接のリンクはご遠慮ください」とあり、まさにその形(個々の画像URLを<img>で
  // 直接表示)で使っていたため、撤去した(server/roadInfoPrvsProxy.mjs・
  // src/components/RoadInfoPrvsCameraLayer/Popup.tsx・
  // src/features/hokkaidoRoadCameras・hokurikuRoadCameras 一式を削除)。
  // 代わりに国交省がまとめている全国のライブカメラ一覧
  // (https://www.mlit.go.jp/road/bosai/LIVEcamera.html)から転載可能なものを個別に対応する。
  //
  // 「確認して 規約違反の機能やライブカメラは削除してください」への対応で、富山県・岐阜県・
  // 石川県・島根県・群馬県・福井県の道路/防災系ライブカメラ(いずれも各県公式ホームページの
  // 著作権ページに「無断で複製・転用することはできません」等の明記があり、ライブカメラ画像の
  // 直接埋め込みが抵触すると判断)はここで全て削除した。中部・中国地方整備局(高山・岐阜・
  // 多治見・鳥取/倉吉/岡山国道事務所)は公共データ利用規約(PDL1.0、要出典表記のみで直接
  // リンク制限なし)準拠を個別に確認済みのため残した。詳細はREADME.md参照。

  const jmaVolcam = usePolledResource(loadJmaVolcanoCameras, []); // 地点一覧は起動時に1回だけ

  // 「その他のカメラのチェックリストは1つにしてください」という要望を受け、以前は
  // 複数の個別トグルだったものを、1つの表示・非表示にまとめた
  // (下のチェックリストJSX・MapViewへの各visible propの両方でこの1つの値を使い回す)。
  // 「川の防災と その他のカメラを統合してください」という指示により、さらに川の防災情報
  // カメラ(kawabouVisible、独立した状態だった)もこの1つの値に統合し、変数名も
  // camerasVisible に変えた(main cameras.json自体は元々チェックボックス無し・常時表示の
  // ままで変えていない)。
  const [camerasVisible, setCamerasVisible] = useState(true);

  const amedas = usePolledResource(loadAmedas, EMPTY_AMEDAS, AMEDAS_POLL_MS);
  // 「起動時のアメダス観測所はチェックリストを外してください」という指示により、既定は
  // 非表示にした(観測データ自体はチェックを外していてもポーリングし続け、オンにすれば
  // すぐ表示できる。usePolledResourceの呼び出し自体はvisibleと無関係のため)。
  const [amedasVisible, setAmedasVisible] = useState(false);
  const [weatherMetric, setWeatherMetric] = useState<WeatherMetric>("temp");

  // 道路情報提供システム(国土交通省)の道路気象観測局の気温は、スマホ版では使わない(2026年10月廃止)。
  // 配信元の「ご利用に際して」に「国土交通省に無断で転載等を行うことはできません」とあるため。
  // 地図の「道路気象(気温)」レイヤー・カメラのポップアップの近くの気温・現在の気温の計算の観測点から外した。

  // 「衛星画像は現在時間だけではなく3時間前まで取得して確認できるようにしてください」という
  // 指示により、単一の最新コマではなく直近3時間分(10分間隔、最大18コマ)の配列を保持し、
  // 雨雲レイヤー(rainFrames/rainFrameIndex)と同じ形でスライダーから選べるようにしている。
  const satellite = usePolledResource(fetchRecentSatelliteFrames, [] as SatelliteFrame[], SATELLITE_POLL_MS);
  const [satelliteFrameIndex, setSatelliteFrameIndex] = useState(0);
  const [satelliteBand, setSatelliteBand] = useState<SatelliteBand>("infrared");
  const [satelliteOpacity, setSatelliteOpacity] = useState(0.7);
  // 「衛星画像に表示非表示のチェックリストを追加してください」への対応。以前は
  // 「画面の下に常に表示されるようにしてください」という指示でチェックボックス自体を
  // 廃止していたが、常時表示バーになったこと自体はそのままに、表示ON/OFFの
  // チェックボックスだけを復活させる。OFFのときは衛星画像タイル・予測コマ・移流矢印を
  // まとめて非表示にする(下のMapView呼び出し箇所でsatelliteVisible?...:nullとしてゲート)。
  // 「衛星画像は始動時に表示されないようにしてください」への対応で、既定をOFF(false)にした
  // (以前はtrue)。衛星画像を見たいときは、下の常時表示バーのチェックボックスでONにする。
  // 取得・予測の計算自体は表示のON/OFFに関係なく従来どおり行う(ONにした瞬間にすぐ出せるように)。
  const [satelliteVisible, setSatelliteVisible] = useState(false);
  // 「ai画像向上は廃止」という指示により、AI超解像(satelliteAiUpscale.ts/
  // satelliteEnhanceTileLayer.ts/SatelliteEnhanceTileLayerComponent.tsx)の状態・ハンドラは
  // すべて削除した(ファイル自体も削除済み)。

  // 「衛星画像で雲のある部分を5キロメッシュで判定して、ある部分を白くして、半分くらいの
  // ところはグレー、ないところは透明にしてください」への対応。AI超解像とは独立した、
  // 赤外線バンドの生データから直接作る雲判定メッシュ(詳細はlib/cloudMesh.tsのコメント参照)。
  const [cloudMeshVisible, setCloudMeshVisible] = useState(false);
  const [cloudMeshOpacity, setCloudMeshOpacity] = useState(0.7);
  const [cloudMeshDataUrl, setCloudMeshDataUrl] = useState<string | null>(null);
  // 「衛星画像の予測の際も メッシュでできるようにしてください」への対応。予測コマを見ている
  // ときは、そのコマ自身のモザイク範囲(実測コマ用のCLOUD_MESH_BOUNDSとほぼ同じだが、
  // 念のためコマごとの実際の範囲をそのまま使う)に合わせて表示位置を変える。
  const [cloudMeshBounds, setCloudMeshBounds] = useState<LatLngBounds>(CLOUD_MESH_BOUNDS);
  const [cloudMeshLoading, setCloudMeshLoading] = useState(false);
  const [cloudMeshError, setCloudMeshError] = useState<string | null>(null);

  // 「衛星画像の予測をしたい 過去1時間分の衛星画像をもとに 3時間後まで どのように動くか
  // 予想したい」への対応。詳細・手法はlib/satelliteForecast.tsのコメント参照。
  // 「衛星画像予測は常にonにしてください」という指示により、表示ON/OFFのトグルは廃止し、
  // 衛星のコマが取得できていれば常に計算する(下のuseEffect参照)。
  const [satelliteForecastFrames, setSatelliteForecastFrames] = useState<PredictedSatelliteFrame[]>([]);
  // 「雲の動きは500キロメッシュで 雲がそれぞれどの方向に動いているのか 計算して もとめて
  // ください」への対応。マス目ごとの動きベクトル(矢印表示に使う)。
  const [satelliteMotionField, setSatelliteMotionField] = useState<MotionField | null>(null);
  const [satelliteForecastLoading, setSatelliteForecastLoading] = useState(false);
  const [satelliteForecastError, setSatelliteForecastError] = useState<string | null>(null);

  // 新しいコマ一覧が届くたび(=10分ごとのポーリングのたび)、選択中のインデックスを
  // 最新コマに合わせる(このマスター時刻に雨雲側も追従するため、実質的に雨雲の表示時刻も
  // ここでリセットされることになる)。
  // useEffectで行うと余分な再レンダーが挟まるため、AstroPointPopup.tsxのpointKeyと同じ
  // 「レンダー中に参照が変わったかを見て直接リセットする」定番パターンを使う。
  const [prevSatelliteFrames, setPrevSatelliteFrames] = useState(satellite.data);
  if (satellite.data !== prevSatelliteFrames) {
    setPrevSatelliteFrames(satellite.data);
    setSatelliteFrameIndex(satellite.data.length > 0 ? satellite.data.length - 1 : 0);
  }

  // 高原天気(気温・霧シミュレーター)は「気象情報を生成」ボタンを押したときだけ計算し直す
  // (DEM取得+グリッド計算を伴い数秒〜十数秒かかるため、自動ポーリングはしない)。
  // 生成結果はIndexedDBに直近5世代まで保存し(1世代あたり10〜20MB程度あり、localStorageの
  // 上限(5〜10MB程度)を超えてしまうため。詳細は kougenTenkiService.ts のコメント参照)、
  // 起動時にまず最新のものを表示しておく(非同期のため、読み込みが終わるまでは未生成の表示になる)。
  // 「過去に生成したデータを読み込めるボタンを追加してください」という指示により、
  // 保存済みの世代一覧から選んで読み込み直せるようにもしている。
  const [kougenTenkiGrid, setKougenTenkiGrid] = useState<KougenTenkiGrid | null>(null);
  const [kougenTenkiGenerating, setKougenTenkiGenerating] = useState(false);
  const [kougenTenkiError, setKougenTenkiError] = useState<string | null>(null);
  const [kougenTenkiVisible, setKougenTenkiVisible] = useState(false);
  const [kougenTenkiHourIndex, setKougenTenkiHourIndex] = useState(0);
  const [kougenTenkiTempOpacity, setKougenTenkiTempOpacity] = useState(0.6);
  const [kougenTenkiFogOpacity, setKougenTenkiFogOpacity] = useState(0.75);
  const [kougenTenkiShowStations, setKougenTenkiShowStations] = useState(true);
  const [kougenTenkiHover, setKougenTenkiHover] = useState<(KougenTenkiValue & { lat: number; lon: number }) | null>(
    null,
  );
  const [kougenTenkiHistory, setKougenTenkiHistory] = useState<KougenTenkiHistoryEntry[]>([]);
  const [kougenTenkiSelectedHistory, setKougenTenkiSelectedHistory] = useState<string>("");
  const [kougenTenkiHistoryLoading, setKougenTenkiHistoryLoading] = useState(false);
  // 「高層天気取得は1日2回までと制限をかけてください(10時間に1回まで)」という指示による、
  // 次に実際のライブ生成ができるまでの残り時間(ms、0なら生成可能)。詳細は
  // kougenTenkiService.ts の kougenTenkiCooldownRemainingMs() 参照。
  const [kougenTenkiCooldownMs, setKougenTenkiCooldownMs] = useState(() => kougenTenkiCooldownRemainingMs());

  // パネルを開いている間は、残り時間の表示が大きくズレないよう1分おきに更新する
  useEffect(() => {
    if (!kougenTenkiVisible) return;
    const id = window.setInterval(() => setKougenTenkiCooldownMs(kougenTenkiCooldownRemainingMs()), 60_000);
    return () => window.clearInterval(id);
  }, [kougenTenkiVisible]);

  const refreshKougenTenkiHistory = useCallback(() => {
    listKougenTenkiHistory().then((list) => {
      setKougenTenkiHistory(list);
      setKougenTenkiSelectedHistory((prev) => (prev && list.some((h) => h.generatedAt === prev) ? prev : (list[0]?.generatedAt ?? "")));
    });
  }, []);

  useEffect(() => {
    refreshKougenTenkiHistory();
    loadLatestKougenTenkiFromHistory().then((grid) => {
      if (!grid) return;
      setKougenTenkiGrid(grid);
      setKougenTenkiHourIndex(kougenTenkiNowIndex(grid));
    });
  }, [refreshKougenTenkiHistory]);

  const generateKougenTenkiWeather = useCallback(() => {
    const remaining = kougenTenkiCooldownRemainingMs();
    setKougenTenkiCooldownMs(remaining);
    setKougenTenkiGenerating(true);
    setKougenTenkiError(null);

    if (remaining > 0) {
      // 「制限中は高層天気のキャッシュを読み込む形にしてください」という指示への対応。
      // 実際のライブ生成(サーバーの/api/kougen-tenki-generate。Open-Meteo等外部取得を伴う
      // 重い処理)は行わず、保存済みの最新キャッシュ(IndexedDB履歴)をそのまま表示するだけにする。
      loadLatestKougenTenkiFromHistory()
        .then((grid) => {
          if (!grid) {
            setKougenTenkiError(
              "10時間に1回までの制限中で、保存済みのキャッシュもまだありません。しばらく待ってから生成してください。",
            );
            return;
          }
          setKougenTenkiGrid(grid);
          setKougenTenkiHourIndex(kougenTenkiNowIndex(grid));
          setKougenTenkiSelectedHistory(grid.generatedAt);
        })
        .finally(() => setKougenTenkiGenerating(false));
      return;
    }

    generateKougenTenki()
      .then((grid) => {
        setKougenTenkiGrid(grid);
        setKougenTenkiHourIndex(kougenTenkiNowIndex(grid));
        setKougenTenkiSelectedHistory(grid.generatedAt);
        markKougenTenkiGenerated();
        setKougenTenkiCooldownMs(kougenTenkiCooldownRemainingMs());
        return saveKougenTenkiToHistory(grid).then(() => refreshKougenTenkiHistory());
      })
      .catch((e: unknown) => setKougenTenkiError(errorMessage(e)))
      .finally(() => setKougenTenkiGenerating(false));
  }, [refreshKougenTenkiHistory]);

  const loadKougenTenkiHistoryEntry = useCallback(() => {
    if (!kougenTenkiSelectedHistory) return;
    setKougenTenkiHistoryLoading(true);
    setKougenTenkiError(null);
    loadKougenTenkiFromHistory(kougenTenkiSelectedHistory)
      .then((grid) => {
        if (!grid) {
          setKougenTenkiError("選択した世代の読み込みに失敗しました(保存データが見つかりません)");
          return;
        }
        setKougenTenkiGrid(grid);
        setKougenTenkiHourIndex(kougenTenkiNowIndex(grid));
      })
      .finally(() => setKougenTenkiHistoryLoading(false));
  }, [kougenTenkiSelectedHistory]);

  // 「高層天気とは別に 現在の気温の推定値のみを表示するボタン」への対応。
  // 高原天気と同じロジック(DEM地形補正+標高別逓減率+IDW補間)で「現在」1コマだけを
  // 都度計算するため、履歴保存(IndexedDB)・クールダウン制限は設けていない
  // (Open-Meteo予報を使わないため高原天気ほど生成が重くない)。
  // 「現在の気温は表示できるようにしてください」という指示により、高原天気と異なり
  // Android版でもこの機能自体は表示する(`currentTemperatureService.ts`がネイティブでは
  // `kougenTenkiNativeGenerate.ts`を使うよう分岐済み)。高原天気は引き続き元アルゴリズムの
  // 出典・ライセンスが不明瞭という理由でAndroid版では非表示のまま(下記JSXのisNativeApp()分岐)。
  const [currentTempGrid, setCurrentTempGrid] = useState<KougenTenkiGrid | null>(null);
  const [currentTempGenerating, setCurrentTempGenerating] = useState(false);
  const [currentTempError, setCurrentTempError] = useState<string | null>(null);
  const [currentTempVisible, setCurrentTempVisible] = useState(false);
  const [currentTempOpacity, setCurrentTempOpacity] = useState(0.6);
  const [currentTempFogOpacity, setCurrentTempFogOpacity] = useState(0.6);
  const [currentTempShowStations, setCurrentTempShowStations] = useState(true);
  const [currentTempHover, setCurrentTempHover] = useState<(KougenTenkiValue & { lat: number; lon: number }) | null>(
    null,
  );

  const generateCurrentTemperatureWeather = useCallback(() => {
    setCurrentTempGenerating(true);
    setCurrentTempError(null);
    generateCurrentTemperature()
      .then((grid) => setCurrentTempGrid(grid))
      .catch((e: unknown) => setCurrentTempError(errorMessage(e)))
      .finally(() => setCurrentTempGenerating(false));
  }, []);

  // 信州大学 山岳科学研究拠点の山岳観測所(気象の観測値・カメラ)の取得は、スマホ版では廃止した(「信州山の環境研究のカメラと気象情報取得も削除」への対応)

  const [selectedPoint, setSelectedPoint] = useState<{ lat: number; lng: number } | null>(null);
  // 「紅葉マップ」(植生×標高×気温×長期予報)。状態は1つのフックにまとめてある
  const koyo = useKoyo(selectedPoint);
  // 「天文情報のところに 紅葉のピークの時期と 植生の種類を追加してください」への対応。
  // 天文情報パネルへ渡す、選択地点の植生と紅葉の見頃(紅葉マップの表示ON/OFFには関係なく計算される)
  const koyoAstro = useMemo(
    () => ({ point: koyo.point, dayRange: koyo.autumnRange, today: koyo.today }),
    [koyo.point, koyo.autumnRange, koyo.today],
  );
  const [selectedDate, setSelectedDate] = useState<Date>(() => new Date());
  // 「クリックしたところを表示するボタンを押すと 3d360度見渡せるビューワーを追加」への対応。
  // 天文情報パネルの「3Dで見渡す」を押した地点・日付・住所(開いている間だけ保持する。
  // 地点を選び直しても開いたままのビューワーの地点は変えない)。本体は押されて初めて読み込む。
  const [viewer3d, setViewer3d] = useState<{
    point: { lat: number; lng: number };
    date: Date;
    address: string | null;
  } | null>(null);
  const koyoViewer = useMemo(
    () => ({
      climateInput: koyo.climateInput,
      veg: koyo.veg?.status === "ok" ? koyo.veg.grid : null,
      zones: koyo.snowZones?.status === "ok" ? koyo.snowZones.grid : null,
      hiddenClasses: koyo.hiddenClasses,
      opacity: koyo.opacity,
      dayRange: koyo.dayRange,
      day: koyo.day,
    }),
    [koyo.climateInput, koyo.veg, koyo.snowZones, koyo.hiddenClasses, koyo.opacity, koyo.dayRange, koyo.day],
  );
  // 3Dビューワーの霧(地面から約100mまで)に使う、「現在の気温」「高原天気」で作成済みの霧データ。
  const fogViewer = useMemo(() => ({ current: currentTempGrid, forecast: kougenTenkiGrid }), [currentTempGrid, kougenTenkiGrid]);
  // 3Dビューワーの雲(空の雲の層)に使う、衛星画像(ひまわり)の実測コマ。使うのは最新のコマ(現在の雲)だけ
  // (「3D表示の雲は現在のみで、過去の部分は必要ない」への対応。予測コマも使わない)。
  const cloudViewer = useMemo(() => ({ observed: satellite.data }), [satellite.data]);
  // 「地図をクリックすると のところを 起動時のみ表示するようにしてください」への対応。
  // 以前は`!selectedPoint`だけで判定していたため、天文情報ポップアップを閉じて
  // selectedPointがnullに戻るたびに案内(.app__hint)が毎回再表示されていた。
  // 「地図を一度でもクリックしたか」を別途保持し、一度クリックしたら(=案内の役目を
  // 終えたら)以後はポップアップを閉じても二度と出さないようにする。
  const [hasEverSelectedPoint, setHasEverSelectedPoint] = useState(false);

  // 「現在地を取得するボタンを追加してください」という指示への対応。
  // ブラウザのGeolocation APIで取得した現在地を地図上にマーカー表示し、そこへ地図を寄せる
  // (地図の操作自体はMapView側のFlyToPointが担当。ここでは座標と状態だけを持つ)。
  const [currentLocation, setCurrentLocation] = useState<GeoPoint | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationError, setLocationError] = useState<string | null>(null);

  const handleLocateMe = useCallback(() => {
    setLocating(true);
    setLocationError(null);
    getCurrentPosition()
      .then((point) => setCurrentLocation(point))
      .catch((e: unknown) => setLocationError(errorMessage(e)))
      .finally(() => setLocating(false));
  }, []);

  // レイヤーが増えて縦に長くなったため、狭い画面では既定で畳んでおく(地図が隠れてしまうため)
  const [controlsOpen, setControlsOpen] = useState(() => window.innerWidth >= MOBILE_BREAKPOINT_PX);
  // 「出典・ライセンス」画面(CreditsSheet.tsx)。「法令適合と著作権などの抵触の確認」への対応
  const [creditsOpen, setCreditsOpen] = useState(false);
  // スマホ版では、開いたときに一覧をボトムシート(画面下からせり上がる形)で表示する
  // (「表示レイヤーはタップしたときに下に出てくるようにしてください」という指示による)。
  const isMobile = useIsMobile();

  // 「衛星画像のタブなのですが...画面の下に常に表示されるようにしてください」への対応。
  // 画面下に常時固定表示する衛星画像バー(.app__satellite-bar)の実際の高さを測り、
  // 天文情報の案内(.app__hint)・エラー表示(.app__toast)がその下に隠れて見えなくなって
  // しまわないよう、CSS変数(--satellite-bar-reserve)としてbottom位置の底上げ量に使う。
  // バーの中身はバンド・不透明度・時刻スライダー・予測の状態・雲判定メッシュなど状態に
  // よって高さが変わるため、固定値ではなく実際の高さを都度測って追従させる。
  // (ResizeObserverでの追従も試したが、ブラウザ検証環境ではコールバックが発火しない
  // ケースが確認できたため、より確実な「毎レンダー後に直接測る」方式にしている。
  // 描画のたびに呼ばれるが、getBoundingClientRect+CSS変数更新は軽い処理のため問題ない)。
  const satelliteBarRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const measure = () => {
      const el = satelliteBarRef.current;
      if (!el) return;
      const height = el.getBoundingClientRect().height;
      document.documentElement.style.setProperty("--satellite-bar-reserve", `${Math.ceil(height)}px`);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  });

  useEffect(() => {
    loadCameras()
      .then(setCameras)
      .catch((e: unknown) => setCameraError(errorMessage(e)));
  }, []);

  const refreshRain = useCallback(() => {
    fetchRainFrames()
      .then((frames) => {
        setRainFrames(frames);
        setRainError(null);
      })
      .catch((e: unknown) => setRainError(errorMessage(e)));
  }, []);

  useEffect(() => {
    refreshRain();
    const id = window.setInterval(refreshRain, RAIN_POLL_MS);
    return () => window.clearInterval(id);
  }, [refreshRain]);

  const handleMapClick = useCallback((lat: number, lng: number) => {
    setSelectedPoint({ lat, lng });
    setHasEverSelectedPoint(true);
  }, []);

  // 「検索機能を追加する」への対応: 検索で選んだ地点へ地図を寄せ、地図をクリックしたときと同じく天文情報(「3Dで見渡す」つき)を出す。
  // 同じ地点を続けて選んでも寄せ直すよう、毎回新しいオブジェクトにする
  const [focusPoint, setFocusPoint] = useState<{ lat: number; lng: number; zoom: number } | null>(null);
  const handleSearchSelect = useCallback((hit: PlaceHit) => {
    setFocusPoint({ lat: hit.lat, lng: hit.lng, zoom: hit.kind === "camera" ? 14 : 13 });
    setSelectedPoint({ lat: hit.lat, lng: hit.lng });
    setHasEverSelectedPoint(true);
  }, []);

  // 予測コマが有効なときは、スライダーのインデックスを「実測コマ(0..len-1)」の続きとして
  // 「予測コマ(len..len+FORECAST_STEPS-1)」まで連続的に扱う(雨雲・高原天気と同じ
  // 「1本のスライダーでコマを選ぶ」作りを崩さないようにするため)。
  const isSatelliteForecastIndex = satelliteFrameIndex >= satellite.data.length;
  const satelliteFrame = isSatelliteForecastIndex ? null : (satellite.data[satelliteFrameIndex] ?? null);
  const satelliteForecastFrame = isSatelliteForecastIndex
    ? (satelliteForecastFrames[satelliteFrameIndex - satellite.data.length] ?? null)
    : null;
  // 「予測の方向も 時間によって 変化するようにして」という指示への対応。予測コマごとに
  // 使う風(motionField)が変わるようになったため、矢印表示も選択中のコマに応じて切り替える
  // (予測コマを見ているときはそのコマ自身のmotionField、実測コマを見ているときは最初の
  // 予測コマ=直近の風のmotionFieldを表示する。以前からの「常に最新の動きベクトルを見せる」
  // という挙動を実測コマ表示中は変えないため)。
  const displayedSatelliteMotionField = satelliteForecastFrame ? satelliteForecastFrame.motionField : satelliteMotionField;

  // 「雨雲と衛星は時刻を統合してください」への対応。衛星画像(30分刻み、実測-5.5時間〜
  // 予測+6時間)と雨雲(気象庁高解像度降水ナウキャスト、5分刻み、実況-1時間〜予測+1時間)は
  // 元々別々のスライダーで別々のコマを選んでいたが、衛星画像側のコマ位置を「マスター時刻」
  // として、雨雲側はその時刻に一番近いコマを自動選択する形に統合した(雨雲の刻みの方が
  // 細かいため、逆に雨雲側のコマ位置を衛星画像に当てはめると衛星画像側は歯抜けになってしまう)。
  // 両者の validtime はどちらも気象庁配信の同じ "YYYYMMDDHHmmss"(UTC)形式のため、
  // 衛星画像用のparseValidTime(parseJmaValidTimeとしてimport)でそのままパースできる。
  const selectedTimeMs = useMemo(() => {
    if (satelliteFrame) return parseJmaValidTime(satelliteFrame.validtime).getTime();
    if (satelliteForecastFrame) {
      const newest = satellite.data[satellite.data.length - 1];
      if (!newest) return null;
      // hoursAhead は最新の実測コマからの経過時間(lib/satelliteForecast.ts参照)
      return parseJmaValidTime(newest.validtime).getTime() + Math.round(satelliteForecastFrame.hoursAhead * 3_600_000);
    }
    return null;
  }, [satelliteFrame, satelliteForecastFrame, satellite.data]);

  const rainFrameIndex = useMemo(() => {
    if (selectedTimeMs == null || rainFrames.length === 0) return 0;
    let bestIndex = 0;
    let bestDiffMs = Infinity;
    for (let i = 0; i < rainFrames.length; i++) {
      const diffMs = Math.abs(parseJmaValidTime(rainFrames[i].validtime).getTime() - selectedTimeMs);
      if (diffMs < bestDiffMs) {
        bestDiffMs = diffMs;
        bestIndex = i;
      }
    }
    return bestIndex;
  }, [selectedTimeMs, rainFrames]);

  // 「衛星画像のタブなのですが...チェックリストもメッシュにするかどうかのみで」という指示
  // により、衛星画像自体の表示ON/OFFチェックボックスは廃止し常に表示するため、ここでの
  // 分岐は不要になった。
  const satelliteTileUrl = useMemo(
    () => (satelliteFrame ? buildSatelliteTileUrl(satelliteFrame, satelliteBand) : null),
    [satelliteFrame, satelliteBand],
  );

  // 雲判定メッシュ(cloudMesh.ts)は、AI超解像と違いGPU/重いモデルを使わない軽い処理
  // (単純なcanvasのピクセル読み取りのみ)のため、「生成」ボタンは設けず、表示ON かつ
  // 選択中のコマが変わるたびに自動で計算し直す。
  //
  // 「衛星画像の予測の際も メッシュでできるようにしてください」への対応。予測コマを見て
  // いるときは、lib/satelliteForecast.tsが予測コマ生成時にあわせて計算済みの
  // cloudMeshDataUrl/boundsをそのまま使う(非同期の再計算は不要)。
  useEffect(() => {
    if (!cloudMeshVisible) {
      setCloudMeshDataUrl(null);
      setCloudMeshError(null);
      return;
    }
    if (isSatelliteForecastIndex) {
      if (satelliteForecastFrame) {
        setCloudMeshDataUrl(satelliteForecastFrame.cloudMeshDataUrl);
        setCloudMeshBounds(satelliteForecastFrame.bounds);
        setCloudMeshError(null);
      } else {
        setCloudMeshDataUrl(null);
      }
      return;
    }
    if (!satelliteFrame) {
      setCloudMeshDataUrl(null);
      setCloudMeshError(null);
      return;
    }
    let cancelled = false;
    setCloudMeshLoading(true);
    setCloudMeshError(null);
    computeCloudMeshGrid(satelliteFrame)
      .then((grid) => {
        if (cancelled) return;
        setCloudMeshDataUrl(renderCloudMeshDataUrl(grid));
        setCloudMeshBounds(CLOUD_MESH_BOUNDS);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setCloudMeshError(errorMessage(e));
        setCloudMeshDataUrl(null);
      })
      .finally(() => {
        if (!cancelled) setCloudMeshLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // satelliteFrame はコマが変わるたびに新しいオブジェクト参照になるため、実体である
    // basetime/validtimeを見て変化を判定する(参照比較だと同じ内容でも毎回再計算してしまう)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloudMeshVisible, isSatelliteForecastIndex, satelliteForecastFrame, satelliteFrame?.basetime, satelliteFrame?.validtime]);

  // 「衛星画像の予測をしたい 過去1時間分の衛星画像をもとに 3時間後まで どのように動くか
  // 予想したい」「高層の風を取得して それを基に 方向を決定することはできますか」への対応。
  // 「衛星画像予測は常にonにしてください」という指示により、表示チェックボックスでの分岐は
  // 廃止し、最新の実測コマが変わるたびに常に動きベクトル・予測コマの生成をやり直す(詳細は
  // lib/satelliteForecast.ts参照。以前は直近1時間の実測画像2枚を比較する画像相関だったが、
  // 「全マス目、高層風の方向に置き換える」という指示によりそちらへ変更した)。まだ実測コマが
  // 1枚も届いていない(起動直後)場合は、エラーとしてではなく単に「まだ計算できない」状態
  // として静かに待つ(起動直後にエラー文言が一瞬出るのを防ぐ)。
  //
  // 「予測コマの計算に失敗しました: 高層風(Open-Meteo)の取得に失敗しました (HTTP 429)」への
  // 対応。以前は依存配列に`satellite.data`(配列参照そのもの)を指定していたため、
  // SATELLITE_POLL_MS(10分)ごとのポーリングでJMA側にまだ新しい画像が無い場合でも
  // (usePolledResourceが取得のたびに新しい配列を作るため)毎回このeffectが再実行され、
  // 無駄にOpen-Meteoへ再リクエストしてしまっていた(常時ONになったことで、この無駄が
  // 手動チェックボックス時代より頻繁に起きるようになり、Open-Meteo無料枠の分単位の
  // リクエスト数上限に当たりやすくなっていた)。最新コマの実体(basetime/validtime)が
  // 実際に変わったときだけ再計算するよう、依存配列を絞った(cloudMeshVisibleのuseEffectで
  // 既に使っているのと同じ考え方)。
  //
  // 「自分用では実装して 発表用では 廃止することはできますか」への対応。気象業務法第17条の
  // 予報業務許可は「不特定多数へ反復・継続的に提供」する場合に必要になるため、公開用の
  // ビルド(この環境変数を設定しないデフォルト状態)では、UIを隠すだけでなく、予測の計算
  // 自体(Open-Meteoへの問い合わせ・移流処理)を行わないようにする(`src/lib/platform.ts`の
  // `isSatelliteForecastEnabled`のコメント参照)。
  const latestSatelliteFrame = satellite.data[satellite.data.length - 1] ?? null;
  useEffect(() => {
    if (!isSatelliteForecastEnabled() || !latestSatelliteFrame) {
      setSatelliteForecastFrames([]);
      setSatelliteMotionField(null);
      setSatelliteForecastError(null);
      return;
    }
    const nowFrame = latestSatelliteFrame;

    let cancelled = false;
    setSatelliteForecastLoading(true);
    setSatelliteForecastError(null);
    computeSatelliteForecast(nowFrame)
      .then((result) => {
        if (cancelled) return;
        setSatelliteForecastFrames(result.frames);
        setSatelliteMotionField(result.motionField);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setSatelliteForecastError(errorMessage(e));
        setSatelliteForecastFrames([]);
        setSatelliteMotionField(null);
      })
      .finally(() => {
        if (!cancelled) setSatelliteForecastLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latestSatelliteFrame?.basetime, latestSatelliteFrame?.validtime]);

  const rainTileTemplate = useMemo(
    () => (rainVisible && rainFrames[rainFrameIndex] ? buildRainTileUrlTemplate(rainFrames[rainFrameIndex]) : null),
    [rainVisible, rainFrames, rainFrameIndex],
  );

  // 「現在地の1日の気温と天気も、高層天気の取得した場合に表示されるようにしてください」への対応。
  // 生成済みグリッドの全コマ(過去12時間+未来12時間)について、現在地の気温・霧リスクをその都度引く。
  // 高原天気の対象範囲(岐阜県北部〜長野県中心)外の場合や、まだ現在地未取得の場合はnull。
  const kougenTenkiCurrentLocationSeries = useMemo(() => {
    if (!kougenTenkiGrid || !currentLocation) return null;
    return kougenTenkiGrid.hours.map((frame, i) => {
      const value = lookupKougenTenkiValue(kougenTenkiGrid, i, currentLocation.lat, currentLocation.lng);
      return value
        ? { timeKey: frame.timeKey, kind: frame.kind, tempC: value.tempC, fog: value.fog }
        : null;
    });
  }, [kougenTenkiGrid, currentLocation]);

  /*
    「カメラのチェックリストを川の防災とアメダス、気象情報生成、衛星画像、雨雲表示と
    その他のカメラに分別してください」という要望を受け、以前は1本の縦並びだった
    チェックリストを6つのグループに分けた(グループ見出しは表示専用で開閉はしない。
    既にリスト全体がスクロールする作りのため、見出しだけで十分に見分けやすくなる)。

    return文の外(関数コンポーネント内)で変数として持っておくのは、デスクトップ版
    (`.app__layer-controls`内にそのまま展開)とスマホ版(`BottomSheet`の中身)の
    どちらでも同じ中身を使い回すため(「表示レイヤーはタップしたときに下に出てくるように
    してください」という指示によりスマホ版だけ表示方法を分けている)。
  */
  const layerGroupsContent = (
    <>
      <div className="app__layer-group-header">背景地図</div>
      <div className="layer-control">
        <label className="layer-control__checkbox">
          <input type="radio" name="baseMap" checked={baseMap === "pale"} onChange={() => setBaseMap("pale")} />
          地図(国土地理院の淡色地図)
        </label>
        <label className="layer-control__checkbox">
          <input type="radio" name="baseMap" checked={baseMap === "photo"} onChange={() => setBaseMap("photo")} />
          衛星写真(国土地理院の全国最新写真)
        </label>
      </div>

      <div className="app__layer-group-header">アメダス</div>
      <WeatherMetricControl
        visible={amedasVisible}
        onVisibleChange={setAmedasVisible}
        metric={weatherMetric}
        onMetricChange={setWeatherMetric}
        stationCount={amedas.data.stations.length}
        observedAt={amedas.data.observedAt || null}
        loading={amedas.loading}
        error={amedas.error}
      />


      {/*
        「衛星画像のタブなのですが 表示レイヤーからなくして 画面の下に常に表示されるように
        してください」という指示への対応。以前はここ(表示レイヤーの一覧)に「衛星画像」の
        見出し+<SatelliteControl>があったが、この一覧からは削除し、下の方で画面下に
        常時表示する<SatelliteControl>(app__satellite-bar)として独立させた。
      */}

      {/*
        「アンドロイド版では 高層天気の趣味レーターは削除してください」という指示への対応。
        高原天気(気温・霧シミュレーター)のアルゴリズムは既存のJavaツール由来で出典・ライセンスが
        はっきりしないため、Android版(Capacitorのネイティブアプリ)ではUI自体を出さないように
        する(Web版はこれまで通り表示する)。裏側の状態・生成ロジックは共通のまま残し、
        `isNativeApp()`でこの表示部分だけ分岐している(下のMapView.tsxの<KougenTenkiLayer>も
        同様に分岐、常にvisible=falseのままなので二重の安全策)。
      */}
      {!isNativeApp() && (
        <>
          <div className="app__layer-group-header">気象情報生成</div>
          <KougenTenkiControl
            visible={kougenTenkiVisible}
            onVisibleChange={setKougenTenkiVisible}
            grid={kougenTenkiGrid}
            hourIndex={kougenTenkiHourIndex}
            onHourIndexChange={setKougenTenkiHourIndex}
            tempOpacity={kougenTenkiTempOpacity}
            onTempOpacityChange={setKougenTenkiTempOpacity}
            fogOpacity={kougenTenkiFogOpacity}
            onFogOpacityChange={setKougenTenkiFogOpacity}
            showStations={kougenTenkiShowStations}
            onShowStationsChange={setKougenTenkiShowStations}
            hover={kougenTenkiHover}
            onGenerate={generateKougenTenkiWeather}
            generating={kougenTenkiGenerating}
            error={kougenTenkiError}
            history={kougenTenkiHistory}
            selectedHistory={kougenTenkiSelectedHistory}
            onSelectedHistoryChange={setKougenTenkiSelectedHistory}
            onLoadHistory={loadKougenTenkiHistoryEntry}
            historyLoading={kougenTenkiHistoryLoading}
            cooldownRemainingMs={kougenTenkiCooldownMs}
            currentLocationSeries={kougenTenkiCurrentLocationSeries}
          />
        </>
      )}

      {/*
        「現在の気温は表示できるようにしてください」への対応。高原天気(上のKougenTenkiControl)は
        引き続きisNativeApp()で分岐してAndroid版では非表示のままだが、こちらは高原天気の
        アルゴリズムをそのまま使うにも関わらず、ネイティブ移植版(kougenTenkiNativeGenerate.tsの
        generateCurrentTemperature、currentTemperatureService.tsが分岐)を用意したため、
        Web版・Android版どちらでも常に表示する(isNativeAppでの分岐なし)。
      */}
      <div className="app__layer-group-header">現在の気温</div>
      <CurrentTemperatureControl
        visible={currentTempVisible}
        onVisibleChange={setCurrentTempVisible}
        grid={currentTempGrid}
        opacity={currentTempOpacity}
        onOpacityChange={setCurrentTempOpacity}
        fogOpacity={currentTempFogOpacity}
        onFogOpacityChange={setCurrentTempFogOpacity}
        showStations={currentTempShowStations}
        onShowStationsChange={setCurrentTempShowStations}
        hover={currentTempHover}
        onGenerate={generateCurrentTemperatureWeather}
        generating={currentTempGenerating}
        error={currentTempError}
      />

      {/*
        「紅葉マップ」: 植生GIS(環境省植生図)で樹種ごとの紅葉時期を推定し、日ごとに紅葉の標高が
        どれだけ降りるか、北→南(地域ごとの平年の気温差)で標高がどう違うか、気象庁の長期予報
        (確率予測資料)の気温で進み具合を地域別に補正できるようにしたもの。Web版・Android版とも表示。
      */}
      <div className="app__layer-group-header">紅葉</div>
      <KoyoControl koyo={koyo} />

      {/*
        「その他のカメラのチェックリストは1つにしてください」でまとめた11個の個別トグルに、
        「川の防災と その他のカメラを統合してください」という指示で川の防災情報カメラ
        (kawabou、以前は「川の防災」という別グループの独立したトグルだった)も合流させた。
      */}
      <div className="app__layer-group-header">ライブカメラ</div>
      <LayerToggle
        label="ライブカメラ"
        visible={camerasVisible}
        onVisibleChange={setCamerasVisible}
        count={
          cameras.length +
          takayama.data.length +
          kokudo.data.length +
          naganoOfficeLinks.data.length +
          jmaVolcam.data.length +
          2
        }
        loading={
          takayama.loading ||
          kokudo.loading ||
          naganoOfficeLinks.loading ||
          jmaVolcam.loading
        }
        error={
          cameraError ||
          takayama.error ||
          kokudo.error ||
          naganoOfficeLinks.error ||
          jmaVolcam.error
        }
      />

      <div className="app__layer-group-header">このアプリについて</div>
      <div className="layer-control">
        <button
          type="button"
          className="credits__open"
          onClick={() => {
            // スマホ版は表示レイヤーのシートを閉じてから開く(シートが2枚重ならないように)
            if (isMobile) setControlsOpen(false);
            setCreditsOpen(true);
          }}
        >
          出典・ライセンス
        </button>
      </div>
    </>
  );

  return (
    <div className="app">
      <MapView
        cameras={cameras}
        camerasVisible={camerasVisible}
        jmaVolcamCameras={jmaVolcam.data}
        jmaVolcamVisible={camerasVisible}
        takayamaCameras={takayama.data}
        takayamaVisible={camerasVisible}
        kokudoCameras={kokudo.data}
        kokudoVisible={camerasVisible}
        naganoOfficeLinks={naganoOfficeLinks.data}
        naganoOfficeLinksVisible={camerasVisible}
        jr9vqVisible={camerasVisible}
        amedasStations={amedas.data.stations}
        amedasVisible={amedasVisible}
        amedasObservedAt={amedas.data.observedAt || null}
        weatherMetric={weatherMetric}
        satelliteTileUrl={satelliteVisible ? satelliteTileUrl : null}
        satelliteOpacity={satelliteOpacity}
        satelliteForecastFrame={satelliteVisible ? satelliteForecastFrame : null}
        satelliteMotionField={satelliteVisible ? displayedSatelliteMotionField : null}
        cloudMeshVisible={cloudMeshVisible}
        cloudMeshDataUrl={cloudMeshDataUrl}
        cloudMeshOpacity={cloudMeshOpacity}
        cloudMeshBounds={cloudMeshBounds}
        currentLocation={currentLocation}
        focusPoint={focusPoint}
        kougenTenkiGrid={kougenTenkiGrid}
        kougenTenkiVisible={kougenTenkiVisible}
        kougenTenkiHourIndex={kougenTenkiHourIndex}
        kougenTenkiTempOpacity={kougenTenkiTempOpacity}
        kougenTenkiFogOpacity={kougenTenkiFogOpacity}
        kougenTenkiShowStations={kougenTenkiShowStations}
        onKougenTenkiHover={setKougenTenkiHover}
        currentTempGrid={currentTempGrid}
        currentTempVisible={currentTempVisible}
        currentTempOpacity={currentTempOpacity}
        currentTempFogOpacity={currentTempFogOpacity}
        currentTempShowStations={currentTempShowStations}
        onCurrentTempHover={setCurrentTempHover}
        koyoVisible={koyo.visible}
        koyoOpacity={koyo.opacity}
        koyoStationT0={koyo.stationT0}
        koyoStationT0Ahead={koyo.stationT0Ahead}
        koyoStationT0Past={koyo.stationT0Past}
        koyoSeason={koyo.season}
        koyoLapseCPerM={koyo.lapseCPerM}
        koyoVeg={koyo.veg?.status === "ok" ? koyo.veg.grid : null}
        koyoHiddenClasses={koyo.hiddenClasses}
        koyoAstro={koyoAstro}
        selectedPoint={selectedPoint}
        selectedDate={selectedDate}
        onDateChange={setSelectedDate}
        onCloseAstro={() => setSelectedPoint(null)}
        onOpen3D={(address) => {
          if (selectedPoint) setViewer3d({ point: selectedPoint, date: selectedDate, address });
        }}
        onMapClick={handleMapClick}
        rainTileTemplate={rainTileTemplate}
        rainOpacity={rainOpacity}
        baseMap={baseMap}
      />

      {viewer3d && (
        <Viewer3DHost
          key={`${viewer3d.point.lat},${viewer3d.point.lng}`}
          point={viewer3d.point}
          address={viewer3d.address}
          date={viewer3d.date}
          koyo={koyoViewer}
          fog={fogViewer}
          cloud={cloudViewer}
          cloudDefaultOn={cloudMeshVisible}
          onRequestCurrentTemp={generateCurrentTemperatureWeather}
          currentTempBusy={currentTempGenerating}
          onClose={() => setViewer3d(null)}
        />
      )}

      {/*
        「現在地を取得するボタンを追加してください」という要望で追加。押すとブラウザの
        Geolocation APIで現在地を取得し、地図をその地点へ寄せつつマーカーを表示する
        (マーカー・地図移動自体の描画は MapView 側)。
        「アンドロイド版は現在地は削除してください」という指示への対応で、Android版
        (Capacitorのネイティブアプリ)ではボタン自体を表示しないようにした(Web版は
        これまで通り表示する)。位置情報のパーミッション取得(Play Storeのデータ safety
        フォームでの申告対象)自体を避けるのが目的のため、`handleLocateMe`が実際に
        呼ばれる唯一の入口であるこのボタンを消せば、Android版でGeolocation APIが
        呼ばれることはなくなる(状態・ロジック自体は共通のまま残している)。
      */}
      {!isNativeApp() && (
        <>
          <button
            type="button"
            className="app__locate-button"
            onClick={handleLocateMe}
            disabled={locating}
            aria-label="現在地を取得"
          >
            <Ico icon={MapPin} /> {locating ? "取得中…" : "現在地を取得"}
          </button>
          {locationError && <div className="app__toast app__toast--location">{locationError}</div>}
        </>
      )}

      {/* 「検索機能を追加する」への対応: 地名・住所・山(国土地理院の地名検索)とライブカメラの名前で探す */}
      <PlaceSearch cameras={cameras} onSelect={handleSearchSelect} atLeft={isNativeApp()} />

      {/* 「ブナ 白樺 カラマツなど 木ごとのチェックリストも 左上についかしてください」への対応(紅葉マップ表示中のみ) */}
      <KoyoSpeciesChecklist koyo={koyo} noLocateButton={isNativeApp()} />

      <div className="app__layer-controls">
        <button
          type="button"
          className="app__layer-toggle"
          onClick={() => setControlsOpen((v) => !v)}
          aria-expanded={controlsOpen}
        >
          <Ico icon={controlsOpen ? ChevronUp : ChevronDown} /> {controlsOpen ? "表示レイヤーを隠す" : "表示レイヤー"}
        </button>

        {/* デスクトップ版は従来通り、ボタンのすぐ下にそのまま展開する */}
        {controlsOpen && !isMobile && layerGroupsContent}
      </div>

      {/* スマホ版は画面下からせり上がるボトムシートで表示する */}
      {controlsOpen && isMobile && (
        <BottomSheet title="表示レイヤー" onClose={() => setControlsOpen(false)}>
          {layerGroupsContent}
        </BottomSheet>
      )}

      {creditsOpen && <CreditsSheet onClose={() => setCreditsOpen(false)} />}

      {cameraError && (
        <div className="app__toast">カメラ情報の読み込みに失敗しました: {cameraError}</div>
      )}

      {!hasEverSelectedPoint && (
        <div className="app__hint">地図をクリックすると、その地点の天文情報を表示します</div>
      )}

      {/*
        「衛星画像のタブなのですが 表示レイヤーからなくして 画面の下に常に表示されるように
        してください」という指示への対応。以前は表示レイヤーの一覧内(タップ/クリックしないと
        開かない場所)にあったが、画面下に常時固定表示するバーとして独立させた
        (App.cssの.app__satellite-barで position: fixed; bottom: 0)。
        「雨雲を表示するのところを 衛星画像のタブと統合してください」という指示により、
        表示レイヤー一覧の独立したグループだった「雨雲表示」もこのバー(SatelliteControl)に
        統合したため、雨雲関連の各状態(rainFrames等)もここへ渡している。
      */}
      <div className="app__satellite-bar" ref={satelliteBarRef}>
        <SatelliteControl
          visible={satelliteVisible}
          onVisibleChange={setSatelliteVisible}
          band={satelliteBand}
          onBandChange={setSatelliteBand}
          opacity={satelliteOpacity}
          onOpacityChange={setSatelliteOpacity}
          frames={satellite.data}
          frameIndex={satelliteFrameIndex}
          onFrameIndexChange={setSatelliteFrameIndex}
          cloudMeshVisible={cloudMeshVisible}
          onCloudMeshVisibleChange={setCloudMeshVisible}
          cloudMeshOpacity={cloudMeshOpacity}
          onCloudMeshOpacityChange={setCloudMeshOpacity}
          cloudMeshLoading={cloudMeshLoading}
          cloudMeshError={cloudMeshError}
          forecastFrames={satelliteForecastFrames}
          forecastLoading={satelliteForecastLoading}
          forecastError={satelliteForecastError}
          forecastEnabled={isSatelliteForecastEnabled()}
          loading={satellite.loading}
          error={satellite.error}
          rainVisible={rainVisible}
          onRainVisibleChange={setRainVisible}
          rainFrames={rainFrames}
          rainFrameIndex={rainFrameIndex}
          rainOpacity={rainOpacity}
          onRainOpacityChange={setRainOpacity}
          rainError={rainError}
        />
      </div>
    </div>
  );
}

export default App;
