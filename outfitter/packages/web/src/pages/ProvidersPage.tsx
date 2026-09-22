import { useProviders } from "../hooks/useProviders.ts";
import { Working } from "../components/Working.tsx";
import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

export function ProvidersPage() {
  const { providers, loaded } = useProviders();

  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.provider.many}</h2>
        <p className="page-subtitle">{vocabSubtitle("provider")}</p>
      </div>
      {!loaded ? (
        <p className="empty-state">
          <Working label="Checking peripherals" size="lg" srOnly={false} />
        </p>
      ) : providers.length === 0 ? (
        <p className="empty-state">No peripherals reported (GET /api/providers is not available yet).</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table stack">
            <thead>
              <tr>
                <th>Name</th>
                <th>Kind</th>
                <th>Status</th>
                <th>Detail</th>
                <th>Checked</th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td data-label="Name">{p.name}</td>
                  <td data-label="Kind">{p.kind}</td>
                  <td data-label="Status">
                    <span className={`status-pill ${p.status}`}>{p.status}</span>
                  </td>
                  <td data-label="Detail">{p.detail ?? "—"}</td>
                  <td data-label="Checked">{p.checkedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
