/**
 * Basic 認証と CSRF のミドルウェアの検証（`app/lib/auth.server.ts`、`app/lib/csrf.server.ts`）。
 *
 * `createRoutesStub` はミドルウェアを実行しないため、ミドルウェア関数を直接呼んで
 * `RouterContextProvider` への設定までを確認する（docs/operations.md の検証対象「認証」「CSRF」）。
 */
import { hash } from "argon2";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { RouterContextProvider } from "react-router";

import {
  authMiddleware,
  authenticate,
  authContext,
  __resetRuntimeConfigCache,
} from "../app/lib/auth.server.ts";
import {
  csrfMiddleware,
  isOriginAllowed,
  __resetPublicOriginCache,
} from "../app/lib/csrf.server.ts";
import { loadRuntimeConfig } from "../app/lib/config.server.ts";
import { validEnvironment } from "./support/environment.ts";

/**
 * `argon2.verify` の spy。ファイル全体で本物へ委譲し、呼び出しの記録だけを取る。
 * ESM の名前空間は `vi.spyOn` できないため `vi.mock` で包む。
 */
const verifyMock = vi.hoisted(() => vi.fn());
vi.mock("argon2", async (importOriginal) => ({
  ...(await importOriginal<typeof import("argon2")>()),
  verify: (...args: Parameters<typeof verifyMock>) => verifyMock(...args),
}));

/** 平文パスワードに対応するハッシュ（`plaintextPassword` の Argon2id 値）。テスト専用。 */
const plaintextPassword = "password";
const plaintextHash =
  "$argon2id$v=19$m=19456,p=1,t=2$Pa2tGYgA9t0lDF2yo9F9cw$H4haHuRgnqflGIUzQnZ+X1kdPEDYUs7HaUG+lUW1WfA";

function request(path: string, init: RequestInit = {}) {
  return new Request(`https://power.example.ts.net${path}`, {
    ...init,
    headers: { "content-type": "text/plain", ...init.headers },
  });
}

/** `next()` が呼ばれたことを記録する替え玉。 */
function stubNext() {
  return vi.fn().mockResolvedValue(undefined);
}

/** ミドルウェア引数の最小構成。ミドルウェアは `request` と `context` だけを使う。 */
function middlewareArgs(requestObject: Request, context = new RouterContextProvider()) {
  return { request: requestObject, context } as unknown as Parameters<
    typeof authMiddleware
  >[0];
}

beforeEach(async () => {
  vi.unstubAllEnvs();
  const actual = await vi.importActual<typeof import("argon2")>("argon2");
  verifyMock.mockImplementation((hashValue, password) => actual.verify(hashValue, password));
  verifyMock.mockClear();
  // モジュールスコープの cache を消す。`vi.unstubAllEnvs()` は cache を消さないため、
  // これを忘れると最初に評価した env の値へ固定される（98d8）。
  __resetRuntimeConfigCache();
  __resetPublicOriginCache();
});

describe("authenticate", () => {
  test("正しい Basic 認証ならユーザー名を返す", async () => {
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = plaintextHash;
    const runtime = loadRuntimeConfig(env);
    const credentials = btoa(`admin:${plaintextPassword}`);
    const result = await authenticate(
      request("/", { headers: { authorization: `Basic ${credentials}` } }),
      runtime,
    );
    expect(result).toBe("admin");
  });

  test("Authorization ヘッダーなしは 401 と WWW-Authenticate", async () => {
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = plaintextHash;
    const runtime = loadRuntimeConfig(env);
    const result = await authenticate(request("/"), runtime);
    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('Basic realm="power-manager"');
  });

  test("誤ったパスワードは 401", async () => {
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = plaintextHash;
    const runtime = loadRuntimeConfig(env);
    const wrong = btoa("admin:wrong-password");
    const result = await authenticate(
      request("/", { headers: { authorization: `Basic ${wrong}` } }),
      runtime,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  test("誤ったユーザー名も 401（区別しない）", async () => {
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = plaintextHash;
    const runtime = loadRuntimeConfig(env);
    const wrongUser = btoa(`other:${plaintextPassword}`);
    const result = await authenticate(
      request("/", { headers: { authorization: `Basic ${wrongUser}` } }),
      runtime,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    expect((result as Response).headers.get("WWW-Authenticate")).toBe(
      'Basic realm="power-manager"',
    );
  });

  test("UTF-8 のマルチバイト資格情報も正しく認証する", async () => {
    // username は設定側の文字種制限（英数字と . _ - ）に縛られるため、
    // マルチバイトはパスワード側で検証する。`atob` は UTF-8 を壊すので回帰検出になる。
    const multibytePassword = "パスワード123";
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = await hash(multibytePassword);
    const runtime = loadRuntimeConfig(env);
    // UTF-8 バイト列を Base64 化する（`btoa` は latin1 なので手動変換）。
    const raw = new TextEncoder().encode(`admin:${multibytePassword}`);
    const credentials = btoa(String.fromCharCode(...raw));
    const result = await authenticate(
      request("/", { headers: { authorization: `Basic ${credentials}` } }),
      runtime,
    );
    expect(result).toBe("admin");
  });

  test("誤ったユーザー名でも verify は呼ばれる（timing 差の排除）", async () => {
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = plaintextHash;
    const runtime = loadRuntimeConfig(env);
    const wrongUser = btoa(`other:${plaintextPassword}`);
    const result = await authenticate(
      request("/", { headers: { authorization: `Basic ${wrongUser}` } }),
      runtime,
    );
    expect((result as Response).status).toBe(401);
    expect(verifyMock).toHaveBeenCalledTimes(1);
  });

  test("`:` のない資格情報は 401", async () => {
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = plaintextHash;
    const runtime = loadRuntimeConfig(env);
    const noColon = btoa("admin-without-colon");
    const result = await authenticate(
      request("/", { headers: { authorization: `Basic ${noColon}` } }),
      runtime,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  test("不正な Base64 は 401", async () => {
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = plaintextHash;
    const runtime = loadRuntimeConfig(env);
    const result = await authenticate(
      request("/", { headers: { authorization: "Basic !!!not-base64!!!" } }),
      runtime,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  test("不正な UTF-8 バイト列の資格情報は 401", async () => {
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = plaintextHash;
    const runtime = loadRuntimeConfig(env);
    // `0xff` は UTF-8 として不正な先頭バイト。
    const invalid = btoa(String.fromCharCode(0x61, 0x3a, 0xff, 0xfe));
    const result = await authenticate(
      request("/", { headers: { authorization: `Basic ${invalid}` } }),
      runtime,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  test("Basic でない Authorization は 401", async () => {
    const env = validEnvironment();
    env.POWER_MANAGER_AUTH_PASSWORD_HASH = plaintextHash;
    const runtime = loadRuntimeConfig(env);
    const result = await authenticate(
      request("/", { headers: { authorization: "Bearer abc" } }),
      runtime,
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });
});

describe("authMiddleware", () => {
  test("認証を通れば next() が呼ばれ context へユーザー名が載る", async () => {
    vi.stubEnv("POWER_MANAGER_AUTH_PASSWORD_HASH", plaintextHash);
    vi.stubEnv("POWER_MANAGER_AUTH_USERNAME", "admin");
    vi.stubEnv("POWER_MANAGER_PUBLIC_ORIGIN", "https://power.example.ts.net");
    vi.stubEnv("POWER_MANAGER_CONFIG_PATH", "/etc/power-manager/config.json");
    vi.stubEnv("POWER_MANAGER_PORT", "8080");
    vi.stubEnv("POWER_MANAGER_SSH_IDENTITY_FILE", "/keys/id");
    vi.stubEnv("POWER_MANAGER_SSH_KNOWN_HOSTS_FILE", "/keys/kh");

    const context = new RouterContextProvider();
    const next = stubNext();
    const credentials = btoa(`admin:${plaintextPassword}`);
    const result = await authMiddleware(
      middlewareArgs(request("/", { headers: { authorization: `Basic ${credentials}` } }), context),
      next as unknown as Parameters<typeof authMiddleware>[1],
    );
    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
    expect(context.get(authContext)).toBe("admin");
  });

  test("認証なしは 401 を返し next() は呼ばれない", async () => {
    vi.stubEnv("POWER_MANAGER_AUTH_PASSWORD_HASH", plaintextHash);
    vi.stubEnv("POWER_MANAGER_AUTH_USERNAME", "admin");
    vi.stubEnv("POWER_MANAGER_PUBLIC_ORIGIN", "https://power.example.ts.net");
    vi.stubEnv("POWER_MANAGER_CONFIG_PATH", "/etc/power-manager/config.json");
    vi.stubEnv("POWER_MANAGER_PORT", "8080");
    vi.stubEnv("POWER_MANAGER_SSH_IDENTITY_FILE", "/keys/id");
    vi.stubEnv("POWER_MANAGER_SSH_KNOWN_HOSTS_FILE", "/keys/kh");

    const context = new RouterContextProvider();
    const next = stubNext();
    const result = await authMiddleware(
      middlewareArgs(request("/"), context),
      next as unknown as Parameters<typeof authMiddleware>[1],
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  test("/healthz は認証を免除する", async () => {
    const context = new RouterContextProvider();
    const next = stubNext();
    const result = await authMiddleware(
      middlewareArgs(request("/healthz"), context),
      next as unknown as Parameters<typeof authMiddleware>[1],
    );
    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });
});

test("cache を消さないと別の env 値が読めないことはない（cache リセットの検証）", async () => {
  // 1 回目は admin / power.example.ts.net でミドルウェアを通し、cache を作らせる。
  vi.stubEnv("POWER_MANAGER_AUTH_PASSWORD_HASH", plaintextHash);
  vi.stubEnv("POWER_MANAGER_AUTH_USERNAME", "admin");
  vi.stubEnv("POWER_MANAGER_PUBLIC_ORIGIN", "https://power.example.ts.net");
  vi.stubEnv("POWER_MANAGER_CONFIG_PATH", "/etc/power-manager/config.json");
  vi.stubEnv("POWER_MANAGER_PORT", "8080");
  vi.stubEnv("POWER_MANAGER_SSH_IDENTITY_FILE", "/keys/id");
  vi.stubEnv("POWER_MANAGER_SSH_KNOWN_HOSTS_FILE", "/keys/kh");
  const credentials = btoa(`admin:${plaintextPassword}`);
  await authMiddleware(
    middlewareArgs(request("/", { headers: { authorization: `Basic ${credentials}` } })),
    stubNext() as unknown as Parameters<typeof authMiddleware>[1],
  );

  // 2 回目は別の env 値。beforeEach で cache を消しているため、新しい値が読める。
  const runtime = loadRuntimeConfig({ ...validEnvironment(), POWER_MANAGER_AUTH_USERNAME: "other" });
  const wrongUser = btoa(`admin:${plaintextPassword}`);
  const result = await authenticate(
    request("/", { headers: { authorization: `Basic ${wrongUser}` } }),
    runtime,
  );
  expect(result).toBeInstanceOf(Response);
  expect((result as Response).status).toBe(401);
});

describe("csrfMiddleware / isOriginAllowed", () => {
  beforeEach(() => {
    vi.stubEnv("POWER_MANAGER_PUBLIC_ORIGIN", "https://power.example.ts.net");
    vi.stubEnv("POWER_MANAGER_AUTH_PASSWORD_HASH", plaintextHash);
    vi.stubEnv("POWER_MANAGER_AUTH_USERNAME", "admin");
    vi.stubEnv("POWER_MANAGER_CONFIG_PATH", "/etc/power-manager/config.json");
    vi.stubEnv("POWER_MANAGER_PORT", "8080");
    vi.stubEnv("POWER_MANAGER_SSH_IDENTITY_FILE", "/keys/id");
    vi.stubEnv("POWER_MANAGER_SSH_KNOWN_HOSTS_FILE", "/keys/kh");
  });

  test("一致する Origin の POST は next() が呼ばれる", async () => {
    const next = stubNext();
    const result = await csrfMiddleware(
      middlewareArgs(
        request("/", {
          method: "POST",
          headers: { origin: "https://power.example.ts.net" },
        }),
      ),
      next as unknown as Parameters<typeof csrfMiddleware>[1],
    );
    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("GET は Origin なしでも許可する", async () => {
    const next = stubNext();
    const result = await csrfMiddleware(
      middlewareArgs(request("/")),
      next as unknown as Parameters<typeof csrfMiddleware>[1],
    );
    expect(result).toBeUndefined();
    expect(next).toHaveBeenCalledTimes(1);
  });

  test("不正な Origin の POST は 403 で next() は呼ばれない", async () => {
    const next = stubNext();
    const result = await csrfMiddleware(
      middlewareArgs(
        request("/", {
          method: "POST",
          headers: { origin: "https://evil.example.ts.net" },
        }),
      ),
      next as unknown as Parameters<typeof csrfMiddleware>[1],
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
    expect(next).not.toHaveBeenCalled();
  });

  test("Origin 欠落の POST は 403", async () => {
    const next = stubNext();
    const result = await csrfMiddleware(
      middlewareArgs(request("/", { method: "POST" })),
      next as unknown as Parameters<typeof csrfMiddleware>[1],
    );
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(403);
  });

  test("Origin の完全一致でないものは拒否する（パス・クエリ付きなど）", () => {
    expect(
      isOriginAllowed(
        request("/", {
          method: "POST",
          headers: { origin: "https://power.example.ts.net/" },
        }),
        "https://power.example.ts.net",
      ),
    ).toBe(false);
    expect(
      isOriginAllowed(
        request("/", {
          method: "POST",
          headers: { origin: "https://power.example.ts.net.evil.example.ts.net" },
        }),
        "https://power.example.ts.net",
      ),
    ).toBe(false);
  });

  test("PUT / PATCH / DELETE も検証対象", () => {
    const origin = "https://power.example.ts.net";
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(
        isOriginAllowed(
          request("/", {
            method,
            headers: { origin: "https://evil.example.ts.net" },
          }),
          origin,
        ),
      ).toBe(false);
      expect(
        isOriginAllowed(
          request("/", {
            method,
            headers: { origin: "https://power.example.ts.net" },
          }),
          origin,
        ),
      ).toBe(true);
    }
  });
});