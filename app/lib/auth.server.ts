/**
 * Basic 認証の検証とミドルウェア（FR-10, SEC-01, SEC-10）。
 *
 * - 認証は HTTP Basic + Argon2id のみ。セッションを持たない（NFR-01, NFR-02）。
 * - 秘密値は起動時の設定から直接読み、load context には載せない（SEC-05）。
 * - 認証を免除するのは `/healthz` のみで、その他の全ルートが対象（SEC-10）。
 *
 * `/healthz` でないパスは、root に適用されたこのミドルウェアと CSRF ミドルウェア
 * （`app/lib/csrf.server.ts`）がすべての要求を検査する（FR-10, SEC-03）。
 */
import { verify } from 'argon2';
import type { Route } from '../+types/root';
import { createContext, type RouterContext } from 'react-router';

import { loadRuntimeConfig, type RuntimeConfig } from './config.server.ts';

export type { RuntimeConfig };

/** 認証を免除するパス。この 1 パスに限定する（SEC-10）。 */
const authExemptPath = '/healthz';

/** 401 に載せる `WWW-Authenticate` の realm。 */
const basicRealm = 'power-manager';

/**
 * 認証済み利用者を保持する load context のキー。
 *
 * `configContext`（`app/lib/config.server.ts`）と同じ理由で `globalThis` のスロットを
 * 唯一の情報源にする。ビルド成果物とサーバーエントリは別のモジュールグラフであり、
 * モジュールスコープで `createContext()` すると実体が 2 つになり、ミドルウェアが
 * 設定した値を loader/action 側の `context.get(authContext)` で引けなくなる。
 */
const authContextSlot = '__powerManagerAuthContext';

type AuthContextRegistry = {
  [authContextSlot]?: RouterContext<string>;
};

const authContextRegistry = globalThis as unknown as AuthContextRegistry;

/** 認証済み利用者のユーザー名。loader/action は `context.get(authContext)` で参照する。 */
export const authContext: RouterContext<string> = (authContextRegistry[
  authContextSlot
] ??= createContext<string>() as RouterContext<string>);

/**
 * 401 応答。`WWW-Authenticate` を忘れるとブラウザが認証ダイアログを出さない。
 * ユーザー名不一致とパスワード不一致は区別しない（`docs/security.md` 2.3）。
 */
function unauthorized(): Response {
  return new Response('Unauthorized', {
    status: 401,
    headers: { 'WWW-Authenticate': `Basic realm="${basicRealm}"` },
  });
}

/** `Authorization` からユーザー名とパスワードを取り出す。形式が違う場合は `null`。 */
function parseBasicCredentials(
  header: string,
): { username: string; password: string } | null {
  if (!header.startsWith('Basic ')) return null;

  // Base64 はバイト列を表す。`atob` は latin1 の 1:1 文字列化しかしないため
  // マルチバイト UTF-8 の資格情報を壊す。TextDecoder で UTF-8 としてデコードする
  // （RFC 7617 の既定文字集合は UTF-8）。
  let decoded: string;
  try {
    const bytes = Uint8Array.from(atob(header.slice('Basic '.length)), (c) =>
      c.charCodeAt(0),
    );
    // 不正な UTF-8 バイト列（ lone surrogate byte 等）もここで 401 に落とす。
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }

  // 最初の `:` で区切る。パスワードは `:` を含んでいてよい。
  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

/**
 * 検証済みの実行時設定を 1 度だけ読み込む（初回の要求で評価する）。
 *
 * テストからのみキャッシュを消す。`vi.unstubAllEnvs()` はモジュールスコープの
 * cache を消さないため、env を差し替えたテストが古い値を読むのを防ぐ
 * （`app/lib/config.server.ts` の cache と同じ課題）。
 */
let runtimeConfig: RuntimeConfig | undefined;

function ensureRuntimeConfig(): RuntimeConfig {
  runtimeConfig ??= loadRuntimeConfig();
  return runtimeConfig;
}

/** テスト用: `runtimeConfig` の cache を消す。本番コードからは呼ばない。 */
export function __resetRuntimeConfigCache(): void {
  runtimeConfig = undefined;
}

/**
 * `Authorization` ヘッダーで認証する。
 *
 * - ユーザー名は `POWER_MANAGER_AUTH_USERNAME` と完全一致。
 * - パスワードは `POWER_MANAGER_AUTH_PASSWORD_HASH` に対して `argon2.verify` で検証。
 * - 失敗は 401 と `WWW-Authenticate: Basic realm="power-manager"`。
 *
 * ユーザー名が一致しない場合もパスワード検証と同種の応答にする（列挙の抑止）。
 */
export async function authenticate(
  request: Request,
  runtime: RuntimeConfig = ensureRuntimeConfig(),
): Promise<Response | string> {
  const header = request.headers.get('authorization');
  if (header === null) return unauthorized();

  const credentials = parseBasicCredentials(header);
  if (credentials === null) return unauthorized();

  const usernameMatches = credentials.username === runtime.authUsername;
  // `&&` で短絡させない。usernameMatches と無関係に必ず verify を呼ぶ。
  // 短絡するとユーザー名不一致の応答が速く返り、時間差でユーザー名の存在が
  // 推測できる（`docs/security.md` 2.3 の区別しない方針）。
  const passwordMatches = await verify(
    runtime.authPasswordHash,
    credentials.password,
  ).catch(() => false);

  if (!usernameMatches || !passwordMatches) return unauthorized();
  return credentials.username;
}

/**
 * 認証ミドルウェア（`docs/security.md` 2.2）。
 *
 * `/healthz` だけ早期に `next()` し、それ以外は `Authorization` の検証を通ってから
 * `context` へ認証済み利用者を設定する。root に適用されるため全ルートへ継承される。
 */
export const authMiddleware: Route.MiddlewareFunction = async (
  { request, context },
  next,
) => {
  const path = new URL(request.url).pathname;
  if (path === authExemptPath) return next();

  const result = await authenticate(request);
  if (result instanceof Response) return result;

  context.set(authContext, result);
  return next();
};
