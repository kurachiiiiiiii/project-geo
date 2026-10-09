import { fetchExt } from "../../lib/extProxy";

/**
 * 「天文情報を表示する際 座標ではなく おおまかな住所を表示してください」への対応。
 * 国土地理院の逆ジオコーディングAPIで、クリックした地点の緯度経度から
 * 市区町村コード(muniCd)+大字名(lv01Nm)を求める。
 * https://mreversegeocoder.gsi.go.jp/reverse-geocoder/LonLatToAddress?lat=..&lon=..
 * CORS未対応のため、他の外部データと同じくプロキシ(`fetchExt`)経由で取得する。
 *
 * このAPIは市区町村コードしか返さないため、`public/muniNames.json`
 * (国土地理院が配布する市区町村コード表 https://maps.gsi.go.jp/js/muni.js を、
 * 一度だけ「コード→都道府県名+市区町村名」の文字列に変換して静的に持たせたもの)
 * と突き合わせて読める住所にする。
 *
 * 山頂・海上など、行政区画の大字レベルの情報が無い地点では空の結果(muniCdなし)が
 * 返ることがある。その場合はnullを返し、呼び出し側で座標表示にフォールバックする
 * (信州大学・犬山自動気象観測所などの補助的データ取得と同じ、失敗しても例外を投げない考え方)。
 *
 * 同じような地点への再問い合わせを避けるため、結果をメモリ上にキャッシュする
 * (小数点以下4桁=おおよそ11m単位で丸める。ズームインしたまま近くを何度もクリックしても
 * 再取得しない)。
 */

interface ReverseGeocodeResult {
  muniCd?: string;
  lv01Nm?: string;
}

let muniNamesPromise: Promise<Record<string, string>> | null = null;
function loadMuniNames(): Promise<Record<string, string>> {
  if (!muniNamesPromise) {
    muniNamesPromise = fetch(`${import.meta.env.BASE_URL}muniNames.json`).then((res) => {
      if (!res.ok) throw new Error(`市区町村名一覧の読み込みに失敗しました (HTTP ${res.status})`);
      return res.json() as Promise<Record<string, string>>;
    });
  }
  return muniNamesPromise;
}

const cache = new Map<string, string | null>();

/** おおよその住所を返す(取得できない・失敗した場合はnull) */
export async function reverseGeocodeRough(lat: number, lon: number): Promise<string | null> {
  const latStr = lat.toFixed(4);
  const lonStr = lon.toFixed(4);
  const key = `${latStr},${lonStr}`;
  if (cache.has(key)) return cache.get(key) ?? null;

  try {
    const [text, muniNames] = await Promise.all([
      fetchExt("gsiReverseGeocode", `/reverse-geocoder/LonLatToAddress?lat=${latStr}&lon=${lonStr}`),
      loadMuniNames(),
    ]);
    const data = JSON.parse(text) as { results?: ReverseGeocodeResult };
    const muniCd = data.results?.muniCd;
    const muniName = muniCd ? muniNames[muniCd] : undefined;
    if (!muniName) {
      cache.set(key, null);
      return null;
    }
    const lv01 = data.results?.lv01Nm;
    const address = lv01 ? `${muniName} ${lv01}` : muniName;
    cache.set(key, address);
    return address;
  } catch {
    cache.set(key, null);
    return null;
  }
}
