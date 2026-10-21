#!/usr/bin/env node
/**
 * 起動スモークテスト。
 *
 * `npm run build` の成果物を本番と同じ手順（node --conditions=react-router）で起動し、
 * loopback で待受けて画面が HTML を返すこと、SIGTERM で正常終了することを確認する。
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.SMOKE_PORT ?? 18080);
const origin = `http://127.0.0.1:${port}`;
const serverEntry = "server/index.ts";
const timeoutMilliseconds = 30_000;

if (!existsSync("build/server/index.js")) {
  console.error("build/server/index.js がありません。先に npm run build を実行してください。");
  process.exit(1);
}

const child = spawn(process.execPath, ["--conditions=react-router", serverEntry], {
  env: {
    ...process.env,
    NODE_ENV: "production",
    POWER_MANAGER_PORT: String(port),
  },
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

try {
  await waitForStarted();
  const { code } = await stopServer();
  if (code !== 0) {
    throw new Error(`SIGTERM 後の終了コードが 0 ではありません: ${code}\n${stderr}`);
  }
  if (!stdout.includes('"event":"started"')) {
    throw new Error(`起動ログに started が含まれていません:\n${stdout}`);
  }
  console.log("smoke: ok");
} catch (error) {
  child.kill("SIGKILL");
  console.error(`smoke: failed\n${error instanceof Error ? error.message : String(error)}`);
  if (stderr) console.error(stderr);
  process.exit(1);
}
