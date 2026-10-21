#!/usr/bin/env node
/**
 * 起動スモークテスト。
 *
 * `npm run build` の成果物（バンドル済みの `server/index.js`）を本番と同じ手順で起動し、
 * loopback で待受けて画面が HTML を返すこと、SIGTERM で正常終了することを確認する。
 * 不正な環境変数では待受を開始せず、設定不備を表す終了コードで終了することも見る。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { configurationErrorExitCode } from "../app/lib/exit-codes.ts";

const serverEntry = "server/index.js";
const timeoutMilliseconds = 30_000;
/** 不正な設定の子プロセスを待つ上限。待受を開始しないので、長く待つ意味がない。 */
const invalidExitMilliseconds = 5_000;
/** 既存の設定 JSON を指しておけばよい（この時点ではまだ読まれない）。 */
const existingFile = process.env.SMOKE_CONFIG_PATH ?? path.resolve("package.json");

for (const artifact of ["build/server/index.js", serverEntry]) {
  if (!existsSync(artifact)) {
    console.error(`${artifact} がありません。先に npm run build を実行してください。`);
    process.exit(1);
  }
}

/**
 * 空いているポートを動的に確保する。
 *
 * 固定ポートだと、開発機で別のプロセスが使っているだけで失敗する。確保したポートを
 * 閉じてから子プロセスに渡すまでに奪われる可能性は残るが、固定より確実に衝突しない。
 */
async function reserveFreePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise((resolve) => probe.close(resolve));
  if (port === 0) throw new Error("空きポートを確保できませんでした");
  return port;
}

const port = process.env.SMOKE_PORT ? Number(process.env.SMOKE_PORT) : await reserveFreePort();
const host = `localhost:${port}`;

/**
 * 起動に必要な環境変数一式。
 *
 * 秘密鍵と `known_hosts` は「存在する通常ファイル」を指す。`/dev/null` は通常ファイル
 * ではないため、将来パスの種別を見る検証を足したときに理由も分からず落ちる。
 * `POWER_MANAGER_PUBLIC_ORIGIN` のホストは実際に叩く URL と揃える（本番では TLS を
 * リバースプロキシで終端するので、アプリ自身への要求は HTTP になる）。
 */
const runtimeEnvironment = {
  NODE_ENV: "production",
  POWER_MANAGER_CONFIG_PATH: existingFile,
  POWER_MANAGER_PORT: String(port),
  POWER_MANAGER_PUBLIC_ORIGIN: `https://${host}`,
  POWER_MANAGER_AUTH_USERNAME: "smoke",
  POWER_MANAGER_AUTH_PASSWORD_HASH:
    "$argon2id$v=19$m=65536,t=2,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM",
  POWER_MANAGER_SSH_IDENTITY_FILE: existingFile,
  POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: existingFile,
};

/**
 * 子プロセスへ渡す環境変数。
 *
 * `process.env` を丸ごと渡すと、開発機の `POWER_MANAGER_*` が意図せず混ざる。
 * 必要なキーだけを明示する（`PATH` は `ssh` の解決に使う）。
 */
function childEnvironment(overrides = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    ...runtimeEnvironment,
    ...overrides,
  };
}

/** 子プロセスの標準出力・標準エラーを溜める。 */
function capture(child) {
  const captured = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    captured.stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    captured.stderr += chunk;
  });
  return captured;
}

const child = spawn(process.execPath, [serverEntry], {
  env: childEnvironment(),
  stdio: ["ignore", "pipe", "pipe"],
});
const captured = capture(child);

/** 起動していない子プロセスを確実に落とす。二重に呼んでも害はない。 */
function killQuietly(target) {
  if (target.exitCode === null && target.signalCode === null) target.kill("SIGKILL");
}

const deadline = Date.now() + timeoutMilliseconds;

async function waitForStarted() {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`サーバーが起動前に終了しました (exit ${child.exitCode})\n${captured.stderr}`);
    }
    try {
      const response = await fetch(`http://${host}/`, { redirect: "manual" });
      const body = await response.text();
      if (response.status !== 200) throw new Error(`GET / が ${response.status} を返しました`);
      if (!response.headers.get("content-type")?.includes("text/html")) {
        throw new Error("GET / が HTML を返しませんでした");
      }
      if (!body.includes("power-manager")) {
        throw new Error("GET / の HTML にアプリケーションの内容が含まれていません");
      }
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(200);
    }
  }
  throw new Error("起動待ちがタイムアウトしました");
}

/**
 * 起動直後に shutdown 用のタイマーが張られていないことを確認する。
 * 起動時に無条件で強制終了タイマーを張ると、正常起動したプロセスが 5 秒後に落ちる。
 */
async function checkStaysAlive() {
  const survivalMilliseconds = 6_000;
  await delay(survivalMilliseconds);
  if (child.exitCode !== null) {
    throw new Error(
      `起動から ${survivalMilliseconds / 1000} 秒以内に終了しました (exit ${child.exitCode})\n${captured.stderr}`,
    );
  }
}

function stopServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      killQuietly(child);
      reject(new Error("SIGTERM 後 10 秒以内に終了しませんでした"));
    }, 10_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
    child.kill("SIGTERM");
  });
}

/**
 * 不正な環境変数では待受を開始せず、終了コード 78 で終了することを確認する（NFR-05, NFR-06）。
 *
 * `spawn` 自体の失敗と、終了しないまま待ち続ける場合の両方で子プロセスを落とす。
 */
function checkConfigurationError() {
  return new Promise((resolve, reject) => {
    const invalid = spawn(process.execPath, [serverEntry], {
      env: childEnvironment({ POWER_MANAGER_PORT: "not-a-port" }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const invalidCaptured = capture(invalid);

    const timer = setTimeout(() => {
      killQuietly(invalid);
      reject(new Error("不正な設定で起動が終了しませんでした"));
    }, invalidExitMilliseconds);

    const finish = (error) => {
      clearTimeout(timer);
      killQuietly(invalid);
      if (error) reject(error);
      else resolve();
    };

    invalid.once("error", (error) => finish(error));
    invalid.once("exit", (code) => {
      if (code !== configurationErrorExitCode) {
        finish(
          new Error(`不正な設定の終了コードが ${code} でした（期待値 ${configurationErrorExitCode}）`),
        );
        return;
      }
      if (!invalidCaptured.stderr.includes('"code":"invalid_configuration"')) {
        finish(
          new Error(
            `startup_failed のログに invalid_configuration が含まれていません:\n${invalidCaptured.stderr}`,
          ),
        );
        return;
      }
      finish();
    });
  });
}

try {
  await waitForStarted();
  await checkStaysAlive();
  const { code } = await stopServer();
  if (code !== 0) {
    throw new Error(`SIGTERM 後の終了コードが 0 ではありません: ${code}\n${captured.stderr}`);
  }
  if (!captured.stdout.includes('"event":"started"')) {
    throw new Error(`起動ログに started が含まれていません:\n${captured.stdout}`);
  }
  await checkConfigurationError();
  console.log("smoke: ok");
} catch (error) {
  console.error(`smoke: failed\n${error instanceof Error ? error.message : String(error)}`);
  if (captured.stderr) console.error(captured.stderr);
  process.exitCode = 1;
} finally {
  killQuietly(child);
}
