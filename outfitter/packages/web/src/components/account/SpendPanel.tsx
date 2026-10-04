import { useEffect, useState } from "react";
import { ApiError } from "../../api/client.ts";
import { accountApi, type UserSpend } from "../../api/account.ts";
import { accountErrorText, currentMonth, formatUsd } from "../../lib/account.ts";
import { vocabulary } from "../../lib/vocabulary.ts";
import { Working } from "../Working.tsx";

type AllSpend = Awaited<ReturnType<typeof accountApi.allSpend>>;

/** #389 CA-7 (§8): a month's router spend, by device (and Drive run) and by model, from LiteLLM
 * through GET /api/me/spend. A Sysop also sees every user's total. */
export function SpendPanel({ operator }: { operator: boolean }) {
  const [month, setMonth] = useState(currentMonth());
  const [spend, setSpend] = useState<UserSpend | null>(null);
  const [all, setAll] = useState<AllSpend | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [allError, setAllError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setAllError(null);
    setUnavailable(false);
    const mine = accountApi.spend(month);
    const everyone = operator ? accountApi.allSpend(month) : Promise.resolve(null);
    Promise.allSettled([mine, everyone]).then(([m, e]) => {
      if (cancelled) return;
      if (m.status === "fulfilled") setSpend(m.value);
      else {
        setSpend(null);
        if (isUnavailable(m.reason)) setUnavailable(true);
        else setError(accountErrorText(m.reason, "Couldn't load spend"));
      }
      if (e.status === "fulfilled") setAll(e.value);
      else {
        // A failed operator view says so, rather than look like the feature isn't there.
        setAll(null);
        setAllError(
          isUnavailable(e.reason)
            ? "Everyone's spend isn't available on this deployment yet."
            : accountErrorText(e.reason, "Couldn't load everyone's spend"),
        );
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [month, operator]);

  return (
    <div>
      <div className="toolbar">
        <label>
          Month{" "}
          <input
            type="month"
            value={month}
            max={currentMonth()}
            onChange={(e) => e.target.value && setMonth(e.target.value)}
            aria-label="Spend month"
          />
        </label>
      </div>
      {loading ? (
        <p className="empty-state"><Working label="Loading" srOnly={false} /></p>
      ) : unavailable ? (
        <p className="empty-state">Spend isn't available on this deployment yet.</p>
      ) : error ? (
        <p className="syntax-error" role="alert">{error}</p>
      ) : spend ? (
        <>
          <p>
            Total for {spend.month}: <strong>{formatUsd(spend.total)}</strong>{" "}
            <span className="session-meta">as of {new Date(spend.fetchedAt).toLocaleString()}</span>
          </p>
          <div className="account-spend-grid">
            <div className="table-scroll">
              <table className="data-table stack" aria-label={`Spend by ${vocabulary.device.one.toLowerCase()}`}>
                <thead>
                  <tr>
                    <th>{vocabulary.device.one}</th>
                    <th>Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {spend.byDevice.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="session-meta">Nothing this month.</td>
                    </tr>
                  ) : (
                    spend.byDevice.map((d) => (
                      <tr key={d.alias}>
                        <td data-label={vocabulary.device.one}>
                          {d.kind === "run" ? `${vocabulary.drive.one} run` : (d.deviceName ?? d.deviceId ?? d.alias)}
                          {d.kind === "run" && (
                            <div className="session-meta">
                              <code>{d.alias}</code>
                            </div>
                          )}
                        </td>
                        <td data-label="Spend">{formatUsd(d.spend)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            <div className="table-scroll">
              <table className="data-table stack" aria-label="Spend by model">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Spend</th>
                  </tr>
                </thead>
                <tbody>
                  {spend.byModel.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="session-meta">Nothing this month.</td>
                    </tr>
                  ) : (
                    spend.byModel.map((m) => (
                      <tr key={m.model}>
                        <td data-label="Model">
                          <code>{m.model}</code>
                        </td>
                        <td data-label="Spend">{formatUsd(m.spend)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      ) : null}

      {operator && !loading && allError && (
        <>
          <h4>Everyone ({vocabulary.operator.one} view)</h4>
          <p className="syntax-error" role="alert">{allError}</p>
        </>
      )}
      {operator && all && (
        <>
          <h4>Everyone ({vocabulary.operator.one} view)</h4>
          <p>
            Fleet total for {all.month}: <strong>{formatUsd(all.total)}</strong>
          </p>
          <div className="table-scroll">
            <table className="data-table stack" aria-label="Spend by user">
              <thead>
                <tr>
                  <th>User</th>
                  <th>Spend</th>
                </tr>
              </thead>
              <tbody>
                {[...all.users]
                  .sort((a, b) => b.total - a.total)
                  .map((u) => (
                    <tr key={u.userId}>
                      <td data-label="User">{u.email ?? <code>{u.userId}</code>}</td>
                      <td data-label="Spend">{formatUsd(u.total)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function isUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.status === 503;
}
