/**
 * fetch() のレスポンスをJSONとして安全にパースする。
 *
 * 外部サイトが一時的に落ちている・メンテナンス中などの理由で、HTTPステータスは200(=res.ok)のまま
 * HTMLのエラーページ(あるいはこのアプリ自身のSPAフォールバックのindex.html)を返してくることがある。
 * その場合そのまま `res.json()` を呼ぶと、ブラウザの生の
 * `Unexpected token '<', "<!doctype "... is not valid JSON` がそのままUI(usePolledResourceのerror)に
 * 表示されてしまい、どのデータソースで何が起きたのか全く分からない。
 * ここで検知し、どのデータソースの応答がおかしいのかが分かるメッセージに変換する。
 */
export async function parseJsonResponse<T>(res: Response, label: string): Promise<T> {
  const text = await res.text();
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<")) {
    // 「北陸地方整備局ライブカメラ一覧の応答がJSONではなくHTMLでした」という報告への対応。
    // vite.config.ts に新しいAPIルートを追加しても、既に起動中のdevサーバーには反映されない
    // (devサーバーの再起動が必要)。その状態で新ルートを叩くと、ViteのSPAフォールバックで
    // このアプリ自身のindex.html(`<div id="root">`を含む)がそのまま返ってきてしまい、
    // 原因が分かりにくい汎用エラーになっていた(src/lib/extProxy.ts の fetchExtWeb では
    // 既にこの判定をしていたが、こちらの共通関数には無かった)。ここで検知し、
    // 再起動を促す分かりやすいメッセージに変える。
    if (text.includes('<div id="root">')) {
      // 開発中(devサーバー)だけ、再起動の案内を出す。スマホ版(PWA・Androidアプリ)の利用者には意味が分からないので、
      // 製品のビルドでは「更新するか、時間をおいて」という案内にする
      throw new Error(
        import.meta.env.DEV
          ? `${label}の取得先が見つかりませんでした。アプリ(devサーバー)を再起動してください` +
              `(vite.config.tsの変更はサーバー再起動後にのみ反映されます)`
          : `${label}を読み込めませんでした(取得先が見つかりません)。アプリを最新の状態に更新するか、しばらくしてからもう一度お試しください`,
      );
    }
    const preview = trimmed.slice(0, 80).replace(/\s+/g, " ");
    throw new Error(
      `${label}の応答がJSONではなくHTMLでした(一時的な障害の可能性があります): "${preview}..."`,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = trimmed.slice(0, 80).replace(/\s+/g, " ");
    throw new Error(`${label}の応答をJSONとして解析できませんでした: "${preview}..."`);
  }
}
