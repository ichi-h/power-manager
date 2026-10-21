#!/usr/bin/env node
/**
 * 起動スモークテスト。
 *
 * `npm run build` の成果物を本番と同じ手順（node --conditions=react-router）で起動し、
 * loopback で待受けて画面が HTML を返すこと、SIGTERM で正常終了することを確認する。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.SMOKE_PORT ?? 18080);
const origin = `http://127.0.0.1:${port}`;
const serverEntry = "server/index.ts";
const timeoutMilliseconds = 30_000;
/** 設定エラーを表す sysexits.h の EX_CONFIG。 */
const configurationErrorExitCode = 78;

/**
 * 起動に必要な環境変数一式。設定 JSON はこの時点ではまだ読まれないため、
 * 存在するファイルを指しておけばよい。
 */
const runtimeEnvironment = {
  NODE_ENV: "production",
  POWER_MANAGER_CONFIG_PATH:
    process.env.SMOKE_CONFIG_PATH ?? path.resolve("package.json"),
  POWER_MANAGER_PORT: String(port),
  POWER_MANAGER_PUBLIC_ORIGIN: `https://localhost:${port}`,
  POWER_MANAGER_AUTH_USERNAME: "smoke",
  POWER_MANAGER_AUTH_PASSWORD_HASH:
    "$argon2id$v=19$m=65536,t=2,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM",
  POWER_MANAGER_SSH_IDENTITY_FILE: "/dev/null",
  POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: "/dev/null",
};

if (!existsSync("build/server/index.js")) {
  console.error("build/server/index.js がありません。先に npm run build を実行してください。");
  process.exit(1);
}

const child = spawn(process.execPath, ["--conditions=react-router", serverEntry], {
  env: { ...process.env, ...runtimeEnvironment },
  stdio: ["ignore", "pipe", "pipe"],
});

let stdout = "";
let stderr = "";
child.stdout.on("data", (chunk) => {
  stdout += chunk;
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const deadline = Date.now() + timeoutMilliseconds;

async function waitForStarted() {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`サーバーが起動前に終了しました (exit ${child.exitCode})\n${stderr}`);
    }
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual" });
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
      `起動から ${survivalMilliseconds / 1000} 秒以内に終了しました (exit ${child.exitCode})\n${stderr}`,
    );
  }
}

function stopServer() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
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
 */
function checkConfigurationError() {
  return new Promise((resolve, reject) => {
    const invalid = spawn(process.execPath, ["--conditions=react-router", serverEntry], {
      env: { ...process.env, ...runtimeEnvironment, POWER_MANAGER_PORT: "not-a-port" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let invalidStderr = "";
    invalid.stderr.on("data", (chunk) => {
      invalidStderr += chunk;
    });

    const timer = setTimeout(() => {
      invalid.kill("SIGKILL");
      reject(new Error("不正な設定で起動が終了しませんでした"));
    }, 10_000);

    invalid.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== configurationErrorExitCode) {
        reject(
          new Error(`不正な設定の終了コードが ${code} でした（期待値 ${configurationErrorExitCode}）`),
        );
        return;
      }
      if (!invalidStderr.includes('"code":"invalid_configuration"')) {
        reject(new Error(`startup_failed のログに invalid_configuration が含まれていません:\n${invalidStderr}`));
        return;
      }
      resolve();
    });
  });
}

try {
  await waitForStarted();
  await checkStaysAlive();
  const { code } = await stopServer();
  if (code !== 0) {
    throw new Error(`SIGTERM 後の終了コードが 0 ではありません: ${code}\n${stderr}`);
  }
  if (!stdout.includes('"event":"started"')) {
    throw new Error(`起動ログに started が含まれていません:\n${stdout}`);
  }
  await checkConfigurationError();
  console.log("smoke: ok");
} catch (error) {
  child.kill("SIGKILL");
  console.error(`smoke: failed\n${error instanceof Error ? error.message : String(error)}`);
  if (stderr) console.error(stderr);
  process.exit(1);
}
