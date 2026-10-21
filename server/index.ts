/**
 * HTTP サーバーのエントリポイント。
 *
 * 起動シーケンスのうち、ここでは待受とシグナル処理のみを扱う。
 * 環境変数と管理対象 JSON の検証は `server/startup.ts`、load context の組み立ては
 * `server/app.ts` が担う。
 *
 * CLI 引数は受け付けない（NFR-06）。設定は環境変数だけで渡す。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { configurationErrorExitCode } from "../app/lib/exit-codes.ts";
import { createAppListener } from "./app.ts";
import { logRequestFailure } from "./log.ts";
import { serveStatic } from "./static.ts";
import { startRuntime, writeStderrLine } from "./startup.ts";

const forcedExitMilliseconds = 5_000;

/** 待受アドレスの不備として扱う `error.code`。設定変更で解消できるため再起動しても無駄になる。 */
const listenAddressErrorCodes = new Set(["EADDRINUSE", "EACCES", "EINVAL"]);

// 引数は解釈しない。設定は環境変数だけで渡す（NFR-06）。
//
// `startRuntime` は設定不備なら終了コード 78 で終了したうえで例外を投げる（テストで
// `process.exit` を差し替えられるようにするため）。待受を始めないことを保証するため、
// ここで受け止めて以降の処理へ進まない。

let startup;
try {
  startup = await startRuntime();
} catch {
  // 設定不備は `startRuntime` が `startup_failed` を出力済み。追加の出力はしない。
  process.exit(configurationErrorExitCode);
}

const { runtime, configStore } = startup;

const requestListener = createAppListener(runtime, configStore);

const server = createServer(
  (request: IncomingMessage, response: ServerResponse) => {
    serveStatic(request, response).then((handled) => {
      if (!handled) requestListener(request, response);
    }, (error: unknown) => {
      logRequestFailure(error);
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

  writeStderrLine(
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
