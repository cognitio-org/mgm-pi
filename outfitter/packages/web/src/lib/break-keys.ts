// #498: when Esc breaks the running turn on a floppy's page, and when it belongs to something else.
//
// Esc is everyone's "close": menus, dialogs, the sheet, the question card, the voice controls and
// the Disk Box search all use it first. Break only takes an Esc nobody else wanted:
// - not one an IME is composing with, or one a handler already took (defaultPrevented);
// - not while a menu or a modal dialog is open;
// - not from a text field, select or other control's own typing, except the composer, and there
//   only while its draft is empty: Esc never throws away a draft or interrupts an edit, but with
//   nothing typed the composer is just where focus rests during a turn.

export interface EscEvent {
  key: string;
  isComposing?: boolean;
  defaultPrevented: boolean;
  target: EventTarget | null;
}

function isEditable(el: Element): boolean {
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT";
}

export function escBreaks(event: EscEvent, doc: Document = document): boolean {
  if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return false;
  if (doc.querySelector("[aria-modal='true'], [role='menu']")) return false;
  const target = event.target;
  if (!(target instanceof Element) || !isEditable(target)) return true;
  if (target instanceof HTMLTextAreaElement && target.closest(".composer")) return target.value.trim() === "";
  return false;
}

/** Whether the turn can be broken (■ Break, Esc): a live run that's working on something, including
 * one that has gone quiet or stuck (workTimeout), which is exactly when Break matters. An idle run
 * with no send of ours in flight has nothing to break, and a waiting question takes Esc itself. */
export function canBreakTurn(input: { canAbort: boolean; pendingQuestion: boolean; runState?: string; phase: string }): boolean {
  return input.canAbort && !input.pendingQuestion && (input.runState !== "idle" || input.phase !== "none");
}
