// Web voice spend (#257, epic #256): what each person's Deepgram use costs, read back from Deepgram
// by the usage tag every browser stream carries (voice.ts voiceTag). Deepgram reports units (hours
// of audio, TTS characters), not money, so dollars come from the rates in config; its usage showed
// streams within a minute or two when checked (2026-09-28), so there is no local estimate to
// reconcile, just a short cache.

import { voiceTag } from "./voice.ts";

export interface VoiceRates {
  /** Nova-3 streaming, USD per audio minute. */
  sttUsdPerMinute: number;
  /** Aura TTS, USD per 1,000 characters (spoken replies, #255). */
  ttsUsdPer1kChars: number;
}

export interface SpendFigure {
  minutes: number;
  ttsCharacters: number;
  usd: number;
}

export interface UserSpend {
  today: SpendFigure;
  week: SpendFigure;
  month: SpendFigure;
  /** When Deepgram was read; the figures may be up to the cache age behind. */
  asOf: string;
}

export interface SpendRow extends SpendFigure {
  tag: string;
  /** The person the tag belongs to, when they're a known user here. */
  email?: string;
}

export interface ProjectSpend {
  /** This calendar month (UTC), per tag, largest first. */
  users: SpendRow[];
  /** Streams with no tag: the laptop (kernal's pi-listen), which shares the Deepgram project. */
  untagged: SpendFigure;
  total: SpendFigure;
  asOf: string;
}

export interface VoiceUsageOptions {
  apiKey: string;
  projectId: string;
  rates: VoiceRates;
  cacheMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

interface UsageDay {
  start?: string;
  hours?: number;
  tts?: { characters?: number };
}

interface BreakdownRow {
  hours?: number;
  tts_characters?: number;
  grouping?: { tags?: string[] | null };
}

const BASE = "https://api.deepgram.com/v1/projects";

/** UTC day, ISO week (from Monday) and calendar month containing `now`, as YYYY-MM-DD. Deepgram
 * buckets usage by UTC day, so the periods are UTC too. */
export function spendPeriods(now: Date): { today: string; weekStart: string; monthStart: string } {
  const day = (d: Date) => d.toISOString().slice(0, 10);
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const weekStart = new Date(today);
  weekStart.setUTCDate(today.getUTCDate() - ((today.getUTCDay() + 6) % 7));
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  return { today: day(today), weekStart: day(weekStart), monthStart: day(monthStart) };
}

export function priced(minutes: number, ttsCharacters: number, rates: VoiceRates): SpendFigure {
  const usd = minutes * rates.sttUsdPerMinute + (ttsCharacters / 1000) * rates.ttsUsdPer1kChars;
  return { minutes, ttsCharacters, usd };
}

export class VoiceUsage {
  private readonly opts: VoiceUsageOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => Date;
  private readonly cache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(opts: VoiceUsageOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => new Date());
  }

  /** Needs the key (with usage:read) and the project it belongs to. */
  get enabled(): boolean {
    return this.opts.apiKey !== "" && this.opts.projectId !== "";
  }

  get rates(): VoiceRates {
    return this.opts.rates;
  }

  async forUser(email: string): Promise<UserSpend> {
    const tag = voiceTag(email);
    return this.cached(`user:${tag}`, async () => {
      const now = this.now();
      const p = spendPeriods(now);
      const start = p.weekStart < p.monthStart ? p.weekStart : p.monthStart;
      const body = await this.get<{ results?: UsageDay[] }>(`/usage?${new URLSearchParams({ start, end: p.today, tag })}`);
      const sum = (from: string) => {
        let minutes = 0;
        let chars = 0;
        for (const r of body.results ?? []) {
          if (!r.start || r.start.slice(0, 10) < from) continue;
          minutes += (r.hours ?? 0) * 60;
          chars += r.tts?.characters ?? 0;
        }
        return priced(minutes, chars, this.opts.rates);
      };
      return { today: sum(p.today), week: sum(p.weekStart), month: sum(p.monthStart), asOf: now.toISOString() };
    });
  }

  /** The month so far for the whole project, per tag. `emailForTag` names the people it can. */
  async forProject(emailForTag: (tag: string) => string | undefined): Promise<ProjectSpend> {
    const raw = await this.cached("project", async () => {
      const now = this.now();
      const p = spendPeriods(now);
      const body = await this.get<{ results?: BreakdownRow[] }>(
        `/usage/breakdown?${new URLSearchParams({ start: p.monthStart, end: p.today, grouping: "tags" })}`,
      );
      return { rows: body.results ?? [], asOf: now.toISOString() };
    });
    const byTag = new Map<string, { minutes: number; chars: number }>();
    let untaggedMinutes = 0;
    let untaggedChars = 0;
    for (const row of raw.rows) {
      const minutes = (row.hours ?? 0) * 60;
      const chars = row.tts_characters ?? 0;
      const tags = row.grouping?.tags ?? [];
      if (tags.length === 0) {
        untaggedMinutes += minutes;
        untaggedChars += chars;
        continue;
      }
      // A stream carries one tag here; if one ever had several, count it once, under the first.
      const acc = byTag.get(tags[0]) ?? { minutes: 0, chars: 0 };
      acc.minutes += minutes;
      acc.chars += chars;
      byTag.set(tags[0], acc);
    }
    const users: SpendRow[] = [...byTag].map(([tag, v]) => {
      const email = emailForTag(tag);
      return { tag, ...(email ? { email } : {}), ...priced(v.minutes, v.chars, this.opts.rates) };
    });
    users.sort((a, b) => b.usd - a.usd);
    const untagged = priced(untaggedMinutes, untaggedChars, this.opts.rates);
    const totalMinutes = users.reduce((n, u) => n + u.minutes, untaggedMinutes);
    const totalChars = users.reduce((n, u) => n + u.ttsCharacters, untaggedChars);
    return { users, untagged, total: priced(totalMinutes, totalChars, this.opts.rates), asOf: raw.asOf };
  }

  private async cached<T>(key: string, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < (this.opts.cacheMs ?? 60_000)) return hit.value as Promise<T>;
    const value = load();
    this.cache.set(key, { at: now, value });
    // A failure isn't cached: the next read tries Deepgram again.
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    return value;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${BASE}/${this.opts.projectId}${path}`, {
      headers: { Authorization: `Token ${this.opts.apiKey}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`deepgram usage ${res.status}`);
    return (await res.json()) as T;
  }
}
