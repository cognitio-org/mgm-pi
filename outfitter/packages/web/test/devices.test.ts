// #389 CA-1 web: the pure helpers behind the approve page and the Devices page (lib/devices.ts).
import { describe, expect, it } from "vitest";
import {
  codeExpiry,
  deviceIp,
  formatUserCodeInput,
  ipsDiffer,
  isExpired,
  normalizeUserCode,
  platformLabel,
  userCodeLetters,
} from "../src/lib/devices.ts";

describe("user codes (spec §1.2)", () => {
  it("normalizes like the api: uppercase, alphabet only, exactly 8 letters", () => {
    expect(normalizeUserCode("BCDF-GHJK")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("bcdf ghjk")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("  bc-df-gh-jk\n")).toBe("BCDF-GHJK");
    expect(normalizeUserCode("BCDFGHJ")).toBeNull();
    expect(normalizeUserCode("BCDFGHJKL")).toBeNull();
    expect(normalizeUserCode("")).toBeNull();
  });

  it("drops vowels, digits and Y, which the alphabet never uses", () => {
    expect(userCodeLetters("A0E1I-OUY")).toBe("");
    expect(normalizeUserCode("BCDA-FGHJK")).toBe("BCDF-GHJK");
  });

  it("formats the field while typing, never past 8 letters", () => {
    expect(formatUserCodeInput("bcd")).toBe("BCD");
    expect(formatUserCodeInput("bcdf")).toBe("BCDF");
    expect(formatUserCodeInput("bcdfg")).toBe("BCDF-G");
    expect(formatUserCodeInput("BCDF-GHJKLMN")).toBe("BCDF-GHJK");
  });
});

describe("ipsDiffer (spec §1.9)", () => {
  it("warns only when both addresses are known and differ", () => {
    expect(ipsDiffer("203.0.113.5", "198.51.100.7")).toBe(true);
    expect(ipsDiffer("203.0.113.5", "203.0.113.5")).toBe(false);
    expect(ipsDiffer("::ffff:203.0.113.5", "203.0.113.5")).toBe(false);
    expect(ipsDiffer("2001:DB8::1", "2001:db8::1")).toBe(false);
    expect(ipsDiffer(undefined, "203.0.113.5")).toBe(false);
    expect(ipsDiffer("203.0.113.5", undefined)).toBe(false);
    expect(ipsDiffer("203.0.113.5", " ")).toBe(false);
  });
});

describe("platformLabel", () => {
  it("names the common platforms and passes anything else through", () => {
    expect(platformLabel("darwin-arm64")).toBe("macOS, Apple silicon");
    expect(platformLabel("darwin-x64")).toBe("macOS, Intel");
    expect(platformLabel("linux-arm64")).toBe("Linux, ARM");
    expect(platformLabel("linux-x64")).toBe("Linux, x86-64");
    expect(platformLabel("win32")).toBe("Windows");
    expect(platformLabel("freebsd-x64")).toBe("freebsd-x64");
    expect(platformLabel(undefined)).toBeUndefined();
  });
});

describe("expiry", () => {
  const now = Date.parse("2026-10-04T10:00:00Z");
  it("counts minutes down and says when the code is gone", () => {
    expect(codeExpiry("2026-10-04T10:07:30Z", now)).toBe("expires in 8 min");
    expect(codeExpiry("2026-10-04T10:00:40Z", now)).toBe("expires within a minute");
    expect(codeExpiry("2026-10-04T10:00:00Z", now)).toBe("expired");
    expect(isExpired("2026-10-04T10:00:00Z", now)).toBe(true);
    expect(isExpired("2026-10-04T10:00:01Z", now)).toBe(false);
    expect(isExpired("not a date", now)).toBe(false);
  });
});

describe("deviceIp", () => {
  it("prefers the last-seen address over the sign-in one", () => {
    expect(deviceIp({ lastSeenIp: "1.1.1.1", loginIp: "2.2.2.2" })).toBe("1.1.1.1");
    expect(deviceIp({ loginIp: "2.2.2.2" })).toBe("2.2.2.2");
    expect(deviceIp({})).toBeUndefined();
  });
});
