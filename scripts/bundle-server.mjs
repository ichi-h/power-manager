#!/usr/bin/env node
/**
 * サーバーエントリを単一ファイルへバンドルする。
 *
 * `server/index.ts` は `../app/lib/config.server.ts` など TypeScript のソースを相対 import
 * するため、ソースツリーを配置しない Nix パッケージでは `ERR_MODULE_NOT_FOUND` で起動できない。
 * ここで自前のソースだけを 1 ファイルに畳み、実行時依存を `node_modules` と `build/` に限る。
 *
 * 依存パッケージは external のまま残す（`packages: "external"`）。`argon2` はネイティブ
 * バインディングを動的に読み込み、`react-router` も実行時に `build/server/index.js` を
 * 動的 import するため、バンドルに巻き込むと解決経路が壊れる。`node_modules` は Nix の
 * 配置対象に含めてあるので external で問題ない。
 *
 * 出力先を `server/index.js` にするのは、`server/static.ts` が
 * `import.meta.url` からの相対パスで `../build/client` を解決するためである。配置後の
 * ディレクトリ構成を変えない。
 */
import { build } from "esbuild";
import { rm } from "node:fs/promises";

const outfile = "server/index.js";

// 前回の成果物を消してから作る。生成物が残っていると、失敗時に古いバンドルで起動してしまう。
await rm(outfile, { force: true });

await build({
  entryPoints: ["server/index.ts"],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  // `--conditions=react-router` で起動するため、解決条件を起動時と揃える。
  conditions: ["react-router", "node", "import"],
  packages: "external",
  legalComments: "none",
  sourcemap: false,
  logLevel: "warning",
  banner: {
    js: "// power-manager のサーバーエントリ。scripts/bundle-server.mjs が生成する。直接編集しない。",
  },
});

console.log(`${outfile} を生成しました`);
