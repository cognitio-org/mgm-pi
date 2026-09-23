import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

await import(fileURLToPath(new URL("../public/welcome.js", import.meta.url)));
const read = globalThis.KernalWelcome.read;

test("a welcome cookie is the name and nothing else", () => {
  assert.equal(read("kernal_welcome=Matthew"), "Matthew");
  assert.equal(read("theme=dark; kernal_welcome=Anne-Marie; other=1"), "Anne-Marie");
  assert.equal(read("kernal_welcome=" + encodeURIComponent("José")), "José");
});

test("a cookie that is not a name is ignored", () => {
  assert.equal(read(""), "");
  assert.equal(read("kernal_welcome=" + encodeURIComponent("<script>")), "");
  assert.equal(read("kernal_welcome=" + encodeURIComponent("Matthew Monteleone")), "");
  assert.equal(read("kernal_welcome=%E0%A4%A"), "");
});

test("show writes text, not markup", () => {
  const el = { hidden: true, textContent: "", id: "welcome" };
  const doc = { cookie: "kernal_welcome=Matthew", getElementById: () => el };
  globalThis.KernalWelcome.show(doc);
  assert.equal(el.hidden, false);
  assert.equal(el.textContent, "Welcome back, Matthew.");
});
