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

import { createContext } from "react-router";
import { z } from "zod";

/** 実行モード。本番の環境変数ファイルでは `production` を指定する。 */
export type NodeEnvironment = "production" | "development" | "test";

/**
 * 検証済みの実行時設定。秘密値もここに含まれるため、画面・ログへ出力しない（SEC-05）。
 *
 * `sshIdentityFile` と `sshKnownHostsFile` は「パスの検証だけ」を起動要件にする。
 * `ssh` 実行ファイルの存在や鍵の実在・権限は起動時に見ない（`docs/architecture.md` 3.2）。
 * `ssh` の不在は停止操作の実行時に `ssh_unavailable` として検出する。
 */
export type RuntimeConfig = {
  /** 管理対象 JSON の絶対パス。 */
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
  /** Basic 認証のユーザー名。 */
  authUsername: string;
  /** Basic 認証のパスワードハッシュ（Argon2id）。 */
  authPasswordHash: string;
  /** SSH 専用秘密鍵の絶対パス。 */
  sshIdentityFile: string;
  /** `known_hosts` の絶対パス。 */
  sshKnownHostsFile: string;
  nodeEnv: NodeEnvironment;
};

/**
 * 検証済みの実行時設定を loader/action へ渡すためのキー。
 * `server/app.ts` が `createLoadContext` で設定し、loader/action は
 * `context.get(configContext)` で参照する。
 */
export const configContext = createContext<RuntimeConfig>();

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

/** Argon2id の標準的な encoded 形式（`$argon2id$v=..$m=..,t=..,p=..$salt$hash`）。 */
const argon2idHashPattern =
  /^\$argon2id\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

const requiredMessage = { error: "設定されていません" };
const emptyMessage = { message: "空です" };

function requiredString() {
  return z.string(requiredMessage).min(1, emptyMessage);
}

function absolutePath() {
  return requiredString().refine((value) => path.isAbsolute(value), {
    message: "絶対パスを指定してください",
  });
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

const portValue = requiredString()
  .regex(/^\d+$/, { message: "1 から 65535 の整数で指定してください" })
  .transform((value) => Number(value))
  .pipe(
    z
      .number()
      .int()
      .min(1, { message: "1 から 65535 の整数で指定してください" })
      .max(65535, { message: "1 から 65535 の整数で指定してください" }),
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

const passwordHashValue = requiredString().refine(
  (value) => argon2idHashPattern.test(value),
  { message: "$argon2id$ で始まる Argon2id のハッシュを指定してください" },
);

/**
 * 環境変数のスキーマ。ここに並ぶ変数がすべて揃わなければ起動しない（NFR-06）。
 *
 * 検証は「値の形式」に限る。外部資源の存在確認（`ssh` 実行ファイル、秘密鍵、
 * 管理対象 JSON）は起動要件に含めない。Nix の配置と手動配置の両方を許容し、
 * 起動要件を環境変数の検証だけに限定するためである。
 */
const environmentSchema = z
  .object({
    POWER_MANAGER_CONFIG_PATH: absolutePath(),
    POWER_MANAGER_PORT: portValue,
    POWER_MANAGER_PUBLIC_ORIGIN: publicOriginValue,
    POWER_MANAGER_AUTH_USERNAME: requiredString(),
    POWER_MANAGER_AUTH_PASSWORD_HASH: passwordHashValue,
    POWER_MANAGER_SSH_IDENTITY_FILE: absolutePath(),
    POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: absolutePath(),
    NODE_ENV: z
      .enum(["production", "development", "test"], {
        error: "production（開発時は development）を指定してください",
      })
      .default("production"),
  })
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

/**
 * 環境変数を検証して実行時設定を返す。1 つでも不正なら `ConfigurationError` を投げる。
 */
export function loadRuntimeConfig(
  env: Record<string, string | undefined> = process.env,
): RuntimeConfig {
  const parsed = environmentSchema.safeParse(env);
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
