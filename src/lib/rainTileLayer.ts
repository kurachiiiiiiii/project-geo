import * as L from "leaflet";

/**
 * 気象庁 高解像度降水ナウキャストのタイルは、ズームレベル **4・6・8・10** でしか配信されていない
 * (実際にタイルを取得して確認: これら以外のズーム(3,5,7,9,11以上など)は同一バイト列の
 * 空のプレースホルダー画像が返り、周辺タイルを含め本物の降水データが一切含まれていなかった)。
 *
 * 通常の TileLayer の `minNativeZoom`/`maxNativeZoom` オプションは連続した範囲の
 * 両端しかクランプできず、範囲内の「歯抜け」のズーム(5, 7, 9)には対応できない。
 * そのため、Leaflet が内部でタイル取得・拡大縮小表示に使うズームを決めている
 * `_clampZoom` を上書きし、どのズームでも「最も近い配信ズーム」に丸めてから
 * 取得・拡大縮小表示させることで、全ズームレベルで表示できるようにしている。
 */
const RAIN_NATIVE_ZOOMS = [4, 6, 8, 10];

function nearestNativeZoom(zoom: number): number {
  return RAIN_NATIVE_ZOOMS.reduce((best, z) =>
    Math.abs(zoom - z) < Math.abs(zoom - best) ? z : best,
  );
}

export const RainTileLayer = L.TileLayer.extend({
  _clampZoom(zoom: number): number {
    return nearestNativeZoom(zoom);
  },
}) as unknown as typeof L.TileLayer;
