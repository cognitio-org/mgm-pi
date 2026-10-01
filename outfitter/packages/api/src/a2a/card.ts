// E9 §5.1 Agent Cards. The public card (GET /.well-known/agent-card.json, unauthenticated) has one
// generic `coding` skill and never names a tape. The extended card (GetExtendedAgentCard, with a
// key) lists the tapes that key may use.

import { AgentCard } from "@a2a-js/sdk";
import type { Config } from "../config.ts";
import type { Guru } from "../store/types.ts";

/** The outfitter-task extension: tape and repo in `message.metadata[<uri>]`. */
export const OUTFITTER_TASK_EXTENSION = "https://kernal.one/a2a/ext/outfitter-task/v1";
export const A2A_PROTOCOL_VERSION = "1.0";

const BLOCKING_NOTE =
  "Send returnImmediately: true, then poll GetTask; a blocking SendMessage returns after at most 25 s with the task as it is.";

/** The link origin the card points callers at: the link role's own origin, or (role "all") the
 * configured link origin, else this process's. */
export function a2aOrigin(config: Pick<Config, "role" | "origin" | "linkOrigin">): string {
  const origin = config.role === "link" ? config.origin : config.linkOrigin || config.origin;
  return origin.replace(/\/+$/, "");
}

/** The public card as v1.0 proto-JSON. */
export function publicCardJson(config: Pick<Config, "role" | "origin" | "linkOrigin" | "release" | "buildCommit">): Record<string, unknown> {
  return {
    name: "Outfitter",
    description:
      "Outfitter runs coding tasks in cloud Drives: it clones a repository, works on a branch of its own " +
      `(outfitter/a2a-*), pushes it, and reports the branch and head. ${BLOCKING_NOTE}`,
    version: config.release || config.buildCommit || "dev",
    provider: { organization: "Kernal", url: "https://kernal.one" },
    supportedInterfaces: [{ url: `${a2aOrigin(config)}/a2a`, protocolBinding: "JSONRPC", protocolVersion: A2A_PROTOCOL_VERSION }],
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json"],
    capabilities: {
      // PR6 turns streaming on with SendStreamingMessage/SubscribeToTask; until then both return
      // UnsupportedOperation, and clients (the Python a2a-sdk streams whenever this is true) must
      // not be told otherwise.
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: true,
      extensions: [
        {
          uri: OUTFITTER_TASK_EXTENSION,
          description: "Choose the tape (skill), repository (owner/name) and base branch: message.metadata[<uri>] = {skill?, repo?, baseBranch?}.",
          required: false,
        },
      ],
    },
    securitySchemes: { outfitterKey: { httpAuthSecurityScheme: { scheme: "Bearer", description: "An Outfitter A2A key (outf_...)." } } },
    securityRequirements: [{ schemes: { outfitterKey: { list: [] } } }],
    skills: [
      {
        id: "coding",
        name: "Coding",
        description: `Fix, change or explain code in a repository the key allows. ${BLOCKING_NOTE}`,
        tags: ["coding", "git"],
      },
    ],
  };
}

export function publicCard(config: Parameters<typeof publicCardJson>[0]): AgentCard {
  return AgentCard.fromJSON(publicCardJson(config));
}

/** The extended card: the public one, with the key's usable tapes as skills (id = tape id). */
export function extendedCard(config: Parameters<typeof publicCardJson>[0], tapes: Pick<Guru, "id" | "name">[]): AgentCard {
  const base = publicCardJson(config);
  return AgentCard.fromJSON({
    ...base,
    skills: tapes.map((t) => ({
      id: t.id,
      name: t.name || t.id,
      description: `Run the task on the "${t.name || t.id}" tape: metadata {skill: "${t.id}"} under ${OUTFITTER_TASK_EXTENSION}. ${BLOCKING_NOTE}`,
      tags: ["coding", "tape"],
    })),
  });
}
