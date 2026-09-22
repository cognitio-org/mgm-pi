import { useProviders } from "../hooks/useProviders.ts";
import { Working } from "../components/Working.tsx";

export function ProvidersPage() {
  const { providers, loaded } = useProviders();

  if (!loaded) return <p className="empty-state"><Working label="Checking providers" size="lg" srOnly={false} /></p>;
  if (providers.length === 0) {
    return <p className="empty-state">No providers reported (GET /api/providers is not available yet).</p>;
  }

  return (
    <div className="table-scroll">
    <table className="data-table">
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
            <td>{p.name}</td>
            <td>{p.kind}</td>
            <td>
              <span className={`status-pill ${p.status}`}>{p.status}</span>
            </td>
            <td>{p.detail ?? "—"}</td>
            <td>{p.checkedAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}
