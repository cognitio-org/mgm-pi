import assert from "node:assert/strict";
import { test } from "node:test";
import { greetingName } from "../src/greeting.ts";

test("a recorded display name keeps its first word and its capitals", () => {
  assert.equal(greetingName({ name: "Matthew Monteleone", email: "mgm@mgms.eu" }), "Matthew");
  assert.equal(greetingName({ name: "  Anne-Marie  ", email: "a@b.c" }), "Anne-Marie");
});

test("without a recorded name, the sign-in address supplies one", () => {
  assert.equal(greetingName({ email: "mgm@mgms.eu" }), "Mgm");
  assert.equal(greetingName({ email: "matthew.monteleone@example.com" }), "Matthew");
});

test("a name that is not safe to print is dropped", () => {
  assert.equal(greetingName({ name: "<script>", email: "1bad@example.com" }), undefined);
  assert.equal(greetingName({ email: "a@b.c" }), undefined);
  assert.equal(greetingName({ email: "" }), undefined);
});
