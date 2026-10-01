// @vitest-environment jsdom
// E9 §5.2: A2A keys on the Dongles page: the kind picker, the tape and repository pickers (tapes
// the api would refuse are disabled), and the kind shown in the list.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { TokensPage } from "../src/pages/TokensPage.tsx";
import { a2aTapeProblem, expiresIn, normalizeA2ARepo } from "../src/lib/a2a-keys.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
});

const tokens = [
  { id: "t1", ownerEmail: "dev@localhost", name: "laptop", prefix: "outf_ab1", createdAt: "2026-09-01T00:00:00Z", kind: "dongle" },
  {
    id: "t2",
    ownerEmail: "dev@localhost",
    name: "ae",
    prefix: "outf_cd2",
    createdAt: "2026-09-01T00:00:00Z",
    kind: "a2a",
    a2a: { tapes: ["coder"], repos: ["acme/widgets"], maxConcurrent: 2 },
  },
];

const gurus = [
  { id: "coder", name: "Coder", model: "m" },
  { id: "sysop", name: "Sysop", model: "m", adminTools: "manage" },
];

function stubFetch() {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url === "/api/me/tokens" && init?.method === "POST") {
        return json({ token: "outf_secret", record: { ...tokens[1], id: "t3", name: "new" } }, 201);
      }
      if (url === "/api/me/tokens") return json(tokens);
      if (url === "/api/me") return json({ email: "dev@localhost", linkOrigin: "https://link.example" });
      if (url === "/api/gurus") return json(gurus);
      return json({});
    }),
  );
  return calls;
}

async function render() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(<TokensPage />));
  await act(async () => {});
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
}

describe("TokensPage: A2A keys", () => {
  it("shows each token's kind and an A2A key's scope", async () => {
    stubFetch();
    await render();
    const text = container!.textContent ?? "";
    expect(text).toContain("A2A key · coder · acme/widgets");
    expect(text).toContain("Dongle");
  });

  it("creates an A2A key with the tapes and repositories picked; refused tapes are disabled", async () => {
    const calls = stubFetch();
    await render();
    const kind = container!.querySelector<HTMLSelectElement>('select[aria-label="Token kind"]')!;
    await act(async () => setValue(kind, "a2a"));
    await act(async () => {});
    const boxes = [...container!.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes).toHaveLength(2);
    expect(boxes[1].disabled).toBe(true);
    expect(container!.textContent).toContain("has admin tools");
    await act(async () => boxes[0].click());
    await act(async () => setValue(container!.querySelector<HTMLInputElement>('input[aria-label="Repository"]')!, "https://github.com/acme/widgets.git"));
    const add = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Add")!;
    await act(async () => add.click());
    await act(async () => setValue(container!.querySelector<HTMLInputElement>('input[aria-label="Token name"]')!, "new"));
    const create = [...container!.querySelectorAll("button")].find((b) => b.textContent === "Create A2A key")!;
    await act(async () => create.click());
    await act(async () => {});
    const post = calls.find((c) => c.init?.method === "POST")!;
    expect(JSON.parse(String(post.init!.body))).toEqual({
      name: "new",
      kind: "a2a",
      a2a: { tapes: ["coder"], repos: ["acme/widgets"], maxConcurrent: 2 },
    });
    expect(container!.textContent).toContain("OUTFITTER_A2A_URL=https://link.example");
  });
});

describe("a2a-keys helpers", () => {
  it("mirror the api's tape refusal", () => {
    expect(a2aTapeProblem({})).toBeUndefined();
    expect(a2aTapeProblem({ memory: "tool" })).toBeUndefined();
    expect(a2aTapeProblem({ adminTools: "operator" })).toBe("has admin tools");
    expect(a2aTapeProblem({ agentEngine: true })).toBeTruthy();
    expect(a2aTapeProblem({ memory: "auto" })).toBeTruthy();
    expect(a2aTapeProblem({ mergeFromCloud: true })).toBeTruthy();
  });

  it("normalize repositories and say when a key expires", () => {
    expect(normalizeA2ARepo(" acme/widgets ")).toBe("acme/widgets");
    expect(normalizeA2ARepo("https://github.com/acme/widgets.git")).toBe("acme/widgets");
    expect(normalizeA2ARepo("acme")).toBeUndefined();
    expect(normalizeA2ARepo("acme/..")).toBeUndefined();
    const now = Date.parse("2026-10-01T00:00:00Z");
    expect(expiresIn("2026-10-13T12:00:00Z", now)).toBe("expires in 12 days");
    expect(expiresIn("2026-10-01T05:00:00Z", now)).toBe("expires today");
    expect(expiresIn("2026-09-01T00:00:00Z", now)).toBe("expired");
  });
});
