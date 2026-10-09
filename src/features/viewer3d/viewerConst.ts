import * as Astronomy from "astronomy-engine";
import { DEG, clamp, type Vec3 } from "./viewerMath";
import type { ConstellationGlData } from "./viewerObjectsGl";

/**
 * 3Dビューワー: 有名な星座の星と線・名前。夏の大三角・冬の大三角・春の大三角のほか、カシオペヤ座、北斗七星、
 * こと座・はくちょう座・わし座、オリオン座、さそり座、いて座(ティーポット)など。
 * 星の位置(赤経・赤緯。J2000)は代表的な明るい星の値で、位置の精度は見た目(0.1°程度)には十分。
 * 空の向きへの変換は、太陽・月・天の川と同じ astronomy-engine を使う(歳差・地球の自転を含む)。
 */

/** id, 赤経(時 分 秒), 赤緯(度 分), 等級, 名前(あれば) */
type StarRow = [string, string, string, number, string?];

const STAR_ROWS: StarRow[] = [
  // 夏の大三角・こと座・はくちょう座・わし座
  ["vega", "18 36 56", "+38 47", 0.03, "ベガ"],
  ["deneb", "20 41 26", "+45 17", 1.25, "デネブ"],
  ["altair", "19 50 47", "+08 52", 0.76, "アルタイル"],
  ["zeta_lyr", "18 44 47", "+37 36", 4.4],
  ["delta_lyr", "18 54 30", "+36 54", 4.3],
  ["gamma_lyr", "18 58 57", "+32 41", 3.25],
  ["beta_lyr", "18 50 05", "+33 22", 3.4],
  ["sadr", "20 22 14", "+40 15", 2.2],
  ["albireo", "19 30 43", "+27 58", 3.1],
  ["delta_cyg", "19 44 58", "+45 08", 2.87],
  ["eps_cyg", "20 46 13", "+33 58", 2.46],
  ["tarazed", "19 46 16", "+10 37", 2.72],
  ["alshain", "19 55 18", "+06 24", 3.7],
  // カシオペヤ座
  ["schedar", "00 40 30", "+56 32", 2.24],
  ["caph", "00 09 10", "+59 09", 2.27],
  ["gamma_cas", "00 56 43", "+60 43", 2.47],
  ["ruchbah", "01 25 49", "+60 14", 2.68],
  ["segin", "01 54 24", "+63 40", 3.38],
  // 北極星・こぐま座
  ["polaris", "02 31 49", "+89 16", 1.98, "北極星"],
  ["kochab", "14 50 42", "+74 09", 2.08],
  ["pherkad", "15 20 44", "+71 50", 3.0],
  ["yildun", "17 32 13", "+86 35", 4.36],
  ["eps_umi", "16 45 58", "+82 02", 4.2],
  ["zeta_umi", "15 44 04", "+77 47", 4.3],
  ["eta_umi", "16 17 30", "+75 45", 4.95],
  // 北斗七星(おおぐま座)
  ["dubhe", "11 03 44", "+61 45", 1.79],
  ["merak", "11 01 50", "+56 23", 2.37],
  ["phecda", "11 53 50", "+53 41", 2.44],
  ["megrez", "12 15 26", "+57 02", 3.31],
  ["alioth", "12 54 02", "+55 57", 1.77],
  ["mizar", "13 23 56", "+54 56", 2.04],
  ["alkaid", "13 47 32", "+49 19", 1.86],
  // オリオン座・冬の大三角・おおいぬ座
  ["betelgeuse", "05 55 10", "+07 24", 0.5, "ベテルギウス"],
  ["rigel", "05 14 32", "-08 12", 0.13, "リゲル"],
  ["bellatrix", "05 25 08", "+06 21", 1.64],
  ["saiph", "05 47 45", "-09 40", 2.07],
  ["mintaka", "05 32 00", "-00 18", 2.23],
  ["alnilam", "05 36 13", "-01 12", 1.69],
  ["alnitak", "05 40 46", "-01 57", 1.74],
  ["meissa", "05 35 08", "+09 56", 3.3],
  ["sirius", "06 45 09", "-16 43", -1.46, "シリウス"],
  ["procyon", "07 39 18", "+05 14", 0.34, "プロキオン"],
  ["mirzam", "06 22 42", "-17 57", 1.98],
  ["adhara", "06 58 38", "-28 58", 1.5],
  ["wezen", "07 08 23", "-26 23", 1.83],
  ["aludra", "07 24 06", "-29 18", 2.45],
  // ふたご座・おうし座・ぎょしゃ座
  ["castor", "07 34 36", "+31 53", 1.58, "カストル"],
  ["pollux", "07 45 19", "+28 02", 1.14, "ポルックス"],
  ["alhena", "06 37 43", "+16 24", 1.9],
  ["tejat", "06 22 58", "+22 30", 2.9],
  ["propus", "06 14 51", "+22 30", 3.3],
  ["mebsuta", "06 43 56", "+25 08", 3.0],
  ["wasat", "07 20 07", "+21 59", 3.5],
  ["aldebaran", "04 35 55", "+16 31", 0.85, "アルデバラン"],
  ["elnath", "05 26 18", "+28 36", 1.65],
  ["zeta_tau", "05 37 39", "+21 09", 3.0],
  ["gamma_tau", "04 19 48", "+15 38", 3.65],
  ["pleiades", "03 47 29", "+24 06", 2.9, "すばる"],
  ["capella", "05 16 41", "+45 59", 0.08, "カペラ"],
  ["menkalinan", "05 59 32", "+44 57", 1.9],
  ["theta_aur", "05 59 43", "+37 13", 2.6],
  ["iota_aur", "04 56 59", "+33 10", 2.7],
  // しし座
  ["regulus", "10 08 22", "+11 58", 1.35, "レグルス"],
  ["denebola", "11 49 04", "+14 34", 2.14, "デネボラ"],
  ["algieba", "10 19 58", "+19 50", 2.0],
  ["zosma", "11 14 06", "+20 31", 2.56],
  ["eta_leo", "10 07 20", "+16 46", 3.5],
  ["chertan", "11 14 14", "+15 26", 3.3],
  ["zeta_leo", "10 16 41", "+23 25", 3.4],
  ["mu_leo", "09 52 45", "+26 00", 3.9],
  ["eps_leo", "09 45 51", "+23 46", 3.0],
  // さそり座
  ["antares", "16 29 24", "-26 26", 0.96, "アンタレス"],
  ["graffias", "16 05 26", "-19 48", 2.6],
  ["dschubba", "16 00 20", "-22 37", 2.3],
  ["pi_sco", "15 58 51", "-26 06", 2.9],
  ["sigma_sco", "16 21 11", "-25 36", 2.9],
  ["tau_sco", "16 35 53", "-28 13", 2.8],
  ["eps_sco", "16 50 10", "-34 17", 2.3],
  ["mu_sco", "16 51 52", "-38 03", 3.0],
  ["zeta_sco", "16 54 33", "-42 21", 3.6],
  ["eta_sco", "17 12 09", "-43 14", 3.3],
  ["sargas", "17 37 19", "-42 59", 1.9],
  ["iota_sco", "17 47 35", "-40 08", 3.0],
  ["kappa_sco", "17 42 29", "-39 02", 2.4],
  ["shaula", "17 33 36", "-37 06", 1.6],
  ["lesath", "17 30 46", "-37 18", 2.7],
  // いて座(ティーポット)
  ["kaus_a", "18 24 10", "-34 23", 1.85],
  ["kaus_m", "18 20 59", "-29 50", 2.7],
  ["kaus_b", "18 27 58", "-25 25", 2.8],
  ["nunki", "18 55 16", "-26 18", 2.05],
  ["ascella", "19 02 37", "-29 52", 2.6],
  ["tau_sgr", "19 06 56", "-27 40", 3.3],
  ["phi_sgr", "18 45 39", "-26 59", 3.2],
  ["alnasl", "18 05 48", "-30 25", 2.98],
  // 秋の四辺形(ペガスス座)・アンドロメダ座・フォーマルハウト
  ["markab", "23 04 46", "+15 12", 2.49],
  ["scheat", "23 03 46", "+28 05", 2.4],
  ["algenib", "00 13 14", "+15 11", 2.83],
  ["alpheratz", "00 08 23", "+29 05", 2.06],
  ["mirach", "01 09 44", "+35 37", 2.05],
  ["almach", "02 03 54", "+42 20", 2.1],
  ["fomalhaut", "22 57 39", "-29 37", 1.16, "フォーマルハウト"],
  // うしかい座・春の大三角
  ["arcturus", "14 15 40", "+19 11", -0.05, "アークトゥルス"],
  ["spica", "13 25 12", "-11 10", 0.97, "スピカ"],
  ["izar", "14 44 59", "+27 04", 2.7],
  ["seginus", "14 32 05", "+38 18", 3.0],
  ["nekkar", "15 01 57", "+40 23", 3.5],
  ["rho_boo", "14 31 50", "+30 22", 3.6],
  ["delta_boo", "15 15 30", "+33 19", 3.5],
];

/** 線の種類: 0=星座の線、1=大三角(目立たせる)、2=春の大曲線 */
type LineKind = 0 | 1 | 2;

interface ConstDef {
  name: string;
  kind: LineKind;
  paths: string[][];
  /**
   * 星と星を直線ではなく、なめらかな曲線(Catmull-Rom)でつなぐ。lead は曲線の最初の向きを決めるだけで線は引かない手前の星
   * (春の大曲線は、北斗七星の柄のカーブをそのままのばした線なので、柄の途中の星 mizar から続くようにする)。
   */
  smooth?: { lead: string };
}

/** 曲線を1区間(星と星の間)ごとに何本の線分に刻むか */
const SMOOTH_STEPS = 16;
/** 曲線の線分(両端のはみ出しなし。つなぎ目で重なって濃い点にならない)の種類番号 */
const KIND_CURVE = 3;

function norm3(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

/** 単位ベクトルの点列を、Catmull-Rom 補間でなめらかにつないだ点列にする(全体を球面に戻す) */
function smoothPath(pts: Vec3[], lead: Vec3): Vec3[] {
  const m = pts.length;
  const out: Vec3[] = [];
  const reflect = (a: Vec3, b: Vec3): Vec3 => [2 * a[0] - b[0], 2 * a[1] - b[1], 2 * a[2] - b[2]];
  for (let i = 0; i + 1 < m; i++) {
    const p0 = i === 0 ? lead : pts[i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = i + 2 < m ? pts[i + 2] : reflect(p2, p1);
    for (let s = 0; s < SMOOTH_STEPS; s++) {
      const t = s / SMOOTH_STEPS;
      const t2 = t * t;
      const t3 = t2 * t;
      const c = [0, 1, 2].map(
        (k) =>
          0.5 *
          (2 * p1[k] + (-p0[k] + p2[k]) * t + (2 * p0[k] - 5 * p1[k] + 4 * p2[k] - p3[k]) * t2 + (-p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k]) * t3),
      );
      out.push(norm3([c[0], c[1], c[2]]));
    }
  }
  out.push(pts[m - 1]);
  return out;
}

const CONSTS: ConstDef[] = [
  // 春の大曲線は先に描く(春の大三角のアークトゥルス-スピカの辺が、曲線に隠れず上に見えるように)
  { name: "春の大曲線", kind: 2, paths: [["alkaid", "arcturus", "spica"]], smooth: { lead: "mizar" } },
  { name: "夏の大三角", kind: 1, paths: [["vega", "deneb", "altair", "vega"]] },
  { name: "冬の大三角", kind: 1, paths: [["betelgeuse", "sirius", "procyon", "betelgeuse"]] },
  { name: "春の大三角", kind: 1, paths: [["arcturus", "spica", "denebola", "arcturus"]] },
  { name: "こと座", kind: 0, paths: [["vega", "zeta_lyr", "delta_lyr", "gamma_lyr", "beta_lyr", "zeta_lyr"]] },
  { name: "はくちょう座", kind: 0, paths: [["deneb", "sadr", "albireo"], ["delta_cyg", "sadr", "eps_cyg"]] },
  { name: "わし座", kind: 0, paths: [["tarazed", "altair", "alshain"]] },
  { name: "カシオペヤ座", kind: 0, paths: [["caph", "schedar", "gamma_cas", "ruchbah", "segin"]] },
  {
    name: "北斗七星(おおぐま座)",
    kind: 0,
    paths: [["dubhe", "merak", "phecda", "megrez", "dubhe"], ["megrez", "alioth", "mizar", "alkaid"]],
  },
  { name: "こぐま座", kind: 0, paths: [["polaris", "yildun", "eps_umi", "zeta_umi", "eta_umi", "pherkad", "kochab", "zeta_umi"]] },
  {
    name: "オリオン座",
    kind: 0,
    paths: [
      ["betelgeuse", "alnitak", "saiph"],
      ["bellatrix", "mintaka", "rigel"],
      ["alnitak", "alnilam", "mintaka"],
      ["meissa", "betelgeuse"],
      ["meissa", "bellatrix"],
    ],
  },
  { name: "おおいぬ座", kind: 0, paths: [["mirzam", "sirius", "wezen", "adhara"], ["wezen", "aludra"]] },
  { name: "ふたご座", kind: 0, paths: [["castor", "mebsuta", "tejat", "propus"], ["pollux", "wasat", "alhena"]] },
  { name: "おうし座", kind: 0, paths: [["elnath", "aldebaran", "gamma_tau"], ["aldebaran", "zeta_tau"]] },
  { name: "ぎょしゃ座", kind: 0, paths: [["capella", "menkalinan", "theta_aur", "elnath", "iota_aur", "capella"]] },
  {
    name: "しし座",
    kind: 0,
    paths: [
      ["regulus", "eta_leo", "algieba", "zeta_leo", "mu_leo", "eps_leo"],
      ["zosma", "denebola", "chertan", "zosma"],
      ["algieba", "zosma"],
      ["regulus", "chertan"],
    ],
  },
  {
    name: "さそり座",
    kind: 0,
    paths: [
      ["graffias", "dschubba", "pi_sco"],
      ["dschubba", "sigma_sco", "antares", "tau_sco", "eps_sco", "mu_sco", "zeta_sco", "eta_sco", "sargas", "iota_sco", "kappa_sco", "shaula", "lesath"],
    ],
  },
  {
    name: "いて座(ティーポット)",
    kind: 0,
    paths: [["alnasl", "kaus_m", "kaus_a", "ascella", "tau_sgr", "nunki", "phi_sgr", "kaus_b", "kaus_m"], ["phi_sgr", "ascella"]],
  },
  { name: "うしかい座", kind: 0, paths: [["arcturus", "izar", "delta_boo", "nekkar", "seginus", "rho_boo", "arcturus"]] },
  { name: "秋の四辺形(ペガスス座)", kind: 0, paths: [["markab", "scheat", "alpheratz", "algenib", "markab"]] },
  { name: "アンドロメダ座", kind: 0, paths: [["alpheratz", "mirach", "almach"]] },
];

interface Star {
  id: string;
  /** J2000の赤道座標の単位ベクトル(x=春分点方向、z=天の北極) */
  v: [number, number, number];
  mag: number;
  name?: string;
}

function parseRa(s: string): number {
  const [h, m, sec] = s.split(" ").map(Number);
  return 15 * (h + m / 60 + sec / 3600);
}

function parseDec(s: string): number {
  const sign = s.startsWith("-") ? -1 : 1;
  const [d, m] = s.slice(1).split(" ").map(Number);
  return sign * (d + m / 60);
}

let starCache: Map<string, Star> | null = null;

function stars(): Map<string, Star> {
  if (starCache) return starCache;
  const map = new Map<string, Star>();
  for (const [id, ra, dec, mag, name] of STAR_ROWS) {
    const a = parseRa(ra) * DEG;
    const d = parseDec(dec) * DEG;
    map.set(id, { id, v: [Math.cos(d) * Math.cos(a), Math.cos(d) * Math.sin(a), Math.sin(d)], mag, name });
  }
  return map;
}

/** 空に重ねる文字(名前)。dirはこのビューワーの座標(X東・Y上・Z南)の単位ベクトル */
export interface ConstLabel {
  text: string;
  dir: Vec3;
  altDeg: number;
  /** 0=星座名、1=大三角・春の大曲線、2=星の名前 */
  kind: 0 | 1 | 2;
}

export interface ConstellationFrame {
  gl: ConstellationGlData;
  labels: ConstLabel[];
}

/** 星の等級 → 点の大きさ(px) */
function pointSize(mag: number): number {
  return clamp(7.4 - 1.35 * mag, 2.2, 9.5);
}

/** その時刻・場所で、星座の星と線の向き・名前の位置を求める */
export function constellationFrame(time: Date, lat: number, lon: number): ConstellationFrame {
  const all = stars();
  const observer = new Astronomy.Observer(lat, lon, 0);
  const rot = Astronomy.Rotation_EQJ_HOR(time, observer);
  const dirOf = new Map<string, Vec3>();
  const base = Astronomy.MakeTime(new Date(0));
  for (const s of all.values()) {
    const h = Astronomy.RotateVector(rot, new Astronomy.Vector(s.v[0], s.v[1], s.v[2], base));
    // 地平座標(x=北・y=西・z=天頂)→ このビューワーの座標(X東・Y上・Z南)
    dirOf.set(s.id, [-h.y, h.z, -h.x]);
  }

  const lineData: number[] = [];
  let lineCount = 0;
  const used = new Set<string>();
  const labels: ConstLabel[] = [];
  for (const c of CONSTS) {
    const members = new Set<string>();
    /** 曲線の名前を置く場所(最初の星と次の星の中ほどの、曲線の上の点)。星の近くに置かない */
    let curveLabelDir: Vec3 | null = null;
    for (const path of c.paths) {
      const lead = c.smooth ? dirOf.get(c.smooth.lead) : undefined;
      const ctrl = path.map((id) => dirOf.get(id));
      if (c.smooth && lead && ctrl.every((d): d is Vec3 => !!d)) {
        const pts = smoothPath(ctrl, lead);
        curveLabelDir = pts[Math.floor(SMOOTH_STEPS / 2)];
        for (let i = 0; i + 1 < pts.length; i++) {
          const a = pts[i];
          const b = pts[i + 1];
          if (a[1] < -0.12 && b[1] < -0.12) continue;
          for (const [end, side] of [
            [0, -1],
            [0, 1],
            [1, -1],
            [1, 1],
          ] as const) {
            lineData.push(a[0], a[1], a[2], b[0], b[1], b[2], end, side, KIND_CURVE);
          }
          lineCount++;
        }
        for (const id of path) {
          members.add(id);
          used.add(id);
        }
        continue;
      }
      for (let i = 0; i + 1 < path.length; i++) {
        const a = dirOf.get(path[i]);
        const b = dirOf.get(path[i + 1]);
        if (!a || !b) continue;
        // 両端とも地平線よりずっと下なら描かない
        if (a[1] < -0.12 && b[1] < -0.12) continue;
        for (const [end, side] of [
          [0, -1],
          [0, 1],
          [1, -1],
          [1, 1],
        ] as const) {
          lineData.push(a[0], a[1], a[2], b[0], b[1], b[2], end, side, c.kind);
        }
        lineCount++;
      }
      for (const id of path) {
        members.add(id);
        used.add(id);
      }
    }
    // 名前は、星座の星の向きの平均の所に
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (const id of members) {
      const d = dirOf.get(id);
      if (!d) continue;
      sx += d[0];
      sy += d[1];
      sz += d[2];
    }
    const l = Math.hypot(sx, sy, sz);
    if (curveLabelDir || l > 1e-6) {
      const dir: Vec3 = curveLabelDir ?? [sx / l, sy / l, sz / l];
      labels.push({ text: c.name, dir, altDeg: Math.asin(clamp(dir[1], -1, 1)) / DEG, kind: c.kind === 0 ? 0 : 1 });
    }
  }

  // 星(線に使う星と、名前のある明るい星)
  const pointData: number[] = [];
  let pointCount = 0;
  for (const s of all.values()) {
    if (!used.has(s.id) && !s.name) continue;
    const d = dirOf.get(s.id);
    if (!d || d[1] < -0.12) continue;
    pointData.push(d[0], d[1], d[2], pointSize(s.mag));
    pointCount++;
    if (s.name && s.mag < 2.2 && s.id !== "polaris") {
      labels.push({ text: s.name, dir: d, altDeg: Math.asin(clamp(d[1], -1, 1)) / DEG, kind: 2 });
    } else if (s.id === "polaris") {
      labels.push({ text: s.name ?? "", dir: d, altDeg: Math.asin(clamp(d[1], -1, 1)) / DEG, kind: 2 });
    } else if (s.id === "pleiades") {
      labels.push({ text: s.name ?? "", dir: d, altDeg: Math.asin(clamp(d[1], -1, 1)) / DEG, kind: 2 });
    }
  }
  return {
    gl: { lines: new Float32Array(lineData), lineCount, points: new Float32Array(pointData), pointCount },
    labels,
  };
}
