import type { FrameParams } from "./viewerGl";
import { SEA_SIGMA, SEA_THICK_M } from "./viewerSea";
import { ATMOS_GLSL, CLOUD_GLSL, FOG_GLSL, LIGHT_GLSL, NOISE_GLSL, SEA_SKY_GLSL, SHADE_GLSL, link } from "./viewerGlsl";
import type { Mat4 } from "./viewerMath";

/**
 * 3Dビューワー: 地形の上に立てる立体(木・建物)と、空に重ねる星座(星・線)を描く。
 * 光・霧・雲は地形と同じ式(viewerGlsl.ts)で掛けるので、霧の中や雲の下でも地形となじむ。
 */

// ---------------------------------------------------------------------------
// データの形(CPU側で作って渡す)
// ---------------------------------------------------------------------------

export interface BuildingMeshData {
  /** 頂点ごとのx,y,z(m) */
  positions: Float32Array;
  /** 頂点ごとの法線(Int8を-127〜127で正規化。x,y,z,0の4つ組) */
  normals: Int8Array;
  /** 頂点ごとの色(Uint8を0〜255で正規化。r,g,b,255の4つ組) */
  colors: Uint8Array;
  indices: Uint32Array;
}

/** 遠くの建物の箱(1棟1インスタンス。`viewerBuildings.ts` の `buildBoxInstances`) */
export interface BoxInstanceData {
  /** 中心x, 中心z, 半幅x, 半幅z(m) */
  a: Float32Array;
  /** 下端y, 上端y(m) */
  b: Float32Array;
  /** 壁の色rgb+255, 屋根の色rgb+255(Uint8) */
  colors: Uint8Array;
  count: number;
}

/** 木の種類。broad=広葉樹(丸い樹冠)、conifer=針葉樹(円錐) */
export type TreeKind = "broad" | "conifer";

export interface TreeSetData {
  kind: TreeKind;
  /** 形の細かさ(0=細かい・近くの木、1=簡単、2=最も簡単・遠くの木) */
  lod: number;
  count: number;
  /** 1本あたり4つ: 根もとの位置x,y,z(m)と高さ(m) */
  inst: Float32Array;
  /** 1本あたり2つ: 幅の倍率(高さに対する)と向き(ラジアン) */
  inst2: Float32Array;
  /** 1本あたり3つ: 樹冠の色(0〜1) */
  colors: Float32Array;
}

export interface ConstellationGlData {
  /** 線: 1本あたり4頂点×9つ(始点の向き3・終点の向き3・端0/1・左右-1/+1・種類) */
  lines: Float32Array;
  lineCount: number;
  /** 星: 1つあたり4つ(向きx,y,z と 大きさpx) */
  points: Float32Array;
  pointCount: number;
}

// ---------------------------------------------------------------------------
// シェーダー
// ---------------------------------------------------------------------------

const TREE_VS = `#version 300 es
precision highp float;
uniform mat4 uVP;
in vec3 aPos;
in vec3 aNrm;
in float aPart;
in vec4 aInst;
in vec2 aInst2;
in vec3 aCol;
out vec3 vPos;
out vec3 vNrm;
out vec3 vCol;
out float vY;
out float vPart;
out vec3 vLeaf;
out float vSeed;
void main() {
  float c = cos(aInst2.y);
  float s = sin(aInst2.y);
  vec3 p = aPos;
  p.xz = vec2(c * p.x - s * p.z, s * p.x + c * p.z);
  vec3 n = aNrm;
  n.xz = vec2(c * n.x - s * n.z, s * n.x + c * n.z);
  vec3 world = aInst.xyz + vec3(p.x * aInst.w * aInst2.x, p.y * aInst.w, p.z * aInst.w * aInst2.x);
  vPos = world;
  vNrm = n;
  vCol = aPart > 0.5 ? aCol : vec3(0.27, 0.19, 0.12);
  vY = aPos.y;
  vPart = aPart;
  // 葉のざらつき用: 木の中の位置(m)と、木ごとの乱数
  vLeaf = vec3(p.x * aInst2.x, p.y, p.z * aInst2.x) * aInst.w;
  vSeed = fract(sin(dot(aInst.xz, vec2(12.9898, 78.233))) * 43758.5453) * 64.0;
  gl_Position = uVP * vec4(world, 1.0);
}`;

const TREE_FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNrm;
in vec3 vCol;
in float vY;
in float vPart;
in vec3 vLeaf;
in float vSeed;
out vec4 outColor;
${FOG_GLSL}
${CLOUD_GLSL}
${LIGHT_GLSL}
${ATMOS_GLSL}
${SHADE_GLSL}
float th3(vec3 p) {
  p = fract(p * 0.3183099 + 0.1);
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
void main() {
  vec3 N = normalize(vNrm);
  float foliage = step(0.5, vPart);
  // 段・こぶの中の高さ(0=下側の影になる所、1=上側の日の当たる所)
  float f = clamp(vPart - 1.0, 0.0, 1.0);
  float shade = mix(1.0, mix(0.62, 1.1, f), foliage);
  // 葉のざらつき(大きなかたまり+細かい粒)。遠くではちらつくので薄くする
  float near = 1.0 - smoothstep(120.0, 450.0, length(vPos - uCam));
  vec3 q = vLeaf + vSeed;
  float clump = th3(floor(q * 0.7));
  float speck = th3(floor(q * 2.4 + 3.1));
  float n = clump * 0.55 + speck * 0.45;
  float leaf = mix(1.0, 0.7 + 0.55 * n, near * foliage);
  vec3 tint = mix(vec3(1.0), vec3(1.0 + 0.07 * (n - 0.5), 1.0, 1.0 - 0.1 * (n - 0.5)), near * foliage);
  vec3 col = vCol * tint * (0.78 + 0.3 * vY) * shade * leaf * sceneLightAt(N, vPos);
  outColor = vec4(applyAtmos(col, vPos), 1.0);
}`;

const BLDG_VS = `#version 300 es
precision highp float;
uniform mat4 uVP;
in vec3 aPos;
in vec3 aNrm;
in vec3 aCol;
out vec3 vPos;
out vec3 vNrm;
out vec3 vCol;
void main() {
  vPos = aPos;
  vNrm = aNrm;
  vCol = aCol;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

/**
 * 遠くの建物の箱(インスタンス描画)。1つの箱は、屋根と、カメラの側を向いた壁2枚(x向き・z向き)だけを描く
 * (向こう側の壁2枚は、箱の手前の面に隠れて見えないので描かない。頂点は1棟12個)。色・光り方は近くの建物と同じ(BLDG_FS)。
 * aU = 面の中の位置(屋根: x,z=-1〜1 / 壁: 横=-1〜1, 高さ=0〜1)、aFace = 0屋根・1 x向きの壁・2 z向きの壁
 */
const BOX_VS = `#version 300 es
precision highp float;
uniform mat4 uVP;
uniform vec3 uCam;
in vec2 aU;
in float aFace;
in vec4 iA;
in vec2 iB;
in vec4 iWall;
in vec4 iRoof;
out vec3 vPos;
out vec3 vNrm;
out vec3 vCol;
void main() {
  vec2 c = iA.xy;
  vec2 h = iA.zw;
  float sx = uCam.x >= c.x ? 1.0 : -1.0;
  float sz = uCam.z >= c.y ? 1.0 : -1.0;
  vec3 p;
  if (aFace < 0.5) {
    p = vec3(c.x + aU.x * h.x, iB.y, c.y + aU.y * h.y);
    vNrm = vec3(0.0, 1.0, 0.0);
    vCol = iRoof.rgb;
  } else if (aFace < 1.5) {
    p = vec3(c.x + sx * h.x, mix(iB.x, iB.y, aU.y), c.y + sx * aU.x * h.y);
    vNrm = vec3(sx, 0.0, 0.0);
    vCol = iWall.rgb;
  } else {
    p = vec3(c.x + sz * aU.x * h.x, mix(iB.x, iB.y, aU.y), c.y + sz * h.y);
    vNrm = vec3(0.0, 0.0, sz);
    vCol = iWall.rgb;
  }
  vPos = p;
  gl_Position = uVP * vec4(p, 1.0);
}`;

/** 人口集中地区(DID)の中の建物は、発光を30%弱める(「DID地区の建物の発光量を30%へらす」) */
const DID_GLOW_CUT = 0.3;
/**
 * DIDの割合の地図(ユニット12。R=0〜1。原点から±uDidRect の範囲。z=0なら地図なし)を読み、位置(x,z)の建物の発光の倍率(0.7〜1)を返す。
 * 割合が約0.25〜0.75の間でなめらかに変える(DIDの縁の建物は、少しだけ弱める)。地図の外は1(変えない)
 */
const DID_GLSL = `
uniform sampler2D uDidMap;
uniform vec4 uDidRect;
float didGlowK(vec2 xz) {
  if (uDidRect.z <= 0.0) return 1.0;
  vec2 uv = (xz - uDidRect.xy) / uDidRect.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 1.0;
  float d = textureLod(uDidMap, uv, 0.0).r;
  return 1.0 - ${DID_GLOW_CUT.toFixed(2)} * smoothstep(0.25, 0.75, d);
}`;

const BLDG_FS = `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNrm;
in vec3 vCol;
out vec4 outColor;
${FOG_GLSL}
${CLOUD_GLSL}
${LIGHT_GLSL}
${NOISE_GLSL}
${ATMOS_GLSL}
${SHADE_GLSL}
${DID_GLSL}
// 夜の建物1棟ごとの明かり(uBldgGlow=夜の強さ。0なら光らない)
uniform float uBldgGlow;
void main() {
  vec3 N = normalize(vNrm);
  vec3 col = vCol * sceneLightAt(N, vPos);
  if (uBldgGlow > 0.0) {
    float camD = length(vPos - uCam);
    // 壁には窓の格子(約3m×3.4m)をつくり、点いている窓だけ暖色に光らせる。屋根はごくわずか。遠くでは窓がちらつくので、平均の明るさにそろえる
    float wall = 1.0 - smoothstep(0.3, 0.7, abs(N.y));
    vec2 tang = vec2(-N.z, N.x);
    vec2 wc = vec2(dot(vPos.xz, tang) / 3.0, vPos.y / 3.4);
    vec2 wf = fract(wc);
    float win = step(0.18, wf.x) * step(wf.x, 0.82) * step(0.22, wf.y) * step(wf.y, 0.78);
    float zone = h21(floor(vPos.xz / 28.0) + 17.0);
    float litP = 0.18 + 0.5 * zone;
    float on = step(1.0 - litP, h21(floor(wc) + floor(vPos.xz / 28.0) * 3.1));
    float nearK = 1.0 - smoothstep(120.0, 700.0, camD);
    float em = mix(litP * 0.62, win * on, nearK);
    vec3 warm = mix(vec3(1.0, 0.8, 0.5), vec3(1.0, 0.93, 0.8), h21(floor(wc) + 5.0));
    col += warm * (em * wall * 0.5 + (1.0 - wall) * 0.02) * uBldgGlow * didGlowK(vPos.xz);
  }
  outColor = vec4(applyAtmos(col, vPos), 1.0);
}`;

/** 星座の線(画面上で一定の太さの帯にする)。線の両端が視点の後ろに回ったときは手前の面で切る */
const LINE_VS = `#version 300 es
precision highp float;
uniform mat4 uVP;
uniform vec3 uCam;
uniform vec2 uViewport;
uniform float uWidthPx;
precision highp sampler2D;
${SEA_SKY_GLSL}
in vec3 aA;
in vec3 aB;
in vec2 aV;
in float aKind;
out float vAlt;
out float vSide;
out float vKind;
void main() {
  vec4 ca = uVP * vec4(uCam + aA * 1.0e5, 1.0);
  vec4 cb = uVP * vec4(uCam + aB * 1.0e5, 1.0);
  const float EPS = 0.01;
  if (ca.w < EPS && cb.w < EPS) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vAlt = 0.0; vSide = 0.0; vKind = aKind;
    return;
  }
  if (ca.w < EPS) ca = mix(ca, cb, (EPS - ca.w) / (cb.w - ca.w));
  if (cb.w < EPS) cb = mix(cb, ca, (EPS - cb.w) / (ca.w - cb.w));
  vec2 hv = uViewport * 0.5;
  vec2 a = ca.xy / ca.w * hv;
  vec2 b = cb.xy / cb.w * hv;
  vec2 d = b - a;
  float l = length(d);
  vec2 dir = l > 1.0e-4 ? d / l : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);
  bool isStart = aV.x < 0.5;
  vec4 c = isStart ? ca : cb;
  vec2 base = isStart ? a : b;
  // 曲線の細かい線分(aKind=3)は両端にはみ出さない(つなぎ目で重なって、半透明の点が濃くならないように)
  float cap = aKind > 2.5 ? 0.0 : 1.0;
  vec2 ndc = (base + nrm * aV.y * uWidthPx * 0.5 + dir * (isStart ? -1.0 : 1.0) * uWidthPx * 0.5 * cap) / hv;
  gl_Position = vec4(ndc * c.w, c.z, c.w);
  vec3 dw = normalize(isStart ? aA : aB);
  vAlt = smoothstep(0.0, 0.1, dw.y);
  if (uCsOn > 0.5) {
    // 雲海の層の下からは、雲に隠れる
    float sshade;
    vAlt *= exp(-seaSkyTau(uCam, dw, sshade));
  }
  vSide = aV.y;
  vKind = aKind;
}`;

const LINE_FS = `#version 300 es
precision highp float;
uniform float uStrength;
in float vAlt;
in float vSide;
in float vKind;
out vec4 outColor;
void main() {
  float edge = smoothstep(1.0, 0.35, abs(vSide));
  vec3 col = vKind > 1.5 ? vec3(0.55, 0.95, 0.8) : (vKind > 0.5 ? vec3(1.0, 0.82, 0.45) : vec3(0.7, 0.85, 1.0));
  float a = (vKind > 1.5 ? 0.6 : (vKind > 0.5 ? 0.78 : 0.55)) * uStrength * vAlt * edge;
  if (a < 0.003) discard;
  outColor = vec4(col, a);
}`;

const STAR_VS = `#version 300 es
precision highp float;
uniform mat4 uVP;
uniform vec3 uCam;
uniform float uDpr;
precision highp sampler2D;
${SEA_SKY_GLSL}
in vec4 aStar;
out float vAlt;
void main() {
  gl_Position = uVP * vec4(uCam + aStar.xyz * 1.0e5, 1.0);
  gl_PointSize = aStar.w * uDpr;
  vAlt = smoothstep(0.0, 0.1, aStar.y);
  if (uCsOn > 0.5) {
    float sshade;
    vAlt *= exp(-seaSkyTau(uCam, normalize(aStar.xyz), sshade));
  }
}`;

const STAR_FS = `#version 300 es
precision highp float;
uniform float uStrength;
in float vAlt;
out vec4 outColor;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float a = smoothstep(1.0, 0.2, d) * uStrength * vAlt;
  if (a < 0.003) discard;
  outColor = vec4(0.95, 0.97, 1.0, a);
}`;

/**
 * 夜の建物の明かり(遠くから見える光の点)。建物1棟につき1つの点で、約1km先から次第に現れ、遠いほど画面上の大きさを
 * 一定以上に保つ(建物そのものは遠くで1画素より小さくなって見えないので、窓の明かりが点として見えるようにする)。
 * 霞・霧・雲海を通った分だけ弱める(通る割合は applyAtmos(1) - applyAtmos(0)。頂点シェーダーで1点につき1回だけ求める)。
 * 地形・建物の後に、加算で重ねる(地形より奥の山の陰では見えない)。
 */
const LIGHT_VS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform mat4 uVP;
uniform float uPxPerRad;
uniform float uDpr;
uniform float uGlowK;
${FOG_GLSL}
${CLOUD_GLSL}
${LIGHT_GLSL}
${ATMOS_GLSL}
${DID_GLSL}
in vec4 aL;
out vec3 vCol;
void main() {
  vec3 rel = aL.xyz - uCam;
  float dist = max(length(rel), 1.0);
  float ramp = smoothstep(900.0, 2400.0, dist);
  float hs = fract(sin(dot(aL.xz, vec2(12.9898, 78.233))) * 43758.5453);
  // 地形の奥行きと重ならないよう、遠いほど少し持ち上げる(遠くでは奥行きの精度が粗い)
  vec3 pos = aL.xyz + vec3(0.0, 1.5 + dist * 0.0006, 0.0);
  float px = 2.0 * aL.w / dist * uPxPerRad;
  float size = clamp(px * 1.6, 3.2 * uDpr, 12.0 * uDpr);
  gl_Position = uVP * vec4(pos, 1.0);
  gl_PointSize = size;
  vec3 tint = hs > 0.82 ? vec3(0.86, 0.93, 1.0) : mix(vec3(1.0, 0.7, 0.36), vec3(1.0, 0.92, 0.78), fract(hs * 13.7));
  float inten = (0.5 + 0.7 * hs) * (0.7 + 0.5 * clamp(aL.w / 20.0, 0.0, 1.0));
  vec3 tr = clamp(applyAtmos(vec3(1.0), pos) - applyAtmos(vec3(0.0), pos), 0.0, 1.0);
  vCol = ramp > 0.001 ? tint * inten * ramp * uGlowK * tr * didGlowK(aL.xz) : vec3(0.0);
}`;

const LIGHT_FS = `#version 300 es
precision highp float;
in vec3 vCol;
out vec4 outColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float r2 = dot(q, q) * 4.0;
  float a = exp(-r2 * 2.4) * (1.0 - smoothstep(0.7, 1.0, r2));
  outColor = vec4(vCol * a, 1.0);
}`;

// ---------------------------------------------------------------------------
// 部品
// ---------------------------------------------------------------------------

/** 雲海を描くための値(`TerrainRenderer.render` から渡される) */
export interface SeaDraw {
  on: boolean;
  rect: [number, number, number, number];
  h: number;
  col: [number, number, number];
  /** 山の影・谷の暗がりの地図が貼られているか(処理「高」) */
  shade: boolean;
  /** 処理「高」の追加効果(霞の前方散乱)を掛けるか */
  hq: boolean;
}
const NO_SEA: SeaDraw = { on: false, rect: [0, 0, 1, 1], h: 0, col: [1, 1, 1], shade: false, hq: false };

class Prog {
  readonly program: WebGLProgram;
  private readonly gl: WebGL2RenderingContext;
  private readonly cache = new Map<string, WebGLUniformLocation | null>();
  constructor(gl: WebGL2RenderingContext, vs: string, fs: string) {
    this.gl = gl;
    this.program = link(gl, vs, fs);
  }
  u(name: string): WebGLUniformLocation | null {
    let l = this.cache.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(this.program, name);
      this.cache.set(name, l);
    }
    return l;
  }
  a(name: string): number {
    return this.gl.getAttribLocation(this.program, name);
  }
}

/** 木1本の形(単位の大きさ。x,zは±0.5、yは0〜1) */
interface UnitMesh {
  pos: number[];
  nrm: number[];
  /** 0=幹、1〜2=葉(1+段・こぶの中の高さの割合。下ほど暗く塗る) */
  part: number[];
  idx: number[];
}

type V3 = [number, number, number];

function newMesh(): UnitMesh {
  return { pos: [], nrm: [], part: [], idx: [] };
}

function addTri(m: UnitMesh, v: [V3, V3, V3], n: [V3, V3, V3], part: [number, number, number]): void {
  const base = m.pos.length / 3;
  for (let i = 0; i < 3; i++) {
    m.pos.push(...v[i]);
    m.nrm.push(...n[i]);
    m.part.push(part[i]);
  }
  m.idx.push(base, base + 1, base + 2);
}

function norm3(a: V3): V3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

/** 三角形の面の向き(外向きになるよう、中心から離れる側へそろえる) */
function faceNormal(a: V3, b: V3, c: V3): V3 {
  const u: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  let n = norm3([u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]);
  const cx = (a[0] + b[0] + c[0]) / 3;
  const cz = (a[2] + b[2] + c[2]) / 3;
  if (n[0] * cx + n[2] * cz < 0) n = [-n[0], -n[1], -n[2]];
  return n;
}

/** 幹(上に向かって少し細くなる四角柱) */
function trunk(m: UnitMesh, rBottom: number, rTop: number, h: number): void {
  const corners: [number, number][] = [
    [1, 1],
    [-1, 1],
    [-1, -1],
    [1, -1],
  ];
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i];
    const [x1, z1] = corners[(i + 1) % 4];
    const a: V3 = [x0 * rBottom, 0, z0 * rBottom];
    const b: V3 = [x1 * rBottom, 0, z1 * rBottom];
    const c: V3 = [x1 * rTop, h, z1 * rTop];
    const d: V3 = [x0 * rTop, h, z0 * rTop];
    const n = norm3([(x0 + x1) / 2, 0, (z0 + z1) / 2]);
    addTri(m, [a, b, c], [n, n, n], [0, 0, 0]);
    addTri(m, [a, c, d], [n, n, n], [0, 0, 0]);
  }
}

/**
 * 針葉樹: 段になった円錐を重ねる(スギ・ヒノキ・マツ・カラマツの雰囲気)。
 * 各段の裾はぎざぎざにし(jag)、段ごとに向きをずらして、のっぺりしないようにする。面ごとに向きを変えて、ざらっとした陰影にする。
 */
function buildConiferMesh(tiers: [number, number, number][], segs: number, jag: number, trunkH: number): UnitMesh {
  const m = newMesh();
  if (trunkH > 0) trunk(m, 0.034, 0.02, trunkH);
  tiers.forEach(([y0, y1, r], ti) => {
    const rot = ti * 0.45;
    for (let j = 0; j < segs; j++) {
      const t0 = rot + (2 * Math.PI * j) / segs;
      const t1 = rot + (2 * Math.PI * (j + 1)) / segs;
      const r0 = r * (j % 2 === 1 ? 1 - jag : 1);
      const r1 = r * ((j + 1) % 2 === 1 ? 1 - jag : 1);
      const a: V3 = [r0 * Math.cos(t0), y0, r0 * Math.sin(t0)];
      const b: V3 = [r1 * Math.cos(t1), y0, r1 * Math.sin(t1)];
      const tip: V3 = [0, y1, 0];
      const n = faceNormal(a, b, tip);
      // 面の向きは、やや上向きにして(葉が重なって上を向く)、日の当たり方を柔らかくする
      const nn = norm3([n[0], n[1] + 0.25, n[2]]);
      addTri(m, [a, b, tip], [nn, nn, nn], [1, 1, 2]);
    }
  });
  return m;
}

/** こぶ(楕円体)を足す。part は 1+(こぶの中の高さの割合) */
function addBlob(m: UnitMesh, cx: number, cy: number, cz: number, rx: number, ry: number, segs: number, rows: number): void {
  const ring = (row: number, j: number): V3 => {
    const phi = -Math.PI / 2 + (Math.PI * row) / rows;
    const th = (2 * Math.PI * j) / segs;
    return [cx + rx * Math.cos(phi) * Math.cos(th), cy + ry * Math.sin(phi), cz + rx * Math.cos(phi) * Math.sin(th)];
  };
  const nrm = (p: V3): V3 => norm3([(p[0] - cx) / (rx * rx), (p[1] - cy) / (ry * ry), (p[2] - cz) / (rx * rx)]);
  const part = (p: V3) => 1 + Math.min(1, Math.max(0, (p[1] - (cy - ry)) / (2 * ry)));
  const tri = (a: V3, b: V3, c: V3) => addTri(m, [a, b, c], [nrm(a), nrm(b), nrm(c)], [part(a), part(b), part(c)]);
  for (let row = 0; row < rows; row++) {
    for (let j = 0; j < segs; j++) {
      const a = ring(row, j);
      const b = ring(row, j + 1);
      const c = ring(row + 1, j + 1);
      const d = ring(row + 1, j);
      if (row === 0) tri(a, c, d);
      else if (row === rows - 1) tri(a, b, d);
      else {
        tri(a, b, c);
        tri(a, c, d);
      }
    }
  }
}

/** 広葉樹: 幹+いくつかのこぶを寄せた、でこぼこの樹冠 */
function buildBroadMesh(blobs: [number, number, number, number, number][], segs: number, rows: number, trunkH: number): UnitMesh {
  const m = newMesh();
  if (trunkH > 0) trunk(m, 0.04, 0.026, trunkH);
  for (const [cx, cy, cz, rx, ry] of blobs) addBlob(m, cx, cy, cz, rx, ry, segs, rows);
  return m;
}

/** 最も簡単な形(遠くの木): 針葉樹=円錐、広葉樹=ひし形 */
function buildFarMesh(kind: TreeKind): UnitMesh {
  if (kind === "conifer") return buildConiferMesh([[0.04, 1.0, 0.5]], 5, 0, 0);
  const m = newMesh();
  const segs = 4;
  const top: V3 = [0, 0.97, 0];
  const bot: V3 = [0, 0.14, 0];
  for (let j = 0; j < segs; j++) {
    const t0 = (2 * Math.PI * j) / segs + 0.4;
    const t1 = (2 * Math.PI * (j + 1)) / segs + 0.4;
    const a: V3 = [0.5 * Math.cos(t0), 0.58, 0.5 * Math.sin(t0)];
    const b: V3 = [0.5 * Math.cos(t1), 0.58, 0.5 * Math.sin(t1)];
    const nt = faceNormal(a, b, top);
    const nb = faceNormal(a, bot, b);
    addTri(m, [a, b, top], [nt, nt, nt], [1.5, 1.5, 2]);
    addTri(m, [a, bot, b], [nb, nb, nb], [1.5, 1, 1.5]);
  }
  return m;
}

function buildTreeMesh(kind: TreeKind, lod: number): UnitMesh {
  if (lod >= 2) return buildFarMesh(kind);
  if (kind === "conifer") {
    return lod === 0
      ? buildConiferMesh(
          [
            [0.1, 0.46, 0.5],
            [0.28, 0.65, 0.42],
            [0.46, 0.83, 0.33],
            [0.62, 1.0, 0.22],
          ],
          8,
          0.16,
          0.16,
        )
      : buildConiferMesh(
          [
            [0.06, 0.62, 0.5],
            [0.38, 1.0, 0.34],
          ],
          6,
          0.12,
          0,
        );
  }
  return lod === 0
    ? buildBroadMesh(
        [
          [0, 0.62, 0, 0.46, 0.33],
          [0.27, 0.56, 0.12, 0.3, 0.24],
          [-0.25, 0.58, -0.16, 0.3, 0.25],
          [0.04, 0.84, -0.06, 0.27, 0.19],
          [-0.1, 0.5, 0.28, 0.25, 0.2],
        ],
        6,
        3,
        0.4,
      )
    : buildBroadMesh(
        [
          [0, 0.48, 0, 0.5, 0.42],
          [0.04, 0.82, -0.04, 0.3, 0.2],
        ],
        5,
        3,
        0,
      );
}

interface TreeGl {
  vao: WebGLVertexArrayObject;
  buffers: WebGLBuffer[];
  colorBuf: WebGLBuffer;
  indexCount: number;
  count: number;
}

/** 建物自体の光(窓の明かり・夜景の光の点)の強さの倍率(「建物自体の発光を30%少なく」で0.7) */
const BUILDING_GLOW_SCALE = 0.7;

export class ObjectRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly tree: Prog;
  private readonly bldg: Prog;
  private readonly lights: Prog;
  private readonly line: Prog;
  private readonly star: Prog;
  private readonly unit: Record<string, UnitMesh> = {};
  private trees: Record<string, TreeGl> = {};
  private bldgVao: WebGLVertexArrayObject | null = null;
  private bldgBuffers: WebGLBuffer[] = [];
  private bldgIndexCount = 0;
  private readonly box: Prog;
  private boxVao: WebGLVertexArrayObject | null = null;
  private boxBuffers: WebGLBuffer[] = [];
  private boxCount = 0;
  private lightVao: WebGLVertexArrayObject | null = null;
  private lightBuf: WebGLBuffer | null = null;
  private lightCount = 0;
  private lineVao: WebGLVertexArrayObject | null = null;
  private lineBuf: WebGLBuffer | null = null;
  private lineIdx: WebGLBuffer | null = null;
  private lineIdxCap = 0;
  private lineCount = 0;
  private starVao: WebGLVertexArrayObject | null = null;
  private starBuf: WebGLBuffer | null = null;
  private starCount = 0;
  /** 人口集中地区の割合の地図(建物の発光を弱める)。nullか、rectのzが0なら、弱めない */
  private didTex: WebGLTexture | null = null;
  private didRect: [number, number, number, number] = [0, 0, 0, 0];

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    this.tree = new Prog(gl, TREE_VS, TREE_FS);
    this.bldg = new Prog(gl, BLDG_VS, BLDG_FS);
    this.box = new Prog(gl, BOX_VS, BLDG_FS);
    this.lights = new Prog(gl, LIGHT_VS, LIGHT_FS);
    this.line = new Prog(gl, LINE_VS, LINE_FS);
    this.star = new Prog(gl, STAR_VS, STAR_FS);
  }

  get hasTrees(): boolean {
    return Object.keys(this.trees).length > 0;
  }

  // ---- 人口集中地区の地図 ----

  /**
   * 人口集中地区(DID)の割合の地図を貼る。data=R8(0〜255)、size×size、上が北、原点から±half(m)を覆う。
   * 建物の窓の明かり・夜景の光の点は、DIDの中だけ30%弱まる。nullなら弱めない
   */
  setDidMap(map: { data: Uint8Array; size: number; half: number } | null): void {
    const gl = this.gl;
    if (!map) {
      this.didRect = [0, 0, 0, 0];
      return;
    }
    this.didTex ??= gl.createTexture();
    gl.activeTexture(gl.TEXTURE12);
    gl.bindTexture(gl.TEXTURE_2D, this.didTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, map.size, map.size, 0, gl.RED, gl.UNSIGNED_BYTE, map.data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.didRect = [-map.half, -map.half, 2 * map.half, 2 * map.half];
  }

  /** DIDの地図を、このプログラム(建物・箱・光の点)に渡す(ユニット12。地形・空は、毎フレーム自分でユニット12を貼り直す) */
  private bindDid(prog: Prog): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE12);
    gl.bindTexture(gl.TEXTURE_2D, this.didRect[2] > 0 ? this.didTex : null);
    gl.uniform1i(prog.u("uDidMap"), 12);
    gl.uniform4fv(prog.u("uDidRect"), this.didRect);
  }

  // ---- 木 ----

  /**
   * 木を貼る。group(帯ごとの名前)を指定すると、その帯の木だけを差し替える(視点を動かしたあと、
   * 視点のまわりの帯だけを作り直すため)。省略すると全部を入れ替える。
   */
  setTrees(sets: TreeSetData[], group?: string): void {
    const gl = this.gl;
    if (group === undefined) this.clearTrees();
    else this.clearTreeGroup(group);
    const g = group ?? "all";
    for (const set of sets) {
      if (set.count === 0) continue;
      const meshKey = `${set.kind}${set.lod}`;
      const key = `${g}|${meshKey}`;
      const um = (this.unit[meshKey] ??= buildTreeMesh(set.kind, set.lod));
      const vao = gl.createVertexArray();
      if (!vao) throw new Error("VAOを作れません");
      gl.bindVertexArray(vao);
      const buffers: WebGLBuffer[] = [];
      const attr = (name: string, data: Float32Array, size: number, divisor: number, usage: number): WebGLBuffer => {
        const buf = gl.createBuffer();
        if (!buf) throw new Error("バッファを作れません");
        buffers.push(buf);
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        gl.bufferData(gl.ARRAY_BUFFER, data, usage);
        const loc = this.tree.a(name);
        if (loc >= 0) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
          gl.vertexAttribDivisor(loc, divisor);
        }
        return buf;
      };
      attr("aPos", new Float32Array(um.pos), 3, 0, gl.STATIC_DRAW);
      attr("aNrm", new Float32Array(um.nrm), 3, 0, gl.STATIC_DRAW);
      attr("aPart", new Float32Array(um.part), 1, 0, gl.STATIC_DRAW);
      attr("aInst", set.inst, 4, 1, gl.STATIC_DRAW);
      attr("aInst2", set.inst2, 2, 1, gl.STATIC_DRAW);
      const colorBuf = attr("aCol", set.colors, 3, 1, gl.DYNAMIC_DRAW);
      const ib = gl.createBuffer();
      if (!ib) throw new Error("バッファを作れません");
      buffers.push(ib);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(um.idx), gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.trees[key] = { vao, buffers, colorBuf, indexCount: um.idx.length, count: set.count };
    }
  }

  /** 木の色だけを差し替える(紅葉の日付が変わったとき) */
  setTreeColors(kind: TreeKind, lod: number, colors: Float32Array, group?: string): void {
    const t = this.trees[`${group ?? "all"}|${kind}${lod}`];
    if (!t) return;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, t.colorBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, colors);
  }

  /** 1つの帯の木だけを外す */
  clearTreeGroup(group: string): void {
    const gl = this.gl;
    const prefix = `${group}|`;
    for (const key of Object.keys(this.trees)) {
      if (!key.startsWith(prefix)) continue;
      const t = this.trees[key];
      gl.deleteVertexArray(t.vao);
      for (const b of t.buffers) gl.deleteBuffer(b);
      delete this.trees[key];
    }
  }

  clearTrees(): void {
    const gl = this.gl;
    for (const t of Object.values(this.trees)) {
      gl.deleteVertexArray(t.vao);
      for (const b of t.buffers) gl.deleteBuffer(b);
    }
    this.trees = {};
  }

  // ---- 建物 ----

  /** 近くの建物(形を押し出した立体)。null で外す */
  setBuildings(mesh: BuildingMeshData | null): void {
    const gl = this.gl;
    if (this.bldgVao) gl.deleteVertexArray(this.bldgVao);
    for (const b of this.bldgBuffers) gl.deleteBuffer(b);
    this.bldgVao = null;
    this.bldgBuffers = [];
    this.bldgIndexCount = 0;
    if (!mesh || mesh.indices.length === 0) return;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("VAOを作れません");
    gl.bindVertexArray(vao);
    const attr = (name: string, data: Float32Array | Int8Array | Uint8Array, size: number, type: number, normalized: boolean) => {
      const buf = gl.createBuffer();
      if (!buf) throw new Error("バッファを作れません");
      this.bldgBuffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = this.bldg.a(name);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
      }
    };
    attr("aPos", mesh.positions, 3, gl.FLOAT, false);
    attr("aNrm", mesh.normals, 4, gl.BYTE, true);
    attr("aCol", mesh.colors, 4, gl.UNSIGNED_BYTE, true);
    const ib = gl.createBuffer();
    if (!ib) throw new Error("バッファを作れません");
    this.bldgBuffers.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.bldgVao = vao;
    this.bldgIndexCount = mesh.indices.length;
  }

  /** 遠くの建物の箱(インスタンス)。null で外す */
  setBuildingBoxes(inst: BoxInstanceData | null): void {
    const gl = this.gl;
    if (this.boxVao) gl.deleteVertexArray(this.boxVao);
    for (const b of this.boxBuffers) gl.deleteBuffer(b);
    this.boxVao = null;
    this.boxBuffers = [];
    this.boxCount = 0;
    if (!inst || inst.count === 0) return;
    // 1つの箱の形: 屋根(4頂点)・x向きの壁(4頂点)・z向きの壁(4頂点)
    const u: number[] = [];
    const face: number[] = [];
    const quad = (f: number, pts: number[]) => {
      for (const v of pts) u.push(v);
      face.push(f, f, f, f);
    };
    quad(0, [-1, -1, 1, -1, 1, 1, -1, 1]);
    quad(1, [-1, 0, 1, 0, 1, 1, -1, 1]);
    quad(2, [-1, 0, 1, 0, 1, 1, -1, 1]);
    const idx: number[] = [];
    for (let q = 0; q < 3; q++) idx.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("VAOを作れません");
    gl.bindVertexArray(vao);
    const attr = (name: string, data: Float32Array | Uint8Array, size: number, type: number, normalized: boolean, divisor: number) => {
      const buf = gl.createBuffer();
      if (!buf) throw new Error("バッファを作れません");
      this.boxBuffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = this.box.a(name);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, type, normalized, 0, 0);
        gl.vertexAttribDivisor(loc, divisor);
      }
      return buf;
    };
    attr("aU", new Float32Array(u), 2, gl.FLOAT, false, 0);
    attr("aFace", new Float32Array(face), 1, gl.FLOAT, false, 0);
    attr("iA", inst.a, 4, gl.FLOAT, false, 1);
    attr("iB", inst.b, 2, gl.FLOAT, false, 1);
    // 壁と屋根の色は、同じバッファの前半4バイト・後半4バイト
    const cb = gl.createBuffer();
    if (!cb) throw new Error("バッファを作れません");
    this.boxBuffers.push(cb);
    gl.bindBuffer(gl.ARRAY_BUFFER, cb);
    gl.bufferData(gl.ARRAY_BUFFER, inst.colors, gl.STATIC_DRAW);
    for (const [name, offset] of [
      ["iWall", 0],
      ["iRoof", 4],
    ] as const) {
      const loc = this.box.a(name);
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.UNSIGNED_BYTE, true, 8, offset);
        gl.vertexAttribDivisor(loc, 1);
      }
    }
    const ib = gl.createBuffer();
    if (!ib) throw new Error("バッファを作れません");
    this.boxBuffers.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(idx), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.boxVao = vao;
    this.boxCount = inst.count;
  }

  /** 夜景の光の点(建物1棟につき1つ。x,y,z と大きさの4つ組)。null で外す */
  setBuildingLights(lights: Float32Array | null): void {
    const gl = this.gl;
    if (this.lightVao) gl.deleteVertexArray(this.lightVao);
    if (this.lightBuf) gl.deleteBuffer(this.lightBuf);
    this.lightVao = null;
    this.lightBuf = null;
    this.lightCount = 0;
    if (!lights || lights.length < 4) return;
    const lv = gl.createVertexArray();
    const lb = gl.createBuffer();
    if (!lv || !lb) return;
    gl.bindVertexArray(lv);
    gl.bindBuffer(gl.ARRAY_BUFFER, lb);
    gl.bufferData(gl.ARRAY_BUFFER, lights, gl.STATIC_DRAW);
    const loc = this.lights.a("aL");
    if (loc >= 0) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);
    this.lightVao = lv;
    this.lightBuf = lb;
    this.lightCount = Math.floor(lights.length / 4);
  }

  // ---- 星座 ----

  setConstellations(d: ConstellationGlData | null): void {
    const gl = this.gl;
    if (!d || (d.lineCount === 0 && d.pointCount === 0)) {
      this.lineCount = 0;
      this.starCount = 0;
      return;
    }
    // 線
    if (!this.lineVao) {
      const vao = gl.createVertexArray();
      const buf = gl.createBuffer();
      const ib = gl.createBuffer();
      if (!vao || !buf || !ib) throw new Error("バッファを作れません");
      this.lineVao = vao;
      this.lineBuf = buf;
      this.lineIdx = ib;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const stride = 9 * 4;
      const bind = (name: string, size: number, offset: number) => {
        const loc = this.line.a(name);
        if (loc < 0) return;
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
      };
      bind("aA", 3, 0);
      bind("aB", 3, 3);
      bind("aV", 2, 6);
      bind("aKind", 1, 8);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bindVertexArray(null);
    }
    if (this.lineBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.bufferData(gl.ARRAY_BUFFER, d.lines, gl.DYNAMIC_DRAW);
    }
    if (this.lineIdx && d.lineCount > this.lineIdxCap) {
      const idx = new Uint16Array(d.lineCount * 6);
      for (let i = 0; i < d.lineCount; i++) {
        const b = i * 4;
        idx.set([b, b + 1, b + 2, b + 2, b + 1, b + 3], i * 6);
      }
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.lineIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
      gl.bindVertexArray(null);
      this.lineIdxCap = d.lineCount;
    }
    this.lineCount = d.lineCount;
    // 星
    if (!this.starVao) {
      const vao = gl.createVertexArray();
      const buf = gl.createBuffer();
      if (!vao || !buf) throw new Error("バッファを作れません");
      this.starVao = vao;
      this.starBuf = buf;
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      const loc = this.star.a("aStar");
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, 0, 0);
      }
      gl.bindVertexArray(null);
    }
    if (this.starBuf) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.starBuf);
      gl.bufferData(gl.ARRAY_BUFFER, d.points, gl.DYNAMIC_DRAW);
    }
    this.starCount = d.pointCount;
  }

  // ---- 描画 ----

  private setScene(prog: Prog, p: FrameParams, vp: Mat4, lfOn: boolean, lcOn: boolean, sea: SeaDraw): void {
    const gl = this.gl;
    const u = (n: string) => prog.u(n);
    gl.uniformMatrix4fv(u("uVP"), false, vp);
    gl.uniform3fv(u("uSunDir"), p.sunDir);
    gl.uniform3fv(u("uSunColor"), p.look.sunColor);
    gl.uniform1f(u("uSunStrength"), p.look.sunStrength);
    gl.uniform3fv(u("uMoonDir"), p.moonDir);
    gl.uniform3fv(u("uMoonColor"), p.look.moonColor);
    gl.uniform1f(u("uMoonStrength"), p.look.moonStrength);
    gl.uniform3fv(u("uAmbient"), p.look.ambient);
    gl.uniform3fv(u("uFogColor"), p.look.horizon);
    const rangeM = p.rangeM ?? 25_000;
    gl.uniform1f(u("uFogDensity"), 1 / (52_000 * (rangeM / 25_000)));
    gl.uniform3fv(u("uCam"), p.eye);
    gl.uniform2f(u("uEdge"), rangeM * 0.76, rangeM * 0.992);
    gl.uniform1i(u("uLfMap"), 4);
    gl.uniform1i(u("uLfHeight"), 5);
    gl.uniform1f(u("uLfOn"), lfOn ? 1 : 0);
    if (p.layerFog) {
      gl.uniform4fv(u("uLfRect"), p.layerFog.rect);
      gl.uniform3fv(u("uLfCol"), p.layerFog.color);
      gl.uniform1f(u("uLfSigma"), p.layerFog.sigma);
      gl.uniform1f(u("uLfTop"), p.layerFog.top);
    }
    gl.uniform1i(u("uCsMap"), 10);
    gl.uniform1f(u("uShOn"), sea.shade ? 1 : 0);
    gl.uniform1f(u("uHq"), sea.hq ? 1 : 0);
    gl.uniform1f(u("uCsOn"), sea.on ? 1 : 0);
    gl.uniform4fv(u("uCsRect"), sea.rect);
    gl.uniform1f(u("uCsH"), sea.h);
    gl.uniform1f(u("uCsThick"), SEA_THICK_M);
    gl.uniform1f(u("uCsSigma"), SEA_SIGMA);
    gl.uniform3fv(u("uCsCol"), sea.col);
    gl.uniform1i(u("uLcMap"), 6);
    gl.uniform1f(u("uLcOn"), lcOn ? 1 : 0);
    if (p.cloud) {
      gl.uniform4fv(u("uLcRect"), p.cloud.rect);
      gl.uniform3fv(u("uLcCol"), p.cloud.color);
      gl.uniform1f(u("uLcSigma"), p.cloud.sigma);
      gl.uniform2fv(u("uLcAlt"), p.cloud.alt);
    }
  }

  /** 地形の後に、木と建物を描く(奥行きあり) */
  drawSolids(p: FrameParams, vp: Mat4, lfOn: boolean, lcOn: boolean, bldgGlow = 0, sea: SeaDraw = NO_SEA): void {
    const gl = this.gl;
    if (p.showBuildings && this.bldgVao) {
      gl.useProgram(this.bldg.program);
      this.setScene(this.bldg, p, vp, lfOn, lcOn, sea);
      gl.uniform1f(this.bldg.u("uBldgGlow"), bldgGlow * BUILDING_GLOW_SCALE);
      this.bindDid(this.bldg);
      gl.bindVertexArray(this.bldgVao);
      gl.drawElements(gl.TRIANGLES, this.bldgIndexCount, gl.UNSIGNED_INT, 0);
    }
    if (p.showBuildings && this.boxVao && this.boxCount > 0) {
      gl.useProgram(this.box.program);
      this.setScene(this.box, p, vp, lfOn, lcOn, sea);
      gl.uniform1f(this.box.u("uBldgGlow"), bldgGlow * BUILDING_GLOW_SCALE);
      this.bindDid(this.box);
      gl.bindVertexArray(this.boxVao);
      gl.drawElementsInstanced(gl.TRIANGLES, 18, gl.UNSIGNED_SHORT, 0, this.boxCount);
    }
    if (p.showTrees) {
      let started = false;
      for (const t of Object.values(this.trees)) {
        if (!started) {
          gl.useProgram(this.tree.program);
          this.setScene(this.tree, p, vp, lfOn, lcOn, sea);
          started = true;
        }
        gl.bindVertexArray(t.vao);
        gl.drawElementsInstanced(gl.TRIANGLES, t.indexCount, gl.UNSIGNED_SHORT, 0, t.count);
      }
    }
    gl.bindVertexArray(null);
  }

  /**
   * 空の後に、夜の建物の明かり(光の点)を加算で重ねる(地形より奥の画素にだけ出る)。雲海の表は、空の描画がユニット11に貼ったまま。
   * bldgGlow=夜の強さ(0なら描かない)
   */
  drawLights(p: FrameParams, vp: Mat4, lfOn: boolean, lcOn: boolean, bldgGlow: number, sea: SeaDraw): void {
    if (bldgGlow <= 0 || !p.showBuildings || !this.lightVao || this.lightCount === 0) return;
    const gl = this.gl;
    gl.useProgram(this.lights.program);
    this.setScene(this.lights, p, vp, lfOn, lcOn, sea);
    gl.uniform1i(this.lights.u("uCsMap"), 11);
    const tanY = Math.tan((p.fovDeg * Math.PI) / 360);
    gl.uniform1f(this.lights.u("uPxPerRad"), p.height / (2 * tanY));
    gl.uniform1f(this.lights.u("uDpr"), p.dpr ?? 1);
    gl.uniform1f(this.lights.u("uGlowK"), bldgGlow * BUILDING_GLOW_SCALE);
    this.bindDid(this.lights);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.bindVertexArray(this.lightVao);
    gl.drawArrays(gl.POINTS, 0, this.lightCount);
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  /** 空の後に、星座の星と線を重ねる(地形より奥の画素にだけ出る) */
  drawConstellations(p: FrameParams, vp: Mat4, sea: SeaDraw = NO_SEA): void {
    const gl = this.gl;
    // 雲海の層(星・線は雲に隠れる)。表は空の描画がユニット11に貼ったまま
    const setSea = (prog: Prog) => {
      gl.uniform1i(prog.u("uCsMap"), 11);
      gl.uniform4fv(prog.u("uCsRect"), sea.rect);
      gl.uniform1f(prog.u("uCsOn"), sea.on ? 1 : 0);
      gl.uniform1f(prog.u("uCsH"), sea.h);
      gl.uniform1f(prog.u("uCsThick"), SEA_THICK_M);
      gl.uniform1f(prog.u("uCsSigma"), SEA_SIGMA);
    };
    const strength = p.constellation?.strength ?? 0;
    if (strength <= 0.01 || (this.lineCount === 0 && this.starCount === 0)) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    if (this.lineCount > 0 && this.lineVao) {
      gl.useProgram(this.line.program);
      gl.uniformMatrix4fv(this.line.u("uVP"), false, vp);
      gl.uniform3fv(this.line.u("uCam"), p.eye);
      gl.uniform2f(this.line.u("uViewport"), p.width, p.height);
      gl.uniform1f(this.line.u("uWidthPx"), Math.max(1.6, p.width / 700) * (p.dpr ?? 1));
      gl.uniform1f(this.line.u("uStrength"), strength);
      setSea(this.line);
      gl.bindVertexArray(this.lineVao);
      gl.drawElements(gl.TRIANGLES, this.lineCount * 6, gl.UNSIGNED_SHORT, 0);
    }
    if (this.starCount > 0 && this.starVao) {
      gl.useProgram(this.star.program);
      gl.uniformMatrix4fv(this.star.u("uVP"), false, vp);
      gl.uniform3fv(this.star.u("uCam"), p.eye);
      gl.uniform1f(this.star.u("uDpr"), p.dpr ?? 1);
      gl.uniform1f(this.star.u("uStrength"), strength);
      setSea(this.star);
      gl.bindVertexArray(this.starVao);
      gl.drawArrays(gl.POINTS, 0, this.starCount);
    }
    gl.bindVertexArray(null);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  dispose(): void {
    const gl = this.gl;
    this.clearTrees();
    this.setBuildings(null);
    this.setBuildingBoxes(null);
    this.setBuildingLights(null);
    if (this.didTex) gl.deleteTexture(this.didTex);
    this.didTex = null;
    if (this.lineVao) gl.deleteVertexArray(this.lineVao);
    if (this.lineBuf) gl.deleteBuffer(this.lineBuf);
    if (this.lineIdx) gl.deleteBuffer(this.lineIdx);
    if (this.starVao) gl.deleteVertexArray(this.starVao);
    if (this.starBuf) gl.deleteBuffer(this.starBuf);
    for (const p of [this.tree, this.bldg, this.box, this.lights, this.line, this.star]) gl.deleteProgram(p.program);
  }
}
