import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api/client.ts";
import { toApiErrorState } from "../src/lib/api-error.ts";

describe("toApiErrorState", () => {
  it("keeps an ApiError's real status and message", () => {
    const err = new ApiError(404, "guru not found");
    expect(toApiErrorState(err, "fallback")).toEqual({ status: 404, message: "guru not found" });
  });

  it("falls back to the given message for a non-ApiError (network failure, thrown string, etc)", () => {
    expect(toApiErrorState(new TypeError("Failed to fetch"), "Failed to load fleet")).toEqual({
      message: "Failed to load fleet",
    });
    expect(toApiErrorState("boom", "Failed to load fleet")).toEqual({ message: "Failed to load fleet" });
  });
});
