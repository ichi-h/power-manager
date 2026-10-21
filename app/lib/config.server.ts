/**
 * 実行時設定（環境変数）のスキーマと読込み。
 *
 * - 起動要件はここに並ぶ環境変数の検証だけである（NFR-06）。ssh の存在や管理対象 JSON の
 *   内容は起動要件に含めない（`docs/architecture.md` 3.2）。
 * - 検証に失敗した場合は `ConfigurationError` を投げる。`server/index.ts` がこれを
 *   `startup_failed`（`code=invalid_configuration`）として記録し、待受を開始せずに
 *   終了コード 78 で終了する（NFR-05, NFR-06）。
 * - 検証済みの値は load context（`configContext`）に載せ、loader/action から参照する。
 */
import path from "node:path";

import { createContext, type RouterContext } from "react-router";
import { z } from "zod";

/** 実行モード。本番の環境変数ファイルでは `production` を指定する。 */
export type NodeEnvironment = "production" | "development" | "test";

/**
 * 画面・loader・action へ渡してよい公開値。
 *
 * 秘密値を含めないのは型で担保する。load context は全 loader/action から到達できるため、
 * 秘密値を同じ型に同居させると「各 loader が出力しない」という実装規律だけが防御になる
 * （SEC-05）。秘密値は `AuthConfig` / `SshConfig` に分ける。
 */
export type PublicRuntimeConfig = {
  /**
   * 管理対象 JSON の絶対パス。
   * パス自体は秘密ではないが、画面へ出す必要もないため loader では使わない想定。
   */
  configPath: string;
  /** loopback HTTP の待受ポート。 */
  port: number;
  /** CSRF 検証に使う外部 Origin（スキーム・ホスト・ポートのみ）。 */
  publicOrigin: string;
  /**
   * `publicOrigin` のホスト部（スキームを含まない `host[:port]`）。
   * React Router の `allowedActionOrigins` は `Origin` ヘッダーの `host` と照合するため、
   * `publicOrigin`（スキーム付き）とは別に保持する。
   */
  publicOriginHost: string;
  /**
   * 配備モード。
   *
   * 起動時の検証（本番で HTTP を拒否する等）のためだけに持ち、ドメイン層の型・関数へは
   * 渡さない。`NODE_ENV` は配備の都合を表す値であり、電源操作の判断材料ではない。
   */
  nodeEnv: NodeEnvironment;
};

/**
 * 認証の秘密値。load context ではなく、認証ミドルウェア（`t004`）だけが読む。
 */
export type AuthConfig = {
  /** Basic 認証のユーザー名。 */
  authUsername: string;
  /** Basic 認証のパスワードハッシュ（Argon2id）。 */
  authPasswordHash: string;
};

/**
 * SSH 停止のための設定。
 *
 * `sshIdentityFile` と `sshKnownHostsFile` は「パスの検証だけ」を起動要件にする。
 * `ssh` 実行ファイルの存在や鍵の実在・権限は起動時に見ない（`docs/architecture.md` 3.2）。
 * `ssh` の不在は停止操作の実行時に `ssh_unavailable` として検出する。
 */
export type SshConfig = {
  /** SSH 専用秘密鍵の絶対パス。 */
  sshIdentityFile: string;
  /** `known_hosts` の絶対パス。 */
  sshKnownHostsFile: string;
};

/**
 * 検証済みの実行時設定（全体）。起動時の配線だけが扱う。
 *
 * load context へ載せるのは `PublicRuntimeConfig` の部分だけである。
 */
export type RuntimeConfig = PublicRuntimeConfig & AuthConfig & SshConfig;

/**
 * 検証済みの実行時設定を loader/action へ渡すためのキー。
 * `server/app.ts` が `createLoadContext` で設定し、loader/action は
 * `context.get(configContext)` で参照する。
 *
 * キーの実体はプロセス内で 1 つでなければならない。`react-router build` が生成する
 * `build/server/index.js`（ルート側）と自前エントリのバンドル（`server/index.js`）は
 * 別のモジュールグラフであり、モジュールスコープで `createContext()` すると同じ名前でも
 * 実体が 2 つになる。すると `server/app.ts` が入れた値がルート側から引けず、
 * 実行時に「No value found for context」で 500 になる。`globalThis` 上の 1 つの
 * スロットを唯一の情報源にして、どちらのグラフからも同じオブジェクトを返す。
 *
 * `RouterContextProvider` はキーをオブジェクト同一性で照合するため、この共有が必要になる。
 */
const configContextSlot = "__powerManagerConfigContext";

type ConfigContextRegistry = {
  [configContextSlot]?: RouterContext<PublicRuntimeConfig>;
};

const configContextRegistry = globalThis as unknown as ConfigContextRegistry;

/**
 * 公開値だけを載せる。秘密値（`AuthConfig` / `SshConfig`）はここに入れない。
 */
export const configContext: RouterContext<PublicRuntimeConfig> = (configContextRegistry[
  configContextSlot
] ??= createContext<PublicRuntimeConfig>());

/**
 * 公開値だけを取り出す。load context へ載せる範囲をこの関数で固定する。
 */
export function toPublicRuntimeConfig(runtime: RuntimeConfig): PublicRuntimeConfig {
  return {
    configPath: runtime.configPath,
    port: runtime.port,
    publicOrigin: runtime.publicOrigin,
    publicOriginHost: runtime.publicOriginHost,
    nodeEnv: runtime.nodeEnv,
  };
}

/**
 * load context から公開値を読む。
 *
 * 未設定ならフレームワークの汎用メッセージではなく、配線不整合だと分かるエラーにする。
 * 本番でここに来るのは、`getLoadContext` を通らない経路を作った場合だけである。
 */
export function requireRuntimeConfig(context: RouterContextProviderLike): PublicRuntimeConfig {
  try {
    return context.get(configContext);
  } catch {
    throw new Error(
      "実行時設定が load context にありません（server/app.ts の createLoadContext を経由していません）",
    );
  }
}

/** `RouterContextProvider` のうち `requireRuntimeConfig` が使う部分。テストで差し替えられるようにする。 */
type RouterContextProviderLike = { get: <T>(key: RouterContext<T>) => T };

/**
 * 環境変数の検証失敗。起動時は終了コード 78 の対象になる（NFR-05, NFR-06）。
 *
 * メッセージには不正な変数名と理由だけを含め、値は含めない（SEC-05）。
 */
export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

/** Origin のホスト名として解釈させない予約語。`Origin: null` との完全一致を防ぐ。 */
const reservedHostnames = new Set(["null", "undefined", "true", "false"]);

/**
 * Argon2id ハッシュのパラメータ許容範囲。
 *
 * 下限は弱いハッシュ（`m=8,t=1` は事実上総当たり可能）を、上限は未認証リクエストごとの
 * 検証でメモリを枯渇させる過大な設定を弾くために置く（SEC-05, `docs/security.md` 2 章）。
 */
const argon2idParameterRanges = {
  /** メモリコスト（KiB）。OWASP の Argon2id 推奨下限 19 MiB、上限 256 MiB。 */
  m: { min: 19_456, max: 262_144 },
  /** 反復回数。 */
  t: { min: 2, max: 10 },
  /** 並列度。 */
  p: { min: 1, max: 4 },
} as const;

/** ソルト・ハッシュの最低バイト数。Base64 換算でソルト 22 文字、ハッシュ 43 文字に対応する。 */
const argon2idMinimumSaltBytes = 16;
const argon2idMinimumHashBytes = 32;

/** パラメータの順序を固定しないために、`$` 区切りのフィールド単位で検査する。 */
const argon2idVersionPattern = /^v=\d+$/;
const argon2idParameterPattern = /^[m,t,p]=\d+(,[m,t,p]=\d+)*$/;
/** Base64（標準・URL 安全）とパディングを許す。`node-argon2` の出力はパディングなし。 */
const argon2idBase64Pattern = /^[A-Za-z0-9+/_-]+={0,2}$/;

/** Base64 文字列が表現するバイト数を求める。 */
function base64ByteLength(value: string): number {
  const unpadded = value.replace(/=+$/, "");
  return Math.floor((unpadded.length * 3) / 4);
}

/**
 * Argon2id の encoded 形式を検証する。
 *
 * `node-argon2` の `hash()` は `m,p,t` の順で出力するため、パラメータ順に依存させない
 * （`docs/security.md` 2 章は「`$argon2id$` で始まる文字列」以上の制約を課していない）。
 * ただし構造（6 フィールド・各フィールドの文字種・パラメータ範囲）は厳格に見る。
 */
function isValidArgon2idHash(value: string): boolean {
  const fields = value.split("$");
  if (fields.length !== 6) return false;

  const [prefix, algorithm, version, parameters, salt, hash] = fields;
  if (prefix !== "" || algorithm !== "argon2id") return false;
  if (version === undefined || parameters === undefined) return false;
  if (salt === undefined || hash === undefined) return false;
  if (!argon2idVersionPattern.test(version)) return false;
  if (!argon2idParameterPattern.test(parameters)) return false;
  if (!argon2idBase64Pattern.test(salt) || !argon2idBase64Pattern.test(hash)) return false;
  if (base64ByteLength(salt) < argon2idMinimumSaltBytes) return false;
  if (base64ByteLength(hash) < argon2idMinimumHashBytes) return false;

  // パラメータは重複しない前提で読み、各値を範囲内に限定する。
  const values = new Map<string, number>();
  for (const pair of parameters.split(",")) {
    const [key, raw] = pair.split("=");
    if (key === undefined || raw === undefined) return false;
    values.set(key, Number(raw));
  }
  for (const [key, range] of Object.entries(argon2idParameterRanges)) {
    const parsed = values.get(key);
    if (parsed === undefined) return false;
    if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) return false;
  }

  return true;
}

/** 検証メッセージ。同じ文言を複数箇所で使うため定数にする。 */
const messages = {
  required: "設定されていません",
  empty: "空です",
  portRange: "1 から 65535 の整数で指定してください",
  absolutePath: "絶対パスを正規化した形で指定してください",
  username: "英数字と . _ - だけを使い、64 文字以内で指定してください",
  surroundingWhitespace: "前後に空白を含めないでください",
} as const;

/**
 * 値が設定されていることを要求する。前後の空白は黙って落とさず拒否する。
 * 環境変数ファイルの書き間違い（行末の空白、値を空にしたままの行）を検出するため。
 */
function requiredString() {
  return z
    .string({ error: messages.required })
    .min(1, { message: messages.empty })
    .refine((value) => value === value.trim(), {
      message: messages.surroundingWhitespace,
    });
}

/**
 * 絶対パスを検証する。
 *
 * NUL バイトを含む値は後続の `fs` 呼び出しで値を含む例外メッセージを生み、
 * `config_reload` の `reason` 経由でログに漏れる。`..` や `//` を含む値は
 * 同じファイルを指す複数の表記を許し、設定の同一性を壊す。
 */
function absolutePath() {
  return requiredString().refine(
    (value) =>
      path.isAbsolute(value) &&
      !value.includes("\0") &&
      // ルート直下の `/` だけは末尾スラッシュを許す。
      (value === path.sep || !value.endsWith(path.sep)) &&
      path.normalize(value) === value,
    { message: messages.absolutePath },
  );
}

/** Origin として正規化した結果。 */
type PublicOrigin = {
  /** スキーム付きの Origin（`https://host[:port]`）。自前ミドルウェアの完全一致検証に使う。 */
  origin: string;
  /** スキームを含まない `host[:port]`。`allowedActionOrigins` の照合形式。 */
  host: string;
};

/**
 * `allowedActionOrigins` が解釈するパターンとして妥当か。
 *
 * React Router の照合は `*` / `**` をワイルドカードとして扱うため、ホストに `*` を含めると
 * VPN 内の任意ホストからの `POST` が第 1 層を通過してしまう。完全一致だけを許可する。
 */
function isAllowedActionOriginPattern(host: string): boolean {
  return host !== "" && !host.includes("*");
}

/**
 * `POWER_MANAGER_PUBLIC_ORIGIN` を Origin として正規化する。
 * 許可するのは HTTPS、および `http://localhost[:port]`（SEC-02, `docs/security.md` 3.2）。
 *
 * HTTP はここでは形式としてのみ通し、`production` での禁止は `environmentSchema` の
 * クロスフィールド検証（`NODE_ENV` × `POWER_MANAGER_PUBLIC_ORIGIN`）で行う。
 * この関数は `NODE_ENV` を知らないため、単体では配備モードを判定できない。
 */
function parsePublicOrigin(value: string): PublicOrigin | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  // 資格情報とパスを含む URL は、Origin の指定ミスとして拒否する。
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;

  // ポート 0 は「空きポートで待受」の意味になり、Origin の指定として無効である。
  if (url.port === "0") return null;

  const hostname = url.hostname;
  if (hostname === "") return null;
  if (reservedHostnames.has(hostname)) return null;
  // 末尾ドットはブラウザが送る `Origin` と一致しないため、正規化で落とさず拒否する。
  if (hostname.endsWith(".")) return null;
  // IPv6 リテラルは `[::1]` の形なので、空ラベルの判定は IPv4・ホスト名にだけ行う。
  if (!hostname.startsWith("[") && hostname.split(".").some((label) => label === "")) {
    return null;
  }
  if (!isAllowedActionOriginPattern(url.host)) return null;

  if (url.protocol === "https:") return { origin: url.origin, host: url.host };
  if (url.protocol === "http:" && hostname === "localhost") {
    return { origin: url.origin, host: url.host };
  }
  return null;
}

/**
 * ポートを検証する。
 *
 * 先頭ゼロを拒む（`08080` を 8 進数風に黙って解釈しない）ため、先頭は 1-9 に限定する。
 * 桁数を 5 桁に制限しておくと、巨大な数値による数値型の内部制約（英語メッセージ）が
 * 先に発火しない。
 */
const portValue = requiredString()
  .regex(/^[1-9]\d{0,4}$/, { message: messages.portRange })
  .transform((value) => Number(value))
  .pipe(
    z
      .number()
      .int()
      .min(1, { message: messages.portRange })
      .max(65535, { message: messages.portRange }),
  );

const publicOriginMessage =
  "HTTPS の URL、または開発時のみ http://localhost[:port] を、パスを含めずに指定してください";

/**
 * 検証と正規化を 1 回の評価で行う。`refine` で判定して `transform` で再度解析すると、
 * 判定結果と変換結果が食い違う余地が残るため、変換のなかで invalid にする。
 */
const publicOriginValue = requiredString().transform((value, ctx) => {
  const parsed = parsePublicOrigin(value);
  if (parsed === null) {
    ctx.addIssue({ code: "custom", message: publicOriginMessage });
    return z.NEVER;
  }
  return parsed;
});

/**
 * Basic 認証のユーザー名。
 *
 * `:` を含むと「最初の `:` で分割する」解析で永久にログインできず、制御文字や長大な値も
 * 無意味に受理されるため、文字種と長さを限定する。
 */
const usernameValue = requiredString().regex(/^[A-Za-z0-9._-]{1,64}$/, {
  message: messages.username,
});

const passwordHashValue = requiredString().refine(isValidArgon2idHash, {
  message:
    "Argon2id のハッシュ（$argon2id$v=..$m=..,t=..,p=..$salt$hash、m=19456-262144, t=2-10, p=1-4）を指定してください",
});

/**
 * 環境変数のスキーマ。ここに並ぶ変数がすべて揃わなければ起動しない（NFR-06）。
 *
 * 検証は「値の形式」に限る。外部資源の存在確認（`ssh` 実行ファイル、秘密鍵、
 * 管理対象 JSON）は起動要件に含めない。Nix の配置と手動配置の両方を許容し、
 * 起動要件を環境変数の検証だけに限定するためである。
 *
 * `loadRuntimeConfig` はこのキーだけを環境から抜き出して
 * から検証する。未知の変数の値がエラー経路（issue の `input` 等）へ入る余地を残さない
 * （SEC-05）。
 */
const environmentShape = {
  POWER_MANAGER_CONFIG_PATH: absolutePath(),
  POWER_MANAGER_PORT: portValue,
  POWER_MANAGER_PUBLIC_ORIGIN: publicOriginValue,
  POWER_MANAGER_AUTH_USERNAME: usernameValue,
  POWER_MANAGER_AUTH_PASSWORD_HASH: passwordHashValue,
  POWER_MANAGER_SSH_IDENTITY_FILE: absolutePath(),
  POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: absolutePath(),
  NODE_ENV: z
    .enum(["production", "development", "test"], {
      error: "production（開発時は development）を指定してください",
    })
    .default("production"),
};

const environmentSchema = z
  .object(environmentShape)
  /**
   * 単一の変数だけでは判定できない条件をここで検査する。
   *
   * 本番で `http://localhost` を Origin に指定できると、CSRF 検証の基準値が開発用のまま
   * 動き、配備ミスを起動時に検出できない（NFR-06, `docs/security.md` 3.2）。
   */
  .superRefine((data, ctx) => {
    if (
      data.NODE_ENV === "production" &&
      data.POWER_MANAGER_PUBLIC_ORIGIN.origin.startsWith("http:")
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["POWER_MANAGER_PUBLIC_ORIGIN"],
        message: "本番（NODE_ENV=production）では HTTPS の URL を指定してください",
      });
    }
  });

/**
 * 検証エラーから、変数名と理由だけの 1 行メッセージを組み立てる。
 * 同じ変数・同じ理由の重複は畳む。
 */
function describeIssues(error: z.ZodError): string {
  const parts: string[] = [];
  const seen = new Set<string>();

  for (const issue of error.issues) {
    const name = issue.path.map(String).join(".") || "(環境変数)";
    const part = `${name}: ${issue.message}`;
    if (seen.has(part)) continue;
    seen.add(part);
    parts.push(part);
  }

  return `環境変数が不正です（${parts.join(" / ")}）`;
}

/** スキーマが求める変数だけを環境から抜き出す。 */
function pickEnvironment(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const picked: Record<string, string | undefined> = {};
  for (const name of Object.keys(environmentShape)) {
    picked[name] = env[name];
  }
  return picked;
}

export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const parsed = environmentSchema.safeParse(pickEnvironment(env));
  if (!parsed.success) throw new ConfigurationError(describeIssues(parsed.error));

  return {
    configPath: parsed.data.POWER_MANAGER_CONFIG_PATH,
    port: parsed.data.POWER_MANAGER_PORT,
    publicOrigin: parsed.data.POWER_MANAGER_PUBLIC_ORIGIN.origin,
    publicOriginHost: parsed.data.POWER_MANAGER_PUBLIC_ORIGIN.host,
    authUsername: parsed.data.POWER_MANAGER_AUTH_USERNAME,
    authPasswordHash: parsed.data.POWER_MANAGER_AUTH_PASSWORD_HASH,
    sshIdentityFile: parsed.data.POWER_MANAGER_SSH_IDENTITY_FILE,
    sshKnownHostsFile: parsed.data.POWER_MANAGER_SSH_KNOWN_HOSTS_FILE,
    nodeEnv: parsed.data.NODE_ENV,
  };
}
