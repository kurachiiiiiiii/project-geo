import { isNativeApp } from "./platform";
import { NATIVE_EXTERNAL_SOURCES } from "./nativeExternalSources";

/**
 * 外部サイトを取得する共通ヘルパー。
 *
 * - Web(PWA): `server/externalProxy.mjs`経由(`/api/ext/<source>`。CORS制約があるため)。
 * - Androidネイティブアプリ: `capacitor.config.ts`で有効化した`CapacitorHttp`プラグインにより
 *   `fetch()`自体がネイティブ通信(CORSの対象外)になるため、プロキシを経由せず外部サイトへ
 *   直接アクセスする(`src/lib/nativeExternalSources.ts`参照)。
 *   「サーバー(プロキシ)が無いと動かない機能は、スマホ内で演算して自己完結させることは
 *   可能でしょうか」という指示への対応。
 */
export async function fetchExt(source: string, upstreamPath: string): Promise<string> {
  if (isNativeApp()) {
    return fetchExtNative(source, upstreamPath);
  }
  return fetchExtWeb(source, upstreamPath);
}

async function fetchExtWeb(source: string, upstreamPath: string): Promise<string> {
  const url = `/api/ext/${source}?path=${encodeURIComponent(upstreamPath)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`外部データ(${source})の取得に失敗しました (HTTP ${res.status})`);
  }
  const text = await res.text();

  // プロキシのミドルウェアが動いていないと、SPAのindex.htmlがそのまま返ってくる。
  // そのまま呼び出し元でJSON.parseすると "Unexpected token '<'" になって原因が分かりにくいので、
  // ここで検知して何が起きているかを伝える(古いサーバーが残っている場合などに起きる)。
  //
  // 【既知の不具合の教訓】以前はここで「本文が '<' で始まる応答は全部エラー」という
  // より広い判定をしていたが、fetchExt() の呼び出し元にはHTMLを受け取ることを前提に
  // 自前でパースしているもの(shinshuWeatherService.ts の速報値テーブル、
  // jr9vqCameraService.ts・jmaVolcamService.ts の詳細ページなど)が複数あり、
  // それらの**正常なHTML応答までエラー扱いにしてしまう**回帰バグを起こした
  // (「信州山岳の情報がHTMLのエラーになる」という報告で発覚)。そのため判定は、
  // このアプリ自身のSPAフォールバック(index.html、`<div id="root">`を含む)を
  // 検知する場合に限定している。JSONを期待する呼び出し元(kawabou等)側で
  // 応答がHTMLだった場合に分かりやすいエラーにしたい場合は、各サービス側で判定すること。
  if (/^\s*<!doctype html/i.test(text) && text.includes('<div id="root">')) {
    throw new Error(
      `プロキシ(/api/ext/${source})が応答していません。アプリを起動し直してください` +
        `(古いサーバーが残っている可能性があります)`,
    );
  }
  return text;
}

const NATIVE_BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

async function fetchExtNative(source: string, upstreamPath: string): Promise<string> {
  // 川の防災情報(kawabou)・道路情報提供システム(roadKisho)の個別処理は、スマホ版では廃止した(2026年10月)

  const cfg = NATIVE_EXTERNAL_SOURCES[source];
  if (!cfg) {
    throw new Error(`未対応の外部データ種別です(ネイティブ版): ${source}`);
  }

  const headers: Record<string, string> = { "User-Agent": NATIVE_BROWSER_UA };
  if (cfg.body) {
    headers["Content-Type"] = cfg.contentType ?? "application/x-www-form-urlencoded";
  }

  let res: Response;
  try {
    res = await fetch(cfg.origin + upstreamPath, {
      method: cfg.method ?? "GET",
      headers,
      body: cfg.body,
    });
  } catch (e) {
    const hint = cfg.headerRiskUnverified
      ? "(この取得先は応答ヘッダーが非標準の可能性があり、ネイティブ通信では取得できないことがあります)"
      : "";
    throw new Error(`外部データ(${source})の取得に失敗しました${hint}: ${String(e)}`);
  }
  if (!res.ok) {
    throw new Error(`外部データ(${source})の取得に失敗しました (HTTP ${res.status})`);
  }

  if (cfg.encoding && cfg.encoding.toLowerCase() !== "utf-8") {
    const buf = await res.arrayBuffer();
    return new TextDecoder(cfg.encoding).decode(buf);
  }
  return res.text();
}
