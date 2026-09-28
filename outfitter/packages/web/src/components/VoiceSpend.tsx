import { useEffect, useState } from "react";
import { api, type ProjectVoiceSpend, type SpendFigure, type VoiceSpend } from "../api/client.ts";
import { formatMinutes, formatUsd } from "../lib/voice-spend.ts";

/** #257: your Deepgram voice spend. `compact` is the one-liner in the mic's settings menu; the
 * full form is the Tokens page's table. Built-in speech is free and not counted. */
export function VoiceSpendView({ compact = false }: { compact?: boolean }) {
  const [spend, setSpend] = useState<VoiceSpend | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let gone = false;
    api
      .voiceSpend()
      .then((s) => !gone && setSpend(s))
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
    };
  }, []);

  if (failed) return <p className={compact ? "voice-menu-hint" : "session-meta"}>Couldn't read voice spend from Deepgram.</p>;
  if (!spend) return <p className={compact ? "voice-menu-hint" : "session-meta"}>Reading voice spend…</p>;
  if (!spend.available) {
    return compact ? <p className="voice-menu-hint">Not tracked here yet.</p> : <p className="session-meta">Deepgram voice spend isn't set up here.</p>;
  }

  const cap = spend.capUsd ? ` of ${formatUsd(spend.capUsd)} cap` : "";
  if (compact) {
    return (
      <p className="voice-spend-line" title={`Deepgram voice, UTC days. ${formatMinutes(spend.month.minutes)} this month.`}>
        {formatUsd(spend.today.usd)} today · {formatUsd(spend.week.usd)} week · {formatUsd(spend.month.usd)} month{cap}
      </p>
    );
  }
  const rows: Array<[string, SpendFigure]> = [
    ["Today", spend.today],
    ["This week", spend.week],
    ["This month", spend.month],
  ];
  return (
    <>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Period</th>
              <th>Audio</th>
              <th>Spend</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}>
                <td>{label}</td>
                <td>{formatMinutes(f.minutes)}</td>
                <td className="mono">{formatUsd(f.usd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="session-meta">
        Deepgram voice input from the web app, at list price{spend.capUsd ? `, capped at ${formatUsd(spend.capUsd)} a month` : ""}. Days are UTC
        days and weeks start on Monday. The browser's built-in speech is free and not counted.
      </p>
    </>
  );
}

/** #257: sysops' month so far, per person, plus the untagged use (the laptop's pi-listen). */
export function ProjectVoiceSpendView() {
  const [spend, setSpend] = useState<ProjectVoiceSpend | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let gone = false;
    api
      .operatorVoiceSpend()
      .then((s) => !gone && setSpend(s))
      .catch(() => !gone && setFailed(true));
    return () => {
      gone = true;
    };
  }, []);

  if (failed) return <p className="session-meta">Couldn't read voice spend from Deepgram.</p>;
  if (!spend) return <p className="session-meta">Reading voice spend…</p>;
  if (!spend.available) return <p className="session-meta">Deepgram voice isn't set up here (no key or project id).</p>;

  return (
    <>
      <div className="table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              <th>Person</th>
              <th>Audio</th>
              <th>Spend</th>
            </tr>
          </thead>
          <tbody>
            {spend.users.map((u) => (
              <tr key={u.tag}>
                <td>{u.email ?? <span className="mono" title="A tag no current user matches">{u.tag}</span>}</td>
                <td>{formatMinutes(u.minutes)}</td>
                <td className="mono">{formatUsd(u.usd)}</td>
              </tr>
            ))}
            <tr>
              <td>Laptop (kernal, untagged)</td>
              <td>{formatMinutes(spend.untagged.minutes)}</td>
              <td className="mono">{formatUsd(spend.untagged.usd)}</td>
            </tr>
            <tr>
              <td>
                <strong>Total</strong>
              </td>
              <td>{formatMinutes(spend.total.minutes)}</td>
              <td className="mono">
                <strong>{formatUsd(spend.total.usd)}</strong>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="session-meta">
        This calendar month (UTC), at ${spend.rates.sttUsdPerMinute}/min for streaming and ${spend.rates.ttsUsdPer1kChars} per 1,000
        characters of speech (<code>VOICE_STT_USD_PER_MINUTE</code>, <code>VOICE_TTS_USD_PER_1K_CHARS</code>). A plan discount or
        promotion makes the actual bill lower.
      </p>
    </>
  );
}
