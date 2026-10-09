import { useEffect, useRef } from "react";

/**
 * 「戻る」(Androidの戻るボタン・ブラウザの戻る)で、開いているパネルを1つずつ閉じる仕組み。
 *
 * 【なぜ要るか】3Dビューワー・下から出るシート(表示レイヤー・天文情報)・カメラの吹き出しは、どれも
 * ページの履歴を持たない。そのまま「戻る」を押すと、開いているものを閉じずに、アプリごと閉じてしまう
 * (Androidアプリ=Capacitorでは、履歴が無いと戻るボタンでアプリが終了する。PWAでも前のページへ戻る)。
 *
 * 【仕組み】開いているものが1つ以上あるあいだ、履歴に「見張り」を1つだけ積む(同じURL。画面は変わらない)。
 * 戻るが押されると、その見張りが消える(popstate)ので、いちばん新しく開いたものを閉じる。まだ開いたものが
 * 残っていれば、見張りを積み直す。閉じるボタンなど、戻る以外で全部閉じたときは、見張りを履歴から外す。
 * Capacitorの戻るボタンは、WebViewに戻れる履歴があればそれを使う(`canGoBack`)ので、プラグインは要らない。
 */
interface Layer {
  close: () => void;
}

const stack: Layer[] = [];
/** 履歴に見張りを積んでいるか */
let guard = false;
/** こちらから history.back() した分の popstate は、戻るボタンではないので無視する */
let ignorePop = 0;
let listening = false;

function onPopState(): void {
  if (ignorePop > 0) {
    ignorePop--;
    return;
  }
  // 戻るが押された(見張りが履歴から消えた)
  guard = false;
  const top = stack.pop();
  if (!top) return;
  try {
    top.close();
  } finally {
    if (stack.length > 0) {
      history.pushState({ p1back: true }, "");
      guard = true;
    }
  }
}

function listen(): void {
  if (listening) return;
  listening = true;
  window.addEventListener("popstate", onPopState);
}

/**
 * 開いたものを登録する。返す関数を呼ぶと登録を外す(閉じたとき)。
 * 戻るで閉じられたときは、`close`が呼ばれ、登録は自動で外れる(返す関数を呼んでも何も起きない)。
 */
export function pushBackLayer(close: () => void): () => void {
  listen();
  const layer: Layer = { close };
  stack.push(layer);
  if (!guard) {
    history.pushState({ p1back: true }, "");
    guard = true;
  }
  return () => {
    const i = stack.indexOf(layer);
    if (i < 0) return;
    stack.splice(i, 1);
    // すぐには履歴を戻さない(開き直し・React開発モードの二重実行で、積んだ直後に外すことがあるため)。
    // この回の処理が終わったとき、まだ空なら見張りを外す
    queueMicrotask(() => {
      if (stack.length === 0 && guard) {
        guard = false;
        ignorePop++;
        history.back();
      }
    });
  };
}

/** `open`のあいだ、「戻る」で`close`を呼ぶようにする(パネル・シート・ビューワーなどの共通フック) */
export function useBackLayer(open: boolean, close: () => void): void {
  const closeRef = useRef(close);
  useEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    return pushBackLayer(() => closeRef.current());
  }, [open]);
}
