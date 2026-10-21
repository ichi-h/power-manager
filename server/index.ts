/**
 * HTTP サーバーのエントリポイント。
 *
 * 起動シーケンスのうち、ここでは待受とシグナル処理のみを扱う。
 * 環境変数・設定 JSON の検証と load context の組み立ては `server/app.ts` が担う。
 */
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

import { createAppListener, loadRuntimeConfig } from "./app.ts";
import { serveStatic } from "./static.ts";

const configurationErrorExitCode = 78;
const forcedExitMilliseconds = 5_000;

let runtime;
try {
  runtime = loadRuntimeConfig();
} catch (error) {
  console.error(
    JSON.stringify({
      event: "startup_failed",
      code: "invalid_configuration",
      reason: error instanceof Error ? error.message : "unknown",
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
