export interface KougenTenkiHourFrameRaw {
  timeKey: string;
  kind: "observed" | "forecast";
  forecastSource?: "open-meteo" | "trend";
  temp10: number[];
  hum: number[];
  fog: number[];
}
export interface KougenTenkiStationRaw {
  name: string;
  id: string;
  lat: number;
  lon: number;
  alt: number;
  temp: number;
  humidity: number;
}
export interface KougenTenkiGenerateResult {
  zoom: number;
  xMin: number;
  yMin: number;
  pixelW: number;
  pixelH: number;
  step: number;
  gw: number;
  gh: number;
  alt: number[];
  hours: KougenTenkiHourFrameRaw[];
  stations: KougenTenkiStationRaw[];
  generatedAt: string;
  /** Open-Meteo予報の取得に失敗し、実測トレンド延長にフォールバックした場合のエラー内容。成功時はnull */
  openMeteoError: string | null;
  /** 犬山自動気象観測所の取得・パースに失敗した場合のエラー内容。成功時(=stationsに追加された場合)はnull */
  inuyamaAwsError: string | null;
}
export declare function generateKougenTenki(): Promise<KougenTenkiGenerateResult>;

/** 「現在の気温」のみを計算する軽量版の結果。hoursは常に要素数1(openMeteoErrorは常にnull) */
export interface CurrentTemperatureGenerateResult extends KougenTenkiGenerateResult {
  roadStationCount: number;
  /** 800hPa/700hPaの高層データ(陸地のみ約200kmメッシュ)から湿度逓減率サンプルを作れた地点数 */
  upperAirLapseSampleCount: number;
}
export declare function generateCurrentTemperature(): Promise<CurrentTemperatureGenerateResult>;
