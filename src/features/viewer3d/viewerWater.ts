import type { GeoData } from "./viewerGeo";

/**
 * 3Dビューワー: 川・池の「水の地図」を作る。地形の上に貼る画像(マスク)で、
 *   R = 水(0〜255)、G = 水のまわりの岸(灰色のコンクリート風。水の縁から5m)、B = 建物の足もと(木を立てない所の判定に使う)
 * を、ベクトルタイルの形をcanvasで塗って作る。細かい所(足もと)用の「近く」と、遠くまでの「広く」の2枚を使う。
 */

/** 水の縁から、灰色の岸にする幅(m)。「周辺5mはグレーのテクスチャで」 */
export const BANK_WIDTH_M = 5;
/** 河川中心線(幅の狭い川)の水の幅(m) */
export const RIVER_WIDTH_M = 4;

export interface WaterMask {
  /** RGBA(size×size×4)。上が北(Zの小さい側) */
  data: Uint8Array;
  size: number;
  /** 範囲(x0, z0, sx, sz。m)。地形の他のテクスチャと同じ向き(X東・Z南) */
  rect: [number, number, number, number];
}

export interface MaskOptions {
  /** 建物の足もとをB(青)に塗るか */
  buildings: boolean;
  /** 水のまわりの灰色の岸(G)を塗るか。省くと(既定は塗る)。遠くまでの水の地図では、1ピクセルが数十mになるので岸は塗らない */
  banks?: boolean;
}

/** 原点の周り ±halfM(m)を size×size のマスクにする */
export function rasterizeMask(geo: GeoData, halfM: number, size: number, opts: MaskOptions): WaterMask {
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("canvasを使えません");
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  const k = size / (2 * halfM); // 1mが何ピクセルか
  const px = (X: number) => (X + halfM) * k;
  const py = (Z: number) => (Z + halfM) * k;
  const inRange = (a: Float32Array): boolean => {
    // 範囲外のものは塗らない(速くするため。少し余白をみる)
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < a.length; i += 2) {
      if (a[i] < minX) minX = a[i];
      if (a[i] > maxX) maxX = a[i];
      if (a[i + 1] < minZ) minZ = a[i + 1];
      if (a[i + 1] > maxZ) maxZ = a[i + 1];
    }
    const m = BANK_WIDTH_M + 2;
    return maxX >= -halfM - m && minX <= halfM + m && maxZ >= -halfM - m && minZ <= halfM + m;
  };
  const tracePath = (a: Float32Array, close: boolean) => {
    ctx.moveTo(px(a[0]), py(a[1]));
    for (let i = 2; i < a.length; i += 2) ctx.lineTo(px(a[i]), py(a[i + 1]));
    if (close) ctx.closePath();
  };

  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  // 1) 岸(灰色の帯)。池・川(内水面)の縁から両側に`BANK_WIDTH_M`ずつ。水の中は後で水で塗りつぶす。
  //    細すぎて消えないよう、最低でも約2ピクセルの幅にする
  const bankPx = Math.max(2 * BANK_WIDTH_M * k, 2);
  const banks = opts.banks !== false;
  ctx.strokeStyle = "rgb(0,255,0)";
  ctx.lineWidth = bankPx;
  for (const w of banks ? geo.waters : []) {
    if (w.sea) continue;
    ctx.beginPath();
    let any = false;
    for (const ring of w.rings) {
      if (!inRange(ring)) continue;
      tracePath(ring, true);
      any = true;
    }
    if (any) ctx.stroke();
  }
  ctx.lineWidth = Math.max((RIVER_WIDTH_M + 2 * BANK_WIDTH_M) * k, 2);
  for (const r of banks ? geo.rivers : []) {
    if (!inRange(r)) continue;
    ctx.beginPath();
    tracePath(r, false);
    ctx.stroke();
  }

  // 2) 水
  ctx.fillStyle = "rgb(255,0,0)";
  ctx.strokeStyle = "rgb(255,0,0)";
  for (const w of geo.waters) {
    ctx.beginPath();
    let any = false;
    for (const ring of w.rings) {
      if (!inRange(ring)) continue;
      tracePath(ring, true);
      any = true;
    }
    if (any) ctx.fill("evenodd");
  }
  ctx.lineWidth = Math.max(RIVER_WIDTH_M * k, 1.2);
  for (const r of geo.rivers) {
    if (!inRange(r)) continue;
    ctx.beginPath();
    tracePath(r, false);
    ctx.stroke();
  }

  // 3) 建物の足もと
  if (opts.buildings) {
    ctx.fillStyle = "rgb(0,0,255)";
    for (const b of geo.buildings) {
      if (!inRange(b.ring)) continue;
      ctx.beginPath();
      tracePath(b.ring, true);
      ctx.fill();
    }
  }

  const img = ctx.getImageData(0, 0, size, size);
  return {
    data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength),
    size,
    rect: [-halfM, -halfM, 2 * halfM, 2 * halfM],
  };
}

/** マスクの、位置(X東・Z南、m)での値(0〜1)。範囲外は null */
export function maskAt(m: WaterMask, X: number, Z: number): { water: number; bank: number; building: number } | null {
  const u = (X - m.rect[0]) / m.rect[2];
  const v = (Z - m.rect[1]) / m.rect[3];
  if (u < 0 || v < 0 || u >= 1 || v >= 1) return null;
  const x = Math.min(m.size - 1, Math.floor(u * m.size));
  const y = Math.min(m.size - 1, Math.floor(v * m.size));
  const o = (y * m.size + x) * 4;
  return { water: m.data[o] / 255, bank: m.data[o + 1] / 255, building: m.data[o + 2] / 255 };
}
