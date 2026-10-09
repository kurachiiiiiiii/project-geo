import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "./errorMessage";

interface PolledResource<T> {
  data: T;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * 「取得→(任意で定期ポーリング)→読み込み中/エラー状態を保持」という定型パターンをまとめたフック。
 * 各都道府県のカメラ取得など、同じ形の非同期データソースが増えてきたための共通化。
 *
 * @param loader データ取得関数
 * @param initial 初期値
 * @param pollMs 指定すると、この間隔(ms)で再取得する。省略時は初回のみ取得。
 */
export function usePolledResource<T>(loader: () => Promise<T>, initial: T, pollMs?: number): PolledResource<T> {
  const [data, setData] = useState<T>(initial);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    loader()
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
    // loader は呼び出し側で毎レンダー新しい関数参照になり得るため、意図的に依存配列から外す
    // (マウント時の1回 + pollMsごとの再取得のみを意図している)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    refresh();
    if (!pollMs) return;
    const id = window.setInterval(refresh, pollMs);
    return () => window.clearInterval(id);
  }, [refresh, pollMs]);

  return { data, loading, error, refresh };
}
