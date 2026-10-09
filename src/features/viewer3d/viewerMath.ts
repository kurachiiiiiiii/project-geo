/**
 * 3Dビューワー(クリックした地点から360°見渡す): 行列・ベクトル・地図座標の小さな計算部品。
 *
 * 座標系は「X=東、Y=上、Z=南」(右手系)で、原点はクリックした地点の真下(標高0m)。
 * 北は −Z 方向。方位角は北=0°・東=90°の時計回り、仰角は水平=0°・真上=90°。
 * 行列は WebGL に渡しやすい列優先(column-major)の Float32Array。
 */

export type Vec3 = [number, number, number];
export type Mat4 = Float32Array;

export const DEG = Math.PI / 180;

/** 方位角・仰角(度)から、その方向の単位ベクトル(X東・Y上・Z南の座標系) */
export function dirFromAzAlt(azimuthDeg: number, altitudeDeg: number): Vec3 {
  const az = azimuthDeg * DEG;
  const al = altitudeDeg * DEG;
  return [Math.cos(al) * Math.sin(az), Math.sin(al), -Math.cos(al) * Math.cos(az)];
}

export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function normalize(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** 視線の向き(進行方向・右・上)。yaw=向いている方位角(度)、pitch=見上げる角度(度。下向きは負) */
export interface CameraBasis {
  forward: Vec3;
  right: Vec3;
  up: Vec3;
}

export function cameraBasis(yawDeg: number, pitchDeg: number): CameraBasis {
  const forward = dirFromAzAlt(yawDeg, pitchDeg);
  const y = yawDeg * DEG;
  const right: Vec3 = [Math.cos(y), 0, Math.sin(y)];
  const up = cross(right, forward);
  return { forward, right, up };
}

export function perspective(fovYDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovYDeg * DEG) / 2);
  const m = new Float32Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

/** 視点 eye から basis の向きを見る視野変換行列 */
export function viewMatrix(eye: Vec3, b: CameraBasis): Mat4 {
  const { right: r, up: u, forward: f } = b;
  const m = new Float32Array(16);
  m[0] = r[0];
  m[4] = r[1];
  m[8] = r[2];
  m[12] = -dot(r, eye);
  m[1] = u[0];
  m[5] = u[1];
  m[9] = u[2];
  m[13] = -dot(u, eye);
  m[2] = -f[0];
  m[6] = -f[1];
  m[10] = -f[2];
  m[14] = dot(f, eye);
  m[15] = 1;
  return m;
}

/** a × b(列優先の行列の積) */
export function mulMat4(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** ワールド座標の点を、クリップ座標(x,y,w)へ。w<=0 なら視点の背後 */
export function projectPoint(vp: Mat4, p: Vec3): { x: number; y: number; w: number } {
  const x = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
  const y = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
  const w = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
  return { x, y, w };
}

// ---------------------------------------------------------------------------
// Webメルカトル(地図タイル)
// ---------------------------------------------------------------------------

export const TILE_PX = 256;
const EARTH_CIRCUMFERENCE_M = 40075016.68557849;

/** 緯度経度 → ズームzの「世界ピクセル座標」(タイル座標×256) */
export function worldPx(lat: number, lon: number, z: number): { x: number; y: number } {
  const n = 2 ** z * TILE_PX;
  const rad = lat * DEG;
  return {
    x: ((lon + 180) / 360) * n,
    y: ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n,
  };
}

/** ズームzの1ピクセルが、その緯度で何mか */
export function metersPerPx(lat: number, z: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos(lat * DEG)) / (2 ** z * TILE_PX);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
}

/** 方位を 0〜360 に正規化 */
export function normAz(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** 方位の差 a−b を −180〜180 に */
export function diffAz(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

const COMPASS_8 = ["北", "北東", "東", "南東", "南", "南西", "西", "北西"];

/** 方位角(度)の8方位の呼び名 */
export function compass8(azDeg: number): string {
  return COMPASS_8[Math.round(normAz(azDeg) / 45) % 8];
}
