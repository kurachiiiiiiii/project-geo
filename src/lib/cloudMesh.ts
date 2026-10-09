import * as L from "leaflet";
import { buildSatelliteTileUrl } from "../features/satellite/satelliteService";
import type { SatelliteFrame } from "../features/satellite/satelliteService";

/**
 * 「衛星画像で雲のある部分を5キロメッシュで判定して、ある部分を白くして、半分くらいの
 * ところはグレー、ないところは透明にしてください」という指示への対応。
 *
 * 赤外線(B13/TBB)バンド(雲頂温度。冷たい=雲頂が高い/厚い雲ほど明るく写る)の生のタイル
 * 画像を直接サンプリングし、日本周辺を約3km間隔のグリッドに区切って、各セルの明るさ
 * (+周囲とのコントラスト。下の「グリッドで雲のコントラスト比が高い場合は」参照)を
 * 3段階(雲あり=白、半分くらい=グレー、雲なし=透明)に分類した画像オーバーレイを作る。
 * AI超解像(`satelliteAiUpscale.ts`)とは別の独立した機能で、GPU/TensorFlow.jsは使わない
 * (単純なcanvasのピクセル読み取りのみのため、生成ボタンや同時実行数の制限も不要)。
 *
 * 【範囲について】AI超解像と同じ日本周辺(緯度25〜46°・経度122〜150°)に揃えている。
 *
 * 【既知の不具合と修正1: メッシュの位置が北・東にずれていた(圧縮ズレ)】当初は緯度経度→
 * ピクセル座標の変換を自前で計算し(Web Mercatorの標準的な式で、Tokyo(z=5,x=28,y=12)を
 * 使った単体テストでは一致していた)、かつグリッドのマス目数を`Math.ceil`で切り上げて
 * 決めていた。後者は「1マスぶんの端数」だけグリッド全体の実サイズが指定範囲(緯度25〜46度・
 * 経度122〜150度)よりわずかに大きくなり、それを`<ImageOverlay>`で指定範囲ぴったりに
 * 引き伸ばして表示する際に、全体が均等に少し圧縮される(その結果、原点(北西端)から
 * 離れるほど、実際の位置より北西寄りに表示されてしまう)ズレの原因になっていた。
 * 「メッシュの位置が北と少し東にずれている」という指摘を受けて、(1)自前の座標変換を
 * やめてLeaflet自身の投影(`L.CRS.EPSG3857`。実際にタイルや他のオーバーレイを描画する際に
 * Leafletが内部で使っているのと同じもの)に置き換え、(2)マス目数を切り上げではなく
 * 四捨五入で決めたうえで、その個数で指定範囲をちょうど割り切るステップ幅を逆算する
 * (=グリッドの実サイズと`CLOUD_MESH_BOUNDS`が厳密に一致し、引き伸ばし時の圧縮ズレが
 * 起きない)ように修正した。
 *
 * 【既知の不具合と修正2: それでも「北に80kmほどずれている」問題(緯度の等分間隔が
 * 間違っていた、より本質的な原因)】修正1の後も「北に80キロほどずれている」という
 * 具体的な指摘が続いたため、実際に表示中の衛星タイルとメッシュ画像を画面上のピクセル単位で
 * 突き合わせて検証したところ、緯度35.3度付近で実測約76kmの系統的なズレを確認した。
 *
 * 原因: `<ImageOverlay>`は画像を`CLOUD_MESH_BOUNDS`の範囲にきっちり引き伸ばして表示するが、
 * この「引き伸ばし」はWeb Mercator投影上で線形(=画像の各行が、投影後のY座標で等間隔になる
 * ことを前提)に行われる。ところが以前の実装は、グリッドの各行(gy)に緯度を
 * `north - (gy+0.5)*緯度のステップ幅`という「緯度(度)で等間隔」の式で割り当てていた。
 * Web Mercator投影は赤道からの距離に応じて縦方向が引き伸ばされる非線形な投影のため、
 * 「緯度(度)で等間隔」と「投影後のY座標で等間隔」は一致しない。日本の対象範囲
 * (緯度25〜46度)ではこのズレが緯度方向に約76〜80km相当になり、これが報告のあった
 * 「北に80kmほどずれている」の正体だった(経度方向はWeb Mercatorでも線形なので、
 * こちらの計算は元々問題なかった)。
 *
 * 検証: 実際に表示されていたメッシュ画像の特定の1セルが、緯度で等間隔に割り当てた式では
 * 緯度34.633度を指していたが、そのセルが画面上で実際に表示されていた位置の真の緯度は
 * (Leaflet自身の`containerPointToLatLng`で確認したところ)35.317度だった(約76km differs)。
 * `crs.project()`(Web Mercator投影後の座標、ズームに依存しない)で線形補間してから
 * `crs.unproject()`で緯度に戻す方式に直したところ、同じセルの緯度が35.324度となり、
 * 真の値との差はわずか0.8km(グリッドの量子化誤差の範囲内)まで縮まることを確認した。
 *
 * 修正: 緯度方向のグリッド行の割り当てを、`crs.project()`/`crs.unproject()`を使って
 * Web Mercator投影後のY座標で等間隔になるように直した(下の`computeCloudMeshGrid`
 * 内の`northProjY`/`southProjY`まわりを参照)。経度方向は元々線形なので変更していない。
 */

export const CLOUD_MESH_BOUNDS = L.latLngBounds([25, 122], [46, 150]);

// 「メッシュも4キロにしてください」という指示により5→4に、続けて「メッシュは3キロ
// めっしゅにしてください」という指示により4→3に変更。
const CELL_KM = 3;
const KM_PER_DEG_LAT = 110.574; // server/kougenTenkiGenerate.mjsと同じ値
const KM_PER_DEG_LON_AT_EQUATOR = 111.32;

const TILE_Z = 5; // ひまわりタイルの最大配信ズーム
const TILE_SIZE = 256;
const TILE_LOAD_TIMEOUT_MS = 15_000; // satelliteEnhanceTileLayer.tsと同じ考え方

// セルの分類値
export const CLOUD_NONE = 0; // 雲なし → 透明
export const CLOUD_PARTIAL = 1; // 半分くらい → グレー
export const CLOUD_FULL = 2; // 雲あり → 白

/**
 * 分類のしきい値(生のB13/TBBピクセル値、0〜255)。実機のひまわり赤外タイルの
 * ヒストグラムを確認したところ、晴天(雲なし)部分の値は概ね20〜60に集中しており、
 * そこから雲になるほど連続的に明るくなる分布(晴天と雲の間に明確な谷間があるわけでは
 * ない)だったため、唯一の正解があるわけではなく実際の画像と見比べながら選んでいる。
 *
 * 変遷: 当初GRAY_THRESHOLD=90・WHITE_THRESHOLD=160。「グレーが広すぎるので白を
 * 増やして」でWHITE_THRESHOLDを160→130に(グレーの範囲90〜160→90〜130)。さらに
 * 「グレーの感度を上げて、白の範囲をもう少しひろげてください」という指摘を受け、
 * GRAY_THRESHOLDを90→65に下げ(=透明だった60〜90あたりもグレー側で拾うようにし、
 * 「感度を上げる」に対応)、WHITE_THRESHOLDを130→110に下げた(グレーの範囲を
 * 65〜130→65〜110に狭め、白側をさらに広げた)。さらに「もう少し白のグリッドを増やして
 * グレーの感知範囲を増やしてください」という指摘を受け、GRAY_THRESHOLDを65→50、
 * WHITE_THRESHOLDを110→90に、それぞれさらに下げた。さらに「グレーの感知範囲を
 * ひろくしてください」という指摘を受け、GRAY_THRESHOLDを50→35にさらに下げた。その後
 * 「グレーの範囲を42にしてください」という具体的な指定を受け、GRAY_THRESHOLDを35→42に
 * 変更した。
 */
const GRAY_THRESHOLD = 42;
const WHITE_THRESHOLD = 90;

/**
 * 「グリッドで雲のコントラスト比が高い場合は、色が薄くても白色にしてください」への対応。
 * それまでは絶対的な明るさ(生のピクセル値)だけで判定していたが、これだと「背景よりは
 * 明るいが、WHITE_THRESHOLDほどは明るくない、輪郭のはっきりした薄い雲」が白にならず
 * グレー止まりになっていた。サンプル点の周囲`CONTRAST_WINDOW_RADIUS`ピクセル四方の
 * 最大値−最小値(ローカルコントラスト)を求め、これが`CONTRAST_THRESHOLD`以上なら
 * (=近くに明確な濃淡差=雲の輪郭がある、とみなせるなら)、絶対的な明るさが
 * WHITE_THRESHOLD未満でも白として扱う。海面など変化に乏しい場所はローカルコントラストが
 * 低いままなので、この判定だけで誤って白になることはない。
 *
 * 「ローカルコントラストの検知範囲をちいさくしてください」という指摘を受け、
 * CONTRAST_WINDOW_RADIUSを2(5×5、約20km四方)→1(3×3、約12km四方)に縮小した。
 */
const CONTRAST_WINDOW_RADIUS = 1; // 周囲何ピクセル四方を見るか(3×3)。ネイティブ解像度で約12km四方
const CONTRAST_THRESHOLD = 60;

export interface CloudMeshGrid {
  gw: number;
  gh: number;
  /** 値は CLOUD_NONE / CLOUD_PARTIAL / CLOUD_FULL。北西→南東、行優先(gy*gw+gx) */
  cells: Uint8Array;
}

function loadTileCanvas(url: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous"; // ひまわりのタイル配信はAccess-Control-Allow-Origin: *(実測で確認済み)
    const timer = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      reject(new Error(`タイル画像の取得が${TILE_LOAD_TIMEOUT_MS / 1000}秒以内に終わりませんでした(タイムアウト)`));
    }, TILE_LOAD_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      const canvas = document.createElement("canvas");
      canvas.width = TILE_SIZE;
      canvas.height = TILE_SIZE;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("2D contextを取得できませんでした"));
        return;
      }
      ctx.drawImage(img, 0, 0);
      resolve(canvas);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("ひまわりタイルの取得に失敗しました"));
    };
    img.src = url;
  });
}

/**
 * 「衛星画像の予測の際も メッシュでできるようにしてください」への対応で、予測コマ
 * (`lib/satelliteForecast.ts`)からも同じ判定基準を使えるようexportしている
 * (しきい値の重複管理を避けるため、値そのものではなく判定関数を公開する)。
 */
export function classify(value: number, localContrast: number): number {
  if (value >= WHITE_THRESHOLD) return CLOUD_FULL;
  if (localContrast >= CONTRAST_THRESHOLD) return CLOUD_FULL; // 色が薄くてもコントラストが高ければ白
  if (value >= GRAY_THRESHOLD) return CLOUD_PARTIAL;
  return CLOUD_NONE;
}

/**
 * サンプル点(width×height の`data`内のlocalX,localY)周辺、`CONTRAST_WINDOW_RADIUS`
 * ピクセル四方の最大値-最小値。`width`/`height`は既定でタイル1枚分(`TILE_SIZE`)だが、
 * 予測コマ(`lib/satelliteForecast.ts`)はタイルを繋ぎ合わせた1枚の大きいモザイク画像に
 * 対してそのまま呼ぶため、実際の画像サイズを引数で渡せるようにしている。
 */
export function localContrastAround(
  data: ImageData,
  localX: number,
  localY: number,
  width: number = TILE_SIZE,
  height: number = TILE_SIZE,
): number {
  let min = 255;
  let max = 0;
  for (let dy = -CONTRAST_WINDOW_RADIUS; dy <= CONTRAST_WINDOW_RADIUS; dy++) {
    const yy = localY + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -CONTRAST_WINDOW_RADIUS; dx <= CONTRAST_WINDOW_RADIUS; dx++) {
      const xx = localX + dx;
      if (xx < 0 || xx >= width) continue;
      const v = data.data[(yy * width + xx) * 4];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }
  return max - min;
}

/**
 * `frame`の赤外線バンドから、日本周辺(`CLOUD_MESH_BOUNDS`)の約4kmメッシュの雲判定グリッドを
 * 作る。対象範囲をカバーするz=5タイル(通常十数枚程度)をすべて並行取得してからサンプリング
 * する(AI超解像と違いGPU/重いモデルを使わないため、`satelliteAiUpscale.ts`のような
 * 同時実行数の制限は不要)。一部のタイルが取得できなかった場合も、そのタイルが担当する
 * セルは「雲なし」扱いにして続行する(致命的にはしない)。
 */
export async function computeCloudMeshGrid(frame: SatelliteFrame): Promise<CloudMeshGrid> {
  const south = CLOUD_MESH_BOUNDS.getSouth();
  const north = CLOUD_MESH_BOUNDS.getNorth();
  const west = CLOUD_MESH_BOUNDS.getWest();
  const east = CLOUD_MESH_BOUNDS.getEast();

  // マス目数は目標のCELL_KMに最も近くなるよう四捨五入で決める(実際のkm/セルは緯度に
  // よって多少ばらつくが、個数を決めるための目安としては十分)。
  const centerLat = (south + north) / 2;
  const latStepDegTarget = CELL_KM / KM_PER_DEG_LAT;
  const lonStepDegTarget = CELL_KM / (KM_PER_DEG_LON_AT_EQUATOR * Math.cos((centerLat * Math.PI) / 180));
  const gw = Math.max(1, Math.round((east - west) / lonStepDegTarget));
  const gh = Math.max(1, Math.round((north - south) / latStepDegTarget));
  // 経度方向のステップ幅は、その個数で範囲をちょうど割り切る値を逆算する(引き伸ばし表示時の
  // 圧縮ズレを防ぐため。経度はWeb Mercatorでも線形なので度のまま扱ってよい)。
  const lonStepDeg = (east - west) / gw;

  // タイル取得範囲・各セルのサンプリング位置とも、Leaflet自身の投影(実際にタイルや
  // 他のオーバーレイを描画する際にLeafletが内部で使っているのと同じ)を使う。
  const crs = L.CRS.EPSG3857;

  // 緯度方向は上のコメント(既知の不具合と修正2)のとおり、度ではなくWeb Mercator投影後の
  // Y座標(ズームに依存しない`crs.project()`)で等間隔になるようにする。
  const northProjY = crs.project(L.latLng(north, 0)).y;
  const southProjY = crs.project(L.latLng(south, 0)).y;

  const nw = crs.latLngToPoint(L.latLng(north, west), TILE_Z);
  const se = crs.latLngToPoint(L.latLng(south, east), TILE_Z);
  const txMin = Math.floor(nw.x / TILE_SIZE);
  const txMax = Math.floor((se.x - 1) / TILE_SIZE);
  const tyMin = Math.floor(nw.y / TILE_SIZE);
  const tyMax = Math.floor((se.y - 1) / TILE_SIZE);

  const template = buildSatelliteTileUrl(frame, "infrared");
  const tileData = new Map<string, ImageData>();
  const loads: Promise<void>[] = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const url = template.replace("{z}", String(TILE_Z)).replace("{x}", String(tx)).replace("{y}", String(ty));
      loads.push(
        loadTileCanvas(url)
          .then((canvas) => {
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            tileData.set(`${tx},${ty}`, ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE));
          })
          .catch(() => {
            // このタイルは「雲なし」扱いで続行する(下のサンプリング側でMapに無ければ0のまま)
          }),
      );
    }
  }
  await Promise.all(loads);

  if (tileData.size === 0) {
    throw new Error("ひまわりタイルを1枚も取得できませんでした");
  }

  const cells = new Uint8Array(gw * gh);

  for (let gy = 0; gy < gh; gy++) {
    // 緯度は度で等間隔ではなく、Web Mercator投影後のY座標で等間隔になるように求める
    // (このファイル冒頭のコメント「既知の不具合と修正2」参照)。
    const projY = northProjY + ((gy + 0.5) / gh) * (southProjY - northProjY);
    const lat = crs.unproject(L.point(0, projY)).lat;
    for (let gx = 0; gx < gw; gx++) {
      const lon = west + (gx + 0.5) * lonStepDeg;
      const p = crs.latLngToPoint(L.latLng(lat, lon), TILE_Z);
      const tx = Math.floor(p.x / TILE_SIZE);
      const ty = Math.floor(p.y / TILE_SIZE);
      const data = tileData.get(`${tx},${ty}`);
      if (!data) continue; // Uint8Arrayの既定値0(CLOUD_NONE)のまま
      const localX = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(p.x - tx * TILE_SIZE)));
      const localY = Math.min(TILE_SIZE - 1, Math.max(0, Math.floor(p.y - ty * TILE_SIZE)));
      const value = data.data[(localY * TILE_SIZE + localX) * 4];
      const localContrast = localContrastAround(data, localX, localY);
      cells[gy * gw + gx] = classify(value, localContrast);
    }
  }

  return { gw, gh, cells };
}

/** 白/グレー/透明の3色 */
const COLOR_FULL: [number, number, number, number] = [255, 255, 255, 235];
const COLOR_PARTIAL: [number, number, number, number] = [170, 170, 170, 190];
const COLOR_NONE: [number, number, number, number] = [0, 0, 0, 0];

/**
 * グリッドをcanvasに描き、data URLとして返す(`<ImageOverlay>`にそのまま渡せる)。
 * セル1つ=1ピクセルの小さいcanvasのまま返す(表示側で`image-rendering: pixelated`を
 * 使い、メッシュのマス目がにじまずくっきり見えるようにする。App.cssの
 * `.cloud-mesh-overlay`参照)。
 */
export function renderCloudMeshDataUrl(grid: CloudMeshGrid): string | null {
  const canvas = document.createElement("canvas");
  canvas.width = grid.gw;
  canvas.height = grid.gh;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;

  const imageData = ctx.createImageData(grid.gw, grid.gh);
  const data = imageData.data;
  for (let i = 0; i < grid.cells.length; i++) {
    const color = grid.cells[i] === CLOUD_FULL ? COLOR_FULL : grid.cells[i] === CLOUD_PARTIAL ? COLOR_PARTIAL : COLOR_NONE;
    const o = i * 4;
    data[o] = color[0];
    data[o + 1] = color[1];
    data[o + 2] = color[2];
    data[o + 3] = color[3];
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL();
}
