import { useProviders } from "../hooks/useProviders.ts";

/** Header strip placeholder for E3.6's providers dashboard. Renders a compact status summary when
 * GET /api/providers returns rows, nothing while loading or on a 404 (endpoint not built yet). */
export function ProviderStrip() {
  const { providers, loaded } = useProviders();
  if (!loaded || providers.length === 0) return null;

  return (
    <div style={{ display: "flex", gap: "0.4rem", marginLeft: "auto", flexWrap: "wrap" }}>
      {providers.map((p) => (
        <span key={p.id} className={`status-pill ${p.status}`} title={p.detail ?? p.name}>
          {p.name}
        </span>
      ))}
    </div>
  );
}
