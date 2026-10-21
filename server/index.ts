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

import { ConfigurationError, loadRuntimeConfig } from "../app/lib/config.server.ts";
import { createAppListener } from "./app.ts";
import { serveStatic } from "./static.ts";

/** 設定エラーを表す sysexits.h の EX_CONFIG。NixOS モジュールが再起動を抑止する。 */
const configurationErrorExitCode = 78;
const forcedExitMilliseconds = 5_000;

let runtime;
try {
  runtime = loadRuntimeConfig();
} catch (error) {
  if (!(error instanceof ConfigurationError)) throw error;

  // 待受を開始する前に終了する。設定不備で再起動ループへ入らないようにする（NFR-05）。
  console.error(
    JSON.stringify({
      event: "startup_failed",
      code: "invalid_configuration",
      reason: error.message,
    }),
  );
  process.exit(configurationErrorExitCode);
}

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

server.on("error", (error) => {
  console.error(
    JSON.stringify({
      event: "startup_failed",
      code: "operation_failed",
      reason: error.message,
    }),
  );
  process.exit(1);
});

const shutdownTimeout = setTimeout(() => {
  process.exit(1);
}, forcedExitMilliseconds).unref();

let shuttingDown = false;
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ event: "shutdown", signal }));

  server.close(() => {
    clearTimeout(shutdownTimeout);
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
