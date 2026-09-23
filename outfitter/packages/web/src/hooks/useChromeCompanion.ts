import { useEffect, useRef, useState } from "react";
import {
  CHROME_EXTENSION_ID,
  placeMessage,
  pollMessage,
  splitMessage,
  pingSucceeded,
  placementFailure,
  splitAvailableFrom,
  type PlaceMode,
} from "../lib/chrome-companion.ts";

interface ChromePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(cb: (message: unknown) => void): void };
  onDisconnect: { addListener(cb: () => void): void };
}

interface ChromeRuntime {
  connect?(extensionId: string, connectInfo: { name: string }): ChromePort;
}

const POLL_MS = 2000;

function pageRuntime(): ChromeRuntime | undefined {
  const host = globalThis as unknown as { chrome?: { runtime?: ChromeRuntime } };
  return host.chrome?.runtime;
}

export interface ChromeCompanion {
  ready: boolean;
  split: boolean;
  note: string | null;
  place: (mode: PlaceMode, title: string) => void;
  splitWith: (otherSessionId: string) => void;
}

/** Connects to the companion when `chrome.runtime` exists. No controls until ping succeeds.
 * A throw or a ping that never arrives leaves `ready` false, so the page looks as it does without the extension. */
export function useChromeCompanion(sessionId: string): ChromeCompanion {
  const [ready, setReady] = useState(false);
  const [split, setSplit] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [linkSession, setLinkSession] = useState(sessionId);
  const portRef = useRef<ChromePort | null>(null);

  if (linkSession !== sessionId) {
    setLinkSession(sessionId);
    setReady(false);
    setSplit(false);
    setNote(null);
  }

  useEffect(() => {
    const runtime = pageRuntime();
    if (!sessionId || !runtime || typeof runtime.connect !== "function") return;
    const connect = runtime.connect.bind(runtime);
    let stopped = false;
    let port: ChromePort | null = null;
    let pingTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let pinged = false;

    const clearPoll = () => {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const startPoll = () => {
      clearPoll();
      if (document.visibilityState !== "visible" || !port) return;
      const send = () => {
        try {
          port?.postMessage(pollMessage());
        } catch {
          // The port closed between the visibility check and the send.
        }
      };
      send();
      pollTimer = setInterval(send, POLL_MS);
    };

    const onVis = () => {
      if (!pinged) return;
      if (document.visibilityState === "visible") startPoll();
      else clearPoll();
    };

    const failClosed = () => {
      pinged = false;
      portRef.current = null;
      setReady(false);
      setSplit(false);
    };

    function arm(next: ChromePort) {
      port = next;
      portRef.current = next;
      pinged = false;
      pingTimer = setTimeout(() => {
        if (pinged || stopped) return;
        failClosed();
        try {
          next.disconnect();
        } catch {
          // Already disconnected.
        }
      }, 1500);
      next.onMessage.addListener((message) => {
        if (pingSucceeded(message)) {
          pinged = true;
          if (pingTimer) clearTimeout(pingTimer);
          setReady(true);
          startPoll();
        }
        setSplit((current) => splitAvailableFrom(message, current));
        const failure = placementFailure(message);
        if (failure === "place_failed") setNote("Chrome couldn't place this Floppy.");
        else if (failure === "split_failed") setNote("Chrome couldn't split these Floppies.");
      });
      next.onDisconnect.addListener(() => {
        if (pingTimer) clearTimeout(pingTimer);
        clearPoll();
        if (portRef.current === next) portRef.current = null;
        if (stopped) return;
        if (!pinged) {
          failClosed();
          return;
        }
        // The service worker was killed. Reconnect so the controls stay while the extension is installed.
        reconnectTimer = setTimeout(() => {
          if (!stopped) open();
        }, 500);
      });
      try {
        next.postMessage({ t: "ping" });
      } catch {
        failClosed();
      }
    }

    function open() {
      try {
        arm(connect(CHROME_EXTENSION_ID, { name: `floppy:${sessionId}` }));
      } catch {
        failClosed();
      }
    }

    document.addEventListener("visibilitychange", onVis);
    open();
    return () => {
      stopped = true;
      if (pingTimer) clearTimeout(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearPoll();
      document.removeEventListener("visibilitychange", onVis);
      portRef.current = null;
      try {
        port?.disconnect();
      } catch {
        // Already disconnected.
      }
    };
  }, [sessionId]);

  function place(mode: PlaceMode, title: string) {
    setNote(null);
    try {
      portRef.current?.postMessage(placeMessage(sessionId, window.location.origin, title, mode));
    } catch {
      setReady(false);
    }
  }

  function splitWith(otherSessionId: string) {
    setNote(null);
    try {
      portRef.current?.postMessage(splitMessage(sessionId, otherSessionId));
    } catch {
      setReady(false);
    }
  }

  return { ready, split, note, place, splitWith };
}
