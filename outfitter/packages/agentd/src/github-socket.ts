/**
 * Unix socket the model (and kernal's BrokerBackend) uses for GitHub API calls: the `github` kind
 * of broker-socket.ts, which has the wire rules. The GitHub token is not an input here. It must
 * not be logged or copied into a result this module builds.
 */
import { listenBrokerSocket, type BrokerSocket, type BrokerSocketOptions } from "./broker-socket.js";
import type { DownGithubResult, UpGithubRequest } from "./protocol.js";

export interface GithubSocket extends Omit<BrokerSocket<"github">, "deliver"> {
  /** API down-frame. Unknown reqIds (already finished, or never forwarded) are ignored. */
  deliver(msg: DownGithubResult): void;
}

export interface GithubSocketOptions extends Omit<BrokerSocketOptions<"github">, "kind" | "send" | "attach"> {
  send: (msg: UpGithubRequest) => void;
  attach?: (socket: GithubSocket) => void;
}

export function listenGithubSocket(opts: GithubSocketOptions): Promise<GithubSocket> {
  return listenBrokerSocket({
    ...opts,
    kind: "github",
    send: (msg) => opts.send(msg as UpGithubRequest),
    attach: opts.attach ? (socket) => opts.attach!(socket as unknown as GithubSocket) : undefined,
  }) as unknown as Promise<GithubSocket>;
}
