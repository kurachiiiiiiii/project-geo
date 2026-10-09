/** 3Dビューワーのシェーダーで共通に使う部品(霧・雲・光・大気・コンパイル) */

/**
 * 地面から一定の高さ(約100m)までの霧(「霧の層」)。霧の濃さの地図(uLfMap)と地面の高さの地図
 * (uLfHeight)を、視点から見ている点までの視線に沿って刻み、霧の層の中を通った長さに比例する
 * 光学的厚み(tau)を足し合わせる。霧の層は「その場所の地面+uLfTop」までなので、斜面に沿って厚みが変わらない。
 * 標本は視線の両端に密(余弦間隔)にしてある: 霧は地面ぎわ(=視線の端)にあるのが普通なので、
 * 少ない標本数でも、足元の霧と、遠くの谷底の霧のどちらも拾える。
 */
export const FOG_GLSL = `
uniform sampler2D uLfMap;
uniform sampler2D uLfHeight;
uniform vec4 uLfRect;
uniform float uLfOn;
uniform vec3 uLfCol;
uniform float uLfSigma;
uniform float uLfTop;
// 層の濃さ(地面からの高さh→1〜0。上端に向かってなめらかに薄くなる)の、hでの積分(原始関数)
float lfInt(float h) {
  float a = uLfTop * 0.6;
  float w = uLfTop - a;
  if (h <= a) return h;
  float x = clamp((h - a) / w, 0.0, 1.0);
  return a + w * (x - (x * x * x - 0.5 * x * x * x * x));
}
// 区間の両端の高さ(h0→h1)が直線的に変わるとして、層の濃さの区間平均を式で求める。
// (薄い層を粗い刻みでサンプリングすると縞になるので、層を通る長さは式で出す)
float lfAvgLayer(float h0, float h1) {
  float dh = h1 - h0;
  if (abs(dh) < 0.5) return 1.0 - smoothstep(uLfTop * 0.6, uLfTop, 0.5 * (h0 + h1));
  return (lfInt(h1) - lfInt(h0)) / dh;
}
float lfHeightAbove(vec3 p, vec2 uv) {
  return p.y - texture(uLfHeight, uv).r;
}
float lfTau(vec3 o, vec3 d, float len) {
  const int N = 40;
  float tau = 0.0;
  float tPrev = 0.0;
  float hPrev = 0.0;
  bool hPrevOk = false;
  float dPrev = 0.0;
  vec3 pPrev = o;
  vec2 uvPrev = vec2(-1.0);
  for (int i = 0; i <= N; i++) {
    float t = len * 0.5 * (1.0 - cos(3.14159265 * float(i) / float(N)));
    vec3 p = o + d * t;
    vec2 uv = (p.xz - uLfRect.xy) / uLfRect.zw;
    float dens = 0.0;
    if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) dens = texture(uLfMap, uv).r;
    float h = 0.0;
    bool hOk = false;
    if (i > 0 && dens + dPrev > 0.0) {
      // 霧のある区間だけ地面の高さを読む(霧の無い所は濃さの地図だけで済ませる)
      h = lfHeightAbove(p, uv);
      hOk = true;
      if (!hPrevOk) hPrev = lfHeightAbove(pPrev, clamp(uvPrev, 0.0, 1.0));
      tau += uLfSigma * 0.5 * (dens + dPrev) * lfAvgLayer(hPrev, h) * (t - tPrev);
    }
    tPrev = t;
    hPrev = h;
    hPrevOk = hOk;
    dPrev = dens;
    pPrev = p;
    uvPrev = uv;
  }
  return tau;
}
`;
/**
 * 雲の層(衛星画像の雲判定メッシュ)。海抜uLcAlt.x〜uLcAlt.yの水平な層を、視線が通る範囲を式で求め、
 * その中を12点でたどって雲の濃さの地図(uLcMap)を足し合わせる(光学的厚みtau)。
 * 白(雲あり)=1、グレー(半分くらい)=約0.26。whiteは、通った雲のうち白いセルの割合(グレーは暗い色で描くのに使う)。
 */
export const CLOUD_GLSL = `
uniform sampler2D uLcMap;
uniform vec4 uLcRect;
uniform float uLcOn;
uniform vec3 uLcCol;
uniform float uLcSigma;
uniform vec2 uLcAlt;
void lcMarch(vec3 o, vec3 d, float len, out float tau, out float white) {
  tau = 0.0;
  white = 0.0;
  float t0;
  float t1;
  if (abs(d.y) < 1.0e-4) {
    if (o.y < uLcAlt.x || o.y > uLcAlt.y) return;
    t0 = 0.0;
    t1 = len;
  } else {
    float ta = (uLcAlt.x - o.y) / d.y;
    float tb = (uLcAlt.y - o.y) / d.y;
    t0 = max(min(ta, tb), 0.0);
    t1 = min(max(ta, tb), len);
  }
  if (t1 <= t0) return;
  const int N = 12;
  float dt = (t1 - t0) / float(N);
  float sumAll = 0.0;
  float sumWhite = 0.0;
  for (int i = 0; i < N; i++) {
    vec3 p = o + d * (t0 + (float(i) + 0.5) * dt);
    vec2 uv = (p.xz - uLcRect.xy) / uLcRect.zw;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
    float dens = texture(uLcMap, uv).r;
    tau += uLcSigma * dens * dt;
    sumAll += dens;
    sumWhite += dens * smoothstep(0.45, 0.75, dens);
  }
  if (sumAll > 0.0) white = sumWhite / sumAll;
}
`;



/** 光の当たり方(環境光+太陽+月明かり)。法線Nの面の明るさ */
export const LIGHT_GLSL = `
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uSunStrength;
uniform vec3 uMoonDir;
uniform vec3 uMoonColor;
uniform float uMoonStrength;
uniform vec3 uAmbient;
vec3 sceneLight(vec3 N) {
  return uAmbient
    + uSunColor * (uSunStrength * 0.75 * max(dot(N, uSunDir), 0.0))
    + uMoonColor * (uMoonStrength * 0.35 * max(dot(N, uMoonDir), 0.0));
}
`;

/** 簡単な値ノイズ(岸のコンクリートの模様・水面のさざ波に使う) */
export const NOISE_GLSL = `
float h21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float vn2(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1.0, 0.0)), f.x), mix(h21(i + vec2(0.0, 1.0)), h21(i + vec2(1.0, 1.0)), f.x), f.y);
}
`;

/**
 * 雲海(厚さ100mの水平に近い雲の層)。層の下面 = 地図(uCsMap)の「基準の標高」+ uCsH(m)、上面 = 下面 + uCsThick。
 * 基準の標高は、まわりの市街地(森林でない所)の標高をなめらかにつないだもの(`viewerSea.ts`)。地球の丸みで遠くの層も下がる(地形と同じ)。
 * 視線を、視点からの距離の約1.6乗の間隔で22区間に分け、各区間が層の中を通る長さ(式で求める)を足して光学的厚み(tau)にする。
 * 雲の色のむら(shade)は、通った場所のノイズの平均。
 */
export const SEA_GLSL = `
uniform sampler2D uCsMap;
uniform vec4 uCsRect;
uniform float uCsOn;
uniform float uCsH;
uniform float uCsThick;
uniform float uCsSigma;
uniform vec3 uCsCol;
float csHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float csNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(csHash(i), csHash(i + vec2(1.0, 0.0)), f.x), mix(csHash(i + vec2(0.0, 1.0)), csHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
// 視点が雲海の層の下面より下にいるほど1(雲を下から見るので、少し暗く見える)。視点の真下の層の下面と比べる
float csUnder(vec3 cam) {
  vec2 cuv = clamp((cam.xz - uCsRect.xy) / uCsRect.zw, 0.0, 1.0);
  float baseC = textureLod(uCsMap, cuv, 0.0).r + uCsH - 0.87 * dot(cam.xz, cam.xz) / 12742000.0;
  return 1.0 - smoothstep(-40.0, 10.0, cam.y - baseC);
}
void csMarch(vec3 o, vec3 d, float len, out float tau, out float shade) {
  tau = 0.0;
  shade = 0.5;
  const int N = 22;
  float prevT = 0.0;
  float wsum = 0.0;
  float ssum = 0.0;
  for (int i = 1; i <= N; i++) {
    float t = len * pow(float(i) / float(N), 1.6);
    float tm = 0.5 * (prevT + t);
    vec3 pm = o + d * tm;
    vec2 uv = (pm.xz - uCsRect.xy) / uCsRect.zw;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
      float ref = textureLod(uCsMap, uv, 0.0).r;
      float drop = 0.87 * dot(pm.xz, pm.xz) / 12742000.0;
      float base = ref + uCsH - drop;
      float top = base + uCsThick;
      float ov;
      if (abs(d.y) < 1.0e-4) {
        ov = (o.y >= base && o.y <= top) ? (t - prevT) : 0.0;
      } else {
        float tl = (base - o.y) / d.y;
        float th = (top - o.y) / d.y;
        float t0 = max(prevT, min(tl, th));
        float t1 = min(t, max(tl, th));
        ov = max(t1 - t0, 0.0);
      }
      if (ov > 0.0) {
        float n = csNoise(pm.xz * 0.0012) * 0.5 + csNoise(pm.xz * 0.0055) * 0.32 + csNoise(pm.xz * 0.021) * 0.18;
        tau += uCsSigma * ov * (0.86 + 0.14 * n);
        wsum += ov;
        ssum += ov * n;
      }
    }
    prevT = t;
  }
  if (wsum > 0.0) shade = ssum / wsum;
}
`;

/**
 * 空の向きdの先が雲海の層をどれだけ通るか(光学的厚みtau)と、雲の色のむら(shade)。
 * 層の下から見上げたとき、青空ではなく雲の底が見えるようにするための式(空・星・星座の描画で使う)。
 * 層を通り抜ける長さは、真上なら高さの差、低い角度ほど長い(最大60km)。SEA_GLSL を含む。
 */
export const SEA_SKY_GLSL = `
${SEA_GLSL}
float seaSkyTau(vec3 o, vec3 d, out float shade) {
  float len = d.y > 0.0 ? min(60000.0, 2600.0 / max(d.y, 0.001)) : 60000.0;
  float tau;
  csMarch(o, d, len, tau, shade);
  return tau;
}
`;

/**
 * 大気(地面から約100mの霧の層・雲海・雲の層・距離による霞)を、色colに掛ける。地形・木・建物で共通。
 * 使うには FOG_GLSL と CLOUD_GLSL を先に入れておく。
 */
export const ATMOS_GLSL = `
${SEA_GLSL}
uniform vec3 uCam;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec2 uEdge;
// 処理「高」の追加効果が有効なとき1(太陽の方向の霞の散乱など)
uniform float uHq;
vec3 applyAtmos(vec3 col, vec3 pos) {
  vec3 ray = pos - uCam;
  float rl = max(length(ray), 0.001);
  if (uLfOn > 0.5) {
    float tau = lfTau(uCam, ray / rl, rl);
    col = mix(col, uLfCol, 1.0 - exp(-tau));
  }
  if (uCsOn > 0.5) {
    float stau;
    float sshade;
    csMarch(uCam, ray / rl, rl, stau, sshade);
    col = mix(col, uCsCol * (0.8 + 0.3 * sshade) * mix(1.0, 0.66, csUnder(uCam)), 1.0 - exp(-stau));
  }
  if (uLcOn > 0.5) {
    float ctau;
    float cwhite;
    lcMarch(uCam, ray / rl, rl, ctau, cwhite);
    col = mix(col, uLcCol * mix(0.67, 1.0, cwhite), 1.0 - exp(-ctau));
  }
  float f = 1.0 - exp(-pow(rl * uFogDensity, 2.0));
  float fe = smoothstep(uEdge.x, uEdge.y, length(pos.xz));
  if (uHq > 0.5) {
    // 太陽の方向を見ると、遠くの霞が太陽の色で明るく光る(前方散乱)。地形の端を空へとかす分(fe)には掛けない(空と色がずれるので)
    float cs = max(dot(ray / rl, uSunDir), 0.0);
    float lobe = pow(cs, 8.0) * 0.8 + pow(cs, 64.0) * 1.2;
    vec3 fogC = min(uFogColor + uSunColor * (uSunStrength * 0.24 * lobe), vec3(1.0));
    return mix(mix(col, fogC, f), uFogColor, fe);
  }
  return mix(col, uFogColor, max(f, fe));
}
`;

/**
 * 山の影と谷・くぼ地の暗がり(処理「高」。`viewerShade.ts`)を掛けた光の当たり方。雲海の地図(uCsMap。RGBA16F)の
 * G=太陽の影(符号付き。smoothstep(-0.5, 0.5, g)が影の濃さ)、B=暗がり(環境光に掛ける)を、位置(uCsRect)から引く。
 * uShOn=0 のとき・地図の範囲外は、従来の sceneLight と同じ。ATMOS_GLSL(uCsMap・uCsRect の宣言)のあとに入れる。
 */
export const SHADE_GLSL = `
uniform float uShOn;
vec3 sceneLightAt(vec3 N, vec3 pos) {
  float sunK = 1.0;
  float ao = 1.0;
  if (uShOn > 0.5) {
    vec2 suv = (pos.xz - uCsRect.xy) / uCsRect.zw;
    if (suv.x > 0.0 && suv.x < 1.0 && suv.y > 0.0 && suv.y < 1.0) {
      vec3 m = textureLod(uCsMap, suv, 0.0).rgb;
      sunK = 1.0 - smoothstep(-0.5, 0.5, m.g);
      ao = m.b;
    }
  }
  return uAmbient * ao
    + uSunColor * (uSunStrength * 0.75 * max(dot(N, uSunDir), 0.0) * sunK)
    + uMoonColor * (uMoonStrength * 0.35 * max(dot(N, uMoonDir), 0.0));
}
`;

export function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error("シェーダーを作れません");
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`シェーダーのコンパイルに失敗: ${log}`);
  }
  return sh;
}

export function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram();
  if (!p) throw new Error("プログラムを作れません");
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`プログラムのリンクに失敗: ${gl.getProgramInfoLog(p)}`);
  }
  return p;
}

