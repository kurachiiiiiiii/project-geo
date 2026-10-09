/**
 * `kougenTenkiNativeGenerate.ts`(高原天気生成のAndroidネイティブ移植版)専用の
 * 簡易キー・バリューキャッシュ。サーバー版(`server/kougenTenkiGenerate.mjs`)の
 * ファイルキャッシュ(DEMタイル・Open-Meteo予報)に相当するものをIndexedDBで実現する
 * (`kougenTenkiService.ts`の生成結果履歴保存と同じ理由でlocalStorageではなくIndexedDBを使う。
 * DEMタイルは範囲内だけでも数百枚になり得るため)。
 */
const DB_NAME = "kougenTenkiNativeCacheDB";
const STORE_NAME = "cache";
const DB_VERSION = 1;

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) {
        req.result.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDBを開けませんでした"));
  });
}

/** キーに対応する文字列を返す。無ければnull(サーバー版のfs読み込み失敗=キャッシュ無しと同じ扱い) */
export async function readNativeCache(key: string): Promise<string | null> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onsuccess = () => resolve(typeof req.result === "string" ? req.result : null);
      req.onerror = () => reject(req.error ?? new Error("IndexedDB読み込みエラー"));
    });
  } catch {
    // 読み込み失敗はキャッシュ無しと同じ扱いにする(サーバー版のtry/catchと同じ考え方)
    return null;
  }
}

export async function writeNativeCache(key: string, content: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put(content, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB書き込みエラー"));
    });
  } catch (e) {
    // 書き込み失敗はキャッシュできないだけで致命的ではないため、サーバー版と同様に握りつぶす
    // (ensureDirAndWriteのtry/catchと同じ考え方)。
    console.warn("kougenTenkiNativeGenerate: キャッシュの保存に失敗しました", e);
  }
}
