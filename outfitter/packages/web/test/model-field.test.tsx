// @vitest-environment jsdom
// #458: model-valued settings are searchable dropdowns, not free-text boxes. The editor against
// GET /api/config/models (fetch mocked): the list follows the selected provider, typing searches,
// "Other…" types any id, a stored value that isn't listed is kept and marked, a locked value is
// read-only, and no list falls back to the plain text box.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsEditor } from "../src/components/account/SettingsEditor.tsx";
import type { ConfigResponse, SettingDecl, SettingsDocView } from "../src/api/account.ts";
import { choicesFor, filterChoices, inList } from "../src/lib/model-choices.ts";
import { menuItems } from "../src/components/account/ModelField.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const PERSONAL = ["fleet", "user", "profile", "device", "local"] as SettingDecl["levels"];
const decls: SettingDecl[] = [
  { key: "model.provider", type: "enum", values: ["litellm", "lmstudio", "openrouter"], secret: false, levels: PERSONAL, override: "any", default: "litellm", since: 1, description: "Backend." },
  { key: "model.default", type: "string", secret: false, levels: PERSONAL, override: "any", since: 1, description: "Start model." },
  { key: "compaction.summaryModel", type: "string", secret: false, levels: PERSONAL, override: "any", since: 1, description: "Summarizer." },
];

const OPTIONS = {
  providers: [
    { id: "litellm", label: "Router", models: ["claude-auto-llm", "gpt-5.4-nano", "gemini-auto-llm"] },
    { id: "openrouter", label: "OpenRouter", models: ["anthropic/claude-sonnet-5", "openai/gpt-5.5"] },
    { id: "lmstudio", label: "Local server", models: [], note: "A local server's models are only known on that computer." },
  ],
};

function effective(locked: string[] = []): ConfigResponse {
  const v = (value: string, key: string) => ({ value, source: locked.includes(key) ? ("fleet" as const) : ("user" as const), override: locked.includes(key) ? ("none" as const) : ("any" as const), locked: locked.includes(key), localAllowed: !locked.includes(key) });
  return {
    schemaVersion: 3,
    account: { email: "dev@localhost", userId: "u_abc" },
    profile: null,
    profiles: [],
    deviceId: null,
    values: { "model.provider": v("litellm", "model.provider"), "model.default": v("gpt-x", "model.default") },
    versions: { fleet: 1, user: 1 },
    resolvedAt: "2026-10-05T00:00:00Z",
  };
}

function stub(modelsStatus = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      if (url.startsWith("/api/config/models")) return modelsStatus === 200 ? json(OPTIONS) : json({ error: "nope" }, modelsStatus);
      return json({ error: "not found" }, 404);
    }),
  );
  return calls;
}

async function render(opts: { values?: Record<string, string>; locked?: string[]; profile?: string } = {}) {
  const onSave = vi.fn(async (values: Record<string, unknown>, version: number): Promise<SettingsDocView> => ({ id: "user:u_abc", level: "user", values: values as Record<string, string>, version: version + 1 }));
  const doc: SettingsDocView = { id: "user:u_abc", level: "user", values: opts.values ?? {}, version: 1 };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root!.render(<SettingsEditor label="Account-wide settings" decls={decls} doc={doc} effective={effective(opts.locked)} onSave={onSave} onReload={() => {}} profile={opts.profile} />),
  );
  for (let i = 0; i < 5; i++) await act(async () => {});
  return { onSave };
}

const field = (key: string) => container!.querySelector(`[aria-label="${key} value"]`) as HTMLInputElement | HTMLSelectElement;
const options = () => [...container!.querySelectorAll('[role="option"]')].map((o) => o.textContent ?? "");

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

async function key(el: HTMLElement, k: string) {
  await act(async () => {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
  });
}

async function openMenu(k: string) {
  await act(async () => field(k).click());
}

async function pick(text: string) {
  const btn = [...container!.querySelectorAll('[role="option"]')].find((o) => o.textContent?.startsWith(text)) as HTMLButtonElement | undefined;
  if (!btn) throw new Error(`no option "${text}" in ${JSON.stringify(options())}`);
  await act(async () => btn.click());
}

async function save() {
  const btn = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Save") as HTMLButtonElement;
  await act(async () => btn.click());
  for (let i = 0; i < 3; i++) await act(async () => {});
}

describe("model-choices", () => {
  it("model.default lists the selected provider's models; the summarizer every provider's as provider/id, the selected first", () => {
    expect(choicesFor("model.default", "openrouter", OPTIONS)!.choices.map((c) => c.value)).toEqual(["anthropic/claude-sonnet-5", "openai/gpt-5.5"]);
    expect(choicesFor("model.default", "lmstudio", OPTIONS)!.note).toMatch(/only known on that computer/);
    const summary = choicesFor("compaction.summaryModel", "openrouter", OPTIONS)!.choices.map((c) => c.value);
    // "self" (summarize with the working model) first, then the selected provider's.
    expect(summary.slice(0, 2)).toEqual(["self", "openrouter/anthropic/claude-sonnet-5"]);
    expect(summary).toContain("litellm/gpt-5.4-nano");
    expect(choicesFor("model.default", "litellm", null)).toBeNull();
  });

  it("searches case-insensitively, and an empty value is always in the list", () => {
    const set = choicesFor("model.default", "litellm", OPTIONS)!.choices;
    expect(filterChoices(set, "AUTO").map((c) => c.value)).toEqual(["claude-auto-llm", "gemini-auto-llm"]);
    expect(inList(set, "")).toBe(true);
    expect(inList(set, "gpt-x")).toBe(false);
    // An unlisted stored value comes right after "not set"; "Other…" is always last.
    expect(menuItems(set, "gpt-x", "").map((i) => i.kind)).toEqual(["unset", "current", "model", "model", "model", "other"]);
    expect(menuItems(set, "", "zzz")).toEqual([{ kind: "other", query: "zzz" }]);
  });
});

describe("SettingsEditor model dropdowns", () => {
  it("asks for the options once, for the profile being edited", async () => {
    const calls = stub();
    await render({ profile: "work" });
    expect(calls.filter((c) => c.startsWith("/api/config/models"))).toEqual(["/api/config/models?profile=work"]);
    act(() => root?.unmount());
    container?.remove();
    // The account-wide editor asks for the account's own list, without the default profile's adds.
    const again = stub();
    await render();
    expect(again.filter((c) => c.startsWith("/api/config/models"))).toEqual(["/api/config/models?scope=account"]);
    expect(field("model.default").getAttribute("role")).toBe("combobox");
    // model.provider is a select with the providers named.
    expect([...(field("model.provider") as HTMLSelectElement).options].map((o) => o.textContent)).toContain("openrouter: OpenRouter");
  });

  it("filters by the selected provider and by what is typed, and saves the pick", async () => {
    stub();
    const { onSave } = await render();
    await openMenu("model.default");
    expect(options()).toContain("claude-auto-llm");
    expect(options().some((o) => o.includes("anthropic/claude-sonnet-5"))).toBe(false);
    await act(async () => setValue(field("model.default") as HTMLInputElement, "gemini"));
    expect(options()).toEqual(["gemini-auto-llm", 'Other: use "gemini"']);
    await pick("gemini-auto-llm");
    expect((field("model.default") as HTMLInputElement).value).toBe("gemini-auto-llm");

    // Switching the provider lists that provider's models instead.
    await act(async () => setValue(field("model.provider"), "openrouter"));
    await openMenu("model.default");
    expect(options()).toContain("anthropic/claude-sonnet-5");
    expect(options()).not.toContain("claude-auto-llm");
    // gemini-auto-llm isn't OpenRouter's: it stays, marked.
    expect(options()).toContain("gemini-auto-llmnot in the listcurrent");
    await save();
    expect(onSave).toHaveBeenCalledWith({ "model.provider": "openrouter", "model.default": "gemini-auto-llm" }, 1);
  });

  it("picks with the keyboard: arrows move, Enter picks without submitting, Escape closes", async () => {
    stub();
    const { onSave } = await render();
    const input = field("model.default") as HTMLInputElement;
    await key(input, "ArrowDown");
    expect(input.getAttribute("aria-expanded")).toBe("true");
    await key(input, "ArrowDown");
    const activeId = input.getAttribute("aria-activedescendant")!;
    expect(container!.querySelector(`#${CSS.escape(activeId)}`)?.textContent).toBe("claude-auto-llm");
    await key(input, "Enter");
    expect(input.value).toBe("claude-auto-llm");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(onSave).not.toHaveBeenCalled();
    await key(input, "ArrowDown");
    await key(input, "Escape");
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("leaving the box keeps what was typed: a listed model in its own case, else the text as typed", async () => {
    stub();
    const { onSave } = await render();
    const input = () => field("model.default") as HTMLInputElement;
    await openMenu("model.default");
    await act(async () => setValue(input(), "GPT-5.4-NANO"));
    await act(async () => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(input().value).toBe("gpt-5.4-nano");
    expect(input().getAttribute("role")).toBe("combobox");
    await openMenu("model.default");
    await act(async () => setValue(input(), "typed-then-tabbed"));
    await act(async () => input().dispatchEvent(new FocusEvent("focusout", { bubbles: true })));
    expect(input().value).toBe("typed-then-tabbed");
    expect(input().getAttribute("role")).toBeNull();
    await save();
    expect(onSave).toHaveBeenCalledWith({ "model.default": "typed-then-tabbed" }, 1);
  });

  it("typing over an unlisted stored value makes Enter pick the first listed match", async () => {
    stub();
    const { onSave } = await render({ values: { "model.default": "claude-auto-llm-old" } });
    const input = field("model.default") as HTMLInputElement;
    await openMenu("model.default");
    await act(async () => setValue(input, "claude-auto"));
    expect(options()[0]).toContain("claude-auto-llm-old");
    await key(input, "Enter");
    expect(input.value).toBe("claude-auto-llm");
    await save();
    expect(onSave).toHaveBeenCalledWith({ "model.default": "claude-auto-llm" }, 1);
  });

  it("clearing this level's own provider lists the default provider's models, not the one going away", async () => {
    stub();
    await render({ values: { "model.provider": "openrouter" } });
    await act(async () => setValue(field("model.provider"), ""));
    await openMenu("model.default");
    expect(options()).toContain("claude-auto-llm");
    expect(options()).not.toContain("anthropic/claude-sonnet-5");
  });

  it("shows a stored value that isn't in the list, marked, and keeps it", async () => {
    stub();
    const { onSave } = await render({ values: { "model.default": "my-private-model" } });
    expect((field("model.default") as HTMLInputElement).value).toBe("my-private-model");
    expect(container!.textContent).toContain("not in the list");
    await save();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Other… types any id; what was typed comes along", async () => {
    stub();
    const { onSave } = await render();
    await openMenu("model.default");
    await act(async () => setValue(field("model.default") as HTMLInputElement, "brand-new-model"));
    await pick('Other: use "brand-new-model"');
    const input = field("model.default") as HTMLInputElement;
    expect(input.getAttribute("role")).toBeNull();
    expect(input.value).toBe("brand-new-model");
    expect(document.activeElement).toBe(input);
    expect(container!.textContent).toContain("not in the list");
    await act(async () => setValue(input, "brand-new-model-2"));
    await save();
    expect(onSave).toHaveBeenCalledWith({ "model.default": "brand-new-model-2" }, 1);
    // And back to the list.
    const back = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Choose from the list") as HTMLButtonElement;
    await act(async () => back.click());
    expect(field("model.default").getAttribute("role")).toBe("combobox");
  });

  it("'not set here' clears the value", async () => {
    stub();
    const { onSave } = await render({ values: { "model.default": "gpt-5.4-nano" } });
    await openMenu("model.default");
    await pick("not set here");
    await save();
    expect(onSave).toHaveBeenCalledWith({ "model.default": null }, 1);
  });

  it("a value the Sysop locks is read-only and opens no list", async () => {
    stub();
    await render({ locked: ["model.default"] });
    const input = field("model.default") as HTMLInputElement;
    expect(input.disabled).toBe(true);
    await openMenu("model.default");
    expect(options()).toEqual([]);
    expect(container!.textContent).toContain("set by your Sysop");
  });

  it("the summarizer offers every provider's models as provider/id", async () => {
    stub();
    await render();
    await openMenu("compaction.summaryModel");
    expect(options()).toContain("litellm/gpt-5.4-nano");
    expect(options()).toContain("self");
    expect(options()).toContain("openrouter/openai/gpt-5.5");
    expect(container!.querySelector('[role="listbox"]')?.textContent).toContain("OpenRouter");
  });

  it("with no list (the options failed, or a provider with none) it is the plain text box", async () => {
    stub(500);
    await render();
    const input = field("model.default") as HTMLInputElement;
    expect(input.getAttribute("role")).toBeNull();
    await act(async () => setValue(input, "typed"));
    expect(input.value).toBe("typed");

    act(() => root?.unmount());
    container?.remove();
    stub();
    await render({ values: { "model.provider": "lmstudio" } });
    expect(field("model.default").getAttribute("role")).toBeNull();
    expect(container!.textContent).toContain("only known on that computer");
  });
});
