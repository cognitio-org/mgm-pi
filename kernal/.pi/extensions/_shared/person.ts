/**
 * Whether a person is at the terminal to answer a dialog. The TUI only: RPC mode has a UI that may
 * have nobody watching, and a Drive's approvals are the API's web card, never a dialog here. `need`
 * also requires that dialog (`ctx.ui.confirm` or `ctx.ui.select`).
 */
export function personHere(ctx: any, need?: "confirm" | "select"): boolean {
  if (process.env.OUTFITTER_SESSION_ID) return false;
  if (ctx?.mode !== "tui") return false;
  return !need || typeof ctx?.ui?.[need] === "function";
}
