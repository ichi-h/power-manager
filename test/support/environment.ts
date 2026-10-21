/**
 * 検証を通る環境変数一式。テストごとに書き換えられるよう、毎回新しいオブジェクトを返す。
 *
 * `test/config.test.ts`、`test/load-context.test.ts`、`test/startup.test.ts` で同じ値を
 * 使う。3 箇所に複製すると、パスワードハッシュの形式を変えたときに片方だけ古いまま
 * 残って原因が分かりにくい失敗になる。
 */
export function validEnvironment(): Record<string, string> {
  return {
    POWER_MANAGER_CONFIG_PATH: "/etc/power-manager/config.json",
    POWER_MANAGER_PORT: "8080",
    POWER_MANAGER_PUBLIC_ORIGIN: "https://power.example.ts.net",
    POWER_MANAGER_AUTH_USERNAME: "admin",
    POWER_MANAGER_AUTH_PASSWORD_HASH:
      "$argon2id$v=19$m=65536,t=2,p=1$CJ2eRzv21JkRoWJAsIi8Yg$1RMRv11PXAK8o6m5v5SYM4+6Lehh35Iw3CPNNvkuSqM",
    POWER_MANAGER_SSH_IDENTITY_FILE: "/run/secrets/power-manager/id_ed25519",
    POWER_MANAGER_SSH_KNOWN_HOSTS_FILE: "/etc/power-manager/known_hosts",
  };
}
