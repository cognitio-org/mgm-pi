import { useProviders } from "../hooks/useProviders.ts";

export function ProvidersPage() {
  const { providers, loaded } = useProviders();

  if (!loaded) return <p className="empty-state">Loading...</p>;
  if (providers.length === 0) {
    return <p className="empty-state">No providers reported (GET /api/providers is not available yet).</p>;
  }

  return (
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
  );
}
