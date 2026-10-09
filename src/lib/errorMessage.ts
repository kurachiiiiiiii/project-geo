/**
 * 通信などの失敗(例外)を、画面に出す日本語の短い文にする。
 * ブラウザの生のメッセージは英語で分かりにくい(Chrome/Androidは "Failed to fetch"、Safariは "Load failed")ので、
 * 電波が無い・つながらない失敗は、分かる文にそろえる。それ以外は、元のメッセージをそのまま返す(HTTPのエラーコードなど、手がかりを残す)。
 */
export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "オフラインです(ネットワークにつながっていません)";
  }
  if (e instanceof DOMException && (e.name === "AbortError" || e.name === "TimeoutError")) {
    return "通信に時間がかかりすぎたため、中断しました";
  }
  if (/failed to fetch|load failed|networkerror|network request failed|network error/i.test(raw)) {
    return "通信できませんでした(電波・ネットワークを確認してください)";
  }
  return raw;
}
