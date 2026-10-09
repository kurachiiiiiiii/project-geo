import { DEG, cameraBasis, compass8, diffAz, dirFromAzAlt, dot, normAz, projectPoint, type Mat4, type Vec3 } from "./viewerMath";
import type { ConstLabel } from "./viewerConst";
import type { BodyPos, PathSample } from "./viewerSky";

/**
 * 3Dビューワー: 3Dの絵の上に重ねる2D表示。
 *   ・上部の方位の目盛り(向いている方位、太陽・月の方位)
 *   ・地平線の方位の文字(北・北東・東…)
 *   ・太陽・月の印(画面の外にあるときは、その方向を指す矢印)
 *   ・その日の太陽・月の通り道(軌跡)と、時刻の目印
 * 太陽・月の円盤そのもの(山に隠れる)は3D側(空のシェーダー)で描いている。ここは位置を読み取るための補助。
 * 絵文字は環境によって表示されないことがあるため、記号はすべて図形で描く。
 */

export const SUN_COLOR = "#ffb52e";
export const MOON_COLOR = "#bcd4ff";
export const MILKY_COLOR = "#c084fc";

export interface OverlayInput {
  /** 画面の大きさ(CSS px) */
  width: number;
  height: number;
  vp: Mat4;
  eye: Vec3;
  yawDeg: number;
  pitchDeg: number;
  /** 縦方向の視野角(度) */
  fovDeg: number;
  sun: BodyPos;
  moon: BodyPos;
  sunPath: PathSample[];
  moonPath: PathSample[];
  /** 銀河中心(天の川の中心)の位置と、その日の通り道。天の川を表示しないときはnull/空 */
  milky: BodyPos | null;
  milkyPath: PathSample[];
  /** 星座の名前(3D側で星・線を描いているときだけ渡す)。strength=夜の暗さ(0〜1) */
  constellation?: { labels: ConstLabel[]; strength: number };
  showPaths: boolean;
  /** 上部のバー(タイトル)に隠れないよう空ける高さ(px) */
  topInset: number;
  /** 下部のパネルに隠れないよう空ける高さ(px) */
  bottomInset: number;
}

const FONT = "600 13px system-ui, 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic UI', sans-serif";

function text(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, fill: string, align: CanvasTextAlign = "left") {
  ctx.textAlign = align;
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(0,0,0,0.7)";
  ctx.strokeText(s, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(s, x, y);
}

function sunIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = SUN_COLOR;
  ctx.fillStyle = SUN_COLOR;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.55, 0, Math.PI * 2);
  ctx.fill();
  for (let i = 0; i < 8; i++) {
    const a = (i * Math.PI) / 4;
    ctx.beginPath();
    ctx.moveTo(x + Math.cos(a) * r * 0.8, y + Math.sin(a) * r * 0.8);
    ctx.lineTo(x + Math.cos(a) * r * 1.15, y + Math.sin(a) * r * 1.15);
    ctx.stroke();
  }
  ctx.restore();
}

function moonIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = MOON_COLOR;
  ctx.strokeStyle = "rgba(20,30,60,0.8)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.75, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function milkyIcon(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, alpha: number) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = MILKY_COLOR;
  ctx.strokeStyle = "rgba(30,10,60,0.8)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.05, r * 0.5, -0.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

interface Screen {
  x: number;
  y: number;
  /** 画面の中(視点の前方で、画面内)にあるか */
  inside: boolean;
  /** 視点の前方か */
  front: boolean;
}

export function drawSkyOverlay(ctx: CanvasRenderingContext2D, o: OverlayInput): void {
  const { width: W, height: H } = o;
  ctx.clearRect(0, 0, W, H);
  ctx.font = FONT;
  ctx.textBaseline = "middle";

  const basis = cameraBasis(o.yawDeg, o.pitchDeg);
  const toScreen = (dir: Vec3): Screen => {
    const p: Vec3 = [o.eye[0] + dir[0] * 1e4, o.eye[1] + dir[1] * 1e4, o.eye[2] + dir[2] * 1e4];
    const c = projectPoint(o.vp, p);
    const front = c.w > 1e-6;
    if (!front) return { x: 0, y: 0, inside: false, front };
    const nx = c.x / c.w;
    const ny = c.y / c.w;
    return {
      x: (nx * 0.5 + 0.5) * W,
      y: (0.5 - ny * 0.5) * H,
      inside: Math.abs(nx) <= 1.02 && Math.abs(ny) <= 1.02,
      front,
    };
  };

  const aspect = W / Math.max(1, H);
  const hFovDeg = (2 * Math.atan(Math.tan((o.fovDeg * DEG) / 2) * aspect)) / DEG;

  // ---- 太陽・月の通り道 ----
  if (o.showPaths) {
    const drawPath = (samples: PathSample[], color: string, dash: number[], labelEveryHours: number) => {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(dash);
      ctx.globalAlpha = 0.85;
      let prev: Screen | null = null;
      for (const s of samples) {
        if (s.altitudeDeg < -3) {
          prev = null;
          continue;
        }
        const sc = toScreen(dirFromAzAlt(s.azimuthDeg, s.altitudeDeg));
        if (sc.front && prev && prev.front && Math.abs(sc.x - prev.x) < W && Math.abs(sc.y - prev.y) < H) {
          ctx.beginPath();
          ctx.moveTo(prev.x, prev.y);
          ctx.lineTo(sc.x, sc.y);
          ctx.stroke();
        }
        prev = sc;
      }
      ctx.restore();
      // 時刻の目印
      ctx.save();
      ctx.font = "600 11px system-ui, 'Hiragino Sans', 'Noto Sans JP', sans-serif";
      for (const s of samples) {
        if (s.altitudeDeg < -1 || s.time.getMinutes() !== 0) continue;
        const h = s.time.getHours();
        if (h % labelEveryHours !== 0) continue;
        const sc = toScreen(dirFromAzAlt(s.azimuthDeg, s.altitudeDeg));
        if (!sc.inside) continue;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(sc.x, sc.y, 3, 0, Math.PI * 2);
        ctx.fill();
        text(ctx, `${h}時`, sc.x + 6, sc.y - 7, color);
      }
      ctx.restore();
    };
    if (o.milky) drawPath(o.milkyPath, MILKY_COLOR, [2, 5], 3);
    drawPath(o.moonPath, MOON_COLOR, [6, 5], 3);
    drawPath(o.sunPath, SUN_COLOR, [], 1);
  }

  // ---- 地平線の方位の文字 ----
  ctx.font = FONT;
  for (let az = 0; az < 360; az += 45) {
    const sc = toScreen(dirFromAzAlt(az, 0.6));
    if (!sc.inside) continue;
    const major = az % 90 === 0;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(sc.x, sc.y);
    ctx.lineTo(sc.x, sc.y - 10);
    ctx.stroke();
    ctx.restore();
    text(ctx, compass8(az), sc.x, sc.y - 20, major ? "#ffffff" : "rgba(255,255,255,0.8)", "center");
  }

  // ---- 星座・星の名前(重ならないように、星座名→大三角など→星の名前の順に置く) ----
  if (o.constellation && o.constellation.strength > 0.12) {
    const a0 = Math.min(1, o.constellation.strength * 1.1);
    const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
    const yMin = o.topInset + 66;
    const yMax = H - o.bottomInset - 8;
    const order = [...o.constellation.labels].sort((p, q) => p.kind - q.kind);
    ctx.save();
    for (const lb of order) {
      if (lb.altDeg < 3 || !lb.text) continue;
      const sc = toScreen(lb.dir);
      if (!sc.inside || sc.y < yMin || sc.y > yMax) continue;
      const small = lb.kind === 2;
      ctx.font = small
        ? "500 11px system-ui, 'Hiragino Sans', 'Noto Sans JP', sans-serif"
        : "700 14px system-ui, 'Hiragino Sans', 'Noto Sans JP', 'Yu Gothic UI', sans-serif";
      const tw = ctx.measureText(lb.text).width;
      // 星の名前は星の少し右上、星座名は中心に
      const cx = small ? sc.x + 6 + tw / 2 : sc.x;
      const cy = small ? sc.y - 8 : sc.y;
      const box = { x0: cx - tw / 2 - 3, y0: cy - 9, x1: cx + tw / 2 + 3, y1: cy + 9 };
      if (placed.some((q) => box.x0 < q.x1 && box.x1 > q.x0 && box.y0 < q.y1 && box.y1 > q.y0)) continue;
      placed.push(box);
      ctx.globalAlpha = a0 * (small ? 0.8 : 1);
      text(ctx, lb.text, cx, cy, small ? "#d8e6ff" : lb.kind === 1 ? "#ffd98a" : "#a8d4ff", "center");
    }
    ctx.restore();
    ctx.font = FONT;
  }

  // ---- 太陽・月の印 ----
  const edgeLabels: { x: number; y: number }[] = [];
  /** 画面の中に出した太陽・月・天の川の文字の位置(重ならないように置くため) */
  const bodyLabels: { x0: number; x1: number; y: number }[] = [];
  const drawBody = (kind: "sun" | "moon" | "milky", pos: BodyPos) => {
    const dir = dirFromAzAlt(pos.azimuthDeg, pos.altitudeDeg);
    const color = kind === "sun" ? SUN_COLOR : kind === "moon" ? MOON_COLOR : MILKY_COLOR;
    const name = kind === "sun" ? "太陽" : kind === "moon" ? "月" : "天の川の中心";
    const below = pos.altitudeDeg < 0;
    const alpha = below ? 0.55 : 1;
    const label = `${name} 方位${Math.round(normAz(pos.azimuthDeg))}°${compass8(pos.azimuthDeg)} 高度${pos.altitudeDeg.toFixed(1)}°${below ? "(地平線の下)" : ""}`;
    const sc = toScreen(dir);
    if (sc.inside) {
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(below ? [4, 4] : []);
      ctx.beginPath();
      ctx.arc(sc.x, sc.y, 22, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      ctx.font = FONT;
      // 文字は、画面からはみ出さない側(右 or 左)に出す。どちらにも入らない狭い画面(スマホの縦)では、短い文にする。
      // 太陽と月が近いときなど、先に置いた文字と重なるときは下へずらす
      const room = (leftSide: boolean) => (leftSide ? sc.x - 28 - 4 : W - 4 - (sc.x + 28));
      let txt = label;
      let tw = ctx.measureText(txt).width;
      let left = sc.x > W * 0.6;
      if (room(left) < tw && room(!left) >= tw) left = !left;
      if (room(left) < tw) {
        txt = `${name} ${Math.round(normAz(pos.azimuthDeg))}° 高度${pos.altitudeDeg.toFixed(0)}°`;
        tw = ctx.measureText(txt).width;
        if (room(left) < tw && room(!left) >= tw) left = !left;
      }
      const lx = left ? sc.x - 28 : sc.x + 28;
      const bx0 = left ? lx - tw : lx;
      let ly = sc.y;
      for (let k = 0; k < 4; k++) {
        if (bodyLabels.some((q) => bx0 < q.x1 && bx0 + tw > q.x0 && Math.abs(q.y - ly) < 17)) ly += 17;
      }
      bodyLabels.push({ x0: bx0, x1: bx0 + tw, y: ly });
      text(ctx, txt, lx, ly, color, left ? "right" : "left");
    } else {
      // 画面の外: その方向の縁に矢印を出す(上のバー・方位の目盛り、下のパネルを避けた枠の縁)
      const vx = dot(dir, basis.right);
      const vy = dot(dir, basis.up);
      const ang = Math.atan2(vy, vx);
      const dx = Math.cos(ang);
      const dy = -Math.sin(ang);
      const m = 34;
      const top = o.topInset + 74;
      const bottom = H - o.bottomInset;
      const hx = Math.max(10, (W - 2 * m) / 2);
      const hy = Math.max(10, (bottom - top) / 2);
      const tx = Math.abs(dx) < 1e-6 ? Infinity : hx / Math.abs(dx);
      const ty = Math.abs(dy) < 1e-6 ? Infinity : hy / Math.abs(dy);
      const t = Math.min(tx, ty);
      const cx = W / 2 + dx * t;
      const cy = (top + bottom) / 2 + dy * t;
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.translate(cx, cy);
      ctx.rotate(Math.atan2(dy, dx));
      ctx.fillStyle = color;
      ctx.strokeStyle = "rgba(0,0,0,0.7)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(14, 0);
      ctx.lineTo(-8, -9);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.restore();
      ctx.font = FONT;
      const alignRight = cx > W / 2;
      const lx = alignRight ? cx - 22 : cx + 22;
      let ly = cy + (dy > 0.7 ? -16 : 0);
      // 太陽と月が近いとき(新月の頃など)、矢印の文字が重ならないようずらす
      for (let k = 0; k < 3; k++) {
        if (edgeLabels.some((q) => Math.abs(q.x - lx) < 200 && Math.abs(q.y - ly) < 15)) ly += dy > 0.7 ? -16 : 16;
      }
      edgeLabels.push({ x: lx, y: ly });
      text(ctx, `${name} ${Math.round(normAz(pos.azimuthDeg))}° 高度${pos.altitudeDeg.toFixed(0)}°`, lx, ly, color, alignRight ? "right" : "left");
    }
  };
  if (o.milky) drawBody("milky", o.milky);
  drawBody("moon", o.moon);
  drawBody("sun", o.sun);

  // ---- 上部の方位の目盛り ----
  const stripY = o.topInset + 4;
  const stripH = 30;
  ctx.save();
  ctx.fillStyle = "rgba(10,16,30,0.55)";
  ctx.fillRect(0, stripY, W, stripH);
  const ppd = W / Math.max(10, hFovDeg);
  const from = Math.floor((o.yawDeg - hFovDeg / 2) / 5) * 5;
  const to = o.yawDeg + hFovDeg / 2 + 5;
  ctx.font = "600 12px system-ui, 'Hiragino Sans', 'Noto Sans JP', sans-serif";
  for (let a = from; a <= to; a += 5) {
    const x = W / 2 + diffAz(a, o.yawDeg) * ppd;
    const aa = normAz(a);
    const major = aa % 15 === 0;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, stripY + stripH);
    ctx.lineTo(x, stripY + stripH - (major ? 9 : 5));
    ctx.stroke();
    if (aa % 45 === 0) {
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.fillText(compass8(aa), x, stripY + 11);
    } else if (aa % 15 === 0 && hFovDeg < 120) {
      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.textAlign = "center";
      ctx.fillText(String(aa), x, stripY + 11);
    }
  }
  // 太陽・月の方位
  const marker = (kind: "sun" | "moon" | "milky", pos: BodyPos) => {
    const d = diffAz(pos.azimuthDeg, o.yawDeg);
    if (Math.abs(d) > hFovDeg / 2 + 4) return;
    const x = W / 2 + d * ppd;
    const alpha = pos.altitudeDeg < 0 ? 0.55 : 1;
    if (kind === "sun") sunIcon(ctx, x, stripY + stripH - 8, 7, alpha);
    else if (kind === "moon") moonIcon(ctx, x, stripY + stripH - 8, 7, alpha);
    else milkyIcon(ctx, x, stripY + stripH - 8, 7, alpha);
  };
  if (o.milky) marker("milky", o.milky);
  marker("moon", o.moon);
  marker("sun", o.sun);
  // 中央(向いている方位)
  ctx.fillStyle = "#ff5a4a";
  ctx.beginPath();
  ctx.moveTo(W / 2, stripY + stripH + 1);
  ctx.lineTo(W / 2 - 5, stripY + stripH + 8);
  ctx.lineTo(W / 2 + 5, stripY + stripH + 8);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  ctx.font = FONT;
  text(ctx, `向き ${Math.round(normAz(o.yawDeg))}°(${compass8(o.yawDeg)})`, W / 2, stripY + stripH + 22, "#ffffff", "center");
}
