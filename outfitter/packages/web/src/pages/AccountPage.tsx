import { vocabSubtitle, vocabulary } from "../lib/vocabulary.ts";

/** #389 CA-7 (docs/specs/central-auth.md §7): account settings (profiles, personal keys, local
 * model sharing, spend). Owned by task H; a placeholder until it lands. */
export function AccountPage() {
  return (
    <div>
      <div className="page-heading">
        <h2>{vocabulary.account.one}</h2>
        <p className="page-subtitle">{vocabSubtitle("account", "one")}</p>
      </div>
      <p className="empty-state">Account settings are coming soon.</p>
    </div>
  );
}
