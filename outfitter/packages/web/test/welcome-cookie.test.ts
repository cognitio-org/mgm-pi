import { describe, expect, test } from "vitest";
import { welcomeCookieAssignment } from "../src/lib/welcome-cookie.ts";

describe("welcomeCookieAssignment", () => {
  test("shares the cookie across kernal.one and locks it on https", () => {
    const line = welcomeCookieAssignment("Matthew", "app.kernal.one", true);
    expect(line).toContain("kernal_welcome=Matthew");
    expect(line).toContain("Domain=.kernal.one");
    expect(line).toContain("Secure");
    expect(line).toContain("SameSite=Lax");
  });

  test("stays on the current host outside kernal.one, and refuses markup", () => {
    const line = welcomeCookieAssignment("Ada", "localhost", false);
    expect(line).not.toContain("Domain=");
    expect(line).not.toContain("Secure");
    expect(welcomeCookieAssignment("<script>", "app.kernal.one", true)).toBeNull();
  });
});
