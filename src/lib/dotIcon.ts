import L from "leaflet";

const cache = new Map<string, L.DivIcon>();

/** マーカーの既定サイズ。視認性を優先してやや大きめにしている。 */
export const DEFAULT_DOT_SIZE = 22;

/**
 * マーカーの形状。データの種類が一目で分かるよう使い分ける:
 * - "circle" … カメラ系レイヤー。「カメラの表示レイヤーを統一してください 形も丸のみに
 *   してください」という指示により、以前は既定値(星)だったものも含め、すべてのカメラ
 *   レイヤーの呼び出し側で明示的にこの丸を指定するようにした(色は出典ごとに変えたまま)。
 * - "square" … アメダス観測所・信州大学山岳観測所など、カメラではなく観測値を示すレイヤー
 * - "star"   … 既定値。カメラ以外の新しいレイヤーを追加するとき、shapeを指定し忘れても
 *   カメラの丸と紛れない見た目になるよう、既定はあえて丸にしていない。
 */
export type DotShape = "circle" | "square" | "star";

const DEFAULT_SHAPE: DotShape = "star";

// 5角星のポリゴン頂点(viewBox 0 0 24 24 基準)
const STAR_POINTS =
  "12,1 15.09,8.26 23,9.27 17,14.97 18.18,22.82 12,19.02 5.82,22.82 7,14.97 1,9.27 8.91,8.26";

/** ドット/四角の中身(内側の<span>)のHTMLを組み立てる。丸か四角かはCSSクラス側で切り替える */
function boxSpanHtml(color: string, size: number): string {
  return `<span style="--dot-color:${color};--dot-size:${size}px"></span>`;
}

/** 星形のHTML(box-shadowがclip-pathで欠けるのを避けるためSVGで描く) */
function starSvgHtml(color: string, size: number): string {
  return (
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" style="display:block;filter:drop-shadow(0 1px 3px rgba(0,0,0,0.6));">` +
    `<polygon points="${STAR_POINTS}" fill="${color}" stroke="rgba(255,255,255,0.92)" stroke-width="1.7" stroke-linejoin="round"/>` +
    `</svg>`
  );
}

function shapeClassName(shape: DotShape): string {
  if (shape === "star") return "star-marker";
  if (shape === "square") return "dot-marker dot-marker--square";
  return "dot-marker";
}

function shapeHtml(color: string, size: number, shape: DotShape): string {
  if (shape === "star") return starSvgHtml(color, size);
  return boxSpanHtml(color, size);
}

/** シンプルな色付きマーカー(divIcon)を作る。同じ色・サイズ・形状は使い回す */
export function dotIcon(color: string, size = DEFAULT_DOT_SIZE, shape: DotShape = DEFAULT_SHAPE): L.DivIcon {
  const key = `${shape}-${color}-${size}`;
  let icon = cache.get(key);
  if (!icon) {
    icon = L.divIcon({
      className: shapeClassName(shape),
      html: shapeHtml(color, size, shape),
      iconSize: [size, size],
    });
    cache.set(key, icon);
  }
  return icon;
}

/**
 * 観測値をラベルとして横に表示するマーカー。
 * 気象データ(アメダス・山岳観測所)で「21.3℃」などを地図上に直接読ませるために使う。
 *
 * `valueColor` を渡すと、値に応じた色(気温なら寒色〜暖色)でドットとラベルを着色する。
 * 数字を読まなくても分布が一目で分かるようにするため。
 */
export function valueIcon(
  color: string,
  text: string,
  options: { valueColor?: string; textColor?: string; size?: number; shape?: DotShape } = {},
): L.DivIcon {
  const { valueColor, textColor, size = DEFAULT_DOT_SIZE, shape = DEFAULT_SHAPE } = options;
  const dotColor = valueColor ?? color;
  const key = `v-${shape}-${dotColor}-${textColor ?? ""}-${text}-${size}`;
  let icon = cache.get(key);
  if (!icon) {
    const labelStyle = valueColor
      ? ` style="background:${valueColor};color:${textColor ?? "#0b1220"}"`
      : "";
    const dotHtml =
      shape === "star"
        ? starSvgHtml(dotColor, size)
        : `<span class="value-marker__dot" style="--dot-color:${dotColor};--dot-size:${size}px"></span>`;
    icon = L.divIcon({
      className: `value-marker${shape === "square" ? " value-marker--square" : ""}`,
      html: dotHtml + `<span class="value-marker__label"${labelStyle}>${text}</span>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
    cache.set(key, icon);
  }
  return icon;
}
