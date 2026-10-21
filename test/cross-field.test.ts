import { describe, expect, test } from "vitest";

import {
  ManagedConfigError,
  parseManagedConfig,
} from "../app/lib/runtime-config.server.ts";

import { validManagedConfig, validSchedule } from "./support/managed-config.ts";

/** 検証を通る定義。個々のテストはここから 1 か所だけ壊す。 */
function validConfig() {
  return validManagedConfig() as ReturnType<typeof validManagedConfig> & {
    servers: { groups: string[] }[];
    groups: { id: string; name: string }[];
    schedules: unknown[];
  };
}

/** 予約 1 件を組み立てる（対象と繰り返しだけ差し替えて使う）。 */
function schedule(overrides: Record<string, unknown> = {}) {
  return validSchedule(overrides);
}

/**
 * 検証を通らないことを、指摘の配列まで含めて確かめる。
 *
 * 集約メッセージへの正規表現一致だと、どの指摘で一致したか分からず、`parseManagedConfig`
 * を 2 回呼ぶことになる。`ManagedConfigError.issues` の配列そのものを比べる。
 */
function expectRejected(input: unknown, expected: readonly string[]): void {
  let caught: unknown;
  try {
    parseManagedConfig(input);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ManagedConfigError);
  expect((caught as ManagedConfigError).issues).toEqual(expected);
}

describe("集合内の一意性", () => {
  test("サーバー ID の重複を拒否する", () => {
    const input = validConfig();
    input.servers.push({ ...input.servers[0]! });

    expectRejected(input, ["servers.1.id: 識別子 nas が重複しています"]);
  });

  test("グループ ID の重複を拒否する", () => {
    const input = validConfig();
    input.groups.push({ id: "storage", name: "別名" });

    expectRejected(input, ["groups.1.id: 識別子 storage が重複しています"]);
  });

  test("予約 ID の重複を拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule(), schedule());

    expectRejected(input, ["schedules.1.id: 識別子 night-shutdown が重複しています"]);
  });

  test("同じ ID でも集合が違えば許す", () => {
    const input = validConfig();
    input.groups.push({ id: "nas", name: "NAS という名前のグループ" });
    // 空グループの拒否に引っかからないよう、参照させる。
    input.servers[0]!.groups = ["storage", "nas"];

    // 集合をまたぐ一意性は要求していない（FR-09 は「それぞれの集合内」）。
    expect(() => parseManagedConfig(input)).not.toThrow();
  });
});

describe("相互参照", () => {
  test("サーバーが参照するグループの未定義を拒否する", () => {
    const input = validConfig();
    input.servers[0]!.groups = ["storage", "missing"];

    expectRejected(input, ["servers.0.groups.1: グループ missing が定義されていません"]);
  });

  test("サーバーを持たないグループを拒否する", () => {
    const input = validConfig();
    input.groups.push({ id: "empty", name: "空のグループ" });

    expectRejected(input, ["groups.1: グループ empty に所属するサーバーがありません"]);
  });

  test("予約対象のサーバー未定義を拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule({ target: { type: "server", id: "missing" } }));

    expectRejected(input, ["schedules.0.target.id: server missing が定義されていません"]);
  });

  test("予約対象のグループ未定義を拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule({ target: { type: "group", id: "missing" } }));

    expectRejected(input, ["schedules.0.target.id: group missing が定義されていません"]);
  });

  test("種類を取り違えた参照（グループ ID を server として指定）を拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule({ target: { type: "server", id: "storage" } }));

    expectRejected(input, ["schedules.0.target.id: server storage が定義されていません"]);
  });

  test("指摘は 1 件に留めず、すべて集めて返す", () => {
    const input = validConfig();
    input.servers[0]!.groups = ["missing"];
    input.groups.push({ id: "empty", name: "空のグループ" });

    // 未定義グループの参照（サーバー側）と、元の所属が外れたグループ（storage）と、空グループ。
    // 検証を通した値だけで呼ぶ（キャストで前提を飛ばさない）。
    let caught: unknown;
    try {
      parseManagedConfig(input);
    } catch (error) {
      caught = error;
    }
    expect((caught as ManagedConfigError).issues).toHaveLength(3);
  });
});

describe("予約の不正", () => {
  test("対象がサーバーとグループの両方を持つ指定を拒否する", () => {
    const input = validConfig();
    input.schedules.push(
      schedule({ target: { type: "group", id: "storage", server: "nas" } }),
    );

    expectRejected(input, ["schedules.0.target: 未知の項目です"]);
  });

  test("対象が type も id も持たない指定を拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule({ target: {} }));

    // 欠落は「必須」、値の不一致は語彙の案内として区別する（FR-09）。
    expectRejected(input, [
      "schedules.0.target.type: 必須です",
      "schedules.0.target.id: 必須です",
    ]);
  });

  test("対象が server / group 以外の type を持つ指定を拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule({ target: { type: "all", id: "storage" } }));

    expectRejected(input, [
      "schedules.0.target.type: type に server か group を指定し、id を 1 つだけ持たせてください",
    ]);
  });

  test("操作種別は wake / shutdown 以外を拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule({ operation: "reboot" }));

    expectRejected(input, ["schedules.0.operation: wake か shutdown を指定してください"]);
  });

  test("繰り返し種別は daily / weekly 以外を拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule({ repeat: { kind: "monthly", time: "23:30" } }));

    expectRejected(input, [
      "schedules.0.repeat.kind: kind に daily か weekly を指定してください（weekly は days が必要です）",
    ]);
  });

  test("daily が days を持つ指定を拒否する", () => {
    const input = validConfig();
    input.schedules.push(
      schedule({ repeat: { kind: "daily", days: ["mon"], time: "23:30" } }),
    );

    expectRejected(input, ["schedules.0.repeat: 未知の項目です"]);
  });

  test("weekly の曜日が空配列なら拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule({ repeat: { kind: "weekly", days: [], time: "07:30" } }));

    expectRejected(input, ["schedules.0.repeat.days: 曜日を 1 つ以上指定してください"]);
  });

  test("weekly の曜日が重複していれば拒否する", () => {
    const input = validConfig();
    input.schedules.push(
      schedule({ repeat: { kind: "weekly", days: ["mon", "mon"], time: "07:30" } }),
    );

    expectRejected(input, ["schedules.0.repeat.days: 曜日が重複しています"]);
  });

  test("weekly で曜日を省略した指定を拒否する", () => {
    const input = validConfig();
    input.schedules.push(schedule({ repeat: { kind: "weekly", time: "07:30" } }));

    expectRejected(input, ["schedules.0.repeat.days: 必須です"]);
  });

  test("曜日の値を検証する", () => {
    const input = validConfig();
    input.schedules.push(
      schedule({ repeat: { kind: "weekly", days: ["monday"], time: "07:30" } }),
    );

    expectRejected(input, [
      "schedules.0.repeat.days.0: mon/tue/wed/thu/fri/sat/sun のいずれかで指定してください",
    ]);
  });

  test("時刻の形式を検証する", () => {
    for (const time of ["7:30", "24:00", "23:60", "23:30:00", "2330"]) {
      const input = validConfig();
      input.schedules.push(schedule({ repeat: { kind: "daily", time } }));

      expectRejected(input, ["schedules.0.repeat.time: HH:MM の 24 時間表記で指定してください"]);
    }
  });

  test("enabled は真偽値のみを受け付ける", () => {
    const input = validConfig();
    input.schedules.push(schedule({ enabled: "true" }));

    expectRejected(input, ["schedules.0.enabled: 真偽値で指定してください"]);
  });

  test("定義済みの予約は通り、対象は型で判別できる", () => {
    const input = validConfig();
    input.schedules.push(
      schedule(),
      schedule({
        id: "storage-morning-wake",
        target: { type: "server", id: "nas" },
        operation: "wake",
        repeat: { kind: "weekly", days: ["mon", "fri"], time: "07:30" },
      }),
    );

    const config = parseManagedConfig(input);
    expect(config.schedules).toHaveLength(2);
    expect(config.schedules[1]?.target).toEqual({ type: "server", id: "nas" });
  });
});
