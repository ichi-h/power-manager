import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  createConfigStore,
  loadManagedConfigForStartup,
} from "../app/lib/config-store.server.ts";
import { parseManagedConfig } from "../app/lib/runtime-config.server.ts";

import { validManagedConfig, validSchedule } from "./support/managed-config.ts";

/**
 * 設定ストアは「読み込む → 検証する → 成功時だけ差し替える」の順序が仕様である
 * （FR-08, NFR-13）。ファイル読込みまで含めて確かめたいので、実際の一時ファイルを使う。
 *
 * 差し替えの「原子性」は 2 通りで観測する。
 *
 * 1. 参照の同一性: 失敗したときに `current()` が同じオブジェクトを返し続けること。
 * 2. 内容の不変: `structuredClone` で取ったスナップショットと `toEqual` で一致すること。
 *
 * 1 だけでは「有効設定のオブジェクトを項目単位で書き換える」失敗モード（参照は同じまま
 * 中身が変わる）を検出できないため、2 を併せて確かめる。
 */
let directory: string;
let configPath: string;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "power-manager-config-"));
  configPath = path.join(directory, "config.json");
  await writeFile(configPath, JSON.stringify(validManagedConfig()));
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

/** 起動時と同じ経路でストアを作る。 */
async function store() {
  const initial = await loadManagedConfigForStartup(configPath);
  return createConfigStore(configPath, initial);
}

describe("起動時の読込み", () => {
  test("検証済みの設定を返す", async () => {
    const config = await loadManagedConfigForStartup(configPath);

    expect(config.version).toBe(2);
    expect(config.servers[0]?.id).toBe("nas");
  });

  test("BOM 付きのファイルも読める", async () => {
    await writeFile(configPath, `\uFEFF${JSON.stringify(validManagedConfig())}`);

    await expect(loadManagedConfigForStartup(configPath)).resolves.toMatchObject({ version: 2 });
  });

  test("存在しないファイルは「見つかりません」として拒否する", async () => {
    await expect(loadManagedConfigForStartup(path.join(directory, "missing.json"))).rejects.toThrow(
      /設定ファイルが見つかりません/,
    );
  });

  test("ディレクトリを指した場合は読取り失敗として拒否する", async () => {
    await expect(loadManagedConfigForStartup(directory)).rejects.toThrow(
      /設定ファイルを読み取れませんでした/,
    );
  });

  test("JSON として壊れたファイルは位置情報を出さずに拒否する", async () => {
    await writeFile(configPath, "{ version: 2 ");

    // JSON.parse のメッセージには入力の断片が入るため、そのままログへ流さない。
    await expect(loadManagedConfigForStartup(configPath)).rejects.toThrow(
      /^管理対象の設定が不正です（JSON として解釈できません）$/,
    );
  });
});

describe("再読込", () => {
  test("成功時は新しい定義に差し替える", async () => {
    const configStore = await store();
    const before = configStore.current();

    const changed = validManagedConfig();
    (changed.servers as Record<string, unknown>[])[0]!.name = "NAS（新しい名前）";
    await writeFile(configPath, JSON.stringify(changed));

    const result = await configStore.reload();

    expect(result.ok).toBe(true);
    expect(configStore.current().servers[0]?.name).toBe("NAS（新しい名前）");
    // 差し替えは新しいオブジェクトで行う（同じ実体を書き換えない）。
    expect(configStore.current()).not.toBe(before);
  });

  test("失敗時は旧設定を維持し、理由を返す（原子性）", async () => {
    const configStore = await store();
    const before = configStore.current();
    const snapshot = structuredClone(before);

    await writeFile(configPath, JSON.stringify({ ...validManagedConfig(), version: 1 }));
    const result = await configStore.reload();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("version");
    expect(result.issues.length).toBeGreaterThan(0);
    // 同一オブジェクトが残っている = 一部だけ反映された状態が無い。
    expect(configStore.current()).toBe(before);
    expect(configStore.current()).toEqual(snapshot);
  });

  test("相互参照の失敗でも旧設定を維持する", async () => {
    const configStore = await store();
    const before = configStore.current();
    const snapshot = structuredClone(before);

    const broken = validManagedConfig();
    (broken.schedules as unknown[]).push(validSchedule({ target: { type: "group", id: "missing" } }));
    await writeFile(configPath, JSON.stringify(broken));

    const result = await configStore.reload();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.issues.join(" ")).toContain(
      "group missing が定義されていません",
    );
    expect(configStore.current()).toBe(before);
    expect(configStore.current()).toEqual(snapshot);
  });

  test("ファイルが消えた場合も旧設定を維持する", async () => {
    const configStore = await store();
    const before = configStore.current();
    const snapshot = structuredClone(before);
    await rm(configPath);

    const result = await configStore.reload();

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("設定ファイルが見つかりません");
    expect(configStore.current()).toBe(before);
    expect(configStore.current()).toEqual(snapshot);
  });

  test("JSON が壊れていても旧設定を維持する", async () => {
    const configStore = await store();
    const before = configStore.current();
    const snapshot = structuredClone(before);
    await writeFile(configPath, "not json");

    const result = await configStore.reload();

    expect(result.ok).toBe(false);
    expect(configStore.current()).toBe(before);
    expect(configStore.current()).toEqual(snapshot);
  });

  test("失敗のあとに成功すれば差し替わる（旧設定は維持され続けない）", async () => {
    const configStore = await store();

    await writeFile(configPath, "not json");
    expect((await configStore.reload()).ok).toBe(false);

    const changed = validManagedConfig();
    (changed.groups as Record<string, unknown>[])[0]!.name = "新しいグループ名";
    await writeFile(configPath, JSON.stringify(changed));

    const result = await configStore.reload();
    expect(result.ok).toBe(true);
    expect(configStore.current().groups[0]?.name).toBe("新しいグループ名");
  });

  test("同梱の開発用の設定例（dev/config.json）を通す", async () => {
    const devConfig = path.resolve("dev/config.json");

    const config = await loadManagedConfigForStartup(devConfig);

    // p001 で README に載せる例そのものが検証を通ることを、ここで固定しておく。
    expect(config.servers.map((server) => server.id)).toEqual(["nas", "test-01"]);
    expect(config.schedules.map((schedule) => schedule.id)).toEqual([
      "test-night-shutdown",
      "storage-morning-wake",
    ]);
  });

  test("検証済みの設定を候補として渡すと、そのまま有効設定になる", async () => {
    const candidate = parseManagedConfig(validManagedConfig());
    const isolated = createConfigStore(configPath, candidate, async () => candidate);

    await isolated.reload();

    expect(isolated.current()).toBe(candidate);
  });
});
