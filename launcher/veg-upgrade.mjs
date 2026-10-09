// 植生グリッド(紅葉・3Dの木・光害・雲海の「森林かどうか」に使う)を、元の植生図(植生データ2024の .gpkg)から作り直す。
// start-app.mjs(デスクトップのアイコン)から、アプリを開いたあとに裏で起動される。手動で実行してもよい:
//   node launcher/veg-upgrade.mjs           必要なときだけ作り直す
//   node launcher/veg-upgrade.mjs --force   すでに細かくても、失敗が続いていても作り直す
//
// 作るもの(どちらも、すでにあれば何もしない):
//   1) 全国の約250mメッシュ(public/data/koyoVegetation.json・.bin.gz。紅葉マップ・遠くの森林の判定用。数分)
//   2) 見ている場所のまわりの約50mメッシュ(public/data/veg50/ のタイル。3Dビューの木・雲海・光害用。十数分〜30分ほど)
//      全国を1枚にすると数GBになるので、約25km四方のタイルに分けて、データのあるタイルだけを作る。
//
// やること:
//   ・元の植生図(プロジェクト直下の「植生データ2024」などにある .gpkg)が無ければ何もしない
//   ・scripts/build-koyo-vegetation.mjs を、優先度を下げて(重い処理でPCが重くならないように)実行する
//   ・成功したら、できたファイルを dist/data にも写す(ブラウザを再読み込みすると、すぐ新しい植生になる)
// 失敗が2回続いたら、それ以上は自動で試さない(launcher/veg-upgrade.log に理由が残る。直したあとは --force で再試行)。
// 同時に2つは動かさない(launcher/veg-upgrade.lock。4時間より古いものは、強制終了の名残とみなして無視する)。

import { spawn } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const logPath = path.join(__dirname, "veg-upgrade.log");
const statePath = path.join(__dirname, "veg-upgrade.state.json");
const lockPath = path.join(__dirname, "veg-upgrade.lock");
const backupDir = path.join(__dirname, "veg-backup");
const dataDir = path.join(projectRoot, "public", "data");
const distDataDir = path.join(projectRoot, "dist", "data");
const buildScript = path.join(projectRoot, "scripts", "build-koyo-vegetation.mjs");
const FILES = ["koyoVegetation.json", "koyoVegetation.bin.gz"];
const fineDir = path.join(dataDir, "veg50");
const distFineDir = path.join(distDataDir, "veg50");
/** 経度の刻み(度)がこれ以下なら「約250m」(250m=0.003125、500m=0.00625) */
const FINE_LON_STEP = 0.0045;
const MAX_FAILURES = 2;
const LOCK_STALE_MS = 4 * 3600 * 1000;
const force = process.argv.includes("--force");

function log(message) {
  const stamp = new Date().toLocaleString("sv-SE");
  try {
    if (existsSync(logPath) && statSync(logPath).size > 300_000) writeFileSync(logPath, "");
    appendFileSync(logPath, `${stamp}  ${message}\n`);
  } catch {
    // ログに書けなくても続ける
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readState() {
  return readJson(statePath) ?? { failures: 0 };
}
function writeState(state) {
  try {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
  } catch {
    // 無視
  }
}

/** プロジェクト直下の2階層までから .gpkg を探す(build-koyo-vegetation.mjs と同じ範囲) */
function findGpkg() {
  const skip = new Set(["node_modules", ".git", "dist", "android", "public", "src", "api", "server", "launcher", "scripts", "assets", ".claude"]);
  const out = [];
  const walk = (dir, depth) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (depth < 2 && !skip.has(e.name)) walk(p, depth + 1);
      } else if (e.isFile() && e.name.toLowerCase().endsWith(".gpkg")) out.push(p);
    }
  };
  walk(projectRoot, 0);
  return out;
}

function takeLock() {
  try {
    const fd = openSync(lockPath, "wx");
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    try {
      if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
        rmSync(lockPath, { force: true });
        return takeLock();
      }
    } catch {
      // 無視
    }
    return false;
  }
}

function runBuild(extraArgs = []) {
  return new Promise((resolve) => {
    let fd = null;
    let stdio = "ignore";
    try {
      fd = openSync(logPath, "a");
      stdio = ["ignore", fd, fd];
    } catch {
      // 無視
    }
    const child = spawn(process.execPath, [buildScript, ...extraArgs], { cwd: projectRoot, stdio, windowsHide: true });
    try {
      // PCが重くならないよう、優先度を下げる
      if (child.pid) os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {
      // 無視
    }
    const done = (code) => {
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // 無視
        }
      }
      resolve(code);
    };
    child.on("exit", (code) => done(code ?? 1));
    child.on("error", (err) => {
      log(`起動に失敗しました: ${err.message}`);
      done(1);
    });
  });
}

/** 1) 全国の約250mメッシュ */
async function upgradeCoarse(gpkgs) {
  const meta = readJson(path.join(dataDir, "koyoVegetation.json"));
  if (!force && meta && typeof meta.lonStep === "number" && meta.lonStep <= FINE_LON_STEP) return; // すでに細かい
  const state = readState();
  if (!force && state.failures >= MAX_FAILURES) return; // 失敗が続いたので自動では試さない
  log(`--- 植生グリッドを約250mに作り直します(.gpkg ${gpkgs.length}個。node ${process.version}) ---`);
  const t0 = Date.now();
  // 失敗したときに戻せるよう、いまのファイルを控える
  mkdirSync(backupDir, { recursive: true });
  for (const f of FILES) {
    if (existsSync(path.join(dataDir, f))) copyFileSync(path.join(dataDir, f), path.join(backupDir, f));
  }
  const code = await runBuild();
  const after = readJson(path.join(dataDir, "koyoVegetation.json"));
  const ok = code === 0 && after && typeof after.lonStep === "number" && after.lonStep <= FINE_LON_STEP;
  const minutes = ((Date.now() - t0) / 60000).toFixed(1);
  if (ok) {
    // 配信用のdistにも写す(次のビルドを待たずに、再読み込みだけで新しいデータになる)
    try {
      if (existsSync(distDataDir)) for (const f of FILES) copyFileSync(path.join(dataDir, f), path.join(distDataDir, f));
    } catch (e) {
      log(`dist/data への複写に失敗しました(次回のビルドで反映されます): ${e instanceof Error ? e.message : e}`);
    }
    log(`完了(${minutes}分)。${after.cols}×${after.rows}メッシュ。ブラウザを再読み込みすると反映されます。`);
    writeState({ ...readState(), failures: 0, done: true, finishedAt: new Date().toISOString() });
  } else {
    for (const f of FILES) {
      if (existsSync(path.join(backupDir, f))) copyFileSync(path.join(backupDir, f), path.join(dataDir, f));
    }
    const failures = (state.failures ?? 0) + 1;
    log(`失敗しました(終了コード ${code}、${minutes}分)。元のデータに戻しました。失敗 ${failures}/${MAX_FAILURES}回。理由はこのログの上の方を見てください。`);
    writeState({ ...readState(), failures, lastFailureAt: new Date().toISOString(), lastCode: code });
  }
}

/** 2) 約50mメッシュ(public/data/veg50/ のタイル) */
async function buildFine(gpkgs) {
  const have = readJson(path.join(fineDir, "index.json"));
  if (!force && have && have.version === 1 && Array.isArray(have.tiles) && have.tiles.length > 0) return; // すでにある
  const state = readState();
  const fineState = state.fine ?? { failures: 0 };
  if (!force && fineState.failures >= MAX_FAILURES) return;
  log(`--- 約50mメッシュの細かい植生を作ります(.gpkg ${gpkgs.length}個。全国のタイルを作るので十数分〜30分ほどかかります。node ${process.version}) ---`);
  const t0 = Date.now();
  const code = await runBuild(["--fine"]);
  const after = readJson(path.join(fineDir, "index.json"));
  const ok = code === 0 && after && after.version === 1 && Array.isArray(after.tiles) && after.tiles.length > 0;
  const minutes = ((Date.now() - t0) / 60000).toFixed(1);
  if (ok) {
    try {
      if (existsSync(distDataDir)) {
        rmSync(distFineDir, { recursive: true, force: true });
        cpSync(fineDir, distFineDir, { recursive: true });
      }
    } catch (e) {
      log(`dist/data/veg50 への複写に失敗しました(次回のビルドで反映されます): ${e instanceof Error ? e.message : e}`);
    }
    log(`完了(${minutes}分)。タイル ${after.tiles.length}枚。ブラウザを再読み込みすると反映されます。`);
    writeState({ ...readState(), fine: { failures: 0, done: true, finishedAt: new Date().toISOString() } });
  } else {
    const failures = (fineState.failures ?? 0) + 1;
    log(`細かい植生の作成に失敗しました(終了コード ${code}、${minutes}分)。失敗 ${failures}/${MAX_FAILURES}回。理由はこのログの上の方を見てください(約250mの植生はそのまま使えます)。`);
    writeState({ ...readState(), fine: { failures, lastFailureAt: new Date().toISOString(), lastCode: code } });
  }
}

async function main() {
  const gpkgs = findGpkg();
  if (gpkgs.length === 0) return; // 元の植生図が無い(このPCでは作り直せない)
  // 先に、やることがあるかだけ調べる(何も無いのに、ロックやログを作らない)
  const coarse = readJson(path.join(dataDir, "koyoVegetation.json"));
  const coarseDone = !!coarse && typeof coarse.lonStep === "number" && coarse.lonStep <= FINE_LON_STEP;
  const fineIdx = readJson(path.join(fineDir, "index.json"));
  const fineDone = !!fineIdx && fineIdx.version === 1 && Array.isArray(fineIdx.tiles) && fineIdx.tiles.length > 0;
  if (!force && coarseDone && fineDone) return;
  if (!takeLock()) return; // 別の作り直しが動いている
  try {
    await upgradeCoarse(gpkgs);
    await buildFine(gpkgs);
  } finally {
    rmSync(lockPath, { force: true });
  }
}

main().catch((err) => {
  log(`エラー: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  try {
    rmSync(lockPath, { force: true });
  } catch {
    // 無視
  }
});
