/**
 * HTTP サーバーのエントリポイント。
 *
 * 起動シーケンスのうち、ここでは待受とシグナル処理のみを扱う。
 * 環境変数の検証と load context の組み立ては `server/app.ts` / `app/lib/config.server.ts` が担う。
 *
 * CLI 引数は受け付けない（NFR-06）。設定は環境変数だけで渡す。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import {
  ConfigurationError,
  loadRuntimeConfig,
  type RuntimeConfig,
} from "../app/lib/config.server.ts";
import { createAppListener } from "./app.ts";
import { serveStatic } from "./static.ts";

/**
 * 設定エラーを表す sysexits.h の EX_CONFIG。NixOS モジュールの
 * `RestartPreventExitStatus` が同じ値を再起動抑止に使う（`nix/module.nix`）。
 */
const configurationErrorExitCode = 78;
const forcedExitMilliseconds = 5_000;

/** 待受アドレスの不備として扱う `error.code`。設定変更で解消できるため再起動しても無駄になる。 */
const listenAddressErrorCodes = new Set(["EADDRINUSE", "EACCES", "EINVAL"]);

/**
 * 環境変数を検証し、失敗したら待受を開始せずに終了コード 78 で終了する（NFR-05, NFR-06）。
 *
 * 検証以外の例外（実装の不具合など）は設定不備ではないため、握りつぶさずに再送出する。
 * これにより、設定不備だけが再起動抑止の対象になる。
 */
function startRuntime(): RuntimeConfig {
  try {
    return loadRuntimeConfig();
  } catch (error) {
    if (!(error instanceof ConfigurationError)) throw error;

    console.error(
      JSON.stringify({
        event: "startup_failed",
        code: "invalid_configuration",
        reason: error.message,
      }),
    );
    process.exit(configurationErrorExitCode);
  }
}

// 引数は解釈しない。設定は環境変数だけで渡す（NFR-06）。
const runtime = startRuntime();

const requestListener = createAppListener(runtime);

const server = createServer(
  (request: IncomingMessage, response: ServerResponse) => {
    serveStatic(request, response).then((handled) => {
      if (!handled) requestListener(request, response);
    }, (error: unknown) => {
      console.error(
        JSON.stringify({
          event: "request_failed",
          reason: error instanceof Error ? error.message : "unknown",
        }),
      );
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  },
);

server.listen(runtime.port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "started", port: runtime.port }));
});

/**
 * 待受の失敗を分類して終了する。
 *
 * 待受アドレスが使えない（使用中・権限なし・不正）場合は設定変更でしか解消できず、
 * `Restart=on-failure` で再起動しても同じ失敗を繰り返すため、設定不備として終了コード 78 にする
 * （NFR-05）。それ以外のソケットエラーは従来どおり終了コード 1 で再起動に委ねる。
 *
 * `server` の `error` は待受の前後にしか意味を持たない（待受成功後の接続の失敗は個々の
 * リクエストエラーになる）ため、イベント名は `startup_failed` のままでよい。
 */
server.on("error", (error: NodeJS.ErrnoException) => {
  const isListenAddressError =
    error.code !== undefined && listenAddressErrorCodes.has(error.code);

  console.error(
    JSON.stringify({
      event: "startup_failed",
      code: isListenAddressError ? "invalid_configuration" : "operation_failed",
      reason: error.message,
    }),
  );
  process.exit(isListenAddressError ? configurationErrorExitCode : 1);
});

let shuttingDown = false;

/**
 * 終了シグナルを受けてから接続の排出を待つ。`forcedExitMilliseconds` の間に閉じきれなければ
 * 強制終了する。タイマーは shutdown のたびに張り、正常終了時は必ず解除する。
 * 起動時に張ると、正常に動いているプロセスが時間経過だけで落ちるため張らない。
 */
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "shutdown", signal }));

  const forcedExitTimeout = setTimeout(() => {
    process.exit(1);
  }, forcedExitMilliseconds).unref();

  server.close(() => {
    clearTimeout(forcedExitTimeout);
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
