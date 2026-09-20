/**
 * Structured logging for agentd (E1.6). Cloud Run's logging agent captures a container's stdout and
 * stderr and, when a line is valid JSON, parses `severity` and `message` (plus any other top-level
 * fields) straight into the LogEntry instead of storing the whole line as opaque text -- see
 * docs.cloud.google.com/logging/docs/structured-logging. agentd's stderr-only, plain-text logging
 * never showed up as anything but the job's own audit entries; this emits one JSON object per line to
 * stdout instead (falling back to a human-readable line when stdout is a TTY, e.g. local dev), and
 * gives pi's own stderr (piped through agentd, see run.ts's onStderr) a place to land at DEBUG
 * severity rather than being dropped or merged into agentd's own INFO lines.
 *
 * Redaction: nothing here ever needs to log a secret on purpose, but a raw error message or a line
 * of pi's own stderr might echo one back (a failed git auth, a raw fetch error against a URL with a
 * token in its query string). `addSecret` registers an exact secret value (RUN_TOKEN, run.spec's
 * githubToken/litellmKey) that gets scrubbed from every message and field string from then on. A
 * generic URL scrubber runs unconditionally, so even a secret nobody registered but that shows up as
 * userinfo (`https://user:pass@host`) or a `token=`/`key=`/`secret=`-shaped query param is caught.
 */

export type Severity = "DEBUG" | "INFO" | "WARNING" | "ERROR";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** Returns a logger that merges `fields` into every log call's fields on top of this logger's own
   * base fields (e.g. `logger.child({ sessionId })` once a run.spec is known). Shares this logger's
   * secret registry: registering a secret on either the parent or a child redacts it everywhere. */
  child(fields: LogFields): Logger;
  /** Registers an exact string value to redact (replaced with "[redacted]") from every message and
   * field logged from this point on, by this logger and any child/ancestor sharing its registry.
   * No-op for undefined/empty values so callers can pass an optional secret unconditionally. */
  addSecret(value: string | undefined): void;
}

export interface CreateLoggerOptions {
  /** Defaults to process.stdout. */
  stream?: NodeJS.WritableStream;
  /** Defaults to `stream.isTTY` (human-readable lines for local/dev terminals; JSON otherwise, which
   * is what Cloud Run's non-interactive container stdout always is). */
  isTTY?: boolean;
  /** When true, an Error logged as a field includes its `stack` at every severity, not just DEBUG.
   * Defaults to false. */
  verbose?: boolean;
}

const REDACTED = "[redacted]";

/** Query params commonly used to carry a secret in a URL (LiteLLM/GitHub/GCS-signed-URL style). */
const SENSITIVE_QUERY_KEYS = /\b(token|key|secret|signature|credential|auth)\b/i;

/** `scheme://user:pass@host` -> `scheme://[redacted]@host`. Runs before secret substring redaction
 * so it still fires even if the exact password string wasn't separately registered. */
function redactUrlUserinfo(text: string): string {
  return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, `$1${REDACTED}@`);
}

/** Redacts the value of any `?key=...`/`&key=...` query param whose name looks secret-shaped. */
function redactSensitiveQueryParams(text: string): string {
  return text.replace(/([?&][^=?&\s]*)=([^&\s]+)/g, (match, keyPart: string, value: string) => {
    const name = keyPart.slice(1); // drop the leading ? or &
    return SENSITIVE_QUERY_KEYS.test(name) ? `${keyPart}=${REDACTED}` : match;
  });
}

function redactString(text: string, secrets: readonly string[]): string {
  let out = redactUrlUserinfo(text);
  out = redactSensitiveQueryParams(out);
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join(REDACTED);
  }
  return out;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactString(value, secrets);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, secrets));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v, secrets);
    return out;
  }
  return value;
}

/** `Error` instances have non-enumerable `message`/`stack` own properties, so plain field-object
 * handling (redactValue, JSON.stringify) sees `{}` for one logged as a field value -- convert it to a
 * plain object first. `stack` is included only at DEBUG severity or when `includeStack` is set
 * (e.g. a `verbose` logger option), since it can be long and is rarely wanted at INFO/WARNING/ERROR
 * in Cloud Logging. Recurses into plain objects/arrays so an Error nested inside `{ err }` or `[err]`
 * is also converted. */
function normalizeErrors(value: unknown, includeStack: boolean): unknown {
  if (value instanceof Error) {
    const out: Record<string, unknown> = { name: value.name, message: value.message };
    if (includeStack && value.stack) out.stack = value.stack;
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => normalizeErrors(v, includeStack));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = normalizeErrors(v, includeStack);
    return out;
  }
  return value;
}

const UNSERIALISABLE_FIELDS: LogFields = { logError: "unserialisable fields" };

class LoggerImpl implements Logger {
  constructor(
    private readonly base: LogFields,
    private readonly secrets: string[],
    private readonly stream: NodeJS.WritableStream,
    private readonly isTTY: boolean,
    private readonly verbose: boolean,
  ) {}

  private write(severity: Severity, message: string, fields?: LogFields): void {
    const redactedMessage = redactString(message, this.secrets);
    // A circular structure (or something JSON.stringify otherwise can't handle, e.g. a BigInt) in
    // `fields` must never take the whole process down just because a caller logged it -- fall back to
    // a placeholder field instead of throwing out of a logging call.
    let mergedFields: LogFields;
    try {
      const includeStack = severity === "DEBUG" || this.verbose;
      const normalized = normalizeErrors({ ...this.base, ...fields }, includeStack);
      mergedFields = redactValue(normalized, this.secrets) as LogFields;
      JSON.stringify(mergedFields); // probe: throws here (not later, mid-write) if unserialisable
    } catch {
      mergedFields = UNSERIALISABLE_FIELDS;
    }
    if (this.isTTY) {
      const extra = Object.keys(mergedFields).length > 0 ? ` ${JSON.stringify(mergedFields)}` : "";
      this.stream.write(`[agentd] ${severity} ${redactedMessage}${extra}\n`);
      return;
    }
    // Cloud Run/Cloud Logging convention: top-level `severity` and `message` on a JSON line written
    // to stdout are lifted straight into the LogEntry (docs.cloud.google.com/logging/docs/structured-logging).
    this.stream.write(`${JSON.stringify({ severity, message: redactedMessage, ...mergedFields })}\n`);
  }

  debug(message: string, fields?: LogFields): void {
    this.write("DEBUG", message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.write("INFO", message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.write("WARNING", message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.write("ERROR", message, fields);
  }

  child(fields: LogFields): Logger {
    // Shares this.secrets (same array reference) so addSecret on either logger redacts for both.
    return new LoggerImpl({ ...this.base, ...fields }, this.secrets, this.stream, this.isTTY, this.verbose);
  }

  addSecret(value: string | undefined): void {
    if (!value) return;
    if (!this.secrets.includes(value)) this.secrets.push(value);
  }
}

export function createLogger(base: LogFields = {}, opts: CreateLoggerOptions = {}): Logger {
  const stream = opts.stream ?? process.stdout;
  const isTTY = opts.isTTY ?? !!(stream as NodeJS.WriteStream).isTTY;
  return new LoggerImpl({ ...base }, [], stream, isTTY, opts.verbose ?? false);
}
