import { Component, lazy, Suspense, type ReactNode } from "react";
import type { Viewer3DProps } from "./Viewer3D";
import { useBackLayer } from "../lib/backStack";

/**
 * 3Dビューワーの入れ物。
 *  ・本体(`Viewer3D`)は重いので、ボタンを押したときに初めて読み込む(lazy)。起動や地図の動作には影響しない。
 *  ・読み込み失敗(オフラインで未取得など)や描画中の例外は、アプリ全体の最上位エラー境界に届く前に
 *    ここで受け止め、3Dビューだけを閉じられるようにする(地図まで真っ白にしない)。
 */
const Viewer3D = lazy(() => import("./Viewer3D"));

interface BoundaryProps {
  onClose: () => void;
  children: ReactNode;
}

class Boundary extends Component<BoundaryProps, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("3Dビューワーでエラーが発生しました", error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="viewer3d viewer3d--message" role="dialog" aria-label="3Dビューワー">
          <div className="viewer3d__loading viewer3d__loading--error">
            <div>3Dビューを開けませんでした</div>
            <div className="viewer3d__loading-sub">{this.state.error.message}</div>
            <button type="button" className="viewer3d__btn viewer3d__btn--on" onClick={this.props.onClose}>
              閉じる
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function Viewer3DHost(props: Viewer3DProps) {
  // 戻るボタン(Android)・ブラウザの戻るで、アプリごと閉じず、3Dビューだけを閉じる
  useBackLayer(true, props.onClose);
  return (
    <Boundary onClose={props.onClose}>
      <Suspense
        fallback={
          <div className="viewer3d viewer3d--message" role="dialog" aria-label="3Dビューワー">
            <div className="viewer3d__loading">
              <div className="viewer3d__spinner" />
              <div>3Dビューを読み込み中…</div>
            </div>
          </div>
        }
      >
        <Viewer3D {...props} />
      </Suspense>
    </Boundary>
  );
}
