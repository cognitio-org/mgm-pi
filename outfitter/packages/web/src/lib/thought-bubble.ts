// Display preference for the live thought bubble (#285). Off unless the person turns it on
// from the session status bar. Same localStorage shape as the floppy-drive sound: a display
// choice on this browser, with nothing stored on the server.

const STORAGE_KEY = "outfitterThoughtBubble";

export function isThoughtBubbleEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function setThoughtBubbleEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // private browsing, or a test environment without storage
  }
}
