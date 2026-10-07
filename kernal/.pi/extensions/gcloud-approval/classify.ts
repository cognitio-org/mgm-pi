/**
 * Read or write? (GA-4, #494.) A pure classifier for the command string an agent sends to Google's
 * remote gcloud MCP server (`run_gcloud_command`, `run_bq_command`). `read` runs without asking;
 * `write` asks the owner first. The default is `write`: a command is `read` only when every part of
 * it is recognised as non-mutating, so anything unparseable, unknown or tricky asks.
 *
 * gcloud reads: `gcloud [group...] <verb> [positionals] [flags]`, where every group before the verb
 * is in KNOWN_GROUPS (so `gcloud compute instances reset list`, a reset of a VM named "list", is not
 * a list) and the verb is one of the read verbs. bq reads: `ls`, `show`, `head`, and a plain
 * SELECT/WITH `query` with only harmless flags.
 *
 * Refused as `write` before any of that: shell metacharacters outside quotes, expansion characters
 * anywhere (`$`, backtick, backslash, newlines), a second command, and flags that change who or what
 * runs it (`--impersonate-service-account`, `--account`, `--flags-file`, ...).
 */

export type Risk = "read" | "write";
export type GcloudTool = "run_gcloud_command" | "run_bq_command";

const MAX_COMMAND = 2000;

/** Verbs that only read. `list-*` and `describe-*` are matched by prefix below. */
const READ_VERBS = new Set(["list", "describe", "get", "get-iam-policy", "get-value", "search-all-resources", "search-all-iam-policies", "read"]);

/** Groups that may precede a read verb. A group not here makes the command `write` (it asks). */
const KNOWN_GROUPS = new Set([
  "access-context-manager", "ai", "ai-platform", "api-gateway", "apigee", "app", "artifacts", "asset", "assured", "batch", "bigtable", "builds", "certificate-manager", "composer", "compute", "config", "container", "dataflow", "dataproc", "datastore", "deploy", "deployment-manager",
  "dns", "domains", "endpoints", "eventarc", "filestore", "firebase", "firestore", "functions", "iam", "iap", "kms", "logging", "memcache", "monitoring",
  "network-management", "networkservices", "notebooks", "organizations", "policy-troubleshoot", "pubsub", "recommender", "redis", "resource-manager",
  "run", "scheduler", "secrets", "services", "source", "spanner", "sql", "storage", "tasks", "workflows",
  "projects", "folders", "instances", "instance-groups", "managed", "unmanaged", "disks", "images", "snapshots", "networks", "subnets", "firewall-rules",
  "forwarding-rules", "addresses", "routers", "routes", "backend-services", "url-maps", "health-checks", "target-pools", "target-http-proxies",
  "target-https-proxies", "ssl-certificates", "ssl-policies", "operations", "zones", "regions", "machine-types", "accelerator-types", "commitments",
  "reservations", "resource-policies", "instance-templates", "node-groups", "node-templates", "vpn-gateways", "vpn-tunnels", "interconnects",
  "clusters", "node-pools", "images", "repositories", "packages", "versions", "tags", "docker", "revisions", "jobs", "executions", "triggers",
  "worker-pools", "service-accounts", "roles", "keys", "workload-identity-pools", "providers", "policies", "keyrings", "cryptokeys", "locations",
  "topics", "subscriptions", "snapshots", "schemas", "databases", "backups", "replicas", "flags", "tiers", "users", "buckets", "objects", "logs", "sinks",
  "metrics", "views", "buckets", "alert-policies", "channels", "dashboards", "uptime", "zones", "records", "managed-zones", "dns-keys", "functions",
  "services", "environments", "releases", "pipelines", "targets", "workflow", "ancestors", "hmac", "insights", "recommendations", "recommenders",
]);

/** Flags that change identity, credentials or arguments, whatever the verb: always ask. */
const FORBIDDEN_FLAGS = new Set([
  "--impersonate-service-account",
  "--account",
  "--configuration",
  "--access-token-file",
  "--credential-file-override",
  "--flags-file",
  "--billing-project",
  "--authorization-token-file",
  "--token-host",
]);

/** bq flags a plain SELECT may carry (always `--flag=value`, except the bare ones below). */
const BQ_QUERY_FLAGS = new Set(["--use_legacy_sql", "--format", "--max_rows", "--project_id", "--location", "--maximum_bytes_billed"]);

/** bq flags allowed before the verb and after `ls`/`show`/`head`. */
const BQ_READ_FLAGS = new Set(["--project_id", "--location", "--format", "--dataset_id", "--max_results", "--max_rows", "--api_version"]);

/** Flags that take no value, so the next word is not theirs. */
const BQ_BARE_FLAGS = new Set(["--headless", "--quiet", "--dry_run", "--nodry_run", "--nouse_legacy_sql", "--nouse_cache", "--sync", "--nosync", "--all"]);

/** What a SELECT must not contain: DDL, DML, scripting, and exports a query can run. */
const BQ_WRITE_WORDS = /\b(insert|update|delete|merge|create|drop|alter|truncate|call|execute|export|load|grant|revoke|begin|declare|set|assert|raise|into)\b/i;

/**
 * Splits like a shell, but only accepts the plain part: single and double quotes group words, and
 * anything that could start another command or expand (outside quotes `; | & < > ( ) { } * ? ~ !`
 * and newlines; anywhere `$`, backtick, backslash, NUL) makes the whole command unparseable.
 */
export function tokenize(command: string): string[] | undefined {
  const words: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | undefined;
  for (const ch of command) {
    if (ch === "$" || ch === "`" || ch === "\\" || ch === "\0" || ch === "\n" || ch === "\r") return undefined;
    if (quote) {
      if (ch === quote) quote = undefined;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      has = true;
      continue;
    }
    if (/[;|&<>(){}*?~!#]/.test(ch)) return undefined;
    if (ch === " " || ch === "\t") {
      if (has) words.push(cur);
      cur = "";
      has = false;
      continue;
    }
    cur += ch;
    has = true;
  }
  if (quote) return undefined;
  if (has) words.push(cur);
  return words;
}

const flagName = (w: string): string => w.split("=")[0];

/** A forbidden flag, or a prefix of one (argparse-style abbreviations, `--impersonate`). */
function usesForbiddenFlag(words: string[]): boolean {
  return words.some((w) => {
    if (!w.startsWith("-")) return false;
    const name = flagName(w);
    if (FORBIDDEN_FLAGS.has(name)) return true;
    return name.startsWith("--") && name.length >= 4 && [...FORBIDDEN_FLAGS].some((f) => f.startsWith(name));
  });
}

function isReadVerb(verb: string): boolean {
  return READ_VERBS.has(verb) || /^(list|describe)-[a-z0-9-]+$/.test(verb);
}

function classifyGcloud(words: string[]): Risk {
  if (usesForbiddenFlag(words)) return "write";
  // Leading flags (`gcloud --project x ...`) hide where the verb is: ask.
  const path: string[] = [];
  for (const w of words) {
    if (w.startsWith("-")) break;
    path.push(w);
  }
  if (path.length === 0) return words.length === 1 && (words[0] === "--version" || words[0] === "--help") ? "read" : "write";
  if (path.length === 1 && (path[0] === "info" || path[0] === "version")) return "read";
  // `storage ls`: the one verb that is not one of the above.
  const groupsThenVerb = (verbAt: number) => path.slice(0, verbAt).every((g) => KNOWN_GROUPS.has(g));
  for (let i = 1; i < path.length; i++) {
    const w = path[i];
    if (!isReadVerb(w) && !(w === "ls" && path[i - 1] === "storage")) continue;
    if (w === "read" && path[i - 1] !== "logging") return "write";
    // Everything before the verb is a known group; at most two positionals follow (a resource and a parent).
    return groupsThenVerb(i) && path.length - i - 1 <= 2 ? "read" : "write";
  }
  return "write";
}

/** Every flag is `--name=value` from `allowed`, or one of the bare flags (`bare`). */
function bqFlagsOk(words: string[], allowed: Set<string>, bare: Set<string>): boolean {
  return words.every((w) => !w.startsWith("-") || (w.includes("=") ? allowed.has(flagName(w)) : bare.has(w)));
}

function classifyBq(words: string[]): Risk {
  let i = 0;
  while (i < words.length && words[i].startsWith("-")) i++;
  // Leading flags are global ones, in the `--name=value` form, so none of them hides the verb.
  if (!bqFlagsOk(words.slice(0, i), BQ_READ_FLAGS, new Set(["--headless", "--quiet"]))) return "write";
  const verb = words[i];
  const rest = words.slice(i + 1);
  if (verb === "ls" || verb === "show" || verb === "head" || verb === "version") {
    return bqFlagsOk(rest, BQ_READ_FLAGS, BQ_BARE_FLAGS) ? "read" : "write";
  }
  return verb === "query" ? classifyBqQuery(rest) : "write";
}

/** A plain SELECT/WITH: one statement, harmless flags, no DML/DDL/scripting words. */
function classifyBqQuery(rest: string[]): Risk {
  if (!bqFlagsOk(rest, BQ_QUERY_FLAGS, BQ_BARE_FLAGS)) return "write";
  const positional = rest.filter((w) => !w.startsWith("-"));
  if (positional.length !== 1) return "write";
  const sql = positional[0].trim();
  if (sql.includes(";") || !/^(select|with)\b/i.test(sql)) return "write";
  return BQ_WRITE_WORDS.test(sql) ? "write" : "read";
}

/**
 * `read` or `write` for one MCP call. `tool` is the server's tool name (anything but the two known
 * tools is `write`); `command` is the command string as the agent sent it.
 */
export function classifyCommand(tool: string, command: unknown): Risk {
  if (tool !== "run_gcloud_command" && tool !== "run_bq_command") return "write";
  if (typeof command !== "string") return "write";
  const text = command.trim();
  if (!text || text.length > MAX_COMMAND) return "write";
  const words = tokenize(text);
  if (!words || words.length === 0) return "write";
  // `gcloud ...` / `bq ...` prefix is optional; the other tool's name means a mismatch: ask.
  const own = tool === "run_gcloud_command" ? "gcloud" : "bq";
  const other = own === "gcloud" ? "bq" : "gcloud";
  if (words[0] === other) return "write";
  const body = words[0] === own ? words.slice(1) : words;
  if (body.length === 0) return "write";
  return tool === "run_gcloud_command" ? classifyGcloud(body) : classifyBq(body);
}
