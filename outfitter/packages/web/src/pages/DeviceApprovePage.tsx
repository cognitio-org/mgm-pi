import { vocabulary } from "../lib/vocabulary.ts";

/** #389 CA-1 web (docs/specs/central-auth.md §1.5, §6): /device, where a person approves a
 * `kernal login` code. Owned by task B; a placeholder until it lands. */
export function DeviceApprovePage() {
  return (
    <div>
      <div className="page-heading">
        <h2>Sign in a {vocabulary.kernal.one}</h2>
      </div>
      <p className="empty-state">Signing Kernal in with your account is coming soon.</p>
    </div>
  );
}
