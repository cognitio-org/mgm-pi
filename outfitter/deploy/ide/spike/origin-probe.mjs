// S3: which header combinations code-server 4.139.1 accepts on the WebSocket upgrade (direct, no proxy).
import { connect } from "node:net";
const tries = {
  "proxy-style (Host=localhost, XFH=public, Origin=localhost)": { host: "localhost:18080", xfh: "ide-test.kernal.run:5000", origin: "http://localhost:18080" },
  "Origin=public, XFH=public, Host=localhost": { host: "localhost:18080", xfh: "ide-test.kernal.run:5000", origin: "http://ide-test.kernal.run:5000" },
  "no XFH, Origin=localhost": { host: "localhost:18080", origin: "http://localhost:18080" },
  "Origin=public, no XFH": { host: "localhost:18080", origin: "https://ide-test.kernal.run" },
};
for (const [name, h] of Object.entries(tries)) {
  const res = await new Promise((resolve) => {
    const s = connect(18080, "127.0.0.1", () => {
      s.write(`GET /stable-53c2f3253bcf32886706fc023e794bbeb253c90f?reconnectionToken=x&reconnection=false&skipWebSocketFrames=false HTTP/1.1\r\nHost: ${h.host}\r\n${h.xfh ? `X-Forwarded-Host: ${h.xfh}\r\nX-Forwarded-Proto: https\r\n` : ""}Origin: ${h.origin}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    s.once("data", (d) => { resolve(d.toString().split("\r\n")[0]); s.destroy(); });
    setTimeout(() => { resolve("timeout"); s.destroy(); }, 3000);
  });
  console.log(res.padEnd(40), name);
}
