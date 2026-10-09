import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type Connect, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { fetchExternal } from "./server/externalProxy.mjs";
import { generateCurrentTemperature, generateKougenTenki } from "./server/kougenTenkiGenerate.mjs";

/**
 * JMA火山監視カメラ・信州大学観測所など、他の外部サイトへの汎用プロキシ。
 * `/api/ext/<source>?path=<エンコードされた上流パス>` を中継する
 * (実装は server/externalProxy.mjs に共通化。本番では api/ext/[source].js が同じ役割を担う)。
 */
function externalProxyPlugin() {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const match = req.url?.match(/^\/api\/ext\/([^/?]+)\?(.*)$/);
    if (!match) {
      next();
      return;
    }
    const source = match[1];
    const params = new URLSearchParams(match[2]);
    const path = params.get("path");
    if (!path) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: "missing path" }));
      return;
    }
    fetchExternal(source, path)
      .then(({ status, body }) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end(body);
      })
      .catch((err: unknown) => {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "failed to reach upstream", detail: String(err) }));
      });
  };

  return {
    name: "external-proxy",
    configureServer(server: { middlewares: { use: (fn: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: { middlewares: { use: (fn: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    },
  };
}

/*
 * カメラ画像の中継(`/api/img/<source>`、server/imageProxy.mjs・api/img/[source].js)は、スマホ版では廃止した
 * (2026年10月)。中継していたのは長野県・美瑛町・STV・南魚沼市・高ボッチ高原の画像で、いずれも国の機関では
 * なく再配信の許諾が確認できないため(cameraService.tsの isAllowedImageSource 参照)。
 */

/**
 * 「高原天気」気温・霧シミュレーターのライブ生成。
 * `/api/kougen-tenki-generate` で気象情報生成ボタンからの呼び出しを受け付ける
 * (実装は server/kougenTenkiGenerate.mjs に共通化。本番では api/kougen-tenki-generate.js が同じ役割を担う)。
 * DEM取得+全グリッド計算を伴うため数秒〜数十秒かかることがある(初回のみ。DEMはタイル単位で
 * キャッシュされるため2回目以降は速い)。
 */
function kougenTenkiGeneratePlugin() {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith("/api/kougen-tenki-generate")) {
      next();
      return;
    }
    generateKougenTenki()
      .then((result) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(result));
      })
      .catch((err: unknown) => {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "failed to generate", detail: String(err) }));
      });
  };

  return {
    name: "kougen-tenki-generate",
    configureServer(server: { middlewares: { use: (fn: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: { middlewares: { use: (fn: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    },
  };
}

/**
 * 「高層天気とは別に 現在の気温の推定値のみを表示するボタン」のライブ生成。
 * `/api/current-temperature-generate` で呼び出しを受け付ける(実装は
 * server/kougenTenkiGenerate.mjs の generateCurrentTemperature に共通化。本番では
 * api/current-temperature-generate.js が同じ役割を担う)。高原天気と違いOpen-Meteo予報を
 * 使わない(現在1コマのみ)ため、数十秒程度で終わる想定。
 */
function currentTemperatureGeneratePlugin() {
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!req.url?.startsWith("/api/current-temperature-generate")) {
      next();
      return;
    }
    generateCurrentTemperature()
      .then((result) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(result));
      })
      .catch((err: unknown) => {
        res.statusCode = 502;
        res.end(JSON.stringify({ error: "failed to generate", detail: String(err) }));
      });
  };

  return {
    name: "current-temperature-generate",
    configureServer(server: { middlewares: { use: (fn: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server: { middlewares: { use: (fn: Connect.NextHandleFunction) => void } }) {
      server.middlewares.use(middleware);
    },
  };
}

/**
 * 「自分用では実装して 発表用では 廃止することはできますか」への対応
 * (`src/lib/platform.ts`の`isSatelliteForecastEnabled`参照)。
 *
 * `VITE_ENABLE_SATELLITE_FORECAST=true`を設定した状態のまま`npm run build`(本番ビルド)
 * してしまうと、公開用のはずのビルドに衛星画像予測(気象業務法上リスクのある機能)が
 * 紛れ込んでしまう。うっかりそのまま配布・公開しないよう、本番ビルド時にこのフラグが
 * 立っていたら目立つ警告を出す(devサーバーでは画面に表示自体がされて分かるため警告不要)。
 */
function satelliteForecastBuildWarningPlugin(mode: string) {
  return {
    name: "satellite-forecast-build-warning",
    buildStart() {
      if (mode !== "production") return;
      const env = loadEnv(mode, process.cwd(), "");
      if (env.VITE_ENABLE_SATELLITE_FORECAST === "true") {
        console.warn(
          "\n⚠️⚠️⚠️ VITE_ENABLE_SATELLITE_FORECAST=true のままです。\n" +
            "衛星画像予測(気象業務法の予報業務許可が必要になり得る機能)が有効なビルドです。\n" +
            "自分用のビルドでなければ(Play Store提出・公開URLへのデプロイ等).env.localを\n" +
            "削除するかfalseにしてから作り直してください。\n",
        );
      }
    },
  };
}

/**
 * 「法令適合と著作権などの抵触の確認」への対応。アプリに組み込まれるオープンソースの
 * ライセンス表示(MIT・BSD・ISC・Hippocratic等は「著作権表示と許諾文を、ソフトウェアの複製に
 * 含める」ことが条件)を、ビルドのたびに自動で `dist/third-party-licenses.txt` にまとめる。
 * 圧縮後のJSからはライセンスのコメントが消えるため、この別ファイルとアプリ内の
 * 「出典・ライセンス」画面(CreditsSheet.tsx)で表示する。
 *
 * 実際にバンドルされたモジュール(node_modules配下)だけを数えるので、使っていない依存
 * (package.jsonに残っているだけのもの)は載らない。node_modules以外から取り込んだもの
 * (Lucideのアイコンの形、天の川の形の元データ)と、JSバンドルに入らないもの(Service Workerの
 * Workbox、Android版のネイティブ部分)は下の EXTRA_NOTICES で足す。
 */
const LICENSE_FILE_RE = /^([a-z0-9]+[-_])?(licen[cs]e|copying|notice)(\.|-|$)/i;

interface LicenseEntry {
  name: string;
  version: string;
  license: string;
  texts: string[];
}

function readPackageLicense(dir: string, name: string): LicenseEntry | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  let pkg: { name?: string; version?: string; license?: unknown; licenses?: unknown; main?: string; module?: string };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const license =
    typeof pkg.license === "string"
      ? pkg.license
      : Array.isArray(pkg.licenses)
        ? pkg.licenses.map((l: { type?: string }) => l?.type ?? "").filter(Boolean).join(" OR ")
        : "(不明)";
  const texts: string[] = [];
  for (const f of readdirSync(dir).sort()) {
    if (!LICENSE_FILE_RE.test(f)) continue;
    try {
      texts.push(readFileSync(join(dir, f), "utf8").trim());
    } catch {
      // 読めないファイルは飛ばす
    }
  }
  // LICENSEファイルを同梱していないパッケージ(astronomy-engine等)は、本体ファイル先頭の
  // ライセンスのコメント(/** @preserve ... */ や /*! ... */)を使う
  if (texts.length === 0) {
    for (const f of [pkg.main, pkg.module]) {
      if (!f) continue;
      const fp = join(dir, f);
      if (!existsSync(fp)) continue;
      try {
        const head = readFileSync(fp, "utf8").slice(0, 8000);
        const m = /^\s*\/\*[*!]?([\s\S]*?)\*\//.exec(head);
        if (m && /licen[cs]e/i.test(m[1]) && /copyright/i.test(m[1])) {
          texts.push(
            m[1]
              .split("\n")
              .map((l) => l.replace(/^\s*\*?\s?/, "").trimEnd())
              .filter((l) => !/^@preserve$/.test(l.trim()))
              .join("\n")
              .trim(),
          );
          break;
        }
      } catch {
        // 読めなければ飛ばす
      }
    }
  }
  return { name: pkg.name ?? name, version: pkg.version ?? "", license, texts };
}

/** 依存のLICENSEファイルを持たないもの・node_modules以外から入っているもの */
const EXTRA_NOTICES: { title: string; body: string }[] = [
  {
    title: "Lucide (アイコンの形。src/lib/lucide.tsx に必要なものだけ写して使用) — ISC License",
    body:
      "ISC License\n\nCopyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT). " +
      "All other copyright (c) for Lucide are held by Lucide Contributors 2022.\n\n" +
      "Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted, " +
      "provided that the above copyright notice and this permission notice appear in all copies.\n\n" +
      'THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH REGARD TO THIS SOFTWARE INCLUDING ALL ' +
      "IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT, " +
      "INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN " +
      "AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR " +
      "PERFORMANCE OF THIS SOFTWARE.\n\n" +
      "The MIT License (MIT) (for portions derived from Feather)\n\nCopyright (c) 2013-2022 Cole Bemis\n\n" +
      "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated " +
      'documentation files (the "Software"), to deal in the Software without restriction, including without limitation the ' +
      "rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit " +
      "persons to whom the Software is furnished to do so, subject to the following conditions:\n\n" +
      "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the " +
      "Software.\n\n" +
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE ' +
      "WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR " +
      "COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR " +
      "OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
  },
  {
    title:
      "天の川の形(public/data/milkyway_gal.png): Milky Way Outline Catalog (Jose R. Vieira) を d3-celestial の data/mw.json 経由で使用し、明るさの地図に加工 — BSD 3-Clause License",
    body:
      "Copyright (c) 2015, Olaf Frohn\nAll rights reserved.\n\n" +
      "Redistribution and use in source and binary forms, with or without modification, are permitted provided that the " +
      "following conditions are met:\n\n" +
      "1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following " +
      "disclaimer.\n\n" +
      "2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following " +
      "disclaimer in the documentation and/or other materials provided with the distribution.\n\n" +
      "3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote " +
      "products derived from this software without specific prior written permission.\n\n" +
      'THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, ' +
      "INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE " +
      "DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, " +
      "SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR " +
      "SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, " +
      "WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE " +
      "OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.",
  },
];

/** Service Worker(sw.js・workbox-*.js)と、Android版のネイティブ部分。JSバンドルの集計に出てこないもの */
const EXTRA_PACKAGES: { name: string; license: string; textFrom: string }[] = [
  { name: "Workbox(Service Worker。sw.js・workbox-*.js)", license: "MIT", textFrom: "workbox-window" },
  { name: "Capacitor Android(Android版)", license: "MIT", textFrom: "@capacitor/core" },
  {
    name: "AndroidX(appcompat・coordinatorlayout・core-splashscreen・car.app ほか)・Kotlin標準ライブラリ・kotlinx.coroutines(Android版)",
    license: "Apache-2.0",
    textFrom: "typescript", // node_modules/typescript/LICENSE.txt は Apache License 2.0 の全文
  },
];

function thirdPartyLicensesPlugin(): Plugin {
  return {
    name: "third-party-licenses",
    apply: "build",
    generateBundle(_options, bundle) {
      const nm = "/node_modules/";
      const dirs = new Map<string, string>(); // パッケージ名 → ディレクトリ
      for (const item of Object.values(bundle)) {
        if (item.type !== "chunk") continue;
        const ids = (item as { moduleIds?: string[] }).moduleIds ?? Object.keys(item.modules);
        for (const raw of ids) {
          const id = raw.replace(/\\/g, "/").replace(/^\0/, "").split("?")[0];
          const i = id.lastIndexOf(nm);
          if (i < 0) continue;
          const parts = id.slice(i + nm.length).split("/");
          const name = parts[0].startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
          if (!dirs.has(name)) dirs.set(name, id.slice(0, i + nm.length) + name);
        }
      }
      const entries = [...dirs.entries()]
        .map(([name, dir]) => readPackageLicense(dir, name))
        .filter((e): e is LicenseEntry => e !== null)
        .sort((a, b) => a.name.localeCompare(b.name));

      const out: string[] = [];
      out.push("このアプリが使っているオープンソースソフトウェアと、そのライセンス");
      out.push("(ビルド時に自動で作成。データの出典はアプリの「出典・ライセンス」画面を参照)");
      out.push("");
      out.push("== 一覧 ==");
      for (const e of entries) out.push(`- ${e.name} ${e.version}: ${e.license}`);
      for (const x of EXTRA_PACKAGES) out.push(`- ${x.name}: ${x.license}`);
      for (const x of EXTRA_NOTICES) out.push(`- ${x.title}`);
      out.push("");
      for (const e of entries) {
        out.push("=".repeat(72));
        out.push(`${e.name} ${e.version} — ${e.license}`);
        out.push("=".repeat(72));
        out.push(e.texts.length > 0 ? e.texts.join("\n\n") : `(ライセンスファイルなし。package.json の表記: ${e.license})`);
        out.push("");
      }
      for (const x of EXTRA_PACKAGES) {
        const dir = join(process.cwd(), "node_modules", x.textFrom);
        const e = existsSync(dir) ? readPackageLicense(dir, x.textFrom) : null;
        out.push("=".repeat(72));
        out.push(`${x.name} — ${x.license}`);
        out.push("=".repeat(72));
        out.push(e && e.texts.length > 0 ? e.texts.join("\n\n") : `(${x.license})`);
        out.push("");
      }
      for (const x of EXTRA_NOTICES) {
        out.push("=".repeat(72));
        out.push(x.title);
        out.push("=".repeat(72));
        out.push(x.body);
        out.push("");
      }
      this.emitFile({ type: "asset", fileName: "third-party-licenses.txt", source: out.join("\n") });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => ({
  plugins: [
    externalProxyPlugin(),
    kougenTenkiGeneratePlugin(),
    currentTemperatureGeneratePlugin(),
    satelliteForecastBuildWarningPlugin(mode),
    thirdPartyLicensesPlugin(),
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // 自前で src/registerSW.ts から virtual:pwa-register を呼び、更新検知時に
      // 即座にリロードさせる(下記の理由により、既定の自動注入スクリプトでは不十分なため)。
      injectRegister: false,
      includeAssets: [
        "favicon.svg",
        "icons/icon.svg",
        "icons/icon-maskable.svg",
        "icons/icon-192.png",
        "icons/icon-512.png",
        "icons/icon-maskable-512.png",
        "icons/apple-touch-icon.png",
      ],
      manifest: {
        name: "ライブカメラ & 天の川マップ",
        short_name: "SkyCamMap",
        description:
          "各地のライブカメラと降水ナウキャストを地図に集約し、地点ごとの日の出没・天文薄明・天の川観測可能時間を確認できるアプリ",
        lang: "ja",
        theme_color: "#0b1220",
        background_color: "#0b1220",
        display: "standalone",
        start_url: ".",
        icons: [
          // PNGを先に並べる(AndroidのChromeは、ホーム画面に追加するときSVGではなくPNGのアイコンを確実に使える)
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          { src: "icons/icon.svg", sizes: "512x512", type: "image/svg+xml", purpose: "any" },
          {
            src: "icons/icon-maskable.svg",
            sizes: "512x512",
            type: "image/svg+xml",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // JMAの降水タイル/YouTube埋め込みなど外部リソースはService Workerでキャッシュせず、
        // アプリ本体(shell)のみオフライン起動できるようにする。cameras.json も対象外にし、
        // 更新したときにService Workerの再ビルドなしで反映されるようにする。
        globPatterns: ["**/*.{js,css,html,svg,png,ico}"],
        // 「衛星画像の画質を上げる」機能(AI超解像、TensorFlow.js込みでgzip後約280KB)は
        // src/lib/satelliteEnhanceTileLayer.ts側で動的import()して使うときだけ読み込む
        // ようコード分割している。ここで事前キャッシュ対象から除外しないと、Service Workerが
        // インストール時に全ユーザーの端末へこのチャンクを強制的に取得してしまい、
        // 「使うときだけ読み込む」という意図が無駄になる(実測でこのチャンクだけで約1.1MB)。
        // モデルの重み(public/models/配下の.json/.bin)はglobPatternsの対象拡張子に
        // 含まれていないため、そちらは元々事前キャッシュされない。
        globIgnores: ["**/satelliteAiUpscale-*.js"],
      },
    }),
  ],
}));
