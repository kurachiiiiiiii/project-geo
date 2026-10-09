import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw, TriangleAlert } from "../lib/lucide";
import { Ico } from "./Ico";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * アプリ全体を包む最上位のエラー境界(React Error Boundary)。
 *
 * 「小さい青の丸の点を 現在の気温を表示しているときにクリックすると なにも表示されなく
 * なります」というバグ調査で、ポップアップ内の未ガードの`.toFixed()`が(まれなデータ不整合で)
 * 例外を投げると、このアプリにはエラー境界が1つも無かったため、React 19がツリー全体を
 * アンマウントして画面が完全に真っ白(≒ブラックアウト)になっていたことを確認した。
 * 個々の原因(ポップアップの未ガードな数値フォーマットなど)はその都度直すが、同種の
 * 見落としが今後どこかで起きても「アプリ全体が消える」ことだけは避けたいため、最上位に
 * このエラー境界を1つ置いておく。地図やポップアップなど描画中の例外を捕まえ、代わりに
 * 再読み込みを促す簡単な画面を出す(地図やレイヤーの状態はReact外のLeafletインスタンスにも
 * またがっており、途中から一部だけ復旧させるのは難しいため、安全策として再読み込みを促す)。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("ErrorBoundary: アプリ内で捕捉されなかったエラーが発生しました", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-error-boundary">
          <div className="app-error-boundary__box">
            <div className="app-error-boundary__title"><Ico icon={TriangleAlert} /> 表示中にエラーが発生しました</div>
            <p className="app-error-boundary__message">
              一部のデータ表示中に問題が発生し、画面を継続できなくなりました。お手数ですが再読み込みしてください。
            </p>
            <p className="app-error-boundary__detail">{this.state.error.message}</p>
            <button
              type="button"
              className="app-error-boundary__reload"
              onClick={() => window.location.reload()}
            >
              <Ico icon={RefreshCw} /> 再読み込み
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
