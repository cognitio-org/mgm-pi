import { afterEach, describe, expect, it, vi } from "vitest";
import {
  registerWebMcpTools,
  WEBMCP_TOOL_NAMES,
  type WebMcpClient,
  type WebMcpTool,
} from "../src/lib/webmcp.ts";

function fakeClient(): WebMcpClient {
  return {
    sessions: vi.fn(async () => []),
    createSession: vi.fn(async () => ({ session: { id: "new" }, run: null })),
    sendMessage: vi.fn(async () => ({ run: null })),
    abort: vi.fn(async () => ({ run: { id: "r" } })),
    stop: vi.fn(async () => ({ run: { id: "r" } })),
    entries: vi.fn(async () => []),
  } as unknown as WebMcpClient;
}

function captureTools(client: WebMcpClient = fakeClient()): { tools: WebMcpTool[]; signals: AbortSignal[] } {
  const tools: WebMcpTool[] = [];
  const signals: AbortSignal[] = [];
  registerWebMcpTools(
    "user@example.com",
    {
      modelContext: {
        registerTool(tool, options) {
          tools.push(tool);
          if (options?.signal) signals.push(options.signal);
        },
      },
    },
    client,
  );
  return { tools, signals };
}

describe("webmcp registrar", () => {
  afterEach(() => {
    registerWebMcpTools(null, {});
  });

  it("registers the seven fleet tool names on document.modelContext", () => {
    const { tools, signals } = captureTools();
    expect(tools.map((tool) => tool.name)).toEqual([...WEBMCP_TOOL_NAMES]);
    expect(new Set(WEBMCP_TOOL_NAMES).size).toBe(7);
    for (const tool of tools) {
      expect(tool.description).toMatch(/Use when/i);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
      for (const key of Object.keys(tool.inputSchema.properties)) {
        expect(key).not.toMatch(/token|dongle|authorization/i);
      }
    }
    expect(signals[0]?.aborted).toBe(false);
  });

  it("does not throw when modelContext is absent", () => {
    expect(() => registerWebMcpTools("user@example.com", {})).not.toThrow();
    expect(() => registerWebMcpTools("user@example.com", null)).not.toThrow();
    expect(() => registerWebMcpTools("user@example.com", { modelContext: null })).not.toThrow();
    expect(() => registerWebMcpTools("user@example.com", { modelContext: {} as never })).not.toThrow();
    expect(() => registerWebMcpTools("user@example.com")).not.toThrow();
    const registerTool = vi.fn();
    registerWebMcpTools(null, { modelContext: { registerTool } });
    expect(registerTool).not.toHaveBeenCalled();
  });

  it("replaces the previous registration when the signed-in user changes", () => {
    const signals: AbortSignal[] = [];
    const host = {
      modelContext: {
        registerTool(_tool: WebMcpTool, options?: { signal?: AbortSignal }) {
          if (options?.signal) signals.push(options.signal);
        },
      },
    };
    registerWebMcpTools("a@example.com", host);
    const first = signals[0];
    registerWebMcpTools("b@example.com", host);
    expect(first?.aborted).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(false);
    expect(signals).toHaveLength(14);
  });

  it("execute calls the page client and rejects a token", async () => {
    const client = fakeClient();
    const { tools } = captureTools(client);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    await byName.get("list_floppies")!.execute({ run_state: "running", guru: "g1" });
    expect(client.sessions).toHaveBeenCalledWith({ runState: "running", guru: "g1" });

    await byName.get("play")!.execute({ guru_id: "g1", prompt: "hi", repo: "org/repo", base_branch: "main" });
    expect(client.createSession).toHaveBeenCalledWith({
      guruId: "g1",
      prompt: "hi",
      repo: "org/repo",
      baseBranch: "main",
    });

    await byName.get("steer")!.execute({ session_id: "s1", text: "follow up" });
    expect(client.sendMessage).toHaveBeenCalledWith("s1", "follow up", "steer");

    await byName.get("break")!.execute({ session_id: "s1" });
    expect(client.abort).toHaveBeenCalledWith("s1");

    await byName.get("stop")!.execute({ session_id: "s1" });
    expect(client.stop).toHaveBeenCalledWith("s1");

    await expect(byName.get("eject")!.execute({ session_id: "s1" })).resolves.toEqual({
      command: "kernal --teleport s1",
    });

    await byName.get("read_transcript")!.execute({ session_id: "s1", after: "e9" });
    expect(client.entries).toHaveBeenCalledWith("s1", "e9");

    await expect(byName.get("play")!.execute({ guru_id: "g1", prompt: "hi", token: "secret" })).rejects.toThrow(/token/i);
    expect(client.createSession).toHaveBeenCalledTimes(1);
  });
});
