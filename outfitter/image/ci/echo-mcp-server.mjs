// A minimal stdio MCP server for the image's CI check that the bundled pi-mcp-adapter still works
// (#222): newline-delimited JSON-RPC, no SDK, one tool. It answers initialize with whatever protocol
// version the client asked for, lists `ci_echo`, and echoes calls; everything else is "method not
// found". Only CI runs it; it is never copied into the image.
import { createInterface } from "node:readline";

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const tool = {
  name: "ci_echo",
  description: "Echoes its text argument (CI check for the bundled pi-mcp-adapter).",
  inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

createInterface({ input: process.stdin }).on("line", (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return; // a notification (notifications/initialized, ...)
  switch (req.method) {
    case "initialize":
      return send({
        id: req.id,
        result: {
          protocolVersion: req.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "ci-echo", version: "1.0.0" },
        },
      });
    case "ping":
      return send({ id: req.id, result: {} });
    case "tools/list":
      return send({ id: req.id, result: { tools: [tool] } });
    case "tools/call":
      return send({ id: req.id, result: { content: [{ type: "text", text: `echo: ${req.params?.arguments?.text ?? ""}` }] } });
    default:
      return send({ id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});
