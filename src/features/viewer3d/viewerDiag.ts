/**
 * 3Dビュー: 「落ちた」(タブが落ちる・描画が止まる)ときの原因を、あとから調べるための記録。
 *
 * 落ちる原因は端末のGPU・メモリ・ドライバーで決まり、アプリの中からは確かめられないことが多い。そこで、
 *   1) GPUに載せた画像・データ・描画面の大きさを数えておき(`trackGlMemory`)、
 *   2) 3Dビューを開いている間、数秒おきに「いまの設定・メモリの見積もり・描画の重さ・直前の操作」を端末の中(localStorage)に書き残し、
 *   3) 正常に閉じられないまま次に開かれたとき(= タブが落ちた)や、WebGLが中断されたとき(`webglcontextlost`)に、
 *      その記録から原因の手がかりを日本語で出す
 * ようにする。外へは何も送らない(記録は端末の中だけ。「診断情報をコピー」を押したときだけ、文字として取り出せる)。
 *
 * 記録が「正常に閉じた」印を持たないのは、タブが落ちたとき(ページの終了イベントが走らない)だけ。画面を閉じる・
 * 3Dビューを閉じる・別のページへ移る、のときは `pagehide` / 閉じる処理で印を付ける。
 */

// ---------------------------------------------------------------------------
// GPUメモリの見積もり
// ---------------------------------------------------------------------------

/** 内部形式ごとの1画素のバイト数(よく使うものだけ。それ以外は4) */
const BPP: Record<number, number> = {
  0x1908: 4, // RGBA
  0x8058: 4, // RGBA8
  0x1907: 3, // RGB
  0x8051: 3, // RGB8
  0x8229: 1, // R8
  0x822b: 2, // RG8
  0x822d: 2, // R16F
  0x822e: 4, // R32F
  0x822f: 4, // RG16F
  0x8230: 8, // RG32F
  0x881a: 8, // RGBA16F
  0x8814: 16, // RGBA32F
  0x1909: 1, // LUMINANCE
  0x1906: 1, // ALPHA
  0x190a: 2, // LUMINANCE_ALPHA
};

export interface GlMemoryReport {
  /** 画像(テクスチャ)の合計(MB。ミップマップを含む) */
  texMB: number;
  /** 頂点・インデックスなどのバッファの合計(MB) */
  bufMB: number;
  /** 描画面(画面に出す前の描画先。アンチエイリアスの分を含む)の見積もり(MB) */
  drawMB: number;
  totalMB: number;
  textureCount: number;
  /** 大きい画像の上位(「幅x高さ x1画素のバイト数」と MB) */
  top: string[];
  drawWidth: number;
  drawHeight: number;
  /** アンチエイリアスの標本数(0・1=なし) */
  samples: number;
}

const TEXTURE_2D = 0x0de1;
const MB = 1048576;

/**
 * WebGLの画像・バッファの大きさを数える(このコンテキストの関数に、数える処理をかぶせる)。作った直後に1度だけ呼ぶ。
 * 数えるのは texImage2D / texStorage2D / bufferData / deleteTexture / deleteBuffer / generateMipmap だけで、負荷はごく小さい。
 */
export function trackGlMemory(gl: WebGL2RenderingContext): { report: () => GlMemoryReport } {
  const texs = new Map<WebGLTexture, { w: number; h: number; bpp: number; mip: boolean }>();
  const bufs = new Map<WebGLBuffer, number>();
  let curTex: WebGLTexture | null = null;
  const curBuf = new Map<number, WebGLBuffer | null>();
  const g = gl as unknown as Record<string, (...a: unknown[]) => unknown>;
  const wrap = (name: string, fn: (a: unknown[]) => void) => {
    const orig = g[name];
    if (typeof orig !== "function") return;
    g[name] = (...a: unknown[]) => {
      try {
        fn(a);
      } catch {
        // 数えそこなっても描画は続ける
      }
      return orig.apply(gl, a);
    };
  };
  wrap("bindTexture", (a) => {
    if (a[0] === TEXTURE_2D) curTex = a[1] as WebGLTexture | null;
  });
  wrap("bindBuffer", (a) => {
    curBuf.set(a[0] as number, a[1] as WebGLBuffer | null);
  });
  wrap("deleteTexture", (a) => {
    texs.delete(a[0] as WebGLTexture);
  });
  wrap("deleteBuffer", (a) => {
    bufs.delete(a[0] as WebGLBuffer);
  });
  wrap("generateMipmap", (a) => {
    if (a[0] !== TEXTURE_2D || !curTex) return;
    const t = texs.get(curTex);
    if (t) t.mip = true;
  });
  wrap("texImage2D", (a) => {
    if (a[0] !== TEXTURE_2D || a[1] !== 0 || !curTex) return;
    const ifmt = a[2] as number;
    let w: number;
    let h: number;
    if (a.length >= 9 && typeof a[3] === "number") {
      w = a[3] as number;
      h = a[4] as number;
    } else {
      const s = a[5] as { width?: number; height?: number; videoWidth?: number; videoHeight?: number };
      w = s.width ?? s.videoWidth ?? 0;
      h = s.height ?? s.videoHeight ?? 0;
    }
    const prev = texs.get(curTex);
    // 貼り直しでは、ミップマップの有無を引き継ぐ(貼り直したあと、また generateMipmap される)
    texs.set(curTex, { w, h, bpp: BPP[ifmt] ?? 4, mip: prev?.mip ?? false });
  });
  wrap("texStorage2D", (a) => {
    if (a[0] !== TEXTURE_2D || !curTex) return;
    texs.set(curTex, { w: a[3] as number, h: a[4] as number, bpp: BPP[a[2] as number] ?? 4, mip: (a[1] as number) > 1 });
  });
  wrap("bufferData", (a) => {
    const b = curBuf.get(a[0] as number);
    if (!b) return;
    const d = a[1];
    bufs.set(b, typeof d === "number" ? d : ((d as ArrayBufferView | null)?.byteLength ?? 0));
  });

  return {
    report(): GlMemoryReport {
      let tex = 0;
      const list: [string, number][] = [];
      for (const t of texs.values()) {
        const by = t.w * t.h * t.bpp * (t.mip ? 4 / 3 : 1);
        tex += by;
        list.push([`${t.w}x${t.h}x${t.bpp}${t.mip ? "m" : ""}`, by / MB]);
      }
      list.sort((p, q) => q[1] - p[1]);
      let buf = 0;
      for (const v of bufs.values()) buf += v;
      let samples = 0;
      try {
        samples = (gl.getParameter(gl.SAMPLES) as number) || 0;
      } catch {
        // 取れなければ0
      }
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      // アンチエイリアスあり: 標本ごとに色4B+奥行き4B、と、画面に出す用の色4B。なし: 色・奥行き・画面用で12B
      const perPx = samples > 1 ? samples * 8 + 4 : 12;
      const drawMB = (w * h * perPx) / MB;
      const texMB = tex / MB;
      const bufMB = buf / MB;
      return {
        texMB: Math.round(texMB),
        bufMB: Math.round(bufMB),
        drawMB: Math.round(drawMB),
        totalMB: Math.round(texMB + bufMB + drawMB),
        textureCount: texs.size,
        top: list.slice(0, 6).map(([k, v]) => `${k}=${Math.round(v)}MB`),
        drawWidth: w,
        drawHeight: h,
        samples,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// 記録(端末の中のlocalStorage)
// ---------------------------------------------------------------------------

const KEY_LIVE = "p1.viewer3d.diag.live";
const KEY_LOG = "p1.viewer3d.diag.log";
const MAX_EVENTS = 10;
const MAX_LOG = 5;

export interface DiagSettings {
  quality: string;
  wide: boolean;
  hq: boolean;
  /** 画面(canvas)の大きさ(CSS px)と、描画の倍率 */
  cssWidth: number;
  cssHeight: number;
  scale: number;
}

export interface DiagRecord {
  v: 1;
  startedAt: number;
  /** 最後に書いた時刻 */
  ts: number;
  /** 正常に閉じた(true)か、閉じる処理が走っていない(false。タブが落ちたときなど) */
  clean: boolean;
  /** 閉じた理由・中断の理由 */
  endReason: string;
  /** 最後に画面が隠れた時刻(あとで戻っていなければ、バックグラウンドで終了された可能性) */
  hiddenAt: number | null;
  settings: DiagSettings;
  gpu: string;
  maxTexture: number;
  deviceMemoryGB: number | null;
  mem: GlMemoryReport | null;
  heapMB: number | null;
  /** 描画1回にかかった時間(ms)の、最近の平均・最大 */
  renderAvgMs: number;
  renderMaxMs: number;
  /** 描画と描画の間(連続して描いているとき)の最大(ms) */
  gapMaxMs: number;
  events: string[];
  ua: string;
}

const now = (): number => Date.now();

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // 保存できない環境では、記録しない(アプリの動作には影響しない)
  }
}
function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** 3Dビューを開いている間の記録(1つだけ) */
let live: DiagRecord | null = null;
let renderTimes: number[] = [];
let lastDrawAt = 0;
let gapMax = 0;

function persist(): void {
  if (live) store(KEY_LIVE, JSON.stringify(live));
}

function jsHeapMB(): number | null {
  const m = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return m ? Math.round(m.usedJSHeapSize / MB) : null;
}

/** メインメモリを共有するGPU(内蔵GPU・スマホ・ソフトウェア描画)の名前 */
const INTEGRATED_GPU_RE = /intel|uhd|iris|radeon\(tm\) graphics|radeon graphics|apple|mali|adreno|powervr|swiftshader|llvmpipe/i;

/**
 * GPUに載せてよい量の目安(MB。画像・バッファ・描画面の合計)。これを超えそうなときは、省いてよい下地(先読みの画像)を作らない。
 * 端末のメモリ(navigator.deviceMemory。Chromeは最大8と報告)と、GPUがメインメモリを共有するか(内蔵GPU)から、控えめに決める。
 */
export function gpuBudgetMB(gl: WebGL2RenderingContext): number {
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const base = typeof dm === "number" ? (dm <= 2 ? 350 : dm <= 4 ? 600 : dm <= 6 ? 850 : 1150) : 950;
  return INTEGRATED_GPU_RE.test(gpuName(gl)) ? base : Math.round(base * 1.3);
}

function gpuName(gl: WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension("WEBGL_debug_renderer_info");
    if (ext) return String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL));
  } catch {
    // 取れなければ不明
  }
  return "不明";
}

/** 3Dビューを開いた(描画の仕組みを作った)ときに呼ぶ */
export function diagOpen(gl: WebGL2RenderingContext, settings: DiagSettings, mem: { report: () => GlMemoryReport }): void {
  const dm = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  live = {
    v: 1,
    startedAt: now(),
    ts: now(),
    clean: false,
    endReason: "",
    hiddenAt: null,
    settings,
    gpu: gpuName(gl),
    maxTexture: (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 0,
    deviceMemoryGB: typeof dm === "number" ? dm : null,
    mem: null,
    heapMB: null,
    renderAvgMs: 0,
    renderMaxMs: 0,
    gapMaxMs: 0,
    events: [],
    ua: navigator.userAgent.slice(0, 160),
  };
  renderTimes = [];
  lastDrawAt = 0;
  gapMax = 0;
  memSource = mem;
  diagNote(`開く: 処理${settings.quality}・描画範囲${settings.wide ? "拡張" : "通常"}`);
  persist();
}

let memSource: { report: () => GlMemoryReport } | null = null;

/** 設定が変わったとき(描画の大きさ・高画質の追加効果の切り替えなど) */
export function diagSettings(settings: Partial<DiagSettings>): void {
  if (!live) return;
  live.settings = { ...live.settings, ...settings };
}

/** 直前の操作を残す(「足もとの地面を読み込み」など。最近の10件) */
export function diagNote(text: string): void {
  if (!live) return;
  const t = ((now() - live.startedAt) / 1000).toFixed(0);
  live.events.push(`${t}秒 ${text}`);
  if (live.events.length > MAX_EVENTS) live.events.shift();
}

/** 1回描いたときに、描画の呼び出しにかかった時間(ms)を渡す */
export function diagRender(ms: number): void {
  if (!live) return;
  renderTimes.push(ms);
  if (renderTimes.length > 120) renderTimes.shift();
  const t = performance.now();
  if (lastDrawAt > 0 && t - lastDrawAt < 1500) gapMax = Math.max(gapMax, t - lastDrawAt);
  lastDrawAt = t;
}

/** 数秒おきに呼ぶ: メモリの見積もり・描画の重さを更新して、端末の中へ書く */
export function diagHeartbeat(): void {
  if (!live) return;
  live.ts = now();
  if (memSource) live.mem = memSource.report();
  live.heapMB = jsHeapMB();
  if (renderTimes.length > 0) {
    live.renderAvgMs = Math.round(renderTimes.reduce((s, v) => s + v, 0) / renderTimes.length);
    live.renderMaxMs = Math.round(Math.max(...renderTimes));
  }
  live.gapMaxMs = Math.round(gapMax);
  persist();
}

/** 画面が隠れた・戻ったとき(バックグラウンドで終了された場合と、落ちた場合を区別するため) */
export function diagVisibility(hidden: boolean): void {
  if (!live) return;
  live.hiddenAt = hidden ? now() : null;
  if (hidden) diagHeartbeat();
  else persist();
}

/** 正常に閉じた(3Dビューを閉じた・ページを閉じた・設定を変えて作り直した) */
export function diagClose(reason: string): void {
  if (!live) return;
  diagHeartbeat();
  live.clean = true;
  live.endReason = reason;
  persist();
  live = null;
  memSource = null;
}

/** WebGLが中断された(webglcontextlost)。記録を残して、原因の手がかりを返す */
export function diagContextLost(): { record: DiagRecord; hints: string[] } | null {
  if (!live) return null;
  diagNote("WebGLが中断された(webglcontextlost)");
  diagHeartbeat();
  const rec = { ...live, clean: true, endReason: "webglcontextlost" };
  appendLog(rec);
  persist();
  return { record: rec, hints: explainRecord(rec) };
}

function appendLog(rec: DiagRecord): void {
  let log: DiagRecord[] = [];
  try {
    const raw = load(KEY_LOG);
    if (raw) log = JSON.parse(raw) as DiagRecord[];
  } catch {
    log = [];
  }
  log.push(rec);
  while (log.length > MAX_LOG) log.shift();
  store(KEY_LOG, JSON.stringify(log));
}

let previousChecked = false;
let previous: { record: DiagRecord; hints: string[] } | null = null;

/**
 * 前回の3Dビューが「正常に閉じられないまま」終わっていたら、その記録と原因の手がかりを返す(1回だけ。以後は null)。
 * 画面を隠したまま端末に終了された場合(スマホのバックグラウンド)は、落ちたとはみなさない。
 */
export function diagPreviousCrash(): { record: DiagRecord; hints: string[] } | null {
  if (previousChecked) return previous;
  previousChecked = true;
  const raw = load(KEY_LIVE);
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as DiagRecord;
    if (rec.v !== 1 || rec.clean) return null;
    store(KEY_LIVE, null);
    // 画面が隠れた状態のまま記録が止まっていたら、バックグラウンドで終了された(落ちたのではない)
    if (rec.hiddenAt !== null) return null;
    // 開いてすぐ(3秒未満)の記録は、何も分からないので出さない
    if (rec.ts - rec.startedAt < 3000) return null;
    const hints = explainRecord(rec);
    appendLog({ ...rec, endReason: "異常終了(タブが落ちた可能性)" });
    previous = { record: rec, hints };
    return previous;
  } catch {
    store(KEY_LIVE, null);
    return null;
  }
}

/** 診断情報を文字にする(「診断情報をコピー」用) */
export function diagText(rec: DiagRecord, hints: string[]): string {
  const m = rec.mem;
  const lines = [
    `3Dビューの診断(${new Date(rec.ts).toLocaleString("ja-JP")})`,
    `設定: 処理${rec.settings.quality}・描画範囲${rec.settings.wide ? "拡張" : "通常"}・高画質の追加効果${rec.settings.hq ? "あり" : "なし"}・画面${rec.settings.cssWidth}×${rec.settings.cssHeight}・描画倍率${rec.settings.scale.toFixed(2)}`,
    `GPU: ${rec.gpu} / 画像の最大 ${rec.maxTexture}px / 端末メモリ ${rec.deviceMemoryGB ?? "不明"}GB`,
    m
      ? `GPUメモリの見積もり: 合計約${m.totalMB}MB(画像${m.texMB}MB[${m.textureCount}枚]・バッファ${m.bufMB}MB・描画面${m.drawMB}MB[${m.drawWidth}×${m.drawHeight}・標本${m.samples}])`
      : "GPUメモリの見積もり: なし",
    m ? `大きい画像: ${m.top.join(", ")}` : "",
    `JSメモリ: ${rec.heapMB ?? "不明"}MB`,
    `描画の重さ: 平均${rec.renderAvgMs}ms・最大${rec.renderMaxMs}ms(連続して描いたときの間隔の最大${rec.gapMaxMs}ms)`,
    `動いていた時間: ${Math.round((rec.ts - rec.startedAt) / 1000)}秒 / 終わり方: ${rec.endReason || "正常に閉じられていない"}`,
    `直前の操作: ${rec.events.join(" → ")}`,
    `エラーコード: ${diagCodes(rec).join(" ")}`,
    `手がかり: ${hints.join(" ")}`,
    `ブラウザ: ${rec.ua}`,
  ];
  return lines.filter(Boolean).join("\n");
}

/** 記録から、考えられる原因を日本語で挙げる(確定ではなく、手がかり) */
export function explainRecord(rec: DiagRecord): string[] {
  const hints: string[] = [];
  const m = rec.mem;
  const integrated = INTEGRATED_GPU_RE.test(rec.gpu);
  if (m) {
    if (m.totalMB >= (integrated ? 700 : 1400)) {
      hints.push(
        `GPUに載せたものが約${m.totalMB}MBと多く(画像${m.texMB}MB・描画面${m.drawMB}MB)、${integrated ? "メインメモリを共有するGPUでは" : "GPUのメモリでは"}足りなくなった可能性があります。`,
      );
    } else if (m.totalMB >= (integrated ? 450 : 900)) {
      hints.push(`GPUに載せたものが約${m.totalMB}MBで、他のタブ・アプリと合わせると足りなくなる可能性があります。`);
    }
    if (m.drawMB >= 150) hints.push(`アンチエイリアスつきの描画面が約${m.drawMB}MB(${m.drawWidth}×${m.drawHeight})あります。`);
  }
  if (rec.heapMB !== null && rec.heapMB >= 1500) hints.push(`JavaScriptのメモリが約${rec.heapMB}MBと多くなっていました。`);
  if (rec.renderMaxMs >= 1500 || rec.gapMaxMs >= 2000) {
    hints.push(
      "描画1回が約2秒以上かかったことがありました。GPUが長く止まると、端末が描画を強制的にやり直すため、3Dの描画が中断されます。「描画」の設定で水・建物・木のチェックを外すと軽くなります。",
    );
  } else if (rec.renderAvgMs >= 400) {
    hints.push(`描画が重くなっていました(1回あたり平均約${rec.renderAvgMs}ms)。`);
  }
  const last = rec.events[rec.events.length - 1] ?? "";
  if (/読み込み|作成|計算|切り替え|開く/.test(last)) hints.push(`直前の操作: ${last}`);
  if (rec.deviceMemoryGB !== null && rec.deviceMemoryGB <= 4) hints.push("端末のメモリが少ない機種です。他のアプリを閉じてから開くと安定します。");
  if (hints.length === 0) hints.push("記録からは原因を絞れませんでした(メモリ・描画の重さは大きくありませんでした)。GPUドライバーやブラウザの一時的な不具合の可能性があります。");
  return hints;
}

/**
 * 診断の記録から、短い「エラーコード」(英大文字。人に見せたり、検索したりしやすい)を作る。
 * 例: UNCLEAN_EXIT / GPU_MEM_779MB / DRAW_SURFACE_168MB_2880x1620_MSAA4 / RENDER_STALL_2400MS / Q_HIGH / WIDE / HQ_ON
 */
export function diagCodes(rec: DiagRecord): string[] {
  const codes: string[] = [];
  if (!rec.clean && !rec.endReason) codes.push("UNCLEAN_EXIT");
  else if (rec.endReason) codes.push(`END_${rec.endReason.replace(/\s+/g, "_")}`);
  const m = rec.mem;
  if (m) {
    codes.push(`GPU_MEM_${m.totalMB}MB`);
    codes.push(`TEX_${m.texMB}MB`, `BUF_${m.bufMB}MB`);
    codes.push(`DRAW_SURFACE_${m.drawMB}MB_${m.drawWidth}x${m.drawHeight}_MSAA${m.samples}`);
  }
  if (rec.renderMaxMs >= 1500 || rec.gapMaxMs >= 2000) codes.push(`RENDER_STALL_${Math.max(rec.renderMaxMs, rec.gapMaxMs)}MS`);
  if (rec.heapMB !== null && rec.heapMB >= 1500) codes.push(`JS_HEAP_${rec.heapMB}MB`);
  codes.push(`Q_${rec.settings.quality.toUpperCase()}`);
  if (rec.settings.wide) codes.push("WIDE");
  if (rec.settings.hq) codes.push("HQ_ON");
  return codes;
}

/** 例外(Error)から、エラーコード(種類)と、読める詳細(メッセージ・スタックの先頭)を取り出す */
export function describeError(e: unknown): { code: string; detail: string } {
  if (e instanceof Error) {
    const stack = (e.stack ?? "").split("\n").slice(0, 6).join("\n");
    return { code: e.name || "Error", detail: stack.includes(e.message) ? stack : `${e.name}: ${e.message}\n${stack}` };
  }
  return { code: "UNKNOWN", detail: String(e) };
}
