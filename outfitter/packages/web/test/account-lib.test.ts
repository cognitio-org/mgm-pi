// #389 CA-7: the Account page's pure helpers (src/lib/account.ts).
import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.ts";
import type { SettingDecl } from "../src/api/account.ts";
import {
  accountErrorText,
  changedValues,
  currentMonth,
  editableDecls,
  formatUsd,
  formatValue,
  isStaleWrite,
  parseDraft,
  PROFILE_NAME_RE,
  providerKeyProblem,
  sourceLabel,
} from "../src/lib/account.ts";

const decl = (over: Partial<SettingDecl>): SettingDecl => ({
  key: "k",
  type: "string",
  secret: false,
  levels: ["fleet", "user", "profile", "device", "local"],
  override: "any",
  since: 1,
  description: "",
  ...over,
});

describe("editableDecls", () => {
  it("keeps declared, live, non-secret keys allowed at the level", () => {
    const settings = [
      decl({ key: "model.default" }),
      decl({ key: "router.key", secret: true, levels: ["device", "local"] }),
      decl({ key: "router.baseUrl", levels: ["fleet", "local"] }),
      decl({ key: "old", retired: true }),
      decl({ key: "localHost.shareModels", type: "boolean", levels: ["user", "profile", "device", "local"] }),
    ];
    expect(editableDecls(settings, "user").map((d) => d.key)).toEqual(["model.default", "localHost.shareModels"]);
    expect(editableDecls(settings, "device").map((d) => d.key)).toEqual(["model.default", "localHost.shareModels"]);
    expect(editableDecls(settings, "fleet").map((d) => d.key)).toEqual(["model.default", "router.baseUrl"]);
  });
});

describe("parseDraft", () => {
  it("treats an empty field as clearing the key", () => {
    expect(parseDraft(decl({}), "  ")).toEqual({ ok: true, value: null });
  });
  it("parses booleans, enums, numbers and urls", () => {
    expect(parseDraft(decl({ type: "boolean" }), "false")).toEqual({ ok: true, value: false });
    expect(parseDraft(decl({ type: "enum", values: ["off", "auto"] }), "auto")).toEqual({ ok: true, value: "auto" });
    expect(parseDraft(decl({ type: "enum", values: ["off", "auto"] }), "on").ok).toBe(false);
    expect(parseDraft(decl({ type: "number", min: 0, max: 1 }), "0.25")).toEqual({ ok: true, value: 0.25 });
    expect(parseDraft(decl({ type: "number", min: 0, max: 1 }), "2")).toEqual({ ok: false, problem: "at most 1" });
    expect(parseDraft(decl({ type: "number" }), "abc").ok).toBe(false);
    expect(parseDraft(decl({ type: "url" }), "https://x.example/v1")).toEqual({ ok: true, value: "https://x.example/v1" });
    expect(parseDraft(decl({ type: "url" }), "ftp://x").ok).toBe(false);
    expect(parseDraft(decl({ type: "url" }), "not a url").ok).toBe(false);
  });
});

describe("changedValues", () => {
  const decls = [decl({ key: "a" }), decl({ key: "b", type: "boolean" }), decl({ key: "c", type: "number" })];
  it("sends only changed keys, null for a cleared one", () => {
    const { values, problems } = changedValues(decls, { a: "x", b: true }, { a: "x", b: "", c: "3" });
    expect(values).toEqual({ b: null, c: 3 });
    expect(problems).toEqual({});
  });
  it("reports fields that don't parse and leaves them out", () => {
    const { values, problems } = changedValues(decls, {}, { a: "y", c: "nope" });
    expect(values).toEqual({ a: "y" });
    expect(Object.keys(problems)).toEqual(["c"]);
  });
  it("is empty when nothing changed", () => {
    expect(changedValues(decls, { a: "x" }, { a: "x", b: "", c: "" }).values).toEqual({});
  });
});

describe("labels and formats", () => {
  it("names sources in the page's words", () => {
    expect(sourceLabel({ source: "fleet" })).toBe("fleet");
    expect(sourceLabel({ source: "user" })).toBe("your account");
    expect(sourceLabel({ source: "profile", sourceName: "work" })).toBe("profile work");
    expect(sourceLabel({ source: "default" })).toBe("default");
  });
  it("formats values, money and the month", () => {
    expect(formatValue(true)).toBe("on");
    expect(formatValue(undefined)).toBe("—");
    expect(formatUsd(1.5)).toBe("$1.50");
    expect(currentMonth(new Date("2026-10-04T23:30:00Z"))).toBe("2026-10");
  });
  it("checks profile names and provider keys like the api", () => {
    expect(PROFILE_NAME_RE.test("work-2")).toBe(true);
    expect(PROFILE_NAME_RE.test("-work")).toBe(false);
    expect(PROFILE_NAME_RE.test("Work")).toBe(false);
    expect(providerKeyProblem("short")).not.toBeNull();
    expect(providerKeyProblem("sk-has space")).not.toBeNull();
    expect(providerKeyProblem("sk-or-v1-abcdef")).toBeNull();
  });
  it("recognises a stale write and maps error codes", () => {
    expect(isStaleWrite(new ApiError(409, "stale_version"))).toBe(true);
    expect(isStaleWrite(new ApiError(409, "profile_exists"))).toBe(false);
    expect(accountErrorText(new ApiError(409, "profile_exists"), "x")).toMatch(/already exists/);
    expect(accountErrorText(new Error("boom"), "fallback")).toBe("fallback");
  });
});
