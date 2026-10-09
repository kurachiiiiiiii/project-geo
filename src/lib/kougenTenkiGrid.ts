import type { KougenTenkiGrid, KougenTenkiValue } from "../types";

/**
 * `hours` のうち「現在」に相当するコマ(=最後の実測 `kind: "observed"`)のindexを返す。
 * `hours` は過去(実測)→未来(予測)の順に並んでいるため、実測が終わって予測が始まる
 * 境目を探すのと同じ。見つからない場合は0。
 */
export function kougenTenkiNowIndex(grid: KougenTenkiGrid): number {
  let lastObserved = 0;
  for (let i = 0; i < grid.hours.length; i++) {
    if (grid.hours[i].kind === "observed") lastObserved = i;
  }
  return lastObserved;
}

function lonToTileX(lon: number, z: number): number {
  return ((lon + 180.0) / 360.0) * Math.pow(2, z);
}

function latToTileY(lat: number, z: number): number {
  const rad = (lat * Math.PI) / 180.0;
  return ((1.0 - Math.log(Math.tan(rad) + 1.0 / Math.cos(rad)) / Math.PI) / 2.0) * Math.pow(2, z);
}

/**
 * 緯度経度からグリッド値を引く(元の `map.html` の `getGridValue()` と同じロジックに、
 * 時刻ごとのフレーム選択を加えたもの)。範囲外・データ未着手・欠測セルは `null`。
 */
export function lookupKougenTenkiValue(
  grid: KougenTenkiGrid,
  hourIndex: number,
  lat: number,
  lon: number,
): KougenTenkiValue | null {
  const frame = grid.hours[hourIndex];
  if (!frame) return null;

  const px = (lonToTileX(lon, grid.zoom) - grid.xMin) * 256.0;
  const py = (latToTileY(lat, grid.zoom) - grid.yMin) * 256.0;

  if (px < 0 || py < 0 || px >= grid.pixelW || py >= grid.pixelH) return null;

  const gx = Math.round(px / grid.step);
  const gy = Math.round(py / grid.step);

  if (gx < 0 || gy < 0 || gx >= grid.gw || gy >= grid.gh) return null;

  const idx = gy * grid.gw + gx;
  const altM = grid.alt[idx];
  const temp10 = frame.temp10[idx];
  if (altM === undefined || temp10 === undefined || temp10 <= -9999) return null;

  return {
    altM,
    tempC: temp10 / 10.0,
    humidityPct: frame.hum[idx],
    fog: frame.fog[idx],
  };
}

/** 気温(℃)→ RGBA(元Java実装 `getTempColor()` の移植。寒色〜白〜暖色) */
function tempColorRgba(tempC: number | null): [number, number, number, number] {
  if (tempC === null) return [0, 0, 0, 0];
  let r: number;
  let g: number;
  let b: number;
  if (tempC < 0) {
    const v = Math.max(0, Math.min(255, Math.round(255 + tempC * 25)));
    r = v;
    g = v;
    b = 255;
  } else if (tempC < 15) {
    const v = Math.round((tempC / 15.0) * 255);
    r = 255 - v;
    g = 255;
    b = 255 - v;
  } else {
    const v = Math.max(0, Math.min(255, Math.round(((tempC - 15) / 15.0) * 255)));
    r = 255;
    g = 255 - v;
    b = 0;
  }
  return [r, g, b, 150];
}

/**
 * 霧リスク(0〜1の連続値)→ RGBA(元Java実装 `getFogColor()` の灰色半透明をベースに調整)。
 * 「霧の不透明度をもう少し高めてほしい」「霧リスクが見にくいので見やすくしてほしい」という
 * 要望を受けて2段階で調整した: ①最大アルファを180→225に、②リスクが0より大きいセルは
 * 最低でもアルファ70を確保する下駄を履かせ、低リスク(0.3)でも背景の地図に埋もれて
 * 見えなくならないようにした(0.3→約122/255・0.6→約175/255・1.0→245/255)。
 */
function fogColorRgba(fog: number): [number, number, number, number] {
  const risk = Math.max(0, Math.min(1, fog));
  if (risk === 0) return [235, 235, 235, 0];
  const alpha = Math.min(255, Math.round(70 + risk * 175));
  return [235, 235, 235, alpha];
}

/**
 * 霧リスク(0〜1の連続値。サーバー側 `calcFogRisk()` 参照)を表示用の短い文言にする。
 * 以前は「湿度が四捨五入で100%かどうか」の0/1判定だったが、露点差ベースの段階判定
 * (0/0.3/0.6/1.0)に変わったため、二値ではなく高・中・低で表示する。
 */
export function fogRiskLabel(risk: number): string {
  if (risk >= 1) return "霧発生リスク: 高";
  if (risk >= 0.6) return "霧発生リスク: 中";
  if (risk > 0) return "霧発生リスク: 低";
  return "霧リスクなし";
}

/** 気温の強調線(等温線)を何℃おきに引くか */
const ISOTHERM_STEP_C = 5;
/** 最終的な画像を元グリッド解像度の何倍で書き出すか(強調線を細く・くっきり見せるため) */
const UPSCALE_FACTOR = 3;

/**
 * 気温分布に5℃おきの強調線(等温線)を描く。
 * グリッドの各セルについて右隣・下隣のセルと比べ、5℃刻みの区分(bin)をまたいでいたら、
 * その境界線(セルとセルの間)に沿って線分を引く、という簡易な等温線の引き方
 * (マーチングスクエア法のような滑らかな等値線ではなく、グリッドの格子に沿った階段状の線になるが、
 * 「◯℃ごとに強調線が欲しい」という目的には十分で、実装もシンプルになる)。
 * 元のグリッド解像度(256×240)のまま1px単位の線を描くと、地図に貼るときに大きく引き伸ばされて
 * ぼやけてしまうため、`scale`(=`UPSCALE_FACTOR`)倍した座標系に線を描く。
 */
function drawIsothermLines(
  ctx: CanvasRenderingContext2D,
  grid: KougenTenkiGrid,
  frame: KougenTenkiGrid["hours"][number],
  scale: number,
): void {
  const stepTemp10 = ISOTHERM_STEP_C * 10;
  const binOf = (t10: number | undefined): number | null =>
    t10 === undefined || t10 <= -9999 ? null : Math.floor(t10 / stepTemp10);

  ctx.save();
  ctx.strokeStyle = "rgba(35, 35, 35, 0.75)";
  ctx.lineWidth = Math.max(0.6, scale * 0.18);
  ctx.lineCap = "round";
  ctx.beginPath();

  for (let gy = 0; gy < grid.gh; gy++) {
    for (let gx = 0; gx < grid.gw; gx++) {
      const idx = gy * grid.gw + gx;
      const b = binOf(frame.temp10[idx]);
      if (b === null) continue;

      // 右隣との境界に縦線
      if (gx + 1 < grid.gw && binOf(frame.temp10[idx + 1]) !== null && binOf(frame.temp10[idx + 1]) !== b) {
        const x = (gx + 1) * scale;
        ctx.moveTo(x, gy * scale);
        ctx.lineTo(x, (gy + 1) * scale);
      }
      // 下隣との境界に横線
      if (gy + 1 < grid.gh && binOf(frame.temp10[idx + grid.gw]) !== null && binOf(frame.temp10[idx + grid.gw]) !== b) {
        const y = (gy + 1) * scale;
        ctx.moveTo(gx * scale, y);
        ctx.lineTo((gx + 1) * scale, y);
      }
    }
  }

  ctx.stroke();
  ctx.restore();
}

/**
 * 選択中の時刻の気温分布/霧リスクをcanvasに描き、data URLとして返す
 * (元のJavaツールはこれをサーバー側でPNGとして事前生成していたが、ライブ生成に切り替えたため
 * クライアント側でその都度描く。データ自体はグリッド解像度(`gw × gh`)のみで軽量)。
 */
export function renderKougenTenkiDataUrl(grid: KougenTenkiGrid, hourIndex: number, mode: "temp" | "fog"): string | null {
  const frame = grid.hours[hourIndex];
  if (!frame) return null;

  // まずグリッド解像度そのままの小さいcanvasに色だけ塗る。
  const baseCanvas = document.createElement("canvas");
  baseCanvas.width = grid.gw;
  baseCanvas.height = grid.gh;
  const baseCtx = baseCanvas.getContext("2d");
  if (!baseCtx) return null;

  const imageData = baseCtx.createImageData(grid.gw, grid.gh);
  const data = imageData.data;

  for (let i = 0; i < grid.gw * grid.gh; i++) {
    let rgba: [number, number, number, number];
    if (mode === "temp") {
      const t10 = frame.temp10[i];
      rgba = tempColorRgba(t10 <= -9999 ? null : t10 / 10.0);
    } else {
      rgba = fogColorRgba(frame.fog[i]);
    }
    const o = i * 4;
    data[o] = rgba[0];
    data[o + 1] = rgba[1];
    data[o + 2] = rgba[2];
    data[o + 3] = rgba[3];
  }
  baseCtx.putImageData(imageData, 0, 0);

  // 最終的な画像は `UPSCALE_FACTOR` 倍のcanvasに、上の小さいcanvasをブラウザの標準的な
  // 補間(bilinear)で拡大描画してから、その上に等温線(強調線)をベクター線として描く。
  // 強調線を小さいcanvas側でピクセル単位に塗ってから同じように拡大すると、拡大時のぼかしで
  // 線がにじんで見えにくくなるため、線だけは拡大後の高解像度側で改めて描き直している。
  const finalCanvas = document.createElement("canvas");
  finalCanvas.width = grid.gw * UPSCALE_FACTOR;
  finalCanvas.height = grid.gh * UPSCALE_FACTOR;
  const finalCtx = finalCanvas.getContext("2d");
  if (!finalCtx) return baseCanvas.toDataURL();

  finalCtx.imageSmoothingEnabled = true;
  finalCtx.drawImage(baseCanvas, 0, 0, finalCanvas.width, finalCanvas.height);

  if (mode === "temp") {
    drawIsothermLines(finalCtx, grid, frame, UPSCALE_FACTOR);
  }

  return finalCanvas.toDataURL();
}

/** グリッドが覆う範囲(Leaflet ImageOverlay の bounds として使う) */
export function kougenTenkiBounds(grid: KougenTenkiGrid): [[number, number], [number, number]] {
  const n = Math.pow(2, grid.zoom);
  const tileXtoLon = (x: number) => (x / n) * 360.0 - 180.0;
  const tileYtoLat = (y: number) => {
    const rad = Math.PI - (2.0 * Math.PI * y) / n;
    return (Math.atan(0.5 * (Math.exp(rad) - Math.exp(-rad))) * 180.0) / Math.PI;
  };

  const west = tileXtoLon(grid.xMin);
  const east = tileXtoLon(grid.xMin + grid.pixelW / 256.0);
  const north = tileYtoLat(grid.yMin);
  const south = tileYtoLat(grid.yMin + grid.pixelH / 256.0);

  return [
    [north, west],
    [south, east],
  ];
}
