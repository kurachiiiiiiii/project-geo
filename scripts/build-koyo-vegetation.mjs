#!/usr/bin/env node
// 紅葉マップ用の植生グリッドを作る変換スクリプト(Node.js版。GeoPackage専用、追加のインストール不要)。
//
// 環境省 自然環境保全基礎調査の植生図(GeoPackage: veg2024bk1a.gpkg など)のポリゴンを読み、
// 凡例名を紅葉の樹種グループ(src/features/koyo/koyoSpecies.ts の VEG_CLASS)に分類して、
// メッシュ(既定は約250m: 緯度1/480°×経度1/320°。--cell-scale 1 なら従来の約500m)の1バイトのグリッドへ集約し、次の2つを書き出す:
//
//   public/data/koyoVegetation.json    メタデータ(範囲・刻み・出典・作成日時)
//   public/data/koyoVegetation.bin.gz  uint8の行優先配列(rows×cols)をgzipしたもの
//
// 実行は scripts/build-koyo-vegetation.bat をダブルクリックするのが簡単(プロジェクト直下で動かす)。
// コマンドで動かす場合:
//
//   node scripts/build-koyo-vegetation.mjs                    植生データのフォルダを自動で探して変換
//   node scripts/build-koyo-vegetation.mjs 植生データ2024        フォルダ(または.gpkg)を指定
//   node scripts/build-koyo-vegetation.mjs --inspect          列名・凡例名・分類結果だけを調べる(ファイルは書かない)
//   node scripts/build-koyo-vegetation.mjs --name-cols HANREI_N,CHU_N   凡例名の列を指定(細かい方を先に)
//   node scripts/build-koyo-vegetation.mjs --extra-rules my.json        規則を足す: [["正規表現","maple"], ...]
//   node scripts/build-koyo-vegetation.mjs --force            未分類が多くても変換を続ける
//   node scripts/build-koyo-vegetation.mjs --cell-scale 1     従来の約500mメッシュで作る(既定の 2 は約250m。解像度が2倍・ファイルは約3〜4倍。
//                                                             作業に約1GBのメモリを使う。アプリは刻みをメタデータから読むので、どちらでも動く)
//
//   node scripts/build-koyo-vegetation.mjs --fine             約50mメッシュの「細かい植生」を作る(3Dビューの木・雲海・光害用)。全国を1枚にすると
//                                                             数GBになるので、512×512メッシュ(約25km四方)のタイルに分け、データのあるタイルだけを
//                                                             public/data/veg50/ に t{x}_{y}.bin.gz と index.json として書き出す(合計は数十MB)。
//                                                             作業に約0.4〜0.8GBのメモリを使う。約250mの全国グリッド(上の2ファイル)は別のままで、
//                                                             アプリは見ている場所のまわりのタイルだけを読んで、約250mの上に重ねる。
//
// 必要なもの: Node.js 22.13以上(組み込みの node:sqlite を使う。それ以前の22.5〜22.12は
// --experimental-sqlite を付けて自動で再実行する)。GDAL・Pythonなどは不要。
// GeoPackage以外(Shapefile・GeoParquetなど)や投影座標系のデータは build-koyo-vegetation.py を使うこと。
//
// 分類規則は scripts/koyo-veg-rules.json(Python版と共通)。メッシュごとの決め方・分類の考え方は
// build-koyo-vegetation.py の冒頭の説明と同じ。変換の最初と最後に、凡例名と分類結果の一覧を
// koyo-vegetation-report.txt(プロジェクト直下)へ書き出す。

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// ---------------------------------------------------------------------------
// node:sqlite の読み込み(古い22.xではフラグ付きで自分を再実行する)
// ---------------------------------------------------------------------------
let DatabaseSync;
try {
  ({ DatabaseSync } = await import("node:sqlite"));
} catch {
  if (!process.execArgv.includes("--experimental-sqlite")) {
    const r = spawnSync(process.execPath, ["--experimental-sqlite", ...process.argv.slice(1)], { stdio: "inherit" });
    if (r.status === 0 || r.status === 1) process.exit(r.status ?? 1);
  }
  console.error(
    `このNode.js(${process.version})には node:sqlite がありません。Node.js 22.13以上へ更新してください(https://nodejs.org/)。\n` +
      "更新できない場合は、Python版(scripts/build-koyo-vegetation.py)を使えます。",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 設定・規則
// ---------------------------------------------------------------------------
const RULES = JSON.parse(readFileSync(path.join(__dirname, "koyo-veg-rules.json"), "utf8"));
const CLASS = RULES.classes; // { none:0, evergreen:1, maple:2, ... }
const CLASS_LABEL = Object.fromEntries(Object.entries(CLASS).map(([k, v]) => [v, k]));
const CLASS_UNKNOWN = 255;
const DECIDUOUS = ["maple", "beech", "oak", "birch", "larch", "alpineShrub", "deciduousMix"].map((k) => CLASS[k]);
const NUM_CLASSES = Math.max(...Object.values(CLASS)) + 1;

// グリッドの刻み(src/features/koyo/koyoVegetation.ts・Python版と同じ)。--cell-scale 2(既定)=約250m、1=約500m
// --fine のときは、さらに5倍細かい約50m(緯度1/2400°×経度1/1600°)。細分はせず、メッシュの中心がどのポリゴンに入るかで決める
const FINE = process.argv.includes("--fine");
const CELL_SCALE = FINE
  ? 10
  : (() => {
      const i = process.argv.indexOf("--cell-scale");
      return i >= 0 && Number(process.argv[i + 1]) === 1 ? 1 : 2;
    })();
/** --fine のタイルの一辺(メッシュ数)。512なら約25km四方 */
const TILE = (() => {
  const i = process.argv.indexOf("--tile");
  const v = i >= 0 ? Number(process.argv[i + 1]) : 512;
  return Number.isInteger(v) && v >= 64 && v <= 4096 ? v : 512;
})();
const LAT_STEP = 1 / (240 * CELL_SCALE);
const LON_STEP = 1 / (160 * CELL_SCALE);
// 1メッシュを SS×SS に細分し、細分点がポリゴンに入るかどうかで面積比を求める(細かいメッシュでは3×3: 約80mおき)
const SS = FINE ? 1 : CELL_SCALE === 2 ? 3 : 4;
const SUB_LAT = LAT_STEP / SS;
const SUB_LON = LON_STEP / SS;

// 作業用グリッドの範囲(日本の主な島々を覆う。範囲外のポリゴンは無視する)
const WEST = 122.5;
const EAST = 149.0;
const SOUTH = 24.0;
const NORTH = 45.7;
const COLS = Math.round((EAST - WEST) / LON_STEP);
const ROWS = Math.round((NORTH - SOUTH) / LAT_STEP);
const SUB_COLS = COLS * SS;
const SUB_ROWS = ROWS * SS;

/** 緯度経度として扱ってよい座標系(EPSG)。WGS84・JGD2011・JGD2000(日本では数cm〜数十cmの違いで、メッシュには影響しない) */
const GEOGRAPHIC_EPSG = new Set([4326, 6668, 4612, 4019]);
const JAPANESE = /[ぁ-んァ-ヶ一-龠]/;
const MAX_LEGEND_DISTINCT = 3000; // これより種類の多い列は、凡例名ではなく備考・番号などとみなす
const SKIP_COLUMN_NAME = /備考|memo|note|comment|remark|file|source|図郭|mesh|date|調査年|撮影|更新|作成/i;

// ---------------------------------------------------------------------------
// 引数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    inputs: [],
    inspect: false,
    fine: false,
    force: false,
    nameCols: null,
    extraRules: null,
    out: path.join(projectRoot, "public", "data"),
    report: path.join(projectRoot, "koyo-vegetation-report.txt"),
    source: "環境省 自然環境保全基礎調査 植生図(1/25,000)を加工して作成",
    maxUnmatchedShare: 0.3,
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    const next = () => {
      if (i + 1 >= argv.length) throw new Error(`${v} の値がありません`);
      return argv[++i];
    };
    if (v === "--inspect") a.inspect = true;
    else if (v === "--force") a.force = true;
    else if (v === "--fine") a.fine = true;
    else if (v === "--tile") next(); // 値は TILE で先に読んでいる
    else if (v === "--name-cols") a.nameCols = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (v === "--extra-rules") a.extraRules = JSON.parse(readFileSync(next(), "utf8"));
    else if (v === "--out") a.out = path.resolve(next());
    else if (v === "--report") a.report = path.resolve(next());
    else if (v === "--source") a.source = next();
    else if (v === "--max-unmatched-share") a.maxUnmatchedShare = Number(next());
    else if (v === "--cell-scale") next(); // 値は CELL_SCALE で先に読んでいる
    else if (v.startsWith("--")) throw new Error(`不明なオプション: ${v}`);
    else a.inputs.push(v);
  }
  return a;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "android", "public", "src", "api", "server", "launcher", "scripts", "assets", ".claude"]);

/** 入力(ファイル/フォルダ)から.gpkgを集める。指定が無ければプロジェクト直下の2階層までを探す */
function listGpkg(inputs) {
  const out = [];
  const walk = (dir, depth, maxDepth, skip) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < maxDepth && !(skip && SKIP_DIRS.has(e.name))) walk(p, depth + 1, maxDepth, skip);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".gpkg")) out.push(p);
    }
  };
  if (inputs.length === 0) walk(projectRoot, 0, 2, true);
  for (const input of inputs) {
    const p = path.resolve(input);
    if (!existsSync(p)) throw new Error(`見つかりません: ${input}`);
    if (statSync(p).isDirectory()) walk(p, 0, 5, false);
    else out.push(p);
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// 凡例名 → 樹種グループ(koyo-veg-rules.json。Python版の classify_name と同じ)
// ---------------------------------------------------------------------------
function buildClassifier(extraRules) {
  const strongNone = new RegExp(RULES.strongNone);
  const weakNone = new RegExp(RULES.weakNone);
  const flat = [];
  let order = 0;
  for (const entry of RULES.species) {
    const cls = CLASS[entry.class];
    for (const word of entry.words) flat.push({ word, cls, order: order++ });
  }
  const extra = (extraRules ?? []).map(([pattern, cname]) => {
    if (!(cname in CLASS)) throw new Error(`--extra-rules: 不明なクラス名 ${cname}(使えるのは ${Object.keys(CLASS).join(", ")})`);
    return { rx: new RegExp(pattern), cls: CLASS[cname] };
  });
  const authNone = RULES.authoritativeNone ? new RegExp(RULES.authoritativeNone) : null;
  const hints = (RULES.hints ?? []).map((h) => ({ rx: new RegExp(h.pattern), cls: CLASS[h.class] }));

  /** 1つの凡例名 → クラスコード(樹種キーワード・明らかな森林以外の語)。分類できなければnull */
  const classifyName = (name) => {
    if (!name) return null;
    if (strongNone.test(name)) return CLASS.none;
    let best = null; // [位置, -長さ, 並び順, クラス]
    for (const { word, cls, order } of flat) {
      const pos = name.indexOf(word);
      if (pos < 0) continue;
      const key = [pos, -word.length, order, cls];
      if (best === null || key[0] < best[0] || (key[0] === best[0] && (key[1] < best[1] || (key[1] === best[1] && key[2] < best[2])))) best = key;
    }
    if (best !== null) return best[3];
    if (weakNone.test(name)) return CLASS.none;
    return null;
  };

  /**
   * 凡例名の列の値(先頭が最も細かい凡例名)からクラスコードを決める。まず先頭の列だけで樹種キーワードを探し、
   * 決まらなければ2列目以降(植生自然度区分・植生区分など)の手掛かり(hints)で決める。決まらなければnull。
   * @param {string[]} names
   * @returns {number | null}
   */
  return (names) => {
    const first = names[0] ?? "";
    const rest = names.slice(1).filter(Boolean).join(" / ");
    // --extra-rules は凡例名(先頭の列)に当てる。組み込みの規則より優先
    if (first) for (const { rx, cls } of extra) if (rx.test(first)) return cls;
    // 2列目以降に「草原」などがあれば、凡例名に樹種名が入っていても森林以外(例: 「エゾツガザクラ群落 / 自然草原」)
    if (rest && authNone && authNone.test(rest)) return CLASS.none;
    const c = classifyName(first);
    if (c !== null) return c;
    if (rest) for (const { rx, cls } of hints) if (rx.test(rest)) return cls;
    return null;
  };
}

// ---------------------------------------------------------------------------
// GeoPackage の読み取り
// ---------------------------------------------------------------------------
const q = (name) => `"${String(name).replace(/"/g, '""')}"`;

function openDb(file) {
  try {
    return new DatabaseSync(file, { readOnly: true });
  } catch {
    return new DatabaseSync(file);
  }
}

function listLayers(db) {
  const rows = db
    .prepare(
      "SELECT c.table_name AS t, c.identifier AS ident, g.column_name AS geom, g.geometry_type_name AS gtype, g.srs_id AS srs " +
        "FROM gpkg_contents c JOIN gpkg_geometry_columns g ON g.table_name = c.table_name WHERE c.data_type = 'features'",
    )
    .all();
  return rows.map((r) => {
    let epsg = null;
    try {
      const s = db.prepare("SELECT organization AS org, organization_coordsys_id AS id FROM gpkg_spatial_ref_sys WHERE srs_id = ?").get(r.srs);
      if (s && String(s.org).toUpperCase() === "EPSG") epsg = Number(s.id);
      else if (r.srs === 4326) epsg = 4326;
    } catch {
      /* 無くても続行 */
    }
    return { table: r.t, geomCol: r.geom, gtype: String(r.gtype ?? "").toUpperCase(), srs: r.srs, epsg };
  });
}

/** 凡例名の列を決める: 日本語を含む文字列の列のうち、種類が多すぎないものを、種類の多い(=細かい)順に */
function pickNameColumns(db, layer, forced) {
  const info = db.prepare(`PRAGMA table_info(${q(layer.table)})`).all();
  const allCols = info.map((c) => c.name);
  if (forced) {
    const missing = forced.filter((c) => !allCols.includes(c));
    if (missing.length) throw new Error(`列が見つかりません: ${missing.join(", ")}(このレイヤーの列: ${allCols.join(", ")})`);
    return { chosen: forced, candidates: [], allCols };
  }
  const candidates = [];
  for (const c of info) {
    if (c.name === layer.geomCol || /^(fid|ogc_fid|rowid)$/i.test(c.name)) continue;
    if (SKIP_COLUMN_NAME.test(c.name)) continue;
    const sample = db.prepare(`SELECT ${q(c.name)} AS v FROM ${q(layer.table)} WHERE ${q(c.name)} IS NOT NULL LIMIT 2000`).all();
    const texts = sample.map((r) => r.v).filter((v) => typeof v === "string");
    if (texts.length === 0) continue;
    if (texts.filter((s) => JAPANESE.test(s)).length / texts.length < 0.5) continue;
    const distinct = Number(db.prepare(`SELECT COUNT(DISTINCT ${q(c.name)}) AS n FROM ${q(layer.table)}`).get().n);
    candidates.push({ name: c.name, distinct });
  }
  const usable = candidates.filter((c) => c.distinct <= MAX_LEGEND_DISTINCT).sort((a, b) => b.distinct - a.distinct);
  return { chosen: usable.map((c) => c.name), candidates, allCols };
}

// --- GPKGのジオメトリ(ヘッダー + WKB) ---
const ENVELOPE_BYTES = [0, 32, 48, 48, 64];

/** @returns {Float64Array[][] | null} ポリゴンの配列。各ポリゴンはリング(x,y,x,y,…)の配列 */
function parseGpkgGeometry(u8) {
  if (!u8 || u8.length < 8 || u8[0] !== 0x47 || u8[1] !== 0x50) return null;
  const flags = u8[3];
  if ((flags >> 4) & 1) return null; // 空のジオメトリ
  const env = (flags >> 1) & 7;
  if (env > 4) return null;
  const buf = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  const polys = [];
  readWkb(buf, 8 + ENVELOPE_BYTES[env], polys);
  return polys;
}

function readWkb(buf, off, out) {
  const le = buf[off] === 1;
  off += 1;
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const f64 = (o) => (le ? buf.readDoubleLE(o) : buf.readDoubleBE(o));
  let type = u32(off);
  off += 4;
  let hasZ = (type & 0x80000000) !== 0;
  let hasM = (type & 0x40000000) !== 0;
  const hasSrid = (type & 0x20000000) !== 0;
  let base = type & 0x1fffffff;
  if (base >= 3000) {
    hasZ = hasM = true;
    base -= 3000;
  } else if (base >= 2000) {
    hasM = true;
    base -= 2000;
  } else if (base >= 1000) {
    hasZ = true;
    base -= 1000;
  }
  if (hasSrid) off += 4;
  const dims = 2 + (hasZ ? 1 : 0) + (hasM ? 1 : 0);
  if (base === 3) {
    const nRings = u32(off);
    off += 4;
    const rings = [];
    for (let r = 0; r < nRings; r++) {
      const n = u32(off);
      off += 4;
      const xy = new Float64Array(n * 2);
      for (let i = 0; i < n; i++) {
        xy[i * 2] = f64(off);
        xy[i * 2 + 1] = f64(off + 8);
        off += 8 * dims;
      }
      rings.push(xy);
    }
    out.push(rings);
    return off;
  }
  if (base === 6 || base === 7) {
    const n = u32(off);
    off += 4;
    for (let i = 0; i < n; i++) off = readWkb(buf, off, out);
    return off;
  }
  throw new Error(`未対応のジオメトリ型です(WKB type ${base})。ポリゴンのレイヤーだけを使ってください`);
}

// ---------------------------------------------------------------------------
// ラスタライズ(細分点がポリゴンの内側かを、走査線の偶奇規則で数える)
// ---------------------------------------------------------------------------
// (--fine のときは、全国を1枚にすると数GBになるので作らない。下の fineTiles に、塗られたタイルだけを持つ)
const counts = FINE ? [] : Array.from({ length: NUM_CLASSES }, () => new Uint8Array(COLS * ROWS));
const xs = [];

// --fine: タイル(TILE×TILE。値は植生クラス、255=植生図なし)を、塗られたときに作る
const TILES_X = Math.ceil(COLS / TILE);
const TILES_Y = Math.ceil(ROWS / TILE);
/** @type {Map<number, Uint8Array>} */
const fineTiles = new Map();
function fineTile(tx, ty) {
  const key = ty * TILES_X + tx;
  let t = fineTiles.get(key);
  if (!t) {
    t = new Uint8Array(TILE * TILE).fill(CLASS_UNKNOWN);
    fineTiles.set(key, t);
  }
  return t;
}

/** --fine: ポリゴンを、メッシュの中心が内側にあるメッシュだけ、クラスclsで塗る(後から塗ったものが上書き)。塗ったメッシュ数を返す */
function fillPolygonFine(rings, cls) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i];
      const y = ring[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < WEST || minX > EAST || maxY < SOUTH || minY > NORTH) return 0;
  const r0 = Math.max(0, Math.ceil((NORTH - maxY) / LAT_STEP - 0.5));
  const r1 = Math.min(ROWS - 1, Math.floor((NORTH - minY) / LAT_STEP - 0.5));
  let painted = 0;
  for (let r = r0; r <= r1; r++) {
    const y = NORTH - (r + 0.5) * LAT_STEP;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const y0 = ring[i * 2 + 1];
        const y1 = ring[j * 2 + 1];
        if (y0 <= y !== y1 <= y) {
          const x0 = ring[i * 2];
          xs.push(x0 + ((y - y0) * (ring[j * 2] - x0)) / (y1 - y0));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const ty = (r / TILE) | 0;
    const rowOff = (r - ty * TILE) * TILE;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      let j = Math.max(0, Math.ceil((xs[k] - WEST) / LON_STEP - 0.5));
      const j1 = Math.min(COLS - 1, Math.ceil((xs[k + 1] - WEST) / LON_STEP - 0.5) - 1);
      while (j <= j1) {
        const tx = (j / TILE) | 0;
        const end = Math.min(j1, (tx + 1) * TILE - 1);
        fineTile(tx, ty).fill(cls, rowOff + (j - tx * TILE), rowOff + (end - tx * TILE) + 1);
        painted += end - j + 1;
        j = end + 1;
      }
    }
  }
  return painted;
}

/** ポリゴン(リングの配列。穴は偶奇規則で抜ける)をクラスclsで塗り、塗った細分点の数を返す */
function fillPolygon(rings, cls) {
  if (FINE) return fillPolygonFine(rings, cls);
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      const x = ring[i];
      const y = ring[i + 1];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < WEST || minX > EAST || maxY < SOUTH || minY > NORTH) return 0;
  const r0 = Math.max(0, Math.ceil((NORTH - maxY) / SUB_LAT - 0.5));
  const r1 = Math.min(SUB_ROWS - 1, Math.floor((NORTH - minY) / SUB_LAT - 0.5));
  const plane = counts[cls];
  let painted = 0;
  for (let r = r0; r <= r1; r++) {
    const y = NORTH - (r + 0.5) * SUB_LAT;
    xs.length = 0;
    for (const ring of rings) {
      const n = ring.length / 2;
      for (let i = 0; i < n; i++) {
        const j = i + 1 === n ? 0 : i + 1;
        const y0 = ring[i * 2 + 1];
        const y1 = ring[j * 2 + 1];
        if (y0 <= y !== y1 <= y) {
          const x0 = ring[i * 2];
          xs.push(x0 + ((y - y0) * (ring[j * 2] - x0)) / (y1 - y0));
        }
      }
    }
    if (xs.length < 2) continue;
    xs.sort((a, b) => a - b);
    const rowBase = ((r / SS) | 0) * COLS;
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const j0 = Math.max(0, Math.ceil((xs[k] - WEST) / SUB_LON - 0.5));
      const j1 = Math.min(SUB_COLS - 1, Math.ceil((xs[k + 1] - WEST) / SUB_LON - 0.5) - 1);
      for (let j = j0; j <= j1; j++) plane[rowBase + ((j / SS) | 0)]++;
      if (j1 >= j0) painted += j1 - j0 + 1;
    }
  }
  return painted;
}

/** 細分点の数 → メッシュの決定(Python版の aggregate_cell と同じ規則) */
function aggregate() {
  const out = new Uint8Array(COLS * ROWS);
  const dec = DECIDUOUS;
  for (let i = 0; i < out.length; i++) {
    let covered = 0;
    for (let c = 0; c < NUM_CLASSES; c++) covered += counts[c][i];
    if (covered === 0) {
      out[i] = CLASS_UNKNOWN;
      continue;
    }
    let decN = 0;
    let best = dec[0];
    let bestN = -1;
    for (const c of dec) {
      const n = counts[c][i];
      decN += n;
      if (n > bestN) {
        bestN = n;
        best = c;
      }
    }
    if (decN * 100 >= covered * 35) out[i] = best;
    else out[i] = counts[CLASS.evergreen][i] > counts[CLASS.none][i] ? CLASS.evergreen : CLASS.none;
  }
  return out;
}

/** --fine: 塗られたタイルを gzip して public/data/veg50/ に書き出す(いったん veg50.tmp に書いてから入れ替える) */
function writeFineTiles(args, log, saveReport) {
  const finalDir = path.join(args.out, "veg50");
  const tmpDir = path.join(args.out, "veg50.tmp");
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  const hist = new Map();
  const present = [];
  let bytes = 0;
  const keys = [...fineTiles.keys()].sort((a, b) => a - b);
  for (const key of keys) {
    const t = fineTiles.get(key);
    let any = false;
    for (let i = 0; i < t.length; i++) {
      const v = t[i];
      hist.set(v, (hist.get(v) ?? 0) + 1);
      if (v !== CLASS_UNKNOWN) any = true;
    }
    if (!any) continue; // 全部「植生図なし」のタイルは作らない
    const tx = key % TILES_X;
    const ty = (key - tx) / TILES_X;
    const gz = gzipSync(Buffer.from(t.buffer, t.byteOffset, t.byteLength), { level: 9 });
    writeFileSync(path.join(tmpDir, `t${tx}_${ty}.bin.gz`), gz);
    bytes += gz.length;
    present.push([tx, ty]);
  }
  if (present.length === 0) throw new Error("植生が1メッシュも得られませんでした(座標系・範囲・ファイルを確認してください)");
  const meta = {
    version: 1,
    west: WEST,
    north: NORTH,
    lonStep: LON_STEP,
    latStep: LAT_STEP,
    cols: COLS,
    rows: ROWS,
    tile: TILE,
    tilesX: TILES_X,
    tilesY: TILES_Y,
    tiles: present,
    source: args.source,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  writeFileSync(path.join(tmpDir, "index.json"), JSON.stringify(meta) + "\n", "utf8");
  rmSync(finalDir, { recursive: true, force: true });
  renameSync(tmpDir, finalDir);
  log(`\n書き出し: ${finalDir}  (タイル ${fmt(present.length)}枚。1枚は${TILE}×${TILE}メッシュ、合計 gzip ${(bytes / 1e6).toFixed(1)} MB)`);
  for (const v of [...hist.keys()].sort((a, b) => a - b)) {
    const label = v === CLASS_UNKNOWN ? "植生図なし(255)" : (CLASS_LABEL[v] ?? String(v));
    log(`  ${label.padEnd(18)} ${fmt(hist.get(v)).padStart(14)} メッシュ`);
  }
  saveReport(true);
  log(`\nレポート: ${args.report}`);
}

// ---------------------------------------------------------------------------
// メイン
// ---------------------------------------------------------------------------
const fmt = (n) => Number(n).toLocaleString("ja-JP");
const elapsed = (t0) => `${((Date.now() - t0) / 1000).toFixed(0)}秒`;
const SUB_AREA_KM2 = ((SUB_LAT * 111.2) * (SUB_LON * 111.32 * Math.cos((36 * Math.PI) / 180)));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const classify = buildClassifier(args.extraRules);
  const files = listGpkg(args.inputs);
  if (files.length === 0) {
    throw new Error("GeoPackage(.gpkg)が見つかりません。フォルダ(または.gpkgのパス)を引数に指定してください");
  }
  console.log(`対象ファイル: ${files.length}件`);
  for (const f of files) console.log(`  ${f}  (${(statSync(f).size / 1e6).toFixed(0)} MB)`);

  const report = [];
  const log = (s = "") => {
    console.log(s);
    report.push(s);
  };

  // 凡例名の組(列の値のタプル)ごとの 件数 / 塗った細分点数 / クラス
  /** @type {Map<string, {names: string[], cls: number | null, polygons: number, samples: number}>} */
  const legend = new Map();
  const plans = []; // {file, layer, cols, keyToCls}

  // ---- 第1段階: 列・座標系・凡例名の調査(ジオメトリは読まない) ----
  for (const file of files) {
    const db = openDb(file);
    let layers;
    try {
      layers = listLayers(db);
    } catch (e) {
      db.close();
      throw new Error(`${path.basename(file)}: GeoPackageとして読めません(${e instanceof Error ? e.message : e})`);
    }
    log(`\n■ ${path.basename(file)}`);
    for (const layer of layers) {
      const isPoly = /POLYGON|^GEOMETRY$/.test(layer.gtype);
      const nRows = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${q(layer.table)}`).get().n);
      log(`  レイヤー ${layer.table}: ${fmt(nRows)}件 / ${layer.gtype} / EPSG:${layer.epsg ?? layer.srs}`);
      if (!isPoly) {
        log("    → ポリゴンではないのでスキップ");
        continue;
      }
      if (layer.epsg === null || !GEOGRAPHIC_EPSG.has(layer.epsg)) {
        db.close();
        throw new Error(
          `${path.basename(file)} の座標系は EPSG:${layer.epsg ?? layer.srs} で、緯度経度(WGS84/JGD2011)ではありません。` +
            "Python版(scripts/build-koyo-vegetation.py)なら座標変換して読めます。",
        );
      }
      const { chosen, candidates, allCols } = pickNameColumns(db, layer, args.nameCols);
      log(`    列: ${allCols.join(", ")}`);
      if (candidates.length) log(`    凡例名の候補(日本語の文字列の列・種類数): ${candidates.map((c) => `${c.name}=${fmt(c.distinct)}`).join(", ")}`);
      if (chosen.length === 0) {
        db.close();
        throw new Error("凡例名の列が見つかりません。--name-cols で指定してください(列名は上の「列」を参照)");
      }
      log(`    凡例名の列(優先順): ${chosen.join(", ")}`);
      const rows = db
        .prepare(`SELECT ${chosen.map(q).join(", ")}, COUNT(*) AS n FROM ${q(layer.table)} GROUP BY ${chosen.map(q).join(", ")}`)
        .all();
      const keyToCls = new Map();
      for (const r of rows) {
        const names = chosen.map((c) => (r[c] == null ? "" : String(r[c])));
        const cls = classify(names);
        const key = names.join("\u0001");
        keyToCls.set(key, cls);
        const lg = legend.get(key) ?? { names, cls, polygons: 0, samples: 0 };
        lg.polygons += Number(r.n);
        legend.set(key, lg);
      }
      plans.push({ file, table: layer.table, geomCol: layer.geomCol, cols: chosen, keyToCls, nRows });
    }
    db.close();
  }

  // 未分類の割合(ポリゴン件数ベース)
  let totalPoly = 0;
  let unmatchedPoly = 0;
  for (const lg of legend.values()) {
    totalPoly += lg.polygons;
    if (lg.cls === null) unmatchedPoly += lg.polygons;
  }
  const unmatchedShare = totalPoly ? unmatchedPoly / totalPoly : 0;
  const writeLegendReport = (withArea) => {
    const lines = [];
    lines.push("凡例名 → 紅葉の樹種グループ(件数の多い順)。" + (withArea ? "面積はおおよそのkm²" : "(面積は変換後に出ます)"));
    const all = [...legend.values()].sort((a, b) => (withArea ? b.samples - a.samples : b.polygons - a.polygons));
    for (const lg of all) {
      const cls = lg.cls === null ? "【未分類→森林以外】" : CLASS_LABEL[lg.cls];
      const area = withArea ? `${(lg.samples * SUB_AREA_KM2).toFixed(1).padStart(10)}km² ` : "";
      lines.push(`  ${fmt(lg.polygons).padStart(10)}件 ${area}${cls.padEnd(14)} ${lg.names.join(" / ")}`);
    }
    return lines;
  };
  log(`\n分類できなかった凡例名: ${fmt(unmatchedPoly)}件 / 全${fmt(totalPoly)}件(${(unmatchedShare * 100).toFixed(1)}%)`);
  const unmatchedList = [...legend.values()].filter((l) => l.cls === null).sort((a, b) => b.polygons - a.polygons);
  for (const l of unmatchedList.slice(0, 40)) log(`    ${fmt(l.polygons).padStart(9)}件  ${l.names.join(" / ")}`);
  if (unmatchedList.length > 40) log(`    …ほか ${unmatchedList.length - 40}種類(全体は ${path.basename(args.report)} を参照)`);

  const saveReport = (withArea) => {
    writeFileSync(args.report, [...report, "", ...writeLegendReport(withArea)].join("\n") + "\n", "utf8");
  };
  saveReport(false);

  if (args.inspect) {
    log(`\n(--inspect のためファイルは書き出しません)  レポート: ${args.report}`);
    return;
  }
  if (unmatchedShare > args.maxUnmatchedShare && !args.force) {
    console.error(
      `\n⚠ 未分類が全体の ${(unmatchedShare * 100).toFixed(0)}% あり、凡例名の列(--name-cols)か分類規則が合っていない可能性があります。\n` +
        `  レポート(${args.report})を確認してください。このまま続けるなら --force を付けて実行します。`,
    );
    process.exitCode = 2;
    return;
  }

  // ---- 第2段階: ジオメトリを読んでラスタライズ ----
  const t0 = Date.now();
  let polysDone = 0;
  let rowsDone = 0;
  let axisChecked = false;
  const total = plans.reduce((s, p) => s + p.nRows, 0);
  for (const plan of plans) {
    console.log(`\n変換中: ${path.basename(plan.file)} / ${plan.table}`);
    const db = openDb(plan.file);
    const stmt = db.prepare(`SELECT ${q(plan.geomCol)} AS g, ${plan.cols.map(q).join(", ")} FROM ${q(plan.table)}`);
    for (const row of stmt.iterate()) {
      rowsDone++;
      if (rowsDone % 200_000 === 0) {
        console.log(`  ${fmt(rowsDone)} / ${fmt(total)} 件 (${((rowsDone / total) * 100).toFixed(0)}%, ${elapsed(t0)})`);
      }
      const polys = parseGpkgGeometry(row.g);
      if (!polys || polys.length === 0) continue;
      const key = plan.cols.map((c) => (row[c] == null ? "" : String(row[c]))).join("\u0001");
      const cls = plan.keyToCls.get(key) ?? null;
      const lg = legend.get(key);
      const fillCls = cls === null ? CLASS.none : cls;
      if (!axisChecked) {
        axisChecked = true;
        const ring = polys[0][0];
        const x = ring[0];
        const y = ring[1];
        if (Math.abs(x) > 180 || Math.abs(y) > 90) {
          db.close();
          throw new Error(`座標(${x}, ${y})が緯度経度ではありません。Python版(scripts/build-koyo-vegetation.py)を使ってください`);
        }
        if (y > 100 && x < 60) {
          db.close();
          throw new Error("座標の順序が(緯度, 経度)になっています。Python版(scripts/build-koyo-vegetation.py)を使ってください");
        }
      }
      for (const rings of polys) {
        const painted = fillPolygon(rings, fillCls);
        if (lg) lg.samples += painted;
        polysDone++;
      }
    }
    db.close();
  }
  console.log(`\nラスタライズ完了: ${fmt(polysDone)} ポリゴン (${elapsed(t0)})`);

  // ---- --fine: タイルに分けて書き出す ----
  if (FINE) {
    writeFineTiles(args, log, saveReport);
    return;
  }

  // ---- 集約・切り詰め・書き出し ----
  const grid = aggregate();
  let rMin = ROWS;
  let rMax = -1;
  let cMin = COLS;
  let cMax = -1;
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      if (grid[r * COLS + c] !== CLASS_UNKNOWN) {
        if (r < rMin) rMin = r;
        if (r > rMax) rMax = r;
        if (c < cMin) cMin = c;
        if (c > cMax) cMax = c;
      }
    }
  }
  if (rMax < 0) throw new Error("植生が1メッシュも得られませんでした(座標系・範囲・ファイルを確認してください)");
  const cols = cMax - cMin + 1;
  const rows = rMax - rMin + 1;
  const sub = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) sub.set(grid.subarray((rMin + r) * COLS + cMin, (rMin + r) * COLS + cMin + cols), r * cols);

  mkdirSync(args.out, { recursive: true });
  const meta = {
    version: 1,
    west: Number((WEST + cMin * LON_STEP).toFixed(9)),
    north: Number((NORTH - rMin * LAT_STEP).toFixed(9)),
    lonStep: LON_STEP,
    latStep: LAT_STEP,
    cols,
    rows,
    source: args.source,
    generatedAt: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  };
  writeFileSync(path.join(args.out, "koyoVegetation.json"), JSON.stringify(meta, null, 2) + "\n", "utf8");
  const gz = gzipSync(Buffer.from(sub.buffer, sub.byteOffset, sub.byteLength), { level: 9 });
  writeFileSync(path.join(args.out, "koyoVegetation.bin.gz"), gz);

  const hist = new Map();
  for (const v of sub) hist.set(v, (hist.get(v) ?? 0) + 1);
  log(`\n書き出し: ${path.join(args.out, "koyoVegetation.json")} / koyoVegetation.bin.gz  (${fmt(cols)}×${fmt(rows)} メッシュ、gzip ${(gz.length / 1e6).toFixed(1)} MB)`);
  for (const v of [...hist.keys()].sort((a, b) => a - b)) {
    const label = v === CLASS_UNKNOWN ? "植生図なし(255)" : (CLASS_LABEL[v] ?? String(v));
    log(`  ${label.padEnd(18)} ${fmt(hist.get(v)).padStart(12)} メッシュ`);
  }
  saveReport(true);
  log(`\nレポート: ${args.report}`);
}

main().catch((e) => {
  console.error(`\nエラー: ${e instanceof Error ? e.message : e}`);
  process.exitCode = 1;
});
