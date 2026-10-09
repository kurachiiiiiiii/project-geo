/**
 * "link" は映像を埋め込まず、配信元ページへのリンクだけを出す種別。
 * 転載(再配信)を禁止しているサイトを地図に載せるために使う。
 *
 * "youtubeChannel" は動画IDではなく**チャンネルID**を指定し、
 * `https://www.youtube.com/embed/live_stream?channel=<チャンネルID>` で
 * 「そのチャンネルが今配信中のライブ」を埋め込む。個人・団体が定点カメラを
 * 1本だけ配信し続けているチャンネルであれば、配信が終了して新しいライブが
 * 始まってもURL(動画ID)を追いかけ直す必要がなくなる(動画IDは配信のたびに変わるため)。
 * ただし同じチャンネルで複数のライブを同時配信している場合は意図しない映像に
 * なり得るため、そのようなチャンネルには使わず通常の "youtube"(動画ID固定)を使うこと。
 */
export type CameraType = "image" | "iframe" | "youtube" | "youtubeChannel" | "link";

export interface CameraConfig {
  id: string;
  name: string;
  lat: number;
  lng: number;
  type: CameraType;
  /**
   * image: JPEGスナップショットのURL / iframe: 埋め込みURL / youtube: 動画ID /
   * youtubeChannel: チャンネルID / link: 配信元ページのURL
   */
  url: string;
  /** ポップアップに表示する補足説明(任意) */
  note?: string;
  /** type:"image" のときの自動リロード間隔(ms)。省略時は30秒 */
  refreshMs?: number;
  /** 出典の表示名(任意) */
  source?: string;
  /** 出典ページへのリンク(任意) */
  sourceUrl?: string;
}

export interface TwilightTimes {
  /** 選択日の日の出 */
  sunrise: Date | null;
  /** 選択日の日の入り */
  sunset: Date | null;
  /** その晩の天文薄明終了(これ以降が完全な夜) */
  astroDusk: Date | null;
  /** 翌朝の天文薄明開始(これ以降は空が明るくなり始める) */
  astroDawn: Date | null;
  /** 月の出(参考値) */
  moonrise: Date | null;
  /** 月の入り(参考値) */
  moonset: Date | null;
  /** 日の出の方位角(0〜360°, 北=0/東=90)。sunriseがnullのときはnull */
  sunriseAzimuthDeg: number | null;
  /** 日の入りの方位角 */
  sunsetAzimuthDeg: number | null;
  /** 月の出の方位角 */
  moonriseAzimuthDeg: number | null;
  /** 月の入りの方位角 */
  moonsetAzimuthDeg: number | null;
}

export interface VisibilityWindow {
  start: Date;
  end: Date;
}

/** ある時刻における天体の方角・高度のサンプル */
export interface DirectionSample {
  time: Date;
  /** 方位角(0〜360°, 北=0/東=90) */
  azimuthDeg: number;
  /** 仰角(°)。負の値は地平線下 */
  altitudeDeg: number;
}

/** ある時刻における銀河中心(天の川)の方角・高度のサンプル */
export interface MilkyWayDirectionSample extends DirectionSample {
  /** その時刻が観測可能条件(仰角15°以上かつ月が沈んでいる)を満たすか */
  visible: boolean;
}

/** 月齢情報(観測地点によらず時刻のみで決まる) */
export interface MoonInfo {
  /** 直近の新月からの経過日数(0〜約29.53) */
  ageDays: number;
  /** 輝面比(0〜1) */
  illumination: number;
}

export interface MilkyWayResult {
  lat: number;
  lng: number;
  twilight: TwilightTimes;
  moon: MoonInfo;
  /** 天文薄明終了〜翌天文薄明開始の間で、銀河中心の仰角が15度以上かつ月が沈んでいる時間帯 */
  windows: VisibilityWindow[];
  /** 天文薄明終了〜翌天文薄明開始の間、1時間ごとの銀河中心(天の川)の方角・高度 */
  directionSamples: MilkyWayDirectionSample[];
  /** 選択日の0時〜23時、1時間ごとの太陽の方角・高度 */
  sunDirectionSamples: DirectionSample[];
  /** 選択日の0時〜23時、1時間ごとの月の方角・高度 */
  moonDirectionSamples: DirectionSample[];
  warnings: string[];
}

/** カレンダー表示用: 1日分の天の川観測可能時間の要約 */
export interface DaySummary {
  date: Date;
  /** その晩の観測可能時間の合計(分) */
  totalMinutes: number;
  windows: VisibilityWindow[];
}

/** 気象庁 火山監視カメラの地点(一覧APIから取得。画像URLは個別ページを開いたときに遅延取得する) */
export interface JmaVolcanoCamera {
  /** volcam.php の VC パラメータ */
  vc: string;
  name: string;
  lat: number;
  lng: number;
}

export interface JmaVolcanoCameraImage {
  imageUrl: string;
  /** "YYYYMMDDHHmmss" (JST) */
  timestamp: string;
}

/** ひまわり衛星画像の種類 */
export type SatelliteBand = "infrared" | "visible" | "truecolor" | "vapor";

export interface SatelliteBandDef {
  key: SatelliteBand;
  label: string;
  /** タイルURLに埋め込むバンド/プロダクト(例 "B13/TBB") */
  path: string;
}

/** 地図上に値を表示できる気象要素 */
export type WeatherMetric = "none" | "temp" | "precipitation1h" | "sun1h" | "humidity" | "wind";

export interface WeatherMetricDef {
  key: Exclude<WeatherMetric, "none">;
  label: string;
  unit: string;
  /** 表示時の小数点以下桁数 */
  digits: number;
}

/** 気象庁アメダスの1観測所 */
export interface AmedasStation {
  code: string;
  name: string;
  lat: number;
  lng: number;
  altitudeM: number;
  temp: number | null;
  humidity: number | null;
  /** 1時間降水量(mm) */
  precipitation1h: number | null;
  /** 1時間日照時間(h) */
  sun1h: number | null;
  /** 風速(m/s) */
  wind: number | null;
  /** 風向(16方位の1〜16、静穏は0) */
  windDirection: number | null;
}

export interface AmedasSnapshot {
  /** 観測時刻(ISO8601, JST) */
  observedAt: string;
  stations: AmedasStation[];
}

/** 立山(雄山)山頂ライブカメラ(JR9VQ) */
export interface Jr9vqCamera {
  id: string;
  name: string;
  /** 方角の説明 */
  direction: string;
  lat: number;
  lng: number;
  /** 上流ページのパス(画像URLの抽出元) */
  pagePath: string;
}

/**
 * 国交省 中部地方整備局の国道事務所ライブカメラ(高山国道事務所を除く)。
 *
 * 「岐阜国道事務所と多治見国道事務所の ライブカメラの位置を特定し 表示してください」への対応。
 * 岐阜国道事務所(国道21号・41号・156号・158号)と多治見砂防国道事務所(国道19号・21号)の
 * 2事務所を、`office`で区別しつつ同じ型・同じレイヤーで扱う(高山国道事務所は既に`TakayamaCamera`
 * として独立実装済みのため対象外)。地点一覧・画像URLは各事務所の公開ページ
 * (岐阜: https://www.cbr.mlit.go.jp/gifu/traffic/livecamera.html 、
 * 多治見: https://www.cbr.mlit.go.jp/tajimi/desk/douro_live.html )から取得し、
 * 緯度経度は国土地理院 地名検索APIで地点名を検索して求め、`public/kokudoCameras.json`として
 * 静的に持たせている(`TakayamaCamera`と同じ方式)。
 */
export interface KokudoCamera {
  id: string;
  name: string;
  /** 事務所名(例: 岐阜国道事務所) */
  office: string;
  /** その事務所のライブカメラ一覧ページ(出典リンク用) */
  officeUrl: string;
  /** 路線名(例: 国道21号) */
  route: string;
  lat: number;
  lng: number;
  /** 画像の絶対URL(HTTPS配信のため直接埋め込み可能) */
  imageUrl: string;
  /** 座標の精度に関する注記(地名検索による大字・町丁目単位の推定値である場合など) */
  note?: string;
}

/** 国交省 高山国道事務所の道路状況ライブカメラ(飛騨地域) */
export interface TakayamaCamera {
  id: string;
  name: string;
  /** 飛騨北部/飛騨中部/飛騨南部/その他のエリア */
  area: string;
  /** 撮影方向の説明(例: 名古屋側を望む) */
  direction: string;
  lat: number;
  lng: number;
  /** 画像の絶対URL(HTTPS配信のため直接埋め込み可能) */
  imageUrl: string;
  /** 座標の精度に関する注記(近傍地点からの推定値である場合など) */
  note?: string;
}

/**
 * 座標が判明していない長野県建設事務所(レガシーなavis.ne.jp系など)への簡易リンクマーカー。
 * 個々のカメラではなく、その事務所のカメラ一覧ページへのリンクを地図上の代表地点(事務所所在地)に置く。
 */
export interface NaganoOfficeLink {
  id: string;
  name: string;
  lat: number;
  lng: number;
  url: string;
}

/**
 * 「高原天気」気温・霧シミュレーター(岐阜県北部〜長野県中心のDEM地形補正モデル)の
 * 観測地点1件分。気象庁アメダス観測所のみ(風・信州大学METIMSは対象外。詳細はサーバー側の
 * `server/kougenTenkiGenerate.mjs` を参照)。
 */
export interface KougenTenkiStation {
  name: string;
  id: string;
  lat: number;
  lon: number;
  alt: number;
  temp: number;
  /** 欠測時はNaN */
  humidity: number;
}

/** 「高原天気」の1時刻分(気温・湿度・霧リスク)。`alt`はグリッド全体で共通のため含まない */
export interface KougenTenkiHourFrame {
  /** 表示用の時刻文字列("YYYY-MM-DDTHH:mm"、日本時間) */
  timeKey: string;
  /** "observed" = アメダス実測に基づく値、"forecast" = 未来の予測値 */
  kind: "observed" | "forecast";
  /**
   * `kind: "forecast"` のときのみ、その予測をどうやって作ったかを示す。
   * "open-meteo" = Open-Meteo(気温・湿度・降水量予報、約1000地点)から計算した値(既定)。
   * "trend" = Open-Meteoの取得に失敗した場合のみのフォールバックで、直近6時間の実測トレンドを
   * 単純に延長した値(気象庁の数値予報等は使っていない簡易な延長)。
   */
  forecastSource?: "open-meteo" | "trend";
  /** 気温×10(℃)。欠測は -9999 */
  temp10: number[];
  /** 湿度(%)。欠測は -1 */
  hum: number[];
  /**
   * 霧リスク(0/0.3/0.6/1.0の段階値。露点差ベースの判定、詳細はサーバー側 `calcFogRisk()` 参照)。
   * 判定は2段階: ①まず生の湿度(標高100m以下の低地補正・地形の吹き下ろし補正のみ反映)が
   * 97%(`FOG_RH_THRESHOLD`)未満なら常に0。②97%以上の場合のみ、以下の要因で判定用の湿度を
   * かさ上げして段階を上げる(生の湿度が97%未満のセルにゼロから霧を発生させることはない):
   * ・予測コマ("forecast")のみ、雨が止んでからの経過時間(`rainFogBoostForHoursSinceRain()`。
   *   雨上がり1時間後をピークに、以降1時間ごとに減衰する)、
   * ・全コマ共通、気温逓減率(gamma)が標準大気より安定側(逆転層寄り)かどうか
   *   (`GAMMA_FOG_BOOST_MAX`。大気が安定しているほど霧が発生・維持されやすいという傾向を反映)、
   * ・予測コマ("forecast")のみ、地形の傾斜(標高差300m/km以上)に風が正面から吹き付けて
   *   いるかどうか(`orographicFogAdjustment()`。地形性上昇流で+2%、逆に山から吹き下ろす
   *   風なら判定前の湿度そのものを-1%かさ下げする)。
   */
  fog: number[];
}

/**
 * 「高原天気」のグリッドデータ(標高を地図タイル座標系で格子状に持ち、気温・湿度・霧リスクは
 * `hours` に過去6時間(実測、1時間刻み)+未来6時間(予測、1時間刻み)の計12コマを
 * 古い→新しい順に並べて持つ)。
 * `alt`/各時刻の`temp10`/`hum`/`fog` はいずれも `gw × gh` の1次元配列(行優先)。
 * ピクセル座標 → グリッド座標への変換は `zoom`/`xMin`/`yMin`/`step` を使う
 * (詳細は `src/lib/kougenTenkiGrid.ts` を参照)。
 */
export interface KougenTenkiGrid {
  zoom: number;
  xMin: number;
  yMin: number;
  pixelW: number;
  pixelH: number;
  step: number;
  gw: number;
  gh: number;
  alt: number[];
  hours: KougenTenkiHourFrame[];
  /** 最新の実測時刻(`hours`のうち最後の `kind: "observed"` の要素)時点の観測地点一覧 */
  stations: KougenTenkiStation[];
  /** 生成に使った最新観測時刻("YYYY-MM-DDTHH:mm"、日本時間) */
  generatedAt: string;
  /**
   * Open-Meteo予報の取得に失敗し、実測トレンド延長(`forecastSource: "trend"`)に
   * フォールバックした場合のエラー内容(例: "Open-Meteoの取得に失敗しました (HTTP 429, batch 1)")。
   * 成功時はnull。
   */
  openMeteoError: string | null;
  /**
   * 犬山自動気象観測所(気温観測地点)の取得・パースに失敗した場合のエラー内容。成功時
   * (=最新の実測コマの`stations`に追加された場合)はnull。マーカーが他のアメダス観測所と
   * 見た目上区別できないため、成功/失敗をその場で確認できるようにするために追加した。
   */
  inuyamaAwsError: string | null;
  /** 「現在の気温」のみ: 道路情報提供システムの観測局のうち観測点として使えた件数 */
  roadStationCount?: number;
  /**
   * 「現在の気温」のみ: 800hPa/700hPaの高層データ(陸地のみ約100kmメッシュ)から
   * 湿度逓減率サンプルを作れた地点数。「800hpaと700hpaの湿度を追加で200キロメッシュ
   * ごとに取得して 湿度の逓減率も計算してください」「もう少し広い範囲で湿度の逓減率を
   * 計算してください」への対応(`server/kougenTenkiGenerate.mjs`の
   * `fetchUpperAirLapseSamples`参照)。
   */
  upperAirLapseSampleCount?: number;
}

/** 「高原天気」グリッドの1地点分の値(ホバー表示用) */
export interface KougenTenkiValue {
  altM: number;
  tempC: number;
  humidityPct: number;
  /** 霧リスク(0/0.3/0.6/1.0の段階値)。`fogRiskLabel()`(`src/lib/kougenTenkiGrid.ts`)で文言化する */
  fog: number;
}
