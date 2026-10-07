// #498: display choices on the session page, remembered per browser like the thought bubble and
// the floppy-drive sound. Nothing here is stored on the server.

export type ScannerColour = "kitt" | "phosphor";

const SCANNER_KEY = "outfitterScanner";
const PANE_KEY = "outfitterSessionPane";
const DISK_BOX_KEY = "outfitterDiskBox";

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // private browsing, or a test environment without storage
  }
}

/** KITT red unless the person picked phosphor green. */
export function loadScannerColour(): ScannerColour {
  return read(SCANNER_KEY) === "phosphor" ? "phosphor" : "kitt";
}

export function saveScannerColour(colour: ScannerColour): void {
  write(SCANNER_KEY, colour);
}

/** The right-hand Details pane. Closed until opened once. */
export function loadPaneOpen(): boolean {
  return read(PANE_KEY) === "open";
}

export function savePaneOpen(open: boolean): void {
  write(PANE_KEY, open ? "open" : "closed");
}

/** The Disk Box sidebar. Open until hidden once. */
export function loadDiskBoxOpen(): boolean {
  return read(DISK_BOX_KEY) !== "closed";
}

export function saveDiskBoxOpen(open: boolean): void {
  write(DISK_BOX_KEY, open ? "open" : "closed");
}
