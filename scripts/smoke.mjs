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
/**
 * スモークテスト用の Basic 認証情報（SEC-01）。
 * `runtimeEnvironment.POWER_MANAGER_AUTH_PASSWORD_HASH` の平文。
 * 本番の資匿情報とは無関係の、テスト専用の値である。
 */
const smokeUsername = "smoke";
const smokePassword = "smoke-password";
/**
 * 既存のファイルを指せばよい環境変数（秘密鍵・`known_hosts`）の代用。
 * これらは起動時にパスの形式だけを見る。
 */
const existingFile = process.env.SMOKE_CONFIG_PATH ?? path.resolve("package.json");

/**
 * 管理対象 JSON。起動時に読み、全体検証する（FR-08, FR-09）。
 * リポジトリ同梱の開発用の例を使う。`package.json` を指すと JSON 検証で終了コード 78 になる。
 */
const managedConfigPath = process.env.SMOKE_MANAGED_CONFIG ?? path.resolve("dev/config.json");

for (const artifact of ["build/server/index.js", serverEntry]) {
  if (!existsSync(artifact)) {
    console.error(`${artifact} がありません。先に npm run build を実行してください。`);
    process.exit(1);
  }
}

if (!existsSync(managedConfigPath)) {
  console.error(`${managedConfigPath} がありません。開発用の設定例を用意してください。`);
  process.exit(1);
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
  POWER_MANAGER_CONFIG_PATH: managedConfigPath,
  POWER_MANAGER_PORT: String(port),
  POWER_MANAGER_PUBLIC_ORIGIN: `https://${host}`,
  POWER_MANAGER_AUTH_USERNAME: smokeUsername,
  // 平文: smoke-password（スモークテスト専用値。上の smokePassword 参照）
  POWER_MANAGER_AUTH_PASSWORD_HASH:
    "$argon2id$v=19$m=19456,p=1,t=2$JlZNKAM26Uz/G7BAI3Jzjw$JCl5X7Ttck+HDOKLF/95sbAOWVJ9AbLJS5Xf2txJAlc",
  POWER_MANAGER_SSH_IDENTITY_FILE: existingFile,
  POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: existingFile,
};

/** Basic 認証ヘッダーの値（SEC-01）。`Authorization: Basic <base64(username:password)>`。 */
const smokeAuthorization = `Basic ${btoa(`${smokeUsername}:${smokePassword}`)}`;

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

/**
 * 待受が始まったことをログで確認する。
 * HTTP の応答を待つだけだと、ルートが壊れて 500 を返し続けた場合に
 * 「起動していない」のか「起動しているが応答が壊れている」のか分からない。
 */
async function waitForStartedLog() {
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`サーバーが起動前に終了しました (exit ${child.exitCode})\n${captured.stderr}`);
    }
    if (captured.stdout.includes('"event":"started"')) return;
    await delay(100);
  }
  throw new Error(`起動ログ (started) が出力されませんでした\n${captured.stderr}`);
}

async function waitForStarted() {
  await waitForStartedLog();

  let lastFailure = null;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`サーバーが起動前に終了しました (exit ${child.exitCode})\n${captured.stderr}`);
    }
    try {
      // 認証なしの要求は 401（SEC-01）。
      const unauthenticated = await fetch(`http://${host}/`, { redirect: "manual" });
      await unauthenticated.body?.cancel();
      if (unauthenticated.status !== 401) {
        throw new Error(`認証なしの GET / が ${unauthenticated.status} を返しました`);
      }
      const challenge = unauthenticated.headers.get("www-authenticate");
      if (challenge !== 'Basic realm="power-manager"') {
        throw new Error(`WWW-Authenticate が不正でした: ${challenge}`);
      }
      // 誤った資格情報は 401（SEC-01）。常に通過する退化を検出する Canary。
      const wrongCredentials = btoa(`${smokeUsername}:wrong-password`);
      const wrongPassword = await fetch(`http://${host}/`, {
        redirect: "manual",
        headers: { authorization: `Basic ${wrongCredentials}` },
      });
      await wrongPassword.body?.cancel();
      if (wrongPassword.status !== 401) {
        throw new Error(`誤ったパスワードの GET / が ${wrongPassword.status} を返しました`);
      }
      // Origin 不一致の POST は拒否される（SEC-03）。CSRF 検証の退化を検出する Canary。
      // 多重防御の第 1 段（React Router 内蔵の `allowedActionOrigins`）が先に動いて
      // 400 を返すため、第 2 段の csrf ミドルウェア（403）には通常到達しない。
      // どちらの段で拒否されても Canary としては成立する。
      const crossOrigin = await fetch(`http://${host}/`, {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: smokeAuthorization,
          "content-type": "text/plain",
          origin: "https://evil.example.ts.net",
        },
      });
      await crossOrigin.body?.cancel();
      if (crossOrigin.status !== 403 && crossOrigin.status !== 400) {
        throw new Error(`Origin 不一致の POST / が ${crossOrigin.status} を返しました`);
      }
      // `/healthz` は認証免除の死活監視（SEC-10）。
      const healthz = await fetch(`http://${host}/healthz`, { redirect: "manual" });
      const healthzBody = await healthz.text();
      if (healthz.status !== 200 || healthzBody !== "ok") {
        throw new Error(`GET /healthz が ${healthz.status} (${healthzBody}) を返しました`);
      }
      const response = await fetch(`http://${host}/`, {
        redirect: "manual",
        headers: { authorization: smokeAuthorization },
      });
      const body = await response.text();
      if (response.status !== 200) throw new Error(`GET / が ${response.status} を返しました`);
      if (!response.headers.get("content-type")?.includes("text/html")) {
        throw new Error("GET / が HTML を返しませんでした");
      }
      if (!body.includes("power-manager")) {
        throw new Error("GET / の HTML にアプリケーションの内容が含まれていません");
      }
      // エラー画面ではなくルートの出力が返っていること。`/` の loader は実行時設定を
      // `context.get` で読むため、キーが別実体になっていればここで 500 になる（r1a2 の再発防止）。
      if (!body.includes("画面を準備中です。")) {
        throw new Error("GET / がルートの出力ではなくエラー画面を返しました");
      }
      if (body.includes("処理を完了できませんでした")) {
        throw new Error("GET / がエラーバウンダリの画面を返しました");
      }
      return;
    } catch (error) {
      lastFailure = error;
      if (Date.now() >= deadline) break;
      await delay(200);
    }
  }

  const detail = lastFailure instanceof Error ? lastFailure.message : String(lastFailure);
  throw new Error(`待受後の最初の応答が不正でした: ${detail}\n${captured.stderr}`);
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
 * ポートだけは有効な値を渡す。ポート自体が不正だと「待受を始めない」ことが、検証で弾かれた
 * 結果なのかポート番号が読めなかった結果なのか区別できない。終了後にそのポートへ接続して
 * 拒否されることまで見れば、待受を始めていないことが観測できる。
 *
 * `spawn` 自体の失敗と、終了しないまま待ち続ける場合の両方で子プロセスを落とす。
 */
async function checkConfigurationError() {
  const unusedPort = await reserveFreePort();
  const unusedHost = `127.0.0.1:${unusedPort}`;

  return new Promise((resolve, reject) => {
    const invalid = spawn(process.execPath, [serverEntry], {
      // ポートは有効なまま、ユーザー名だけを空にして検証で止める。
      env: childEnvironment({
        POWER_MANAGER_PORT: String(unusedPort),
        POWER_MANAGER_AUTH_USERNAME: "",
      }),
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
      void (async () => {
        if (code !== configurationErrorExitCode) {
          throw new Error(
            `不正な設定の終了コードが ${code} でした（期待値 ${configurationErrorExitCode}）`,
          );
        }
        if (!invalidCaptured.stderr.includes('"code":"invalid_configuration"')) {
          throw new Error(
            `startup_failed のログに invalid_configuration が含まれていません:\n${invalidCaptured.stderr}`,
          );
        }
        // 設定不備では待受を開始しない。started のログも出ない。
        if (invalidCaptured.stdout.includes('"event":"started"')) {
          throw new Error(`不正な設定なのに started を出力しました:\n${invalidCaptured.stdout}`);
        }
        try {
          await fetch(`http://${unusedHost}/`);
        } catch {
          // 接続を拒否された = 待受を開始していない。
          return;
        }
        throw new Error(`不正な設定で終了したのに ${unusedHost} が接続を受け付けました`);
      })().then(finish, (error) => finish(error));
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
