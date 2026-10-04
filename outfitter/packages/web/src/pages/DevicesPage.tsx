import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

/** #389 CA-1 web (docs/specs/central-auth.md §6): the signed-in devices, with revoke. Owned by
 * task B; a placeholder until it lands. */
export function DevicesPage() {
  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.device.many}</h2>
        <p className="page-subtitle">{vocabSubtitle("device")}</p>
      </div>
      <p className="empty-state">Signing Kernal in with your account is coming soon.</p>
    </div>
  );
}
