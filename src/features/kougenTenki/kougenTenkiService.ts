import { isNativeApp } from "../../lib/platform";
import { parseJsonResponse } from "../../lib/safeJson";
import type { KougenTenkiGrid } from "../../types";

/**
 * 「高原天気」気温・霧シミュレーター(岐阜県北部〜長野県中心)のライブ生成。
 *
 * 元は https://desktop/高原天気 のJava製ツール(Tenki.java)の計算ロジックを
 * `server/kougenTenkiGenerate.mjs` に移植したもの。「気象情報を生成」ボタンを押すたびに
 * `/api/kougen-tenki-generate` を叩き、アメダス観測値(直近12時間・1時間刻み。犬山自動気象
 * 観測所を最新コマにのみ追加)+国土地理院DEM(標高、タイル単位でサーバー側キャッシュ)から
 * 気温分布・霧リスクのグリッドを都度計算して返す。上空観測は対象外(指示により簡略化)。
 * 過去12時間〜現在の「実況の推定」だけを作る(スマホ版では、未来12時間の予測(Open-Meteo)・
 * 信州大学 山岳観測所の取得を廃止した。アプリが自分で予報を作らない)。
 *
 * Androidネイティブアプリでは`/api/kougen-tenki-generate`(サーバー)を使わず、同じ計算ロジックを
 * 端末内で実行する`kougenTenkiNativeGenerate.ts`を動的importで読み込む(「サーバーなしでスマホ
 * 完結化」の指示への対応)。Web版のバンドルに含めないよう、ネイティブアプリのときだけ読み込む
 * (`satelliteAiUpscale`と同じ、重い機能を遅延読み込みする既存パターン)。
 */
export async function generateKougenTenki(): Promise<KougenTenkiGrid> {
  if (isNativeApp()) {
    const { generateKougenTenki: generateNative } = await import("./kougenTenkiNativeGenerate");
    return generateNative() as Promise<KougenTenkiGrid>;
  }

  const res = await fetch("/api/kougen-tenki-generate");
  if (!res.ok) {
    throw new Error(`高原天気の生成に失敗しました (HTTP ${res.status})`);
  }
  return parseJsonResponse<KougenTenkiGrid>(res, "高原天気");
}

/**
 * 保存するデータの形のバージョン。`hours`の中身(実測のみ→実測+予測など)を変えるたびに上げる。
 * バージョンが一致しない過去の生成結果は、一覧表示・読み込みの対象から除外する
 * (`listKougenTenkiHistory`)。古い形式のデータをそのまま画面に出すと、フィールドが
 * 足りない等でおかしな表示になるため。
 */
const SCHEMA_VERSION = 11; // 3: 予測をOpen-Meteoベースに変更(forecastSource追加)、霧リスクを段階値に変更
// 4: 霧リスクに標高(谷・盆地度)・気温逓減率(gamma)による補正を追加、openMeteoErrorを追加
// 5: 霧リスクのしきい値を湿度97%からに変更、標高100m以下は1%かさ下げ、湿度の標高別逓減率
//    (気温と同様にDEMへ適用)を追加
// 6: 雨による霧リスクのかさ上げを、降水量合計ベースから「雨が止んでからの経過時間」ベースの
//    減衰カーブ(1時間後+3%→以降1時間ごとに-2%)に変更
// 7: 霧リスクのしきい値判定(97%ゲート)を、雨・地形・逓減率のブースト後ではなく生の湿度
//    (低地補正のみ反映)で行うよう修正(湿度95%でもブーストだけでリスクありになる不具合を修正)。
//    雨による霧リスクのピークを5%→3%に引き下げ
// 8: 谷・盆地度による霧リスクのブーストを撤去
// 9: 過去12時間+未来12時間(計24時間)に拡張、犬山自動気象観測所を追加、地形性上昇流・
//    吹き下ろし(標高差300m/km以上・風向)による霧リスク補正(+2%/-1%)を追加
// 10: inuyamaAwsError(犬山自動気象観測所の取得成功/失敗)を追加
// 11: 未来12時間の予測(Open-Meteo・実測トレンドの延長)と信州大学 山岳観測所を廃止し、過去12時間〜現在の実況だけに
//     (以前の予測コマを含む生成結果は読み込まない)

/**
 * 生成結果の保存先を localStorage から IndexedDB に変更した経緯。
 *
 * 【既知の不具合と修正】「高原天気の気象予測を、過去に生成したデータを読み込めるボタンを
 * 追加してください」という指示を受けて実装中、1回ぶんの生成結果(過去12時間+未来12時間、
 * 256×240セル)をJSON化すると**約17MB**にもなることが判明した。localStorageの上限は
 * ブラウザにもよるが一般に5〜10MB程度のため、以前の実装(localStorageに1件だけ保存)は
 * 24時間ぶんに拡張して以降、実質的に保存できておらず(`try/catch`で容量超過を黙って
 * 無視していたため気づけなかった)、「前回訪問時の生成結果をすぐ表示する」機能が
 * 静かに壊れていた可能性が高い。IndexedDBはブラウザにもよるが数十MB〜数百MB以上を
 * 扱えるため、こちらに切り替えた。あわせて、1件だけでなく直近`MAX_HISTORY_ENTRIES`件を
 * 保持し、「過去に生成したデータを読み込むボタン」で選んで読み込めるようにした。
 */
const DB_NAME = "kougenTenkiDB";
const STORE_NAME = "generations";
const DB_VERSION = 1;
/** 保持する世代数の上限(1件あたり約10〜20MBあるため、際限なく増やさない) */
const MAX_HISTORY_ENTRIES = 5;

interface StoredRecord {
  /** キー。生成対象の最新観測時刻("YYYY-MM-DDTHH:mm"、日本時間)。grid.generatedAtと同じ */
  generatedAt: string;
  /** 保存した実時刻(ms)。同じgeneratedAtで再保存された場合の新しい順の判定・古い世代の間引きに使う */
  savedAt: number;
  version: number;
  grid: KougenTenkiGrid;
}

/** 履歴一覧UI向けの軽量なメタ情報(グリッド本体を含まない) */
export interface KougenTenkiHistoryEntry {
  generatedAt: string;
  savedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("このブラウザはIndexedDBに対応していません"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "generatedAt" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDBのオープンに失敗しました"));
  });
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB操作に失敗しました"));
  });
}

/** 直近`MAX_HISTORY_ENTRIES`件を超えた古い世代(savedAtが古い順)を削除する */
async function pruneHistory(db: IDBDatabase): Promise<void> {
  const tx = db.transaction(STORE_NAME, "readwrite");
  const store = tx.objectStore(STORE_NAME);
  const all = await promisifyRequest(store.getAll() as IDBRequest<StoredRecord[]>);
  const sorted = [...all].sort((a, b) => b.savedAt - a.savedAt); // 新しい順
  const toDelete = sorted.slice(MAX_HISTORY_ENTRIES);
  for (const rec of toDelete) {
    store.delete(rec.generatedAt);
  }
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 生成結果を履歴に保存する(直近`MAX_HISTORY_ENTRIES`件のみ保持し、それより古いものは自動的に間引く)。
 *
 * どの関数も`openDb()`のたびに新しい接続を作るため、使い終わったら必ず`db.close()`する
 * (呼びっぱなしで閉じないと接続が残り続け、後で`indexedDB.deleteDatabase()`をブロックする
 * ことがある。動作確認中に実際にこれで一時的にハングした)。
 */
export async function saveKougenTenkiToHistory(grid: KougenTenkiGrid): Promise<void> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDb();
    const record: StoredRecord = { generatedAt: grid.generatedAt, savedAt: Date.now(), version: SCHEMA_VERSION, grid };
    await new Promise<void>((resolve, reject) => {
      const tx = db!.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    await pruneHistory(db);
  } catch {
    // IndexedDBが使えない/容量超過などで失敗しても、単なる利便性のためのキャッシュなので無視してよい。
  } finally {
    db?.close();
  }
}

/** 保存済みの生成履歴を新しい順(savedAt降順)の一覧で返す(グリッド本体は含まない軽量な一覧) */
export async function listKougenTenkiHistory(): Promise<KougenTenkiHistoryEntry[]> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const all = await promisifyRequest(tx.objectStore(STORE_NAME).getAll() as IDBRequest<StoredRecord[]>);
    return all
      .filter((r) => r.version === SCHEMA_VERSION && r.grid)
      .sort((a, b) => b.savedAt - a.savedAt)
      .map((r) => ({ generatedAt: r.generatedAt, savedAt: r.savedAt }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** 指定した世代(`generatedAt`)のグリッドを読み込む。見つからない/失敗した場合はnull */
export async function loadKougenTenkiFromHistory(generatedAt: string): Promise<KougenTenkiGrid | null> {
  let db: IDBDatabase | undefined;
  try {
    db = await openDb();
    const tx = db.transaction(STORE_NAME, "readonly");
    const record = await promisifyRequest(
      tx.objectStore(STORE_NAME).get(generatedAt) as IDBRequest<StoredRecord | undefined>,
    );
    if (!record || record.version !== SCHEMA_VERSION || !record.grid) return null;
    return record.grid;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** 起動時にまず表示しておく、最新(savedAtが最大)の生成結果を読み込む。無ければnull */
export async function loadLatestKougenTenkiFromHistory(): Promise<KougenTenkiGrid | null> {
  const list = await listKougenTenkiHistory();
  if (list.length === 0) return null;
  return loadKougenTenkiFromHistory(list[0].generatedAt); // listは既にsavedAt降順
}

/**
 * 「高層天気取得は1日2回までと制限をかけてください(10時間に1回まで)。制限中は高層天気の
 * キャッシュを読み込む形にしてください」という指示への対応。
 *
 * サーバー側の実際のライブ生成(`/api/kougen-tenki-generate`。DEM取得やOpen-Meteoへの
 * 外部リクエストを伴う重い処理)にのみ最小間隔を設ける。保存済み履歴の閲覧・読み込み
 * (`loadKougenTenkiFromHistory`等)はこの制限の対象外(ローカルのIndexedDBを読むだけで
 * 外部への負荷が無いため)。
 *
 * 「10時間に1回まで」を素直に間隔として実装しており、厳密な「暦日1日あたり2回」ではない
 * (10時間おきに生成し続けると暦日をまたいで3回になり得るが、指示にある2つの数字のうち
 * より具体的な「10時間に1回」を実際の制限値として採用し、「1日2回程度」はその結果として
 * 説明する形にしている)。
 */
const MIN_GENERATE_INTERVAL_MS = 10 * 60 * 60 * 1000;
const LAST_GENERATED_AT_KEY = "kougenTenkiLastGeneratedAt";

/** 次に実際のライブ生成ができるようになるまでの残り時間(ms)。今すぐ生成できるなら0 */
export function kougenTenkiCooldownRemainingMs(): number {
  try {
    const raw = localStorage.getItem(LAST_GENERATED_AT_KEY);
    if (!raw) return 0;
    const last = Number(raw);
    if (!Number.isFinite(last)) return 0;
    return Math.max(0, MIN_GENERATE_INTERVAL_MS - (Date.now() - last));
  } catch {
    return 0;
  }
}

/** 実際のライブ生成に成功した直後に呼び、クールダウンの起点時刻を記録する */
export function markKougenTenkiGenerated(): void {
  try {
    localStorage.setItem(LAST_GENERATED_AT_KEY, String(Date.now()));
  } catch {
    // 保存できなくても致命的ではない(単なる制限用の記録)ので無視する
  }
}
