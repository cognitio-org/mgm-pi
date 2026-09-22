import { useEffect, useState } from "react";

/** `navigator.onLine`, kept live via the `online`/`offline` window events -- backs the
 * "?DEVICE NOT PRESENT ERROR" banner App.tsx shows while the browser itself is offline
 * (docs/reports/mobile-desk.md). Defaults to true (never shows a false-positive offline banner) in
 * an environment without `navigator.onLine` (older/non-browser test runners). */
export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === "undefined" ? true : navigator.onLine));

  useEffect(() => {
    function goOnline() {
      setOnline(true);
    }
    function goOffline() {
      setOnline(false);
    }
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  return online;
}
