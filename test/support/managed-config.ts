/**
 * 検証を通る管理対象 JSON の雛形。
 *
 * 設定 JSON のスキーマ・相互参照・設定ストアのテストで共有する。個々のテストは
 * ここから 1 か所だけ壊し、どの指摘が出るかを見る。
 */
export function validManagedConfig(): Record<string, unknown> {
  return {
    version: 2,
    servers: [
      {
        id: "nas",
        name: "NAS",
        groups: ["storage"],
        macAddress: "00:11:22:33:44:55",
        wol: { broadcastAddress: "192.168.1.255", port: 9 },
        ssh: {
          host: "nas.example.internal",
          port: 22,
          user: "power-manager",
          shutdownCommand: "sudo systemctl poweroff",
        },
      },
    ],
    groups: [{ id: "storage", name: "ストレージ" }],
    schedules: [] as unknown[],
  };
}

/** 検証を通る予約 1 件。対象と繰り返しだけ差し替えて使う。 */
export function validSchedule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "night-shutdown",
    name: "夜間停止",
    enabled: true,
    target: { type: "group", id: "storage" },
    operation: "shutdown",
    repeat: { kind: "daily", time: "23:30" },
    ...overrides,
  };
}
