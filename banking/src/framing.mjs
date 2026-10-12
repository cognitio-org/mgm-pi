// MCP stdio is either newline-delimited JSON or Content-Length frames.
// Accept both, and reply in the framing the client just used.
const MAX_BUFFER = 1024 * 1024;

export function createFrameParser(onMessage) {
  let buf = Buffer.alloc(0);
  return {
    push(chunk) {
      buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buf.length > MAX_BUFFER) throw new Error("MCP message is too large.");
      while (buf.length) {
        if (buf[0] === 0x20 || buf[0] === 0x09 || buf[0] === 0x0a || buf[0] === 0x0d) {
          buf = buf.subarray(1);
          continue;
        }
        if (buf[0] === 0x7b) {
          const nl = buf.indexOf(0x0a);
          if (nl < 0) return;
          const line = buf.subarray(0, nl).toString("utf8").replace(/\r$/, "");
          buf = buf.subarray(nl + 1);
          onMessage(JSON.parse(line), "ndjson");
          continue;
        }
        const head = buf.subarray(0, Math.min(buf.length, 20)).toString("utf8").toLowerCase();
        if (head.startsWith("content-length")) {
          const sep = buf.indexOf("\r\n\r\n");
          if (sep < 0) return;
          const header = buf.subarray(0, sep).toString("utf8");
          const match = /content-length:\s*(\d+)/i.exec(header);
          if (!match) throw new Error("MCP frame is missing Content-Length.");
          const len = Number(match[1]);
          if (!Number.isInteger(len) || len < 2 || len > MAX_BUFFER) throw new Error("MCP Content-Length is invalid.");
          const start = sep + 4;
          if (buf.length < start + len) return;
          const body = buf.subarray(start, start + len).toString("utf8");
          buf = buf.subarray(start + len);
          onMessage(JSON.parse(body), "content-length");
          continue;
        }
        throw new Error("Unrecognized MCP frame.");
      }
    },
  };
}

export function encodeFrame(message, framing) {
  const json = JSON.stringify(message);
  if (framing === "content-length") {
    const body = Buffer.from(json, "utf8");
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8"), body]);
  }
  return Buffer.from(`${json}\n`, "utf8");
}
