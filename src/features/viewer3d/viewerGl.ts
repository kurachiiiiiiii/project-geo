import { cameraBasis, mulMat4, perspective, viewMatrix, type Mat4, type Vec3 } from "./viewerMath";
import { ObjectRenderer, type SeaDraw } from "./viewerObjectsGl";
import type { SkyLook } from "./viewerSky";
import type { WaterMask } from "./viewerWater";
import { ATMOS_GLSL, CLOUD_GLSL, FOG_GLSL, LIGHT_GLSL, NOISE_GLSL, SEA_SKY_GLSL, SHADE_GLSL, link } from "./viewerGlsl";
import type { OverlayImage, TerrainMesh } from "./viewerTerrain";
import { trackGlMemory, type GlMemoryReport } from "./viewerDiag";
import { SEA_SIGMA, SEA_THICK_M } from "./viewerSea";
import { VEG_SATURATION } from "./viewerQuality";

/**
 * 3Dビューワー: WebGL2で、空(太陽・月・星)と地形を描く。
 * 外部のライブラリ(three.jsなど)は使わず、必要な分だけを直接書いている
 * (依存を増やすとPC側で`npm install`が要るようになり、アプリが起動しなくなる危険があるため)。
 *
 * 空はフルスクリーンの三角形で、画素ごとの視線方向から色を決める(太陽・月の円盤、月の満ち欠け、星も
 * ここで描くので、山の稜線の後ろに自然に隠れる)。地形は、下地の地図と紅葉メッシュのテクスチャを
 * 地形の位置から引いて、太陽・月明かりの当たり方(法線)と霞(距離)で陰をつける。
 */

const TERRAIN_VS = `#version 300 es
precision highp float;
uniform mat4 uVP;
in vec3 aPos;
in vec3 aNrm;
out vec3 vPos;
out vec3 vNrm;
void main() {
  vPos = aPos;
  vNrm = aNrm;
  gl_Position = uVP * vec4(aPos, 1.0);
}`;

const TERRAIN_FS = `#version 300 es
precision highp float;
uniform sampler2D uFarBase;
uniform sampler2D uNearBase;
// 中景の下地(描画範囲の拡張+処理「高」のときだけ。遠景より細かい画像を、約26kmまで重ねる)
uniform sampler2D uMidBase;
uniform vec4 uMidRect;
uniform float uMidOn;
// 足もとの下地(処理「高」のときだけ。近景よりさらに細かい画像を、足もと約1.3kmに重ねる。画像のないタイルは透明=近景のまま)
uniform sampler2D uFootBase;
uniform vec4 uFootRect;
uniform float uFootOn;
// 足もとの画像は、最大の大きさで1度だけ確保したテクスチャの左上に貼る(動くたびに確保し直さない)。uFootAt = 画像の大きさ÷テクスチャの大きさ
uniform vec2 uFootAt;
// 最も細かい下地(処理「高」のときだけ。カメラのまわり約±300mに、ズーム18の画像を重ねる。足もとと同じく、画像のない所は透明)
// と、広い足もとの下地(カメラのまわり約±4kmに、ズーム15の画像を、近景と足もと(ズーム17)の間に重ねる)。
// この2つは、テクスチャユニットを増やせないので、1枚のテクスチャ(uFineBase)の上下に並べて(アトラス)貼る。uFineAt/uWFootAt = (開始u, 開始v, uの幅, vの幅)
uniform sampler2D uFineBase;
uniform vec4 uFineRect;
uniform vec4 uFineAt;
uniform float uFineOn;
uniform vec4 uWFootRect;
uniform vec4 uWFootAt;
uniform float uWFootOn;
// 向いている方向の遠く(約20km先まで。ズーム14・約7.7m/画素)の下地。これも同じテクスチャ(アトラス)の上段
uniform vec4 uAheadRect;
uniform vec4 uAheadAt;
uniform float uAheadOn;
uniform sampler2D uFarOv;
uniform sampler2D uNearOv;
uniform vec4 uFarRect;
uniform vec4 uNearRect;
uniform float uNearOn;
uniform float uNearOvOn;
uniform float uOvOpacity;
// 川・池の水の地図(R=水、G=岸)。near=足もと用(細かい)、wide=広い範囲用、far=地形の端まで(粗い。処理「中・高」のとき)
uniform sampler2D uWaterNear;
uniform sampler2D uWaterWide;
uniform sampler2D uWaterFar;
uniform vec4 uWaterNearRect;
uniform vec4 uWaterWideRect;
uniform vec4 uWaterFarRect;
uniform vec3 uWaterOn;
uniform vec3 uZenith;
// 地面の光(夜に光る)。uGroundLight=建物の光(白)のR=強さ(250m区画)。uRoadLight=道路の光(オレンジ)のR=強さ(約39m/画素、ミップマップ付き。
// 同じ範囲uGroundLightRectを覆う)。uGroundGlowK=夜の強さ(0なら光らない)。uRoadOn=道路の光の地図があるか
uniform sampler2D uGroundLight;
uniform sampler2D uRoadLight;
uniform vec4 uGroundLightRect;
uniform float uGroundGlowK;
uniform float uRoadOn;
in vec3 vPos;
in vec3 vNrm;
out vec4 outColor;
${FOG_GLSL}
${CLOUD_GLSL}
${LIGHT_GLSL}
${NOISE_GLSL}
${ATMOS_GLSL}
${SHADE_GLSL}
// (水, 岸) の濃さ。足もと用があればそちらを優先し、端でなめらかに広い方へ移る
vec2 waterMaskAt(vec3 p) {
  vec2 r = vec2(0.0);
  if (uWaterOn.z > 0.5) {
    vec2 uv = (p.xz - uWaterFarRect.xy) / uWaterFarRect.zw;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
      vec2 e = min(uv, 1.0 - uv);
      r = textureLod(uWaterFar, uv, 0.0).rg * smoothstep(0.0, 0.01, min(e.x, e.y));
    }
  }
  if (uWaterOn.x > 0.5) {
    vec2 uv = (p.xz - uWaterWideRect.xy) / uWaterWideRect.zw;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
      vec2 e = min(uv, 1.0 - uv);
      r = mix(r, textureLod(uWaterWide, uv, 0.0).rg, smoothstep(0.0, 0.02, min(e.x, e.y)));
    }
  }
  if (uWaterOn.y > 0.5) {
    vec2 uv = (p.xz - uWaterNearRect.xy) / uWaterNearRect.zw;
    if (uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0) {
      vec2 e = min(uv, 1.0 - uv);
      r = mix(r, textureLod(uWaterNear, uv, 0.0).rg, smoothstep(0.0, 0.03, min(e.x, e.y)));
    }
  }
  return r;
}
void main() {
  vec2 fuv = (vPos.xz - uFarRect.xy) / uFarRect.zw;
  vec3 baseF = texture(uFarBase, fuv).rgb;
  vec4 ovF = texture(uFarOv, fuv);
  vec2 nuv = (vPos.xz - uNearRect.xy) / uNearRect.zw;
  vec3 baseN = texture(uNearBase, nuv).rgb;
  vec4 ovN = texture(uNearOv, nuv);
  vec2 e = min(nuv, 1.0 - nuv);
  float wn = smoothstep(0.0, 0.12, min(e.x, e.y)) * uNearOn;
  vec2 muv = (vPos.xz - uMidRect.xy) / uMidRect.zw;
  vec3 baseM = texture(uMidBase, muv).rgb;
  vec2 me = min(muv, 1.0 - muv);
  float wmid = smoothstep(0.0, 0.06, min(me.x, me.y)) * uMidOn;
  vec3 base = mix(baseF, baseM, wmid);
  // 向いている方向の遠くの下地(乗算済みアルファ。約20km先まで): 遠景(約15m/画素)と近景・広い足もと(約3.8m/画素)の間をなめらかにつなぐ(近景より下に敷く)。
  // 縁は広い幅(窓の12%=約2.4km)でぼかして、解像度の境目が急に見えないようにする
  vec2 auv = (vPos.xz - uAheadRect.xy) / uAheadRect.zw;
  vec4 baseA = texture(uFineBase, uAheadAt.xy + auv * uAheadAt.zw);
  vec2 ae = min(auv, 1.0 - auv);
  float wah = smoothstep(0.0, 0.12, min(ae.x, ae.y)) * uAheadOn;
  base = base * (1.0 - baseA.a * wah) + baseA.rgb * wah;
  base = mix(base, baseN, wn);
  // 広い足もとの下地(カメラの向いている方向へ約8km・うしろへ約1kmの窓。乗算済みアルファ): 縁は窓の14%(約1.3km)でぼかす
  vec2 wuv = (vPos.xz - uWFootRect.xy) / uWFootRect.zw;
  vec4 baseW = texture(uFineBase, uWFootAt.xy + wuv * uWFootAt.zw);
  vec2 we = min(wuv, 1.0 - wuv);
  float wwf = smoothstep(0.0, 0.14, min(we.x, we.y)) * uWFootOn;
  base = base * (1.0 - baseW.a * wwf) + baseW.rgb * wwf;
  // 足もとの下地(乗算済みアルファ): 範囲のへりと、画像のない所では、下の近景の画像へなめらかにつなぐ
  vec2 tuv = (vPos.xz - uFootRect.xy) / uFootRect.zw;
  vec4 baseT = texture(uFootBase, tuv * uFootAt);
  vec2 te = min(tuv, 1.0 - tuv);
  float wfoot = smoothstep(0.0, 0.14, min(te.x, te.y)) * uFootOn;
  base = base * (1.0 - baseT.a * wfoot) + baseT.rgb * wfoot;
  vec2 guv2 = (vPos.xz - uFineRect.xy) / uFineRect.zw;
  vec4 baseG = texture(uFineBase, uFineAt.xy + guv2 * uFineAt.zw);
  vec2 gm = min(guv2, 1.0 - guv2);
  float wfine = smoothstep(0.0, 0.07, min(gm.x, gm.y)) * uFineOn;
  base = base * (1.0 - baseG.a * wfine) + baseG.rgb * wfine;
  // 近くの地面は、写真の細かさの限界(約0.5m/画素)を超えてぼやけて見えるので、足もとほど細かい濃淡(土・草のきめ)を足す
  float camG = length(vPos - uCam);
  float grain = 1.0 - smoothstep(18.0, 160.0, camG);
  if (grain > 0.0) {
    float g1 = vn2(vPos.xz * 1.9);
    float g2 = vn2(vPos.xz * 6.3 + 7.0);
    float g3 = vn2(vPos.xz * 17.0 + 3.0);
    base *= 1.0 + grain * ((g1 - 0.5) * 0.2 + (g2 - 0.5) * 0.16 + (g3 - 0.5) * 0.1 * (1.0 - smoothstep(18.0, 70.0, camG)));
  }
  vec4 ov = mix(ovF, ovN, wn * uNearOvOn);
  // 植生の色(紅葉メッシュ)の彩度を2割下げる(「全体的に植生地面の彩度を20%さげて」)。乗算済みアルファのままで、明るさは変えない
  ov.rgb = mix(vec3(dot(ov.rgb, vec3(0.299, 0.587, 0.114))), ov.rgb, ${VEG_SATURATION.toFixed(2)});
  // 紅葉メッシュ(乗算済みアルファ)を下地の地図に重ねる
  vec3 col = base * (1.0 - ov.a * uOvOpacity) + ov.rgb * uOvOpacity;
  vec3 N = normalize(vNrm);
  vec3 light = sceneLightAt(N, vPos);
  col *= light;

  // 地面の光(光害): 建物のある所(森林以外)は白く、道路は白色気味の街灯の色に光る(道路は空の光害には影響しない)。近くでは家や街灯の点も散らす
  if (uGroundGlowK > 0.0) {
    vec2 guv = (vPos.xz - uGroundLightRect.xy) / uGroundLightRect.zw;
    vec2 ge = min(guv, 1.0 - guv);
    float gin = smoothstep(0.0, 0.04, min(ge.x, ge.y));
    // 道路の光の地図は、遠くで細い線がちらつかないよう、画素の大きさに合わせてぼかして引く(分岐の前に画素の広がりを求める)
    float roadLod = clamp(log2(max(length(fwidth(vPos.xz)), 1.0) / (uGroundLightRect.z / 2048.0)), 0.0, 7.0);
    if (gin > 0.0) {
      float lit = textureLod(uGroundLight, guv, 0.0).r * gin;
      float road = uRoadOn > 0.5 ? textureLod(uRoadLight, guv, roadLod).r * gin : 0.0;
      float camD = length(vPos - uCam);
      if (lit > 0.004) {
        float blotch = 0.75 + 0.5 * vn2(vPos.xz * 0.012);
        float dots = step(0.86, h21(floor(vPos.xz / 20.0))) * smoothstep(0.3, 0.9, lit) * (1.0 - smoothstep(500.0, 3000.0, camD));
        vec3 white = mix(vec3(1.0, 0.93, 0.82), vec3(1.0, 0.99, 0.96), lit);
        col += white * ((lit * lit * 0.38 + lit * 0.2) * blotch + dots * 0.45) * uGroundGlowK;
      }
      if (road > 0.01) {
        // 道路の中心線ぞいがほんのり明るい(白色気味の街灯の色)。近くでは街灯の点がまばらに並ぶ
        float rr = smoothstep(0.08, 0.85, road);
        float lamps = step(0.78, h21(floor(vPos.xz / 36.0))) * (1.0 - smoothstep(300.0, 2500.0, camD));
        vec3 lampCol = vec3(1.0, 0.84, 0.64);
        col += lampCol * (rr * 0.26 + rr * lamps * 0.28) * uGroundGlowK;
      }
    }
  }

  // 川・池: 水の縁から5mは灰色のコンクリート風の岸、水は空を映す液体
  vec2 wm = waterMaskAt(vPos);
  float water = clamp(wm.x, 0.0, 1.0);
  float bank = clamp(wm.y, 0.0, 1.0) * (1.0 - water);
  if (bank > 0.004) {
    float n = vn2(vPos.xz * 0.9) * 0.5 + vn2(vPos.xz * 3.7) * 0.3 + vn2(vPos.xz * 13.0) * 0.2;
    float crack = smoothstep(0.47, 0.5, vn2(vPos.xz * 2.2));
    vec3 gray = vec3(0.47 + 0.24 * (n - 0.5) - 0.07 * crack);
    col = mix(col, gray * light, clamp(bank * 1.5, 0.0, 1.0));
  }
  if (water > 0.004) {
    vec3 V = normalize(uCam - vPos);
    float dist = length(vPos - uCam);
    float amp = 0.14 / (1.0 + dist / 150.0);
    vec2 q = vPos.xz;
    const float eps = 0.3;
    float h0 = vn2(q * 0.8) + 0.5 * vn2(q * 2.3 + 11.0);
    float hx = vn2((q + vec2(eps, 0.0)) * 0.8) + 0.5 * vn2((q + vec2(eps, 0.0)) * 2.3 + 11.0);
    float hz = vn2((q + vec2(0.0, eps)) * 0.8) + 0.5 * vn2((q + vec2(0.0, eps)) * 2.3 + 11.0);
    vec3 Nw = normalize(vec3(-(hx - h0) / eps * amp, 1.0, -(hz - h0) / eps * amp));
    vec3 R = reflect(-V, Nw);
    R.y = abs(R.y);
    float F = 0.025 + 0.975 * pow(1.0 - clamp(dot(Nw, V), 0.0, 1.0), 5.0);
    vec3 skyRefl = mix(uFogColor, uZenith, pow(clamp(R.y, 0.0, 1.0), 0.5));
    vec3 deep = vec3(0.06, 0.17, 0.22);
    vec3 body = deep * (uAmbient * 0.8 + uSunColor * (uSunStrength * 0.25));
    vec3 spec = uSunColor * (uSunStrength * pow(max(dot(R, uSunDir), 0.0), 300.0) * 2.5)
      + uMoonColor * (uMoonStrength * pow(max(dot(R, uMoonDir), 0.0), 300.0) * 1.2);
    vec3 wcol = mix(body, skyRefl, F) + spec;
    col = mix(col, wcol, water);
  }

  outColor = vec4(applyAtmos(col, vPos), 1.0);
}`;

const SKY_VS = `#version 300 es
out vec2 vNdc;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vNdc = p * 2.0 - 1.0;
  gl_Position = vec4(vNdc, 1.0, 1.0);
}`;

/**
 * スマホ版は、空のシェーダー(天の川)を軽くする: ノイズの重なりを5→4段にし、2段目のゆがみ・細い暗黒のすじ(尾根形ノイズ)・
 * いちばん細かい星の段をやめる。天の川の形・色・星の数の多さはほぼ同じに見える(画素が多い夜の空で、約4割の計算を減らす)。
 */
const SKY_LITE = true;
const SKY_FS = `#version 300 es
precision highp float;
${SKY_LITE ? "#define SKY_LITE\n#define FBM_OCT 4" : "#define FBM_OCT 5"}
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform vec2 uTan;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uGround;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uMoonDir;
uniform float uSunVisible;
uniform float uNight;
uniform float uSunR;
uniform float uMoonR;
uniform float uMoonIllum;
uniform vec3 uCam;
// 天球(銀河座標)の向き。星も天の川も、この向きで描くので、時刻を動かすと星座と一緒に回る
uniform vec3 uGx;
uniform vec3 uGy;
uniform vec3 uGz;
uniform float uMilky;
// 天の川の明るさの地図(銀河座標。経度-180〜180°×緯度-45〜45°。R: 実際の天の川の輪郭5段階、G: 周りのぼんやりした光、B: Rを約1°ぼかしたもの。public/data/milkyway_gal.png)
uniform sampler2D uMwMap;
uniform float uMwMapOn;
// 光害(市街地の方角の夜空のぼんやりした明るさ)。uGlow=方位ごとの強さ(横360画素、R=0〜1)。uGlowOn=0/1
uniform sampler2D uGlow;
uniform float uGlowOn;
uniform float uGlowDome;
in vec2 vNdc;
out vec4 outColor;
${FOG_GLSL}
${CLOUD_GLSL}
${SEA_SKY_GLSL}
float hash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.1, 0.2, 0.3));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash(i);
  float n100 = hash(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash(i + vec3(1.0, 1.0, 1.0));
  return mix(mix(mix(n000, n100, f.x), mix(n010, n110, f.x), f.y),
             mix(mix(n001, n101, f.x), mix(n011, n111, f.x), f.y), f.z);
}
float fbm3(vec3 p) {
  float a = 0.5;
  float s = 0.0;
  for (int i = 0; i < FBM_OCT; i++) {
    s += a * vnoise(p);
    p = p * 2.03 + vec3(1.7, 9.2, 4.1);
    a *= 0.5;
  }
  return s;
}
float wrapPi(float a) {
  return a - 6.2831853 * floor((a + 3.1415927) / 6.2831853);
}
// 銀河座標(経度l・緯度b)の、だ円形のぼんやりした盛り上がり(星雲・星の集まり・暗黒星雲の位置に使う)
float blobAt(float l, float b, float l0, float b0, float sl, float sb) {
  float dl = wrapPi(l - l0) / sl;
  float db = (b - b0) / sb;
  return exp(-0.5 * (dl * dl + db * db));
}
void main() {
  vec3 d = normalize(uFwd + uRight * (vNdc.x * uTan.x) + uUp * (vNdc.y * uTan.y));
  float h = d.y;
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(h, 0.0, 1.0), 0.5));
  if (h < 0.0) sky = mix(uHorizon, uGround, clamp(-h * 8.0, 0.0, 1.0));

  // 光害: 市街地の方角の地平線ぎわがぼんやり暖色に明るい(方位ごとの表から。R=光の強さ、G=その方角の光る地面の割合)。
  // 光る地面の割合が大きい方角ほど、空へ高く広がり、強く明るくなる。全方位には、うっすらした明るさ(uGlowDome)もある。星・天の川はそのぶん薄くなる
  float pol = 0.0;
  vec3 glowCol = vec3(0.0);
  if (uGlowOn > 0.5 && uNight > 0.01) {
    float az = atan(d.x, -d.z);
    vec2 gt = textureLod(uGlow, vec2(az * 0.15915494 + 0.5, 0.5), 0.0).rg;
    float alt = asin(clamp(d.y, -1.0, 1.0));
    float horizon = smoothstep(-0.08, 0.01, alt);
    // 地平線ぎわが一番明るい。光る地面の割合が大きいほど高くまで(約7°〜30°で半分)届く
    float prof = exp(-max(alt, 0.0) / (0.12 + 0.34 * gt.g)) * horizon;
    float dome = uGlowDome * exp(-max(alt, 0.0) / 0.55) * horizon;
    pol = clamp(gt.r * prof * (0.55 + 0.9 * gt.g) + dome, 0.0, 1.0);
    glowCol = mix(vec3(1.0, 0.74, 0.5), vec3(1.0, 0.95, 0.88), clamp(gt.r + 0.3 * gt.g, 0.0, 1.0)) * pol * 0.78 * uNight;
  }
  float starDim = 1.0 - 0.85 * pol;

  // 天球に固定した向き(銀河座標)。以前は、星を地平座標の向き(d)で描いていたので、時刻を動かしても星が回らなかった
  vec3 g = vec3(dot(d, uGx), dot(d, uGy), dot(d, uGz));
  // 星(夜だけ)
  if (uNight > 0.01 && h > -0.05) {
    vec3 p = g * 140.0;
    vec3 ip = floor(p);
    vec3 fp = fract(p) - 0.5;
    float r = hash(ip);
    float star = step(0.992, r) * smoothstep(0.38, 0.0, length(fp));
    sky += vec3(star) * (0.4 + 0.6 * hash(ip + 7.0)) * uNight * smoothstep(0.0, 0.12, h) * starDim;
    // 暗い空(光害が少なく、月が明るくない)では、天頂に近いほど、暗い星がたくさん見える(2段の細かい星を足す)
    float moonK = uMoonIllum * smoothstep(-0.1, 0.35, uMoonDir.y);
    // 暗い星は、地平線の近く(約3°〜20°)では大気で薄くなる。以前は天頂の近くにしか出していなかった(写真では空じゅうに細かい星がある)
    float amt = clamp(1.0 - 1.7 * pol, 0.0, 1.0) * (1.0 - 0.8 * moonK) * smoothstep(0.05, 0.35, h);
    if (amt > 0.01) {
      vec3 q = g * 230.0;
      vec3 iq = floor(q);
      float s2 = step(1.0 - 0.03 * amt, hash(iq + 31.0)) * smoothstep(0.36, 0.0, length(fract(q) - 0.5));
      sky += vec3(0.92, 0.95, 1.0) * s2 * (0.25 + 0.5 * hash(iq + 11.0)) * uNight * starDim;
      vec3 q3 = g * 400.0;
      vec3 iq3 = floor(q3);
      float s3 = step(1.0 - 0.024 * amt, hash(iq3 + 57.0)) * smoothstep(0.34, 0.0, length(fract(q3) - 0.5));
      sky += vec3(0.9, 0.94, 1.0) * s3 * (0.15 + 0.3 * hash(iq3 + 3.0)) * uNight * starDim;
      // さらに暗い星(空全体に細かく散らばる)
      vec3 q4 = g * 700.0;
      vec3 iq4 = floor(q4);
      float s4 = step(1.0 - 0.03 * amt, hash(iq4 + 71.0)) * smoothstep(0.5, 0.0, length(fract(q4) - 0.5));
      sky += vec3(0.92, 0.93, 0.95) * s4 * (0.1 + 0.18 * hash(iq4 + 9.0)) * uNight * starDim;
    }
  }

  // 天の川(銀河座標で描く)。大まかな形(帯の幅・明るい星の雲・暗黒帯の裂け目・石炭袋など)は、実際の天の川の輪郭(5段階)から作った
  // 地図(uMwMap)で決め、そこへ細かい模様(星の雲の粒々・細い暗黒のすじ)と、帯の中の細かい星をシェーダーで足す。
  // 色・明るさは、利用者の天の川の写真(長時間露光)を参考に: 帯は白っぽい灰色〜うすいベージュ、いて座の中心付近は暖かいベージュ、
  // 暗黒帯は暗い茶色がかった色、干潟星雲(M8)などは小さなピンク。空じゅうに細かい星。
  // 銀河面から約43°より離れた所は、帯がほぼ0なので計算しない
  if (uMilky > 0.01 && h > -0.05 && abs(g.z) < 0.68) {
    float b = asin(clamp(g.z, -1.0, 1.0));
    float l = atan(g.y, g.x);
    float al = abs(l);
    // 模様の座標: 2段にゆがませて(ドメインワープ)、銀河面に沿って伸ばす
    vec3 w = g + 0.09 * (vec3(vnoise(g * 3.1 + 1.0), vnoise(g * 3.1 + 7.3), vnoise(g * 3.1 + 13.9)) - 0.5);
#ifndef SKY_LITE
    w += 0.03 * (vec3(vnoise(g * 9.7 + 2.0), vnoise(g * 9.7 + 5.1), vnoise(g * 9.7 + 11.3)) - 0.5);
#endif
    vec3 gs = vec3(w.xy, w.z * 2.8);
    float n1 = fbm3(gs * 5.0);
    float n2 = fbm3(gs * 13.0 + 4.0);
    float n3 = vnoise(gs * 36.0 + 9.0);
    // 細かいむら(星の雲の粒々。約0.2°まで)
    float n4 = fbm3(gs * 34.0 + 2.0);
    // 細い暗黒のすじ(尾根形のノイズを鋭くしたもの。スマホ版は省く)
#ifdef SKY_LITE
    float fil = 0.0;
#else
    float ridge = 1.0 - abs(2.0 * fbm3(gs * 21.0 + 6.0) - 1.0);
    float fil = pow(ridge, 7.0);
#endif
    // 大まかな明るさ(0〜1)。地図が無いとき(読み込み前・失敗)は、なめらかな帯で代わりにする
    float m;
    // 帯の周りの、なだらかに広がるぼんやりした光の量(地図を大きくぼかしたもの。地図のG)
    float env;
    if (uMwMapOn > 0.5) {
      // 地図の境目の段差が見えないよう、少しずらした所の値も混ぜてぼかし、ノイズで縁をゆらす
      vec2 muv = vec2(l * 0.15915494 + 0.5, 0.5 - b * 0.63661977);
      vec2 jit = (vec2(n1, n2) - 0.5) * vec2(0.0016, 0.006);
      // 地図は約0.18°/画素で、画面の画素より粗い(拡大して引く)ので、いつも最も細かい段(LOD 0)を引く(経度±180°のつなぎ目で、段が飛ばないように)
      vec3 ma = textureLod(uMwMap, muv + jit, 0.0).rgb;
      float ms = ma.r * 0.6 + textureLod(uMwMap, muv - jit * 1.7, 0.0).r * 0.4;
      // 淡い所(外縁・暗黒帯の中)は約1°ぼかした値(B)を使い、帯の縁がなだらかに暗くなるようにする。明るい星の雲は、細かい形(R)のまま
      m = mix(ma.b, ms, smoothstep(0.35, 0.75, ms));
      env = ma.g * ma.g;
    } else {
      float width = mix(0.07, 0.17, exp(-al * al / 1.2));
      float bc = b - 0.02 * (n1 - 0.5);
      m = exp(-bc * bc / (2.0 * width * width)) * (0.3 + 0.5 * exp(-al * al / 2.2)) + exp(-l * l / 0.1 - b * b / 0.045) * 0.6;
      env = exp(-b * b / (2.0 * 0.12 * 0.12)) * (0.25 + 0.4 * exp(-al * al / 1.5));
    }
    // 帯の外側で星を少し多くする量(星の密度にだけ使う)。以前は、これで光も足していたので、帯の周りに
    // 一様に明るい所ができていた。周りの光は、なだらかに暗くなる env で出す
    float halo = exp(-b * b / (2.0 * 0.16 * 0.16)) * (0.35 + 0.65 * exp(-al * al / 1.5)) * 0.12;
    // 細い暗黒のすじは、帯の中ほどの明るさの所(星の雲のふち)に多い
    float filMask = smoothstep(0.12, 0.45, m) * (1.0 - 0.5 * smoothstep(0.7, 1.0, m)) * smoothstep(0.35, 0.65, n2);
    float absorb = clamp(fil * filMask * 0.8 + (1.0 - smoothstep(0.25, 0.55, n1 + 0.2 * n3)) * smoothstep(0.15, 0.4, m) * 0.25, 0.0, 1.0);
    // 明るさ: 段が上がるほど急に明るく(写真の星の雲)、細かい粒々でむらをつける
    // いて座の中心付近(バルジ)は、写真のように一段と明るい
    float core = exp(-al * al / 0.3) * smoothstep(0.25, 0.9, m);
    // 地図のいちばん外側の段(天の川のごく淡い外縁。地図の値で約0.2)は、光はほぼ0にする(写真でも、そこは暗い空に星があるだけ)
    float mg = clamp((m - 0.15) / 0.85, 0.0, 1.0);
    float inten = (mg * 0.6 + mg * mg * 1.3) * (1.0 + 0.6 * core) * (0.7 + 0.6 * n1) * (0.55 + 0.9 * n4) * (1.0 - 0.85 * absorb);
    // 帯の周りのぼんやりした光: 帯から離れるほど、なだらかに(約15°かけて)暗い空へつながる。大きなむらを少しだけつける
    inten += env * 0.35 * (0.85 + 0.3 * n1) * (1.0 - 0.4 * absorb);
    // 色
    // 中心付近の暖かい色・暗黒帯の茶色は、彩度を控えめに(8回目の色から彩度を約35%下げた)
    vec3 mcol = mix(vec3(0.84, 0.84, 0.86), vec3(0.95, 0.86, 0.73), clamp(core * 1.3 + 0.25 * m, 0.0, 1.0));
    mcol = mix(mcol, vec3(0.67, 0.57, 0.49), clamp(absorb * 1.4, 0.0, 0.6));
    // 小さなピンクの星雲: 干潟星雲M8・三裂星雲M20・オメガ星雲M17・わし星雲M16・北アメリカ星雲
    float pink = blobAt(l, b, 0.1047, -0.0209, 0.011, 0.008) * 1.0
      + blobAt(l, b, 0.1222, -0.0042, 0.006, 0.006) * 0.6
      + blobAt(l, b, 0.2635, -0.0122, 0.005, 0.004) * 0.5
      + blobAt(l, b, 0.2967, 0.0140, 0.006, 0.005) * 0.4
      + blobAt(l, b, 1.4940, -0.0157, 0.02, 0.016) * 0.35;
    pink *= 0.6 + 0.8 * n4;
    vec3 mw = mcol * inten * 0.15 + vec3(1.0, 0.42, 0.62) * pink * 0.15;
    // 帯の中は小さな星が密に見える(暗黒帯の中は少ない)。星は天球に固定した向き(g)で置く(時刻とともに回る)。
    // 4段(大きめ・中・細かい・とても細かい)で、細かい段ほど数が多く暗い
    float dens = clamp(m * 1.3 + halo * 1.5, 0.0, 1.5) * (1.0 - 0.9 * absorb);
    vec3 c1 = g * 300.0;
    vec3 c2 = g * 620.0;
    vec3 c3 = g * 950.0;
    float st = step(1.0 - 0.03 * dens, hash(floor(c1))) * (0.6 + 0.6 * hash(floor(c1) + 5.0)) * smoothstep(0.55, 0.0, length(fract(c1) - 0.5))
      + step(1.0 - 0.06 * dens, hash(floor(c2) + 3.0)) * (0.45 + 0.4 * hash(floor(c2) + 8.0)) * smoothstep(0.55, 0.0, length(fract(c2) - 0.5))
      + step(1.0 - 0.1 * dens, hash(floor(c3) + 19.0)) * (0.3 + 0.3 * hash(floor(c3) + 2.0)) * smoothstep(0.55, 0.0, length(fract(c3) - 0.5));
#ifndef SKY_LITE
    vec3 c4 = g * 1400.0;
    st += step(1.0 - 0.12 * dens, hash(floor(c4) + 23.0)) * (0.18 + 0.2 * hash(floor(c4) + 4.0)) * smoothstep(0.6, 0.0, length(fract(c4) - 0.5));
#endif
    mw += vec3(0.92, 0.93, 0.98) * st * 0.42;
    sky += mw * uMilky * smoothstep(0.0, 0.1, h) * starDim;
  }
  sky += glowCol;

  // 太陽(円盤と周りの光)
  float cs = dot(d, uSunDir);
  float sunAng = acos(clamp(cs, -1.0, 1.0));
  float glow = exp(-sunAng * sunAng / 0.0144) * 0.55 + exp(-sunAng * sunAng / 0.25) * 0.16;
  sky += uSunColor * glow * uSunVisible;
  float disc = smoothstep(uSunR, uSunR * 0.8, sunAng) * uSunVisible;
  sky = mix(sky, vec3(1.0, 0.97, 0.86) * 1.6, disc);

  // 月(満ち欠けは、月から見た太陽の向きで陰をつけて表す)
  float cm = dot(d, uMoonDir);
  if (cm > 0.0) {
    vec3 e = d - uMoonDir * cm;
    float eang = length(e);
    sky += vec3(0.6, 0.7, 1.0) * exp(-eang * eang / 0.0036) * 0.14 * uMoonIllum * (0.35 + 0.65 * uNight);
    if (eang < uMoonR) {
      vec3 u = e / uMoonR;
      float sq = sqrt(max(1.0 - dot(u, u), 0.0));
      vec3 n = normalize(u - uMoonDir * sq);
      float lit = clamp(dot(n, uSunDir) * 2.5, 0.0, 1.0);
      vec3 darkSide = mix(sky * 0.9, vec3(0.05, 0.06, 0.09), uNight);
      vec3 moonCol = mix(darkSide, vec3(0.97, 0.96, 0.88), lit);
      sky = mix(sky, moonCol, smoothstep(uMoonR, uMoonR * 0.9, eang));
    }
  }
  if (uLfOn > 0.5) {
    float tau = lfTau(uCam, d, 25000.0);
    sky = mix(sky, uLfCol, 1.0 - exp(-tau));
  }
  if (uCsOn > 0.5) {
    // 雲海: 層の下から見上げると、青空・太陽・星は雲に隠れて、雲の底が見える
    float sshade;
    float stau = seaSkyTau(uCam, d, sshade);
    if (stau > 0.002) {
      // 視点が層の下面より下にいるほど1(雲の底は少し暗く、太陽の方向だけ明るく透ける)
      float under = csUnder(uCam);
      float sunLit = pow(max(dot(d, uSunDir), 0.0), 6.0);
      vec3 cc = uCsCol * (0.8 + 0.3 * sshade) * mix(1.0, 0.66, under) * (1.0 + 0.45 * sunLit * under);
      sky = mix(sky, cc, 1.0 - exp(-stau));
    }
  }
  if (uLcOn > 0.5) {
    float ctau;
    float cwhite;
    lcMarch(uCam, d, 200000.0, ctau, cwhite);
    sky = mix(sky, uLcCol * mix(0.67, 1.0, cwhite), 1.0 - exp(-ctau));
  }
  outColor = vec4(sky, 1.0);
}`;

/** 1フレームを描くのに必要な値 */
export interface FrameParams {
  /** 描画バッファの大きさ(px) */
  width: number;
  height: number;
  eye: Vec3;
  yawDeg: number;
  pitchDeg: number;
  /** 縦方向の視野角(度) */
  fovDeg: number;
  near: number;
  far: number;
  sunDir: Vec3;
  moonDir: Vec3;
  moonIllum: number;
  look: SkyLook;
  /** 紅葉メッシュの濃さ(0なら非表示) */
  overlayOpacity: number;
  /** 遠景・近景のテクスチャの範囲(x0, z0, sx, sz。m) */
  farRect: [number, number, number, number];
  nearRect: [number, number, number, number];
  /** 中景のテクスチャの範囲と、読み込み済みか(拡張+処理「高」のときだけ) */
  midRect: [number, number, number, number];
  midOn: boolean;
  /** 足もとの下地のテクスチャの範囲と、読み込み済みか(処理「高」のときだけ) */
  footRect: [number, number, number, number];
  footOn: boolean;
  /** 最も細かい下地(カメラのまわり。ズーム18)の範囲と、読み込み済みか(処理「高」のときだけ) */
  fineRect: [number, number, number, number];
  fineOn: boolean;
  /** 広い足もとの下地(カメラのまわり約±4km。ズーム15)の範囲と、読み込み済みか(処理「高」のときだけ) */
  wfootRect: [number, number, number, number];
  wfootOn: boolean;
  /** 向いている方向の遠く(約20km先まで。ズーム14)の範囲と、読み込み済みか(処理「高」のときだけ) */
  aheadRect: [number, number, number, number];
  aheadOn: boolean;
  /** 近景のテクスチャが読み込み済みか */
  nearOn: boolean;
  /** 近景の紅葉メッシュが作成済みか(未作成の間は遠景の紅葉メッシュを使う) */
  nearOvOn: boolean;
  /** 地面から一定の高さまでの霧(霧の地図と地面の高さの地図が貼られているときだけ描く) */
  layerFog?: LayerFogParams;
  /** 雲の層(衛星画像の雲判定メッシュ。雲の地図が貼られているときだけ描く) */
  cloud?: LayerCloudParams;
  /** 雲海(基準の標高の地図が貼られているときだけ描く)。h=層の下面の、基準の標高からの高さ(m)。col=雲の色 */
  sea?: { on: boolean; h: number; col: Vec3 };
  /** 光害(市街地の方角の夜空の明るさ)を描くか(表が貼られているときだけ) */
  glowOn?: boolean;
  /** 天の川(銀河面の向きと見え方)。省略すると描かない */
  milky?: { gx: Vec3; gy: Vec3; gz: Vec3; strength: number };
  /** 天球(銀河座標)の向き。天の川を描かないときも、星の向きに使う */
  skyFrame?: { gx: Vec3; gy: Vec3; gz: Vec3 };
  /** 川・池の水(水の地図が貼られているときだけ描く) */
  waterOn?: boolean;
  /** 建物・木を描くか */
  showBuildings?: boolean;
  showTrees?: boolean;
  /** 星座(星と線)。strength=見え方(0〜1。夜ほど強い)。省略すると描かない */
  constellation?: { strength: number };
  /** 画面の解像度の倍率(線の太さ・星の大きさに使う) */
  dpr?: number;
  /** 処理「高」の追加効果(霞の前方散乱など)を掛けるか。山の影・谷の暗がりは、地図を貼る(setShade)と掛かる */
  hq?: boolean;
  /** 地形を作った半径(m。通常25km、描画範囲の拡張で50km)。地形の端を霧の色にとかす位置と、遠くの霞の濃さを決める */
  rangeM?: number;
}

export interface LayerFogParams {
  on: boolean;
  color: Vec3;
  /** 濃さ1(最も濃い)の霧の、1mあたりの減衰(視程 ≒ 3.9/sigma) */
  sigma: number;
  /** 霧の層の厚み(地面からの高さ、m) */
  top: number;
  /** 霧・高さの地図の範囲(x0, z0, sx, sz。m) */
  rect: [number, number, number, number];
}

export interface LayerCloudParams {
  on: boolean;
  color: Vec3;
  /** 層の下端・上端(海抜m) */
  alt: [number, number];
  /** 濃さ1(白)の雲の、1mあたりの減衰 */
  sigma: number;
  /** 雲の地図の範囲(x0, z0, sx, sz。m) */
  rect: [number, number, number, number];
}

export type TexSlot = "far" | "near";
/** 下地の画像の段(遠景・近景・中景・足もと・最も細かい) */
export type BaseSlot = TexSlot | "mid" | "foot" | "fine" | "wfoot" | "ahead";
export type WaterSlot = "near" | "wide" | "far";

export class TerrainRenderer {
  private readonly gl: WebGL2RenderingContext;
  /** GPUメモリの見積もり(`viewerDiag.ts`) */
  readonly mem: { report: () => GlMemoryReport };
  private readonly terrainProg: WebGLProgram;
  private readonly skyProg: WebGLProgram;
  private readonly emptyVao: WebGLVertexArrayObject;
  private meshVao: WebGLVertexArrayObject | null = null;
  private meshBuffers: WebGLBuffer[] = [];
  private indexCount = 0;
  private readonly tex: Record<"farBase" | "nearBase" | "midBase" | "footBase" | "fineBase" | "farOv" | "nearOv", WebGLTexture>;
  /**
   * カメラについていく下地のうち、最も細かい下地(ズーム18)・広い足もと(ズーム15)・向いている方向の遠く(ズーム14)を
   * 1枚に並べたテクスチャ(fineBase)の大きさ(px)と、各部分の位置(null ならその部分は無い)。
   * ふつうは縦に並べる(上から ahead・wfoot・fine)。高さがGPUの上限を超えるときは、左の列に ahead・wfoot、右の列に fine を置く。
   */
  private atlas: { w: number; h: number; parts: Record<"ahead" | "wfoot" | "fine", { x: number; y: number; w: number; h: number } | null> } = {
    w: 0,
    h: 0,
    parts: { ahead: null, wfoot: null, fine: null },
  };
  /** アトラスの中の各部分の位置(開始u, 開始v, uの幅, vの幅。画像の大きさ÷アトラスの大きさ) */
  private atlasAt: Record<"ahead" | "wfoot" | "fine", [number, number, number, number]> = {
    ahead: [0, 0, 1, 1],
    wfoot: [0, 0, 1, 1],
    fine: [0, 0, 1, 1],
  };
  /** 足もとの画像のテクスチャの、確保した大きさ(0なら未確保)と、いま貼っている画像の大きさの割合 */
  private footSize = { w: 0, h: 0 };
  private footAt: [number, number] = [1, 1];
  private fogTex: WebGLTexture;
  private heightTex: WebGLTexture;
  private cloudTex: WebGLTexture;
  private cloudReady = false;
  private seaTex: WebGLTexture;
  private seaReady = false;
  private seaRect: [number, number, number, number] = [0, 0, 1, 1];
  /** 雲海の基準の標高の地図(CPU側の元データ。山の影の地図と1枚のテクスチャにまとめて貼る) */
  private seaData: { data: Float32Array; size: number } | null = null;
  /** 山の影(G)・谷の暗がり(B)の地図(処理「高」。雲海の地図と同じ範囲。1枚のRGBA16Fに R=雲海・G=影・B=暗がり でまとめる) */
  private shade: { size: number; ao: Uint8Array; g: Float32Array | null } | null = null;
  /** seaTex が、いまどの形式か(再確保が要るかの判定) */
  private seaTexKind = "";
  private glowTex: WebGLTexture;
  /** 天の川の明るさの地図(`setMilkyWayMap`) */
  private mwTex: WebGLTexture;
  private mwReady = false;
  private glowReady = false;
  private glowDome = 0;
  private groundLightTex: WebGLTexture;
  private roadLightTex: WebGLTexture;
  private roadLightReady = false;
  private groundLightReady = false;
  private groundLightRect: [number, number, number, number] = [0, 0, 1, 1];
  private waterTex: Record<WaterSlot, WebGLTexture>;
  private waterRect: Record<WaterSlot, [number, number, number, number]> = {
    near: [0, 0, 1, 1],
    wide: [0, 0, 1, 1],
    far: [0, 0, 1, 1],
  };
  private waterReady: Record<WaterSlot, boolean> = { near: false, wide: false, far: false };
  /** 木・建物・星座(viewerObjectsGl.ts) */
  readonly objects: ObjectRenderer;
  private fogReady = false;
  private heightReady = false;
  private readonly aniso: EXT_texture_filter_anisotropic | null;
  /** 地面の画像の異方性フィルタの強さ(処理「高」で16。既定8) */
  private anisoLevel = 8;
  /** この端末のWebGLが扱える画像の一辺の最大(px) */
  readonly maxTextureSize: number;
  private readonly uT: Record<string, WebGLUniformLocation | null> = {};
  private readonly uS: Record<string, WebGLUniformLocation | null> = {};

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: false, powerPreference: "high-performance" });
    if (!gl) throw new Error("このブラウザは3D表示(WebGL2)に対応していません");
    this.gl = gl;
    // GPUに載せた画像・バッファ・描画面の大きさを数える(落ちたときの原因を調べる記録用)
    this.mem = trackGlMemory(gl);
    this.terrainProg = link(gl, TERRAIN_VS, TERRAIN_FS);
    this.skyProg = link(gl, SKY_VS, SKY_FS);
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("VAOを作れません");
    this.emptyVao = vao;
    this.aniso = gl.getExtension("EXT_texture_filter_anisotropic");
    this.maxTextureSize = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096;
    this.tex = {
      farBase: this.placeholderTexture([205, 208, 196, 255]),
      nearBase: this.placeholderTexture([205, 208, 196, 255]),
      midBase: this.placeholderTexture([205, 208, 196, 255]),
      footBase: this.placeholderTexture([0, 0, 0, 0]),
      fineBase: this.placeholderTexture([0, 0, 0, 0]),
      farOv: this.placeholderTexture([0, 0, 0, 0]),
      nearOv: this.placeholderTexture([0, 0, 0, 0]),
    };
    this.fogTex = this.placeholderTexture([0, 0, 0, 255]);
    this.heightTex = this.placeholderTexture([0, 0, 0, 255]);
    this.cloudTex = this.placeholderTexture([0, 0, 0, 255]);
    this.seaTex = this.placeholderTexture([0, 0, 0, 255]);
    this.glowTex = this.placeholderTexture([0, 0, 0, 255]);
    this.mwTex = this.placeholderTexture([0, 0, 0, 255]);
    this.groundLightTex = this.placeholderTexture([0, 0, 0, 255]);
    this.roadLightTex = this.placeholderTexture([0, 0, 0, 255]);
    this.waterTex = {
      near: this.placeholderTexture([0, 0, 0, 255]),
      wide: this.placeholderTexture([0, 0, 0, 255]),
      far: this.placeholderTexture([0, 0, 0, 255]),
    };
    this.objects = new ObjectRenderer(gl);
    for (const name of [
      "uVP", "uFarBase", "uNearBase", "uMidBase", "uMidRect", "uMidOn", "uFootBase", "uFootRect", "uFootOn", "uFootAt", "uFineBase", "uFineRect", "uFineAt", "uFineOn", "uWFootRect", "uWFootAt", "uWFootOn", "uAheadRect", "uAheadAt", "uAheadOn", "uFarOv", "uNearOv", "uFarRect", "uNearRect", "uNearOn", "uNearOvOn", "uOvOpacity",
      "uSunDir", "uSunColor", "uSunStrength", "uMoonDir", "uMoonColor", "uMoonStrength", "uAmbient",
      "uFogColor", "uFogDensity", "uCam", "uEdge",
      "uLfMap", "uLfHeight", "uLfRect", "uLfOn", "uLfCol", "uLfSigma", "uLfTop",
      "uLcMap", "uLcRect", "uLcOn", "uLcCol", "uLcSigma", "uLcAlt",
      "uWaterNear", "uWaterWide", "uWaterFar", "uWaterNearRect", "uWaterWideRect", "uWaterFarRect", "uWaterOn", "uZenith",
      "uGroundLight", "uRoadLight", "uGroundLightRect", "uGroundGlowK", "uRoadOn",
      "uCsMap", "uCsRect", "uCsOn", "uCsH", "uCsThick", "uCsSigma", "uCsCol", "uShOn", "uHq",
    ]) {
      this.uT[name] = gl.getUniformLocation(this.terrainProg, name);
    }
    for (const name of [
      "uRight", "uUp", "uFwd", "uTan", "uZenith", "uHorizon", "uGround", "uSunDir", "uSunColor", "uMoonDir",
      "uSunVisible", "uNight", "uSunR", "uMoonR", "uMoonIllum", "uCam", "uGx", "uGy", "uGz", "uMilky", "uMwMap", "uMwMapOn", "uGlow", "uGlowOn", "uGlowDome",
      "uLfMap", "uLfHeight", "uLfRect", "uLfOn", "uLfCol", "uLfSigma", "uLfTop",
      "uLcMap", "uLcRect", "uLcOn", "uLcCol", "uLcSigma", "uLcAlt",
      "uCsMap", "uCsRect", "uCsOn", "uCsH", "uCsThick", "uCsSigma", "uCsCol",
    ]) {
      this.uS[name] = gl.getUniformLocation(this.skyProg, name);
    }
  }

  /** WebGLのコンテキスト(診断の記録で、GPUの名前などを読むため) */
  get context(): WebGL2RenderingContext {
    return this.gl;
  }

  /** 地面の画像の異方性フィルタの強さ(以降に貼る画像から。処理「高」で16) */
  setAnisoLevel(level: number): void {
    this.anisoLevel = Math.max(1, level);
  }

  private placeholderTexture(rgba: [number, number, number, number]): WebGLTexture {
    const gl = this.gl;
    const t = gl.createTexture();
    if (!t) throw new Error("テクスチャを作れません");
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  private finishTexture(): void {
    const gl = this.gl;
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.aniso) {
      const max = gl.getParameter(this.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number;
      gl.texParameterf(gl.TEXTURE_2D, this.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(this.anisoLevel, max));
    }
  }

  setMesh(mesh: TerrainMesh): void {
    const gl = this.gl;
    if (this.meshVao) gl.deleteVertexArray(this.meshVao);
    for (const b of this.meshBuffers) gl.deleteBuffer(b);
    this.meshBuffers = [];
    const vao = gl.createVertexArray();
    if (!vao) throw new Error("VAOを作れません");
    gl.bindVertexArray(vao);
    const attrib = (name: string, data: Float32Array) => {
      const buf = gl.createBuffer();
      if (!buf) throw new Error("バッファを作れません");
      this.meshBuffers.push(buf);
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(this.terrainProg, name);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    };
    attrib("aPos", mesh.positions);
    attrib("aNrm", mesh.normals);
    const ib = gl.createBuffer();
    if (!ib) throw new Error("バッファを作れません");
    this.meshBuffers.push(ib);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.meshVao = vao;
    this.indexCount = mesh.indices.length;
  }

  /**
   * 最も細かい下地(ズーム18)・広い足もと(ズーム15)・向いている方向の遠く(ズーム14)を貼るテクスチャ(アトラス)の大きさを決めて、
   * 空で確保する(最初に1度だけ)。ahead・wfoot が null なら、その部分は作らない。縦1列で並べるとGPUの上限を超えるときは
   * 2列にし、それでも超えるときは、遠く(ahead)→広い足もと(wfoot)の順に諦める。戻り値は、実際に作った部分。
   * 画像は、貼る範囲(タイル数)が変わっても収まるよう、(上限の枚数×256px)の大きさを確保しておき、画像の大きさに合わせて部分的に貼る。
   */
  reserveFineAtlas(
    ahead: { w: number; h: number } | null,
    wfoot: { w: number; h: number } | null,
    fine: { w: number; h: number },
    /** GPUメモリの上限(MB。ミップマップ込み)。超える並べ方は使わない(省ける部分を省く) */
    maxMB = Infinity,
  ): { ahead: boolean; wfoot: boolean } {
    const gl = this.gl;
    const max = this.maxTextureSize;
    const mbOf = (w: number, h: number): number => (w * h * 4 * 4) / 3 / (1024 * 1024);
    type Part = { x: number; y: number; w: number; h: number };
    type Layout = { w: number; h: number; parts: { ahead: Part | null; wfoot: Part | null; fine: Part } };
    // 縦に1列 → 2列(左に ahead・wfoot、右に fine)の順に試す
    const layouts = (a: typeof ahead, wf: typeof wfoot): Layout[] => {
      const col: Layout = { w: 0, h: 0, parts: { ahead: null, wfoot: null, fine: { x: 0, y: 0, ...fine } } };
      let y = 0;
      if (a) {
        col.parts.ahead = { x: 0, y, ...a };
        y += a.h;
      }
      if (wf) {
        col.parts.wfoot = { x: 0, y, ...wf };
        y += wf.h;
      }
      col.parts.fine = { x: 0, y, ...fine };
      col.w = Math.max(fine.w, a?.w ?? 0, wf?.w ?? 0);
      col.h = y + fine.h;
      const out = [col];
      if (a || wf) {
        const leftW = Math.max(a?.w ?? 0, wf?.w ?? 0);
        const two: Layout = {
          w: leftW + fine.w,
          h: Math.max((a?.h ?? 0) + (wf?.h ?? 0), fine.h),
          parts: { ahead: a ? { x: 0, y: 0, ...a } : null, wfoot: wf ? { x: 0, y: a?.h ?? 0, ...wf } : null, fine: { x: leftW, y: 0, ...fine } },
        };
        out.push(two);
      }
      return out;
    };
    // 遠く(ahead)→広い足もと(wfoot)の順に諦める
    let chosen: Layout | null = null;
    for (const [a, wf] of [
      [ahead, wfoot],
      [null, wfoot],
      [null, null],
    ] as const) {
      chosen = layouts(a, wf).find((l) => l.w <= max && l.h <= max && (l.parts.ahead === null && l.parts.wfoot === null ? true : mbOf(l.w, l.h) <= maxMB)) ?? null;
      if (chosen) break;
    }
    const lay = chosen ?? { w: Math.min(fine.w, max), h: Math.min(fine.h, max), parts: { ahead: null, wfoot: null, fine: { x: 0, y: 0, ...fine } } };
    this.atlas = { w: lay.w, h: lay.h, parts: lay.parts };
    this.atlasAt = { ahead: [0, 0, 1, 1], wfoot: [0, 0, 1, 1], fine: [0, 0, 1, 1] };
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fineBase);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, lay.w, lay.h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.finishTexture();
    return { ahead: lay.parts.ahead !== null, wfoot: lay.parts.wfoot !== null };
  }

  /** アトラスの1部分(ahead・wfoot・fine)に画像を貼る。画像のない所は透明(乗算済みアルファ) */
  private setAtlasPart(slot: "ahead" | "wfoot" | "fine", image: HTMLCanvasElement): void {
    const gl = this.gl;
    if (this.atlas.w === 0) this.reserveFineAtlas(null, null, { w: image.width, h: image.height });
    const { w, h } = this.atlas;
    const part = this.atlas.parts[slot];
    if (!part || image.width > part.w || image.height > part.h) return;
    gl.bindTexture(gl.TEXTURE_2D, this.tex.fineBase);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, part.x, part.y, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.atlasAt[slot] = [part.x / w, part.y / h, image.width / w, image.height / h];
    this.finishTexture();
  }

  /** 下地の地図(標準地図)の画像を貼る */
  /**
   * 足もとの画像(ズーム17)のテクスチャを、最大の大きさで空のまま確保しておく(最初に1度だけ)。以後は、動くたびに読み直した画像を
   * 左上に部分的に貼る(`texSubImage2D`)。以前は読み直すたびに約100MBのテクスチャを確保し直していて、遠くまで移動し続けると、
   * 古いテクスチャが片づく前に次を確保して、GPUのメモリが足りなくなりやすかった。
   */
  reserveFoot(w: number, h: number): void {
    const gl = this.gl;
    const W = Math.min(w, this.maxTextureSize);
    const H = Math.min(h, this.maxTextureSize);
    gl.bindTexture(gl.TEXTURE_2D, this.tex.footBase);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, W, H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.finishTexture();
    this.footSize = { w: W, h: H };
    this.footAt = [1, 1];
  }

  setBase(slot: BaseSlot, image: HTMLCanvasElement): void {
    const gl = this.gl;
    if (slot === "fine" || slot === "wfoot" || slot === "ahead") {
      this.setAtlasPart(slot, image);
      return;
    }
    if (slot === "foot" && this.footSize.w >= image.width && this.footSize.h >= image.height && this.footSize.w > 0) {
      gl.bindTexture(gl.TEXTURE_2D, this.tex.footBase);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, image);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      this.footAt = [image.width / this.footSize.w, image.height / this.footSize.h];
      this.finishTexture();
      return;
    }
    if (slot === "foot") {
      // 確保した大きさに収まらないとき(確保していないとき)は、画像の大きさで確保し直す
      this.footSize = { w: image.width, h: image.height };
      this.footAt = [1, 1];
    }
    const key =
      slot === "far" ? "farBase" : slot === "mid" ? "midBase" : slot === "foot" ? "footBase" : "nearBase";
    gl.bindTexture(gl.TEXTURE_2D, this.tex[key]);
    // 足もと・最も細かい画像は、タイルのない所が透明。乗算済みアルファで貼ると、透明との境の色がにじまない
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, slot === "foot");
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    this.finishTexture();
  }

  /** 紅葉メッシュ(乗算済みアルファ)の画像を貼る */
  setOverlay(slot: TexSlot, img: OverlayImage): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex[slot === "far" ? "farOv" : "nearOv"]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, img.width, img.height, 0, gl.RGBA, gl.UNSIGNED_BYTE, img.data);
    this.finishTexture();
  }

  /**
   * 天の川の明るさの地図(銀河座標。横=経度-180〜180°、縦=緯度+45°〜-45°。赤の値0〜1)を貼る。
   * 経度方向はつながっているので、横はくり返し(REPEAT)にする。
   */
  setMilkyWayMap(image: TexImageSource): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.mwTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    // R: 天の川の明るさの段(0〜1)、G: 周りのぼんやりした光の量の平方根、B: Rを約1°ぼかしたもの
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.mwReady = true;
  }

  /** 霧の濃さの地図(0〜255、size×size。nullなら霧なし)を貼る。双線形補間で使うのでなめらかな地図を渡す */
  setFogMap(data: Uint8Array | null, size: number): void {
    const gl = this.gl;
    if (!data) {
      this.fogReady = false;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    this.linearClamp();
    this.fogReady = true;
  }

  /** 地面の高さの地図(m、size×size。霧の層の上端=この高さ+厚み)を貼る */
  setHeightMap(data: Float32Array, size: number): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, size, size, 0, gl.RED, gl.FLOAT, data);
    this.linearClamp();
    this.heightReady = true;
  }

  /** 雲の濃さの地図(0〜255、size×size。nullなら雲なし)を貼る */
  setCloudMap(data: Uint8Array | null, size: number): void {
    const gl = this.gl;
    if (!data) {
      this.cloudReady = false;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.cloudTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, size, size, 0, gl.RED, gl.UNSIGNED_BYTE, data);
    this.linearClamp();
    this.cloudReady = true;
  }

  /**
   * 雲海の「基準の標高」の地図(m。size×size。上が北)を貼る。rect=範囲(x0, z0, sx, sz。m)。nullなら雲海を描かない。
   * 雲海の層の下面 = この標高 + 設定の高さ(`viewerSea.ts`)
   */
  setSeaMap(data: Float32Array | null, size: number, rect: [number, number, number, number]): void {
    if (!data) {
      this.seaReady = false;
      this.seaData = null;
      return;
    }
    this.seaData = { data, size };
    this.seaRect = rect;
    this.seaReady = true;
    this.uploadSeaTex();
  }

  /**
   * 山の影・谷の暗がりの地図(処理「高」。`viewerShade.ts`)を貼る。ao=谷・くぼ地の暗がり(0〜255。255=暗がりなし)、
   * g=太陽の影(符号付き。nullの間は影なし)。どちらも size×size(上が北)で、範囲 rect は雲海の地図と同じにする。nullなら外す。
   * 雲海の地図と1枚のテクスチャ(RGBA16F)にまとめて貼る(テクスチャのユニットを増やさないため)
   */
  setShade(shade: { size: number; ao: Uint8Array; g: Float32Array | null } | null, rect: [number, number, number, number]): void {
    this.shade = shade;
    if (shade) this.seaRect = rect;
    this.uploadSeaTex();
  }

  /** 太陽の影の地図だけを差し替える(時刻が変わったとき) */
  setShadeSun(g: Float32Array | null): void {
    if (!this.shade) return;
    this.shade.g = g;
    this.uploadSeaTex();
  }

  /** 雲海・影・暗がりの地図のテクスチャ(ユニット10)を作り直して貼る */
  private uploadSeaTex(): void {
    const gl = this.gl;
    const sh = this.shade;
    const sea = this.seaData;
    if (!sh) {
      if (!sea) {
        // 影も雲海も無くなった: 大きな影の地図のGPUメモリを手放す(1画素に戻す)
        if (this.seaTexKind.startsWith("rgba")) {
          gl.bindTexture(gl.TEXTURE_2D, this.seaTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
          this.seaTexKind = "";
        }
        return;
      }
      gl.bindTexture(gl.TEXTURE_2D, this.seaTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, sea.size, sea.size, 0, gl.RED, gl.FLOAT, sea.data);
      this.linearClamp();
      this.seaTexKind = `r${sea.size}`;
      return;
    }
    const n = sh.size;
    gl.bindTexture(gl.TEXTURE_2D, this.seaTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const kind = `rgba${n}`;
    if (this.seaTexKind !== kind) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, n, n, 0, gl.RGBA, gl.FLOAT, null);
      this.seaTexKind = kind;
    }
    // 雲海の基準の標高(粗い地図)を、影の地図と同じ大きさへ双線形で広げながら、128行ずつ貼る(一度に大きな配列を作らない)
    const ROWS = 128;
    const buf = new Float32Array(ROWS * n * 4);
    const sd = sea ? sea.data : null;
    const sn = sea ? sea.size : 0;
    // 列ごとの補間位置(行によらない)
    const cx0 = new Int32Array(n);
    const cx1 = new Int32Array(n);
    const ctx = new Float32Array(n);
    if (sd) {
      for (let x = 0; x < n; x++) {
        const f = Math.min(sn - 1, Math.max(0, ((x + 0.5) / n) * sn - 0.5));
        const x0 = Math.floor(f);
        cx0[x] = x0;
        cx1[x] = Math.min(sn - 1, x0 + 1);
        ctx[x] = f - x0;
      }
    }
    const g = sh.g;
    for (let y0 = 0; y0 < n; y0 += ROWS) {
      const rows = Math.min(ROWS, n - y0);
      for (let yy = 0; yy < rows; yy++) {
        const y = y0 + yy;
        let r0 = 0;
        let r1 = 0;
        let ty = 0;
        if (sd) {
          const f = Math.min(sn - 1, Math.max(0, ((y + 0.5) / n) * sn - 0.5));
          const yi = Math.floor(f);
          r0 = yi * sn;
          r1 = Math.min(sn - 1, yi + 1) * sn;
          ty = f - yi;
        }
        let o = yy * n * 4;
        const base = y * n;
        for (let x = 0; x < n; x++, o += 4) {
          let v = 0;
          if (sd) {
            const tx = ctx[x];
            const a = sd[r0 + cx0[x]] * (1 - tx) + sd[r0 + cx1[x]] * tx;
            const b = sd[r1 + cx0[x]] * (1 - tx) + sd[r1 + cx1[x]] * tx;
            v = a * (1 - ty) + b * ty;
          }
          buf[o] = v;
          buf[o + 1] = g ? g[base + x] : -2;
          buf[o + 2] = sh.ao[base + x] / 255;
          buf[o + 3] = 1;
        }
      }
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, n, rows, gl.RGBA, gl.FLOAT, rows === ROWS ? buf : buf.subarray(0, rows * n * 4));
    }
    this.linearClamp();
  }

  /** 川・池の水の地図(RGBA。R=水・G=岸・B=建物)を貼る。nullなら外す */
  setWaterMask(slot: WaterSlot, mask: WaterMask | null): void {
    const gl = this.gl;
    if (!mask) {
      this.waterReady[slot] = false;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.waterTex[slot]);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    // シェーダーが読むのは R(水)・G(岸)だけなので、2チャンネルにして貼る(GPUのメモリを半分にする。B=建物の足もとはCPU側だけで使う)
    const n = mask.size * mask.size;
    const rg = new Uint8Array(n * 2);
    for (let i = 0, j = 0; i < n; i++, j += 2) {
      rg[j] = mask.data[i * 4];
      rg[j + 1] = mask.data[i * 4 + 1];
    }
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, mask.size, mask.size, 0, gl.RG, gl.UNSIGNED_BYTE, rg);
    this.linearClamp();
    this.waterRect[slot] = mask.rect;
    this.waterReady[slot] = true;
  }

  /**
   * 光害の方位ごとの値(横に並んだ画素。R=光の強さ、G=その方角の光る地面の割合、どちらも0〜255。先頭が方位の-180°側)と、
   * 空全体のうっすらした明るさ(0〜1)。nullなら外す
   */
  setGlow(table: Uint8Array | null, dome = 0): void {
    const gl = this.gl;
    if (!table || table.length === 0) {
      this.glowReady = false;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.glowTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, table.length / 2, 1, 0, gl.RG, gl.UNSIGNED_BYTE, table);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.glowDome = dome;
    this.glowReady = true;
  }

  /**
   * 地面の光の地図を貼る。data=建物の光(白。R=強さ 0〜255、size×size)。road=道路の光(オレンジ。roadSize×roadSize。
   * ミップマップを作る)。どちらも原点から±half(m)を覆う。nullなら外す
   */
  setGroundLight(
    map: {
      data: Uint8Array;
      size: number;
      half: number;
      road?: Uint8Array | null;
      roadSize?: number;
      /** 人口集中地区の割合の地図(建物の発光を、DIDの中だけ弱める)。didSize×didSize、原点から±didHalf(m) */
      did?: Uint8Array;
      didSize?: number;
      didHalf?: number;
    } | null,
  ): void {
    const gl = this.gl;
    if (!map) {
      this.groundLightReady = false;
      this.roadLightReady = false;
      this.objects.setDidMap(null);
      return;
    }
    this.objects.setDidMap(map.did && map.didSize && map.didHalf ? { data: map.did, size: map.didSize, half: map.didHalf } : null);
    gl.bindTexture(gl.TEXTURE_2D, this.groundLightTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, map.size, map.size, 0, gl.RED, gl.UNSIGNED_BYTE, map.data);
    this.linearClamp();
    this.groundLightRect = [-map.half, -map.half, 2 * map.half, 2 * map.half];
    this.groundLightReady = true;
    if (map.road && map.roadSize) {
      gl.bindTexture(gl.TEXTURE_2D, this.roadLightTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, map.roadSize, map.roadSize, 0, gl.RED, gl.UNSIGNED_BYTE, map.road);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      this.roadLightReady = true;
    } else {
      this.roadLightReady = false;
    }
  }

  private linearClamp(): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** 描いて、そのフレームの「ワールド→画面」の行列を返す(太陽・月の印などを重ねるのに使う) */
  render(p: FrameParams): Mat4 {
    const gl = this.gl;
    const basis = cameraBasis(p.yawDeg, p.pitchDeg);
    const aspect = p.width / Math.max(1, p.height);
    const proj = perspective(p.fovDeg, aspect, p.near, p.far);
    const vp = mulMat4(proj, viewMatrix(p.eye, basis));
    const tanY = Math.tan((p.fovDeg * Math.PI) / 360);
    const look = p.look;

    gl.viewport(0, 0, p.width, p.height);
    gl.clearColor(look.horizon[0], look.horizon[1], look.horizon[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // 霧の層(霧の地図・地面の高さの地図が貼られていて、オンのときだけ)
    const lf = p.layerFog;
    const lfOn = !!lf && lf.on && this.fogReady && this.heightReady;
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_2D, this.fogTex);
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    const lc = p.cloud;
    const lcOn = !!lc && lc.on && this.cloudReady;
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, this.cloudTex);
    const setLayerCloud = (u: Record<string, WebGLUniformLocation | null>) => {
      gl.uniform1i(u.uLcMap, 6);
      gl.uniform1f(u.uLcOn, lcOn ? 1 : 0);
      if (lc) {
        gl.uniform4fv(u.uLcRect, lc.rect);
        gl.uniform3fv(u.uLcCol, lc.color);
        gl.uniform1f(u.uLcSigma, lc.sigma);
        gl.uniform2fv(u.uLcAlt, lc.alt);
      }
    };
    const setLayerFog = (u: Record<string, WebGLUniformLocation | null>) => {
      gl.uniform1i(u.uLfMap, 4);
      gl.uniform1i(u.uLfHeight, 5);
      gl.uniform1f(u.uLfOn, lfOn ? 1 : 0);
      if (lf) {
        gl.uniform4fv(u.uLfRect, lf.rect);
        gl.uniform3fv(u.uLfCol, lf.color);
        gl.uniform1f(u.uLfSigma, lf.sigma);
        gl.uniform1f(u.uLfTop, lf.top);
      }
    };

    // 雲海(地形・木・建物・空・星座で共通)
    const sea = p.sea;
    const seaOn = !!sea && sea.on && this.seaReady;
    const seaDraw: SeaDraw = {
      on: seaOn,
      rect: this.seaRect,
      h: sea?.h ?? 0,
      col: sea?.col ?? [1, 1, 1],
      shade: !!this.shade,
      hq: !!p.hq,
    };

    // 夜の地面・建物の明かりの強さ(昼は0)
    let glowK = 0;

    // --- 地形(先に描く。空は地形に隠れていない画素だけに描くので、重い霧の計算を無駄にしない) ---
    if (this.meshVao) {
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.depthMask(true);
      gl.useProgram(this.terrainProg);
      const t = this.uT;
      gl.uniformMatrix4fv(t.uVP, false, vp);
      const bind = (unit: number, tex: WebGLTexture, name: string) => {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(t[name], unit);
      };
      bind(0, this.tex.farBase, "uFarBase");
      bind(1, this.tex.nearBase, "uNearBase");
      bind(2, this.tex.farOv, "uFarOv");
      bind(3, this.tex.nearOv, "uNearOv");
      bind(13, this.tex.midBase, "uMidBase");
      gl.uniform4fv(t.uMidRect, p.midRect);
      gl.uniform1f(t.uMidOn, p.midOn ? 1 : 0);
      bind(14, this.tex.footBase, "uFootBase");
      gl.uniform4fv(t.uFootRect, p.footRect);
      gl.uniform1f(t.uFootOn, p.footOn ? 1 : 0);
      gl.uniform2fv(t.uFootAt, this.footAt);
      bind(15, this.tex.fineBase, "uFineBase");
      gl.uniform4fv(t.uFineRect, p.fineRect);
      gl.uniform4fv(t.uFineAt, this.atlasAt.fine);
      gl.uniform1f(t.uFineOn, p.fineOn ? 1 : 0);
      gl.uniform4fv(t.uWFootRect, p.wfootRect);
      gl.uniform4fv(t.uWFootAt, this.atlasAt.wfoot);
      gl.uniform1f(t.uWFootOn, p.wfootOn && this.atlas.parts.wfoot ? 1 : 0);
      gl.uniform4fv(t.uAheadRect, p.aheadRect);
      gl.uniform4fv(t.uAheadAt, this.atlasAt.ahead);
      gl.uniform1f(t.uAheadOn, p.aheadOn && this.atlas.parts.ahead ? 1 : 0);
      bind(7, this.waterTex.near, "uWaterNear");
      bind(8, this.waterTex.wide, "uWaterWide");
      bind(9, this.waterTex.far, "uWaterFar");
      bind(11, this.groundLightTex, "uGroundLight");
      bind(12, this.roadLightTex, "uRoadLight");
      gl.uniform1f(t.uRoadOn, this.roadLightReady ? 1 : 0);
      gl.uniform4fv(t.uGroundLightRect, this.groundLightRect);
      glowK = p.glowOn && this.groundLightReady ? Math.min(1, look.night * 1.2) * 0.9 : 0;
      gl.uniform1f(t.uGroundGlowK, glowK);
      gl.uniform4fv(t.uWaterNearRect, this.waterRect.near);
      gl.uniform4fv(t.uWaterWideRect, this.waterRect.wide);
      gl.uniform4fv(t.uWaterFarRect, this.waterRect.far);
      const wOn = p.waterOn !== false;
      gl.uniform3f(
        t.uWaterOn,
        wOn && this.waterReady.wide ? 1 : 0,
        wOn && this.waterReady.near ? 1 : 0,
        wOn && this.waterReady.far ? 1 : 0,
      );
      gl.uniform3fv(t.uZenith, look.zenith);
      setLayerFog(t);
      setLayerCloud(t);
      // 雲海(ユニット10。空のシェーダーがあとで同じユニットに光害の表を貼るので、フレームごとに貼り直す)
      bind(10, this.seaTex, "uCsMap");
      gl.uniform4fv(t.uCsRect, this.seaRect);
      gl.uniform1f(t.uShOn, this.shade ? 1 : 0);
      gl.uniform1f(t.uHq, p.hq ? 1 : 0);
      gl.uniform1f(t.uCsOn, seaOn ? 1 : 0);
      gl.uniform1f(t.uCsH, sea?.h ?? 0);
      gl.uniform1f(t.uCsThick, SEA_THICK_M);
      gl.uniform1f(t.uCsSigma, SEA_SIGMA);
      gl.uniform3fv(t.uCsCol, sea?.col ?? [1, 1, 1]);
      gl.uniform4fv(t.uFarRect, p.farRect);
      gl.uniform4fv(t.uNearRect, p.nearRect);
      gl.uniform1f(t.uNearOn, p.nearOn ? 1 : 0);
      gl.uniform1f(t.uNearOvOn, p.nearOvOn ? 1 : 0);
      gl.uniform1f(t.uOvOpacity, p.overlayOpacity);
      gl.uniform3fv(t.uSunDir, p.sunDir);
      gl.uniform3fv(t.uSunColor, look.sunColor);
      gl.uniform1f(t.uSunStrength, look.sunStrength);
      gl.uniform3fv(t.uMoonDir, p.moonDir);
      gl.uniform3fv(t.uMoonColor, look.moonColor);
      gl.uniform1f(t.uMoonStrength, look.moonStrength);
      gl.uniform3fv(t.uAmbient, look.ambient);
      gl.uniform3fv(t.uFogColor, look.horizon);
      const rangeM = p.rangeM ?? 25_000;
      // 遠くの霞: 描画範囲を拡張したときは、霞を薄くして(約50kmでも通常の25kmと同じ濃さ)、25km以遠の紅葉も見えるようにする
      gl.uniform1f(t.uFogDensity, 1 / (52_000 * (rangeM / 25_000)));
      gl.uniform3fv(t.uCam, p.eye);
      gl.uniform2f(t.uEdge, rangeM * 0.76, rangeM * 0.992);
      gl.bindVertexArray(this.meshVao);
      gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
      // 建物・木(地形と同じ光・霧・雲を掛ける)
      this.objects.drawSolids(p, vp, lfOn, lcOn, glowK, seaDraw);
    }

    // --- 空(奥行き1.0=地形が無い画素だけ) ---
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(false);
    gl.useProgram(this.skyProg);
    const s = this.uS;
    setLayerFog(s);
    setLayerCloud(s);
    gl.uniform3fv(s.uCam, p.eye);
    gl.uniform3fv(s.uRight, basis.right);
    gl.uniform3fv(s.uUp, basis.up);
    gl.uniform3fv(s.uFwd, basis.forward);
    gl.uniform2f(s.uTan, tanY * aspect, tanY);
    gl.uniform3fv(s.uZenith, look.zenith);
    gl.uniform3fv(s.uHorizon, look.horizon);
    gl.uniform3fv(s.uGround, look.ground);
    gl.uniform3fv(s.uSunDir, p.sunDir);
    gl.uniform3fv(s.uSunColor, look.sunColor);
    gl.uniform3fv(s.uMoonDir, p.moonDir);
    gl.uniform1f(s.uSunVisible, look.sunVisible);
    gl.uniform1f(s.uNight, look.night);
    gl.uniform1f(s.uSunR, SUN_DISC_RADIUS_RAD);
    gl.uniform1f(s.uMoonR, MOON_DISC_RADIUS_RAD);
    gl.uniform1f(s.uMoonIllum, p.moonIllum);
    // 天球の向きは、天の川を表示しないときも渡す(星をこの向きで描くため)
    const frame = p.milky ?? p.skyFrame;
    if (frame) {
      gl.uniform3fv(s.uGx, frame.gx);
      gl.uniform3fv(s.uGy, frame.gy);
      gl.uniform3fv(s.uGz, frame.gz);
    }
    gl.uniform1f(s.uMilky, p.milky ? p.milky.strength : 0);
    // 天の川の明るさの地図(ユニット12。地形のシェーダーは、毎フレーム、ユニット12を道路の光の地図に貼り直す)
    gl.activeTexture(gl.TEXTURE12);
    gl.bindTexture(gl.TEXTURE_2D, this.mwTex);
    gl.uniform1i(s.uMwMap, 12);
    gl.uniform1f(s.uMwMapOn, this.mwReady ? 1 : 0);
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, this.glowTex);
    gl.uniform1i(s.uGlow, 10);
    gl.uniform1f(s.uGlowOn, p.glowOn && this.glowReady ? 1 : 0);
    gl.uniform1f(s.uGlowDome, this.glowDome);
    // 雲海の層(ユニット11。地形のシェーダーは次のフレームで、ユニット11を地面の光の表に貼り直す)
    gl.activeTexture(gl.TEXTURE11);
    gl.bindTexture(gl.TEXTURE_2D, this.seaTex);
    gl.uniform1i(s.uCsMap, 11);
    gl.uniform4fv(s.uCsRect, this.seaRect);
    gl.uniform1f(s.uCsOn, seaOn ? 1 : 0);
    gl.uniform1f(s.uCsH, sea?.h ?? 0);
    gl.uniform1f(s.uCsThick, SEA_THICK_M);
    gl.uniform1f(s.uCsSigma, SEA_SIGMA);
    gl.uniform3fv(s.uCsCol, sea?.col ?? [1, 1, 1]);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);
    gl.bindVertexArray(null);
    // 夜の建物の明かり・星座(空の上に重ねる)
    this.objects.drawLights(p, vp, lfOn, lcOn, glowK, seaDraw);
    this.objects.drawConstellations(p, vp, seaDraw);
    return vp;
  }

  dispose(): void {
    const gl = this.gl;
    if (this.meshVao) gl.deleteVertexArray(this.meshVao);
    for (const b of this.meshBuffers) gl.deleteBuffer(b);
    for (const t of Object.values(this.tex)) gl.deleteTexture(t);
    gl.deleteTexture(this.fogTex);
    gl.deleteTexture(this.heightTex);
    gl.deleteTexture(this.cloudTex);
    gl.deleteTexture(this.seaTex);
    gl.deleteTexture(this.glowTex);
    gl.deleteTexture(this.mwTex);
    gl.deleteTexture(this.groundLightTex);
    gl.deleteTexture(this.roadLightTex);
    gl.deleteTexture(this.waterTex.near);
    gl.deleteTexture(this.waterTex.wide);
    gl.deleteTexture(this.waterTex.far);
    this.objects.dispose();
    gl.deleteProgram(this.terrainProg);
    gl.deleteProgram(this.skyProg);
    gl.deleteVertexArray(this.emptyVao);
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  }
}

/**
 * 空に描く太陽・月の円盤の半径(ラジアン)。実際の見かけの大きさ(約0.0046)の約4倍で、
 * 位置が分かりやすいように大きめにしてある。
 */
export const SUN_DISC_RADIUS_RAD = 0.019;
export const MOON_DISC_RADIUS_RAD = 0.019;
