import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { classifyRequestFailure, describeError, logRequestFailure } from "../server/log.ts";

const csrfMessage =
  "The `request.url` origin does not match `origin` header from a forwarded action request. Aborting the action.";

describe("リクエスト失敗の分類", () => {
  test("CSRF 検査の失敗を csrf_rejected にする", () => {
    expect(classifyRequestFailure(new Error(csrfMessage))).toBe("csrf_rejected");
  });

  test("Origin ヘッダーの解釈失敗を request_rejected にする", () => {
    expect(
      classifyRequestFailure(new Error("`origin` header is not a valid URL. Aborting the action.")),
    ).toBe("request_rejected");
  });

  test("それ以外の例外は internal_error にする", () => {
    expect(classifyRequestFailure(new Error("boom"))).toBe("internal_error");
    expect(classifyRequestFailure("文字列")).toBe("internal_error");
    expect(classifyRequestFailure(undefined)).toBe("internal_error");
  });

  test("404・405 などの想定内の拒否を internal_error にしない", () => {
    // React Router は `ErrorResponseImpl`（`Error` でも `Response` でもない）を投げる。
    // これを内部障害として記録すると、実際の不具合がログから埋もれる。
    const notAllowed = Object.assign(new Error("Invalid request method \"POST\""), {
      status: 405,
      statusText: "Method Not Allowed",
    });

    expect(classifyRequestFailure(notAllowed)).toBe("request_rejected");
    expect(describeError(notAllowed)).toBe("status 405");
  });

  test("status を持たないオブジェクトは internal_error のままにする", () => {
    expect(classifyRequestFailure({ status: "405" })).toBe("internal_error");
    expect(classifyRequestFailure({ status: 200 })).toBe("internal_error");
  });
});

describe("reason の整形", () => {
  test("複数行のメッセージを 1 行に潰す", () => {
    expect(describeError(new Error("line one\n  line two\tline three"))).toBe(
      "line one line two line three",
    );
  });

  test("空のメッセージは unknown にする", () => {
    expect(describeError(new Error("   \n "))).toBe("unknown");
  });

  test("200 文字を超えるメッセージは切り詰める", () => {
    const reason = describeError(new Error("あ".repeat(300)));

    expect(reason).toHaveLength(201);
    expect(reason.endsWith("…")).toBe(true);
  });

  test("中断は aborted にする", () => {
    const abortError = new Error("This operation was aborted");
    abortError.name = "AbortError";

    expect(describeError(abortError)).toBe("aborted");
  });
});

describe("request_failed の出力", () => {
  let errors: string[];

  beforeEach(() => {
    errors = [];
    vi.spyOn(console, "error").mockImplementation((line: string) => {
      errors.push(line);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("1 回の失敗につき 1 行の JSON を出す", () => {
    logRequestFailure(new Error(csrfMessage));

    expect(errors).toHaveLength(1);
    expect(errors[0]).not.toContain("\n");
    expect(JSON.parse(errors[0] ?? "")).toEqual({
      event: "request_failed",
      code: "csrf_rejected",
      reason: csrfMessage,
    });
  });

  test("スタックトレースを出さない", () => {
    const error = new Error("internal detail");
    error.stack = "Error: internal detail\n    at secretFunction (/app/secret.ts:1:1)";

    logRequestFailure(error);

    expect(errors[0]).not.toContain("secretFunction");
    expect(errors[0]).not.toContain("/app/secret.ts");
  });
});
