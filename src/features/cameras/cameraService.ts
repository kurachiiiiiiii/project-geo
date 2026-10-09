import { parseJsonResponse } from "../../lib/safeJson";
import type { CameraConfig } from "../../types";

/** public/cameras.json を読み込み、簡易バリデーションをかけて返す */
export async function loadCameras(): Promise<CameraConfig[]> {
  const res = await fetch(`${import.meta.env.BASE_URL}cameras.json`);
  if (!res.ok) {
    throw new Error(`cameras.json の読み込みに失敗しました (HTTP ${res.status})`);
  }
  const data = await parseJsonResponse<unknown>(res, "cameras.json");
  if (!Array.isArray(data)) {
    throw new Error("cameras.json はカメラ設定の配列である必要があります");
  }
  return data.filter(isValidCamera).filter(isAllowedImageSource);
}

/**
 * 画像を直接表示する(`type: "image"`)カメラは、国の機関(`*.go.jp`)の画像だけにする。
 *
 * 「法令適合と著作権などの抵触の確認」の結果、民間・個人・自治体系のサイトのカメラ画像は、
 * 「無断転載禁止」の明記が無くても再配信・埋め込みの許諾が確認できない(著作権は配信元にある)ため、
 * スマホ版では表示しないことにした(2026年10月、「全ては削減します」)。国の機関(地方整備局・
 * 国道事務所など)は公共データ利用規約(PDL1.0。出典の表示で利用可)に準拠している。
 * `cameras.json`から該当する行も消してあるが、今後うっかり足したときにも出ないよう、ここでも除く。
 * YouTube(公式の埋め込みプレーヤー)・配信元へのリンクだけのカメラは対象外。
 */
function isAllowedImageSource(c: CameraConfig): boolean {
  if (c.type !== "image") return true;
  try {
    const host = new URL(c.url).hostname;
    return host === "go.jp" || host.endsWith(".go.jp");
  } catch {
    // 相対URL(以前の画像中継 /api/img/... など)は、配信元が国の機関ではないので出さない
    return false;
  }
}

function isValidCamera(value: unknown): value is CameraConfig {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.name === "string" &&
    typeof c.lat === "number" &&
    typeof c.lng === "number" &&
    CAMERA_TYPES.has(c.type as string) &&
    typeof c.url === "string"
  );
}

const CAMERA_TYPES = new Set<string>(["image", "iframe", "youtube", "youtubeChannel", "link"]);

/** YouTubeの動画/ライブID から埋め込みiframeのURLを組み立てる */
export function youtubeEmbedUrl(videoId: string): string {
  return `https://www.youtube.com/embed/${videoId}?autoplay=1&mute=1`;
}

/**
 * YouTubeの**チャンネルID**から、「そのチャンネルが今配信中のライブ」を埋め込むURLを組み立てる。
 * 動画IDを固定で埋め込む youtubeEmbedUrl と違い、配信が終わって新しいライブ(新しい動画ID)が
 * 始まっても自動的に追従する。CameraType の "youtubeChannel" の説明も参照。
 */
export function youtubeChannelEmbedUrl(channelId: string): string {
  return `https://www.youtube.com/embed/live_stream?channel=${channelId}&autoplay=1&mute=1`;
}
