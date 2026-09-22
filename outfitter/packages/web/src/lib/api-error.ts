import { ApiError } from "../api/client.ts";
import type { ApiErrorState } from "../components/SystemErrorDialog.tsx";

/** Normalizes anything a `catch` block can hand you into the shape SystemErrorDialog.tsx renders:
 * an ApiError keeps its real status/message, anything else (a thrown string, a client-side bug, a
 * network failure that never reached the API) falls back to `fallbackMessage` with no status
 * (rendered as "ID = ERR"). */
export function toApiErrorState(err: unknown, fallbackMessage: string): ApiErrorState {
  if (err instanceof ApiError) return { status: err.status, message: err.message };
  return { message: fallbackMessage };
}
