// デスクトップアイコンから実行される起動スクリプト。
// 1) ソースがビルド成果物(dist/)より新しければ再ビルド
// 2) 本番ビルドをローカルサーバーで配信 (vite preview)
// 3) サーバーが応答したら既定のブラウザでアプリを開く
//
// 既にサーバーが動いている場合は、それが「今のコードで動いているか」を確認してから再利用する。
// 古いサーバーが残ったままだと、プロキシ(/api/ext/*)が未登録の設定で動き続けて
// 画面に "Unexpected token '<'" などのエラーが出るため(実際に起きた)。
//
// 開発中(ホットリロードしながらコードを編集する)場合は、このランチャーではなく
// 通常どおり `npm run dev` を使ってください。
//
// うまく開かないとき:
//   - 実行の記録は launcher/launcher.log に残ります(失敗時はメモ帳で自動的に開きます)。
//   - launcher/start-app-debug.bat をダブルクリックすると、黒い画面で経過を見ながら起動できます。
//
// アプリを開いたあと、植生データが約500m(粗い)のままで、元の植生図(.gpkg)がこのPCにあれば、
// launcher/veg-upgrade.mjs を裏で起動して約250mに作り直します(優先度を下げて実行。経過は launcher/veg-upgrade.log)。

import { spawn, execFileSync } from "node:child_process";
import { existsSync, statSync, readdirSync, openSync, closeSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const distIndex = path.join(projectRoot, "dist", "index.html");
const logPath = path.join(__dirname, "launcher.log");
const nodeExe = process.execPath; // このスクリプトを実行しているnode.exe自身のフルパスを使う
const viteBin = path.join(projectRoot, "node_modules", "vite", "bin", "vite.js");
const PORT = 4173;
const URL = `http://localhost:${PORT}`;
const interactive = Boolean(process.stdout.isTTY); // 黒い画面(start-app-debug.bat)から実行されているか

/** ビルド結果に影響するソース(これらが dist より新しければ再ビルドする) */
const WATCHED = ["src", "public", "index.html", "vite.config.ts", "package.json", "server"];

/** 画面(黒い画面から実行時のみ)とログファイルの両方に1行出力する */
function log(message) {
  const stamp = new Date().toLocaleString("sv-SE"); // 2026-10-05 21:13:29
  try {
    appendFileSync(logPath, `${stamp}  ${message}\n`);
  } catch {
    // ログに書けなくても起動自体は続ける
  }
  if (interactive) console.log(message);
}

/** ログが大きくなり過ぎたら作り直す(200 KB 超) */
function rotateLog() {
  try {
    if (existsSync(logPath) && statSync(logPath).size > 200_000) writeFileSync(logPath, "");
  } catch {
    // 無視
  }
}

function run(args) {
  return new Promise((resolve, reject) => {
    // 黒い画面から実行時は出力をそのまま表示、アイコンから実行時(非表示)はログファイルへ書く
    let logFd = null;
    let stdio = "inherit";
    if (!interactive) {
      try {
        logFd = openSync(logPath, "a");
        stdio = ["ignore", logFd, logFd];
      } catch {
        stdio = "ignore";
      }
    }
    const child = spawn(nodeExe, args, { cwd: projectRoot, stdio, windowsHide: true });
    const done = () => {
      if (logFd !== null) closeSync(logFd);
    };
    child.on("exit", (code) => {
      done();
      if (code === 0) resolve();
      else reject(new Error(`command failed (exit ${code}): ${args.join(" ")}`));
    });
    child.on("error", (err) => {
      done();
      reject(err);
    });
  });
}

/** 指定パス配下で最も新しい更新時刻(ミリ秒)を返す */
function latestMtime(target) {
  if (!existsSync(target)) return 0;
  const stat = statSync(target);
  if (!stat.isDirectory()) return stat.mtimeMs;
  let newest = stat.mtimeMs;
  for (const entry of readdirSync(target)) {
    newest = Math.max(newest, latestMtime(path.join(target, entry)));
  }
  return newest;
}

function needsRebuild() {
  if (!existsSync(distIndex)) return true;
  const built = statSync(distIndex).mtimeMs;
  return WATCHED.some((rel) => latestMtime(path.join(projectRoot, rel)) > built);
}

async function isServerUp() {
  try {
    await fetch(URL, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

/**
 * 動いているサーバーが今の設定で起動しているか(プロキシが登録されているか)を確かめる。
 * 未登録だとSPAのindex.htmlが返ってくるので、それを検出する。
 */
async function isServerHealthy() {
  try {
    const res = await fetch(`${URL}/api/ext/__healthcheck__?path=%2F`, {
      signal: AbortSignal.timeout(3000),
    });
    const text = await res.text();
    // プロキシが動いていれば「許可されていないソース」としてJSONの404が返る。
    // 動いていなければSPAのHTMLが返ってくる。
    return !/^\s*<!doctype html/i.test(text);
  } catch {
    return false;
  }
}

/** 指定ポートを LISTEN しているプロセスを終了する(古いサーバーの後始末) */
function killProcessOnPort(port) {
  try {
    const out = execFileSync("netstat", ["-ano"], { encoding: "utf-8" });
    const pids = new Set();
    for (const line of out.split("\n")) {
      if (line.includes(`:${port}`) && line.includes("LISTENING")) {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== "0") pids.add(pid);
      }
    }
    for (const pid of pids) {
      execFileSync("taskkill", ["/PID", pid, "/F"], { stdio: "ignore" });
      log(`古いサーバー(PID ${pid})を終了しました。`);
    }
    return pids.size > 0;
  } catch (err) {
    log(`古いサーバーの終了に失敗しました: ${err instanceof Error ? err.message : err}`);
    return false;
  }
}

function openBrowser(url) {
  // Windows既定ブラウザで開く (start は cmd.exe の組み込みコマンドなので shell 経由で呼ぶ)
  const child = spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", (err) => log(`ブラウザを開けませんでした: ${err.message}`));
  child.unref();
}

/** 植生グリッドの作り直し(全国の約250m・まわりの約50mタイル)を裏で起動する。必要ないとき(すでにある・元データが無い等)は、すぐ終わる */
function kickVegUpgrade() {
  try {
    const script = path.join(__dirname, "veg-upgrade.mjs");
    if (!existsSync(script)) return;
    const child = spawn(nodeExe, [script], { cwd: projectRoot, detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (err) => log(`植生の作り直しを起動できませんでした: ${err.message}`));
    child.unref();
  } catch (err) {
    log(`植生の作り直しを起動できませんでした: ${err instanceof Error ? err.message : err}`);
  }
}

/** 失敗時: 原因が分かるようにログをメモ帳で開く(黒い画面から実行時は開かない) */
function showLog() {
  if (interactive) return;
  try {
    const child = spawn("notepad.exe", [logPath], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // 無視
  }
}

async function waitForServer(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp()) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function main() {
  rotateLog();
  log(`--- 起動 (node ${process.version}, ${nodeExe}) ---`);
  log(`プロジェクト: ${projectRoot}`);

  if (!existsSync(viteBin)) {
    throw new Error(`vite が見つかりません: ${viteBin} (プロジェクトフォルダで npm install が必要かもしれません)`);
  }

  const rebuild = needsRebuild();
  log(`再ビルド: ${rebuild ? "必要" : "不要"}`);

  if (await isServerUp()) {
    // 再ビルドが必要 or 古い設定で動いている場合は、作り直してから起動し直す
    const healthy = rebuild ? false : await isServerHealthy();
    log(`既にサーバーが動作中 (正常: ${healthy})`);
    if (!rebuild && healthy) {
      log("既にサーバーが起動しています。ブラウザを開きます。");
      openBrowser(URL);
      kickVegUpgrade();
      return;
    }
    log("動作中のサーバーが古いため、作り直します...");
    killProcessOnPort(PORT);
    // ポートが解放されるまで少し待つ
    await new Promise((r) => setTimeout(r, 1500));
  }

  if (rebuild) {
    log("ソースが更新されているためビルドします(数秒〜数十秒かかります)...");
    const t0 = Date.now();
    await run([viteBin, "build"]);
    log(`ビルド完了 (${((Date.now() - t0) / 1000).toFixed(1)} 秒)`);
  }

  log(`プレビューサーバーを起動しています (${URL}) ...`);
  const server = spawn(nodeExe, [viteBin, "preview", "--port", String(PORT), "--strictPort"], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  server.on("error", (err) => log(`サーバー起動エラー: ${err.message}`));
  server.unref();

  if (!(await waitForServer())) {
    throw new Error(
      "サーバーの起動確認がタイムアウトしました (ポート 4173 が他のアプリに使われている可能性があります)。" +
        "手動で `npm run preview` を試してください。",
    );
  }

  log("起動しました。ブラウザを開きます。");
  openBrowser(URL);
  kickVegUpgrade();
}

main().catch((err) => {
  log(`エラー: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  if (interactive) console.error(err);
  showLog();
  process.exitCode = 1;
});
