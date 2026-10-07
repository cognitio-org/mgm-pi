import { useContext, useEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, ApiError, type ModelRow, type SessionDetail } from "../api/client.ts";
import { useSessionStream } from "../hooks/useSessionStream.ts";
import { useProviders } from "../hooks/useProviders.ts";
import { PHONE_QUERY, WIDE_QUERY, useMediaQuery } from "../hooks/useMediaQuery.ts";
import { canBreakTurn, escBreaks } from "../lib/break-keys.ts";
import { AppNavContext, AppVersionContext } from "../lib/nav.ts";
import { entriesToViews } from "../lib/entry-view.ts";
import { STREAMED_THOUGHT_ID, buildFlow, lastVsCodeToolId, liveThinkingId, runningTool, thinkingSeconds } from "../lib/flow.ts";
import { isThoughtBubbleEnabled, setThoughtBubbleEnabled } from "../lib/thought-bubble.ts";
import { groupThinkingBlocks } from "../lib/thinking.ts";
import { deriveSessionHeader } from "../lib/session-header.ts";
import {
  contextMeterMessage,
  deriveTransportStatusLine,
  runStateNote,
  transportStatusLine,
  type TransportOutcome,
} from "../lib/retro-errors.ts";
import { sessionLamp } from "../lib/session-lamp.ts";
import { githubCluster, looseRepoClause } from "../lib/session-facts.ts";
import { toApiErrorState } from "../lib/api-error.ts";
import { formatElapsed, formatTokens, toolVerb, turnOutputTokens, turnStartedAt } from "../lib/live-status.ts";
import {
  loadDiskBoxOpen,
  loadPaneOpen,
  loadScannerColour,
  saveDiskBoxOpen,
  savePaneOpen,
  saveScannerColour,
  type ScannerColour,
} from "../lib/session-prefs.ts";
import { ThinkingRow, TranscriptFlow, UserBlock } from "../components/TranscriptFlow.tsx";
import { Composer } from "../components/Composer.tsx";
import { StatusPill } from "../components/StatusPill.tsx";
import { ChangesFullView, ChangesPane } from "../components/ChangesPane.tsx";
import { CreatePrDialog } from "../components/CreatePrDialog.tsx";
import { GitChips, GitStrip, type GitChipAction } from "../components/GitChips.tsx";
import { useSessionGit } from "../hooks/useSessionGit.ts";
import { useDiffNotes } from "../hooks/useDiffNotes.ts";
import { PreviewChips } from "../components/PreviewChips.tsx";
import { IdeChip } from "../components/IdeChip.tsx";
import { IdeProvider } from "../components/IdeProvider.tsx";
import { TransportDot } from "../components/TransportDot.tsx";
import { UiRequestPanel } from "../components/UiRequestPanel.tsx";
import { Working } from "../components/Working.tsx";
import { NotFoundError } from "../components/NotFoundError.tsx";
import { SystemErrorDialog, type ApiErrorState } from "../components/SystemErrorDialog.tsx";
import { DeviceNotPresent } from "../components/DeviceNotPresent.tsx";
import { DiskBoxSidebar } from "../components/DiskBoxSidebar.tsx";
import { KnightRiderScanner } from "../components/KnightRiderScanner.tsx";
import { PopMenu } from "../components/PopMenu.tsx";
import { SessionDetails } from "../components/SessionDetails.tsx";
import { SessionMenu } from "../components/SessionMenu.tsx";
import { SessionSheet } from "../components/SessionSheet.tsx";
import { SoundToggle } from "../components/SoundToggle.tsx";
import { ThemeToggle } from "../components/ThemeToggle.tsx";
import { BackIcon, ContextRing, MoreIcon, PaneIcon, SideIcon } from "../components/SessionIcons.tsx";
import { withFloppySound } from "../lib/floppy-sound.ts";
import { floppyActions, vocabulary } from "../lib/vocabulary.ts";
import { FormatFloppyDialog } from "../components/FormatFloppyDialog.tsx";
import { SwitchModelDialog } from "../components/SwitchModelDialog.tsx";
import { deriveSessionActivity, nextSendAnchor, notePendingRunState, type PendingSend } from "../lib/send-status.ts";
import { useChromeCompanion } from "../hooks/useChromeCompanion.ts";
import { teleportCommand } from "../lib/webmcp.ts";
import { previewAccessByEntry, previewAccessFor } from "../lib/html-preview-access.ts";

type PendingAction = "abort" | "stop" | "wake" | null;

/** How long a just-finished BREAK/LOAD ERROR outcome stays on the status line before it reverts to
 * READY. -- long enough to read, short enough that it doesn't linger past its relevance. */
const OUTCOME_FLASH_MS = 3000;

/** How long a "Copied" note stays in the dock. */
const TOAST_MS = 2000;

/** The right pane's tabs (#502: Changes first). */
const PANE_TABS = [
  { id: "changes", label: "Changes" },
  { id: "details", label: "Details" },
] as const;
type PaneTab = (typeof PANE_TABS)[number]["id"];

/**
 * A floppy's page (#498, docs/design/sessions-redesign-demo.html): the Disk Box down the left, the
 * conversation in the middle under a one-line header, and a Details pane on the right that opens
 * with ◫. The transcript flows without boxes; the dock under it holds the live status line, any
 * notes, a waiting question, and the composer. On a phone the floppy fills the screen, with a back
 * arrow to the Disk Box and the menu and details in a bottom sheet.
 */
export function SessionPage() {
  const { id } = useParams<{ id: string }>();
  const sessionId = id ?? "";
  // ?expandThinking=1 defaults every collapsed thinking row open -- used only to drive a
  // screenshot of the expanded state (docs/reports/mobile-desk.md); not otherwise surfaced in the
  // UI.
  const [searchParams] = useSearchParams();
  const defaultThinkingExpanded = searchParams.get("expandThinking") === "1";
  const [session, setSession] = useState<SessionDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [apiError, setApiError] = useState<ApiErrorState | null>(null);
  const [copiedGuruId, setCopiedGuruId] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [pendingAction, setPendingAction] = useState<PendingAction>(null);
  const [transportOutcome, setTransportOutcome] = useState<TransportOutcome | null>(null);
  const {
    entries,
    entriesLoaded,
    runState,
    runStateReason,
    statusDetail,
    pendingUiRequest,
    costEstimate,
    startup: streamStartup,
    agentSeenAt,
    piActiveAt,
    liveThought: streamedThought,
    lastPush,
  } = useSessionStream(sessionId, session?.id === sessionId ? session.lastPush : undefined);
  const { providers } = useProviders();
  const phone = useMediaQuery(PHONE_QUERY);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Scroll position the page jumped to on its own, so its scroll event isn't taken for the reader's.
  const landedAt = useRef<number | null>(null);
  // #285: follow a growing thought only when the reader was already at the bottom.
  const followThought = useRef(true);
  // Cloud-fixes 11: the message just sent, until its stored entry and reply arrive.
  const [pendingSend, setPendingSend] = useState<PendingSend | null>(null);
  // Last time the page saw progress (a new entry, a run state change, or pi activity from the
  // `liveness` frame) -- the work/wake timeouts count from here. `now` ticks while something is in
  // flight so a timeout can fire.
  const [lastProgressAt, setLastProgressAt] = useState(() => Date.now());
  const [now, setNow] = useState(() => Date.now());
  const chromePlace = useChromeCompanion(sessionId);
  const [splitTargets, setSplitTargets] = useState<{ id: string; name?: string }[]>([]);
  // #498: the layout's own choices, remembered on this browser.
  const [diskBoxOpen, setDiskBoxOpen] = useState(() => loadDiskBoxOpen());
  // #498 review: open by default on a wide desktop, until the person toggles it once.
  const wide = useMediaQuery(WIDE_QUERY);
  const [paneChoice, setPaneChoice] = useState<boolean | null>(() => loadPaneOpen());
  const paneOpen = paneChoice ?? wide;
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const navItems = useContext(AppNavContext);
  const versionText = useContext(AppVersionContext);
  const [paneTab, setPaneTab] = useState<PaneTab>("changes");
  // #502: the Create PR dialog, and the phone's full-screen Changes view, held as the floppy they
  // were opened on so moving to another one closes them.
  const [prDialogFor, setPrDialogFor] = useState<string | null>(null);
  const [changesFullFor, setChangesFullFor] = useState<string | null>(null);
  const [scannerColour, setScannerColour] = useState<ScannerColour>(() => loadScannerColour());
  // The phone's bottom sheet, held as the session it was opened on, like the model switcher.
  const [sheetFor, setSheetFor] = useState<string | null>(null);
  const sheetOpen = phone && sheetFor === sessionId;
  // #285: optional live thought bubble. A display choice on this browser, remembered like the
  // floppy-drive sound. Off leaves thinking folded to its one line.
  const [thoughtBubbles, setThoughtBubbles] = useState(() => isThoughtBubbleEnabled());
  const navigate = useNavigate();
  // #209: Archive, Restore and Format. Archived floppies are read-only (api 409s wake and send).
  const [shelving, setShelving] = useState<"archive" | "restore" | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);
  // The model switcher, held as the session it was opened on, so moving to another floppy closes it.
  const [modelOpenFor, setModelOpenFor] = useState<string | null>(null);
  const modelOpen = modelOpenFor === sessionId;
  // The route reuses this component across sessions, so an archive that returns after the user
  // moved on must not write its session into the next one's page.
  const currentSessionId = useRef(sessionId);
  currentSessionId.current = sessionId;

  // The route reuses this component when navigating from one session to another (App.tsx's
  // /sessions/:id has no key), so a pending send must not follow the user into the next session:
  // its baseline indexes the old session's entries and its optimistic row would show there.
  useEffect(() => {
    setPendingSend(null);
    setLastProgressAt(Date.now());
    setFormatOpen(false);
    setShelving(null);
    setSession(null);
    setNotFound(false);
  }, [sessionId]);

  useEffect(() => {
    if (!chromePlace.ready || !chromePlace.split) return;
    let cancelled = false;
    api
      .sessions()
      .then((rows) => {
        if (cancelled) return;
        const others = rows
          .filter((row) => row.id !== sessionId)
          .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
        setSplitTargets(others.map((row) => ({ id: row.id, name: row.name })));
      })
      .catch(() => {
        if (!cancelled) setSplitTargets([]);
      });
    return () => {
      cancelled = true;
    };
  }, [chromePlace.ready, chromePlace.split, sessionId]);

  useEffect(() => {
    setLastProgressAt(Date.now());
  }, [entries.length]);

  // pi streaming a token or starting a tool is progress too, though no entry lands until the step
  // ends (#182). Only forward: an older activity time never rewinds the clock.
  useEffect(() => {
    if (piActiveAt !== undefined) setLastProgressAt((prev) => Math.max(prev, piActiveAt));
  }, [piActiveAt]);

  useEffect(() => {
    setLastProgressAt(Date.now());
    setPendingSend((p) => notePendingRunState(p, runState));
    // Held mail (cloud-fixes 13) changes with run lifecycle; refresh the session detail with it.
    if (runState) loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runState]);

  const activity = deriveSessionActivity({
    runState,
    runStateReason,
    entries,
    pending: pendingSend,
    now,
    lastProgressAt,
    agentSeenAt,
    piActiveAt,
    pendingAction,
  });
  const ticking =
    activity.phase === "sending" || activity.phase === "waking" || activity.phase === "working" || activity.phase === "quiet";
  const canBreak = canBreakTurn({ canAbort: activity.canAbort, pendingQuestion: pendingUiRequest != null, runState, phase: activity.phase });

  useEffect(() => {
    if (!ticking) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [ticking]);

  // Answered: the pending send has done its job.
  useEffect(() => {
    if (pendingSend && activity.phase === "none" && pendingSend.error === undefined) setPendingSend(null);
  }, [pendingSend, activity.phase]);

  function flashOutcome(outcome: TransportOutcome) {
    setTransportOutcome(outcome);
    setTimeout(() => setTransportOutcome((current) => (current === outcome ? null : current)), OUTCOME_FLASH_MS);
  }

  function flashToast(text: string) {
    setToast(text);
    setTimeout(() => setToast((current) => (current === text ? null : current)), TOAST_MS);
  }

  function loadSession() {
    if (!sessionId) return;
    api
      .session(sessionId)
      .then((s) => {
        if (currentSessionId.current !== s.id) return;
        setSession(s);
        setNotFound(false);
      })
      .catch((err) => {
        const state = toApiErrorState(err, "Failed to load session");
        if (state.status === 404) setNotFound(true);
        else setApiError(state);
      });
  }

  useEffect(() => {
    loadSession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // E3.8: GET /api/models' contextWindow is the only piece deriveSessionHeader can't get from the
  // transcript itself. Fetched once per page visit (ModelsService caches server-side for 5 min
  // regardless), not on every entries change.
  useEffect(() => {
    api.models().then(setModels).catch(() => setModels([]));
  }, []);

  useEffect(() => {
    const title = session?.name ?? (sessionId ? `Floppy ${sessionId.slice(0, 8)}` : "Floppy");
    const previous = document.title;
    document.title = `${title} · Outfitter`;
    return () => {
      document.title = previous;
    };
  }, [session?.name, sessionId]);

  // idle/stopped/failed means pi is not inside a tool. A newer user message settles the
  // previous turn even when the next run is already "running" again.
  const runSettled = runState === "idle" || runState === "stopped" || runState === "failed";
  // Memoised on the transcript itself: the page re-renders every second while a turn runs, and with
  // every streamed thought token, and none of that should re-group or re-diff the transcript.
  const flow = useMemo(
    () =>
      buildFlow(groupThinkingBlocks(entriesToViews(entries, { runSettled })), {
        runSettled,
        seconds: thinkingSeconds(entries),
      }),
    [entries, runSettled],
  );
  const previewAccess = useMemo(
    () => previewAccessByEntry(entries, session?.htmlPreviewAccessByRun, previewAccessFor(session?.allowExternalHtmlResources)),
    [entries, session?.htmlPreviewAccessByRun, session?.allowExternalHtmlResources],
  );
  // #502: the branch, PR and checks, read once for the chips, the Changes tab and the phone strip.
  // Messages for the agent (Fix CI, a conflict, diff notes) go through the normal send path.
  const git = useSessionGit({
    sessionId,
    repo: session?.id === sessionId ? session.repo : undefined,
    lastPush,
    runState,
    send: (text) => handleSend(text),
  });
  const diffNotes = useDiffNotes(sessionId);
  const changesFull = phone && changesFullFor === sessionId;
  const prDialog = prDialogFor === sessionId;

  const header = useMemo(() => {
    const windowById = new Map(models.map((m) => [m.id, m.contextWindow]));
    return deriveSessionHeader(entries, (id) => windowById.get(id));
  }, [entries, models]);
  // #285. The streamed text is the open message, which is not in the transcript yet, so it wins
  // over a persisted thought from earlier in the turn. Once that message is stored the stream
  // clears, and the newest stored thought stays open while later tool calls from the same reply run.
  const runLive = thoughtBubbles && runState === "running";
  const persistedThoughtId = liveThinkingId(flow, runLive);
  const persistedThought = persistedThoughtId ? flow.find((item) => item.id === persistedThoughtId) : undefined;
  const persistedThoughtText =
    persistedThought?.kind === "thinking" ? persistedThought.blocks.map((b) => b.text).join("\n\n") : null;
  const showStreamedThought = runLive && streamedThought !== null && streamedThought !== persistedThoughtText;
  const liveThoughtText = showStreamedThought ? streamedThought : (persistedThoughtText ?? "");

  // Follow the latest entry. Remember where that jump landed so its scroll event is not taken for
  // the reader scrolling away.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight <= el.clientHeight + 16) {
      landedAt.current = null;
      return;
    }
    el.scrollTo({ top: el.scrollHeight });
    landedAt.current = el.scrollTop;
    followThought.current = true;
  }, [entries.length, pendingSend?.localId, sessionId]);

  // The column changes size without a new entry: the dock grows (a question, a note, a taller
  // draft) or a row opens. A reader who was at the bottom stays there.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (!followThought.current) return;
      el.scrollTo({ top: el.scrollHeight });
      landedAt.current = el.scrollTop;
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [sessionId]);

  // A live thought grows inside one entry, so the entry-count follow above never sees it.
  // Stay with the newest line only when the reader was already at the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !liveThoughtText) return;
    if (!followThought.current) return;
    el.scrollTo({ top: el.scrollHeight });
    landedAt.current = el.scrollTop;
  }, [liveThoughtText]);

  async function reload() {
    const fresh = await api.session(sessionId);
    if (currentSessionId.current === fresh.id) setSession(fresh);
  }

  /** Sends, or queues behind the running turn. A stopped or sleeping floppy needs nothing else: the
   * api stores the message as mail and wakes a Drive for it (session-create.ts's postUserMail), and
   * the status line says "Waking a drive" meanwhile. */
  /** Resolves true once the api accepted (stored) the message. */
  async function handleSend(text: string, behavior?: "steer" | "followUp"): Promise<boolean> {
    const sentAt = Date.now();
    const localId = `local-${sentAt}`;
    setNow(sentAt);
    setPendingSend({
      localId,
      text,
      behavior,
      sentAt,
      ...nextSendAnchor(entries, pendingSend),
      runStateAtSend: runState,
      sawChange: false,
      sawRunning: false,
    });
    try {
      await api.sendMessage(sessionId, text, behavior);
      const acceptedAt = Date.now();
      setLastProgressAt(acceptedAt);
      setPendingSend((p) => (p?.localId === localId ? { ...p, acceptedAt } : p));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPendingSend((p) => (p?.localId === localId ? { ...p, error: message } : p));
      return false;
    }
    await reload().catch(() => {});
    return true;
  }

  /** Retry on the status line: a failed send or a stuck turn re-sends; a drive that didn't come up
   * is re-woken (and any mail parked for a deploy mismatch released). */
  async function handleRetry() {
    const p = pendingSend;
    if (activity.phase === "wakeTimeout") {
      const at = Date.now();
      setLastProgressAt(at);
      setNow(at);
      if (p) setPendingSend({ ...p, acceptedAt: at, runStateAtSend: runState, sawChange: false, sawRunning: false });
      try {
        await api.retryMail(sessionId);
        if (!p) await api.wake(sessionId);
        await reload();
      } catch (err) {
        flashOutcome("loadError");
        setApiError(toApiErrorState(err, "Failed to wake"));
      }
      return;
    }
    if (p) {
      await handleSend(p.text, p.behavior);
      return;
    }
    // A quiet running turn with no send of ours to repeat: keep waiting from now.
    setLastProgressAt(Date.now());
  }

  async function handleMailRetry() {
    try {
      await api.retryMail(sessionId);
      await reload();
    } catch (err) {
      setApiError(toApiErrorState(err, "Failed to retry held messages"));
    }
  }

  async function runAction(action: Exclude<PendingAction, null>, call: () => Promise<unknown>) {
    setPendingAction(action);
    try {
      await withFloppySound(call());
      await reload();
      if (action === "abort") flashOutcome("break");
    } catch (err) {
      if (action === "wake") flashOutcome("loadError");
      setApiError(toApiErrorState(err, `Failed to ${action}`));
    } finally {
      setPendingAction(null);
    }
  }

  async function shelve(action: "archive" | "restore") {
    const id = sessionId;
    setShelving(action);
    try {
      await withFloppySound(action === "archive" ? api.archiveSession(id) : api.restoreSession(id));
      if (currentSessionId.current === id) await reload();
    } catch (err) {
      if (currentSessionId.current === id) setApiError(toApiErrorState(err, `Failed to ${action} floppy`));
    } finally {
      if (currentSessionId.current === id) setShelving(null);
    }
  }

  const handleAbort = () => runAction("abort", () => api.abort(sessionId));
  const handleStop = () => runAction("stop", () => api.stop(sessionId));
  // Start Drive (the ⋯ menu): a Drive without a prompt, for VS Code or previews.
  const handleWake = () => runAction("wake", () => api.wake(sessionId));

  // Esc breaks the running turn when nothing else wants it (lib/break-keys.ts).
  const abortRef = useRef<(() => void) | null>(null);
  abortRef.current = canBreak && pendingAction === null ? handleAbort : null;
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!escBreaks(event)) return;
      if (!abortRef.current) return;
      event.preventDefault();
      abortRef.current();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  async function handleUiResponse(requestId: string, value: unknown) {
    await api.uiResponse(sessionId, requestId, value);
  }

  async function copyTeleport() {
    const cmd = teleportCommand(sessionId);
    try {
      await navigator.clipboard.writeText(cmd);
      flashToast(`Copied: ${cmd}`);
    } catch {
      // clipboard access denied -- nothing more we can do from here
    }
  }

  async function copyGuruId() {
    if (!session?.guruId) return;
    try {
      await navigator.clipboard.writeText(session.guruId);
      setCopiedGuruId(true);
      flashToast("Copied the tape id");
      setTimeout(() => setCopiedGuruId(false), TOAST_MS);
    } catch {
      // clipboard access denied -- nothing more we can do from here
    }
  }

  /** A git chip: open the Changes tab (the full-screen view on a phone), or do its action. */
  function onGitAction(action: GitChipAction) {
    if (action === "create-pr") {
      setPrDialogFor(sessionId);
      return;
    }
    if (action === "fix-ci") void git.fixCi();
    if (phone) {
      setChangesFullFor(sessionId);
      return;
    }
    setPaneTab("changes");
    if (!paneOpen) {
      savePaneOpen(true);
      setPaneChoice(true);
    }
  }

  function togglePane() {
    savePaneOpen(!paneOpen);
    setPaneChoice(!paneOpen);
  }

  function setDiskBox(open: boolean) {
    saveDiskBoxOpen(open);
    setDiskBoxOpen(open);
  }

  if (notFound) return <NotFoundError subject="This floppy" />;

  const archived = Boolean(session?.archivedAt);
  const cost = costEstimate ?? session?.cost;
  const percent = header.context?.percent;
  const oomMessage = typeof percent === "number" ? contextMeterMessage(percent) : null;
  // Bug 7 (docs/reports/cloud-fixes.md): a pi RPC command agentd's run rejected. Also the api's own
  // reason when it refuses the run's agent connection (agentlink.ts's refuse()) or gives up on its
  // sandbox (runs.ts's reconciler) -- for a run that never started, this note is the only thing a
  // person gets, since the transcript's end line only has room for the short reason.
  const detailNote = runStateNote(statusDetail);
  // Same source as the pill and Break: while a send is in flight (or timed out) the live status line
  // speaks for the run, so the transcript must not also end on READY. The lamp is the human state.
  const statusLine =
    activity.phase === "none"
      ? deriveTransportStatusLine(activity.pillState, transportOutcome, runStateReason)
      : transportOutcome
        ? transportStatusLine(transportOutcome)
        : null;
  const lamp = sessionLamp({
    runState: activity.pillState,
    phase: activity.phase,
    pendingQuestion: pendingUiRequest != null,
    statusLine,
  });
  const statusError = activity.errorHeadline;

  // A session's current model reads "provider/model" (deriveSessionHeader); if that provider's
  // own Peripherals row reports "down", the run can't reach it -- surface the same
  // ?DEVICE NOT PRESENT ERROR the Peripherals page shows for that row, right where the user is
  // already looking, instead of a confusing generic run failure.
  const floppyTitle = session?.name ?? `Floppy ${sessionId.slice(0, 8)}`;
  const cluster = githubCluster(session);
  const looseRepo = looseRepoClause(session);
  const modelProviderKind = header.model?.split("/")[0];
  // The floppy's own model (pinned from the tape when it was made, then switched), when pi isn't on
  // it yet. Before the first reply the header shows the floppy's model itself instead.
  const pendingModel =
    header.model && session?.modelOverride && session.modelOverride !== header.model ? session.modelOverride : undefined;
  const shownModel = header.model ?? session?.modelOverride;
  const driveGoing = runState === "queued" || runState === "provisioning" || runState === "running" || runState === "idle";
  const modelProviderDown = modelProviderKind
    ? providers.find((p) => p.kind === modelProviderKind)?.status === "down"
    : false;
  const canSwitchModel = !archived && Boolean(session);
  const startup = streamStartup !== undefined ? streamStartup : session?.startup;

  // The live status line: what it's doing, how long, how many tokens.
  const toolInFlight = runningTool(flow);
  const liveVerb = toolInFlight && activity.phase === "working" ? toolVerb(toolInFlight) : (activity.label ?? "Working").replace(/…$/, "");
  const startedAt = turnStartedAt(entries, pendingSend?.sentAt);
  const outTokens = turnOutputTokens(entries);
  const sentWhileBusy = pendingSend?.runStateAtSend === "running" && pendingSend.behavior !== "steer";

  function onSessionScroll(event: UIEvent<HTMLDivElement>) {
    const el = event.currentTarget;
    const top = el.scrollTop;
    if (landedAt.current !== null && Math.abs(top - landedAt.current) < 2) return;
    landedAt.current = null;
    // Same slop as the jump recorded above. A short scroll up is the reader, and the next
    // thought line must not pull them back to the bottom.
    followThought.current = el.scrollHeight - top - el.clientHeight < 2;
  }

  const liveChips = (
    <>
      <PreviewChips sessionId={sessionId} runState={runState} onError={setApiError} />
      <IdeChip />
    </>
  );

  const changesPane = (
    <ChangesPane
      git={git}
      notes={diffNotes}
      lastPush={lastPush}
      onCreatePr={() => setPrDialogFor(sessionId)}
      autofix={
        session?.repo
          ? {
              state: session.autofix,
              canManage: Boolean(session.canManage),
              archived,
              onToggle: async (on) => {
                // Bound to the floppy it started on, like the git writes (#502).
                const id = sessionId;
                try {
                  const result = await api.setAutofix(id, on);
                  setSession((s) => (s && s.id === id ? { ...s, autofixCi: result.autofixCi, autofix: result.autofix } : s));
                  return null;
                } catch (err) {
                  return err instanceof ApiError ? err.message : "Auto-fix couldn't be changed. Try again.";
                }
              },
            }
          : undefined
      }
      onSendNotes={async (text) => {
        const ok = await handleSend(text);
        if (ok) setChangesFullFor(null);
        return ok;
      }}
    />
  );

  const details = (withChips: boolean) => (
    <SessionDetails
      sessionId={sessionId}
      runState={runState}
      startup={startup}
      model={shownModel}
      pendingModel={pendingModel}
      thinking={header.thinking}
      onSwitchModel={() => {
        setSheetFor(null);
        setModelOpenFor(sessionId);
      }}
      canSwitchModel={canSwitchModel}
      guruId={session?.guruId}
      onCopyGuruId={copyGuruId}
      copiedGuruId={copiedGuruId}
      cost={cost}
      looseRepo={looseRepo}
      context={header.context}
      oomMessage={oomMessage}
      cluster={cluster}
      chips={withChips ? liveChips : undefined}
      thoughtBubbles={thoughtBubbles}
      onThoughtBubbles={(next) => {
        setThoughtBubbleEnabled(next);
        setThoughtBubbles(next);
      }}
      scannerColour={scannerColour}
      onScannerColour={(next) => {
        saveScannerColour(next);
        setScannerColour(next);
      }}
    />
  );

  const menu = (close: () => void) => (
    <SessionMenu
      close={close}
      sessionId={sessionId}
      floppyTitle={floppyTitle}
      onEject={copyTeleport}
      chrome={chromePlace}
      splitTargets={splitTargets}
      onSwitchModel={() => setModelOpenFor(sessionId)}
      canSwitchModel={canSwitchModel}
      onStop={handleStop}
      canStop={activity.canStop}
      onStart={handleWake}
      canStart={activity.canWake && !archived}
      canManage={Boolean(session?.canManage)}
      archived={archived}
      shelving={shelving !== null}
      onArchive={() => shelve("archive")}
      onRestore={() => shelve("restore")}
      onFormat={() => setFormatOpen(true)}
      guruId={session?.guruId}
      onCopyGuruId={copyGuruId}
    />
  );

  const placeholder = archived
    ? "This floppy is archived"
    : ticking && activity.canAbort
      ? "Add a follow-up. It sends when this turn ends"
      : runState === "idle"
        ? `Message ${floppyTitle}`
        : "Drive is asleep. Sending wakes it";

  // The transcript's last line when nothing is running: READY. and its cursor, or how it stopped.
  const endLine =
    !ticking && !pendingUiRequest && statusLine ? (
      statusLine === "READY." ? (
        <div className="flow-end is-ready" role="status">
          READY.<span className="flow-cursor" aria-hidden="true" />
        </div>
      ) : (
        <div className={`flow-end${statusLine.startsWith("LOAD ERROR") || statusLine === "BREAK" ? " is-error" : ""}`} role="status">
          {statusLine}
        </div>
      )
    ) : null;

  return (
    // #273: one view of the Drive's IDE for the header chip, the menu and any chat chips.
    <IdeProvider sessionId={sessionId} runState={runState} onError={setApiError}>
      <div className={`session-shell${phone ? " is-phone" : ""}`} data-scanner={scannerColour}>
        {apiError && (
          <SystemErrorDialog
            error={apiError}
            onRestart={() => {
              setApiError(null);
              loadSession();
            }}
            onResume={() => setApiError(null)}
          />
        )}
        {!phone && diskBoxOpen && (
          <DiskBoxSidebar
            currentId={sessionId}
            needsYou={pendingUiRequest != null}
            refreshKey={`${sessionId}|${runState ?? ""}|${session?.name ?? ""}|${session?.archivedAt ?? ""}`}
            archiveKey={`${sessionId}|${session?.archivedAt ?? ""}`}
            onHide={() => setDiskBox(false)}
          />
        )}
        <div className="session-main">
          <header className="session-head">
            {phone ? (
              <Link to="/fleet" className="icon-btn" aria-label={`Back to the ${vocabulary.sessionList.one}`} title={vocabulary.sessionList.one}>
                <BackIcon />
              </Link>
            ) : !diskBoxOpen ? (
              <button type="button" className="icon-btn" onClick={() => setDiskBox(true)} aria-label="Show the Disk Box" title="Show the Disk Box">
                <SideIcon />
              </button>
            ) : null}
            <div className="session-head-title">
              <h1 title={floppyTitle}>{floppyTitle}</h1>
              <span className="session-state">
                <TransportDot tone={lamp.tone} label={lamp.detail === lamp.label ? undefined : lamp.label} />
                <StatusPill state={activity.pillState} />
                {lamp.detail && (
                  <span className={`session-transport-detail${lamp.detail === "BREAK" ? " is-attention" : ""}`} title={lamp.detail}>
                    {lamp.detail}
                  </span>
                )}
              </span>
            </div>
            {!phone && (
              <div className="session-chips">
                <GitChips git={git} onAction={onGitAction} />
                {liveChips}
              </div>
            )}
            {!phone && (
              <button
                type="button"
                className="icon-btn"
                aria-pressed={paneOpen}
                aria-controls={paneOpen ? "session-pane" : undefined}
                aria-label="Changes and details pane"
                title="Changes and details: the branch and PR, model, context, Drive stats and logs"
                onClick={togglePane}
              >
                <PaneIcon />
              </button>
            )}
            {phone ? (
              <button
                ref={moreRef}
                type="button"
                className="icon-btn"
                aria-label="More actions and details"
                aria-expanded={sheetOpen}
                onClick={() => setSheetFor(sheetOpen ? null : sessionId)}
              >
                <MoreIcon />
              </button>
            ) : (
              <PopMenu label="More actions" icon={<MoreIcon />}>
                {menu}
              </PopMenu>
            )}
          </header>
          {phone && <GitStrip git={git} onOpen={() => setChangesFullFor(sessionId)} />}
          <div className="session-body">
            <div className="session-col">
              <div className="session-scroll" ref={scrollRef} onScroll={onSessionScroll}>
                <div className="transcript flow" aria-label="Transcript">
                  {flow.length === 0 && !activity.showOptimistic && !showStreamedThought ? (
                    <p className="empty-state">No entries yet. Send a message below to start the run.</p>
                  ) : (
                    <TranscriptFlow
                      items={flow}
                      sessionId={sessionId}
                      previewAccess={previewAccess}
                      liveThinkingId={showStreamedThought ? null : persistedThoughtId}
                      defaultThinkingExpanded={defaultThinkingExpanded}
                      vscodeLiveId={lastVsCodeToolId(flow)}
                    />
                  )}
                  {showStreamedThought && streamedThought !== null && (
                    <ThinkingRow blocks={[{ id: STREAMED_THOUGHT_ID, text: streamedThought }]} live />
                  )}
                  {activity.showOptimistic && pendingSend && (
                    <UserBlock text={pendingSend.text} queued={sentWhileBusy && pendingSend.error === undefined}>
                      <span className="flow-user-local" data-local-id={pendingSend.localId} hidden />
                      {pendingSend.acceptedAt === undefined && pendingSend.error === undefined && (
                        <span className="entry-sending-note">Sending</span>
                      )}
                      {pendingSend.error !== undefined && (
                        <span className="entry-failed-note" role="alert">
                          Not sent{pendingSend.error ? `: ${pendingSend.error}` : ""}.{" "}
                          <button type="button" className="btn btn-small" onClick={handleRetry}>
                            Retry
                          </button>
                        </span>
                      )}
                    </UserBlock>
                  )}
                  {endLine}
                </div>
              </div>
              <div className="scanner-seam">{ticking && !pendingUiRequest && <KnightRiderScanner />}</div>
              <div className="session-dock">
                {ticking && !statusError && !pendingUiRequest && (
                  <div className="live-status" role="status">
                    <span className="live-spin" aria-hidden="true">
                      ✻
                    </span>
                    <span className="live-verb">{liveVerb}…</span>
                    <span className="live-meta">
                      {startedAt !== undefined ? formatElapsed(now - startedAt) : null}
                      {outTokens > 0 ? ` · ↓ ${formatTokens(outTokens)} tokens` : null}
                    </span>
                    {canBreak && <span className="live-hint">esc to break</span>}
                  </div>
                )}
                {statusError && (
                  <p className="dock-note is-error send-status-error" role="alert">
                    <strong>{statusError}</strong>
                    <span className="send-status-detail">{activity.label}</span>
                    {!archived && (
                      <button type="button" className="btn btn-small" onClick={handleRetry}>
                        Retry
                      </button>
                    )}
                  </p>
                )}
                {oomMessage && (
                  <p className="dock-note is-warn context-oom-note" role="alert">
                    {oomMessage}
                  </p>
                )}
                {modelProviderDown && (
                  <DeviceNotPresent reason={`the ${modelProviderKind} peripheral is down -- this run can't reach its model right now.`} />
                )}
                {detailNote && (
                  <p className="dock-note is-error status-detail-note" role="alert">
                    {detailNote}
                  </p>
                )}
                {session?.mailNotice && (
                  <p className="dock-note is-warn mail-held-note" role="alert">
                    <span>
                      {session.mailNotice}
                      {session.heldMail ? ` (${session.heldMail})` : ""}
                    </span>
                    <button
                      type="button"
                      className="btn btn-small"
                      onClick={handleMailRetry}
                      disabled={archived}
                      title={archived ? "Restore this floppy to deliver its messages" : undefined}
                    >
                      Retry
                    </button>
                  </p>
                )}
                {archived && (
                  <p className="dock-note archived-note" role="status">
                    <span>This floppy is archived: it can't run or take messages until it's restored.</span>
                    {session?.canManage && (
                      <>
                        <button type="button" className="btn btn-small" onClick={() => shelve("restore")} disabled={shelving !== null} title={floppyActions.restore.hint}>
                          {shelving === "restore" ? <Working label="Restoring" /> : floppyActions.restore.word}
                        </button>
                        <button type="button" className="btn btn-small btn-danger" onClick={() => setFormatOpen(true)} disabled={shelving !== null} title={floppyActions.format.hint}>
                          {floppyActions.format.word}…
                        </button>
                      </>
                    )}
                  </p>
                )}
                {shelving === "archive" && (
                  <p className="dock-note" role="status">
                    <Working label="Archiving" srOnly={false} />
                  </p>
                )}
                {chromePlace.note && (
                  <p className="dock-note is-error status-detail-note" role="alert">
                    {chromePlace.note}
                  </p>
                )}
                {pendingUiRequest && <UiRequestPanel request={pendingUiRequest} onRespond={handleUiResponse} />}
                <Composer
                  // One composer per session: a draft (and its Preview state) never follows the user to
                  // another session, where Enter would send it to the wrong agent.
                  key={sessionId}
                  sessionId={sessionId}
                  voiceEngine={session?.voiceEngine}
                  voiceSpeak={session?.voiceSpeak}
                  entries={entries}
                  entriesLoaded={entriesLoaded}
                  agentBusy={ticking}
                  onSend={async (text, behavior) => {
                    await handleSend(text, behavior);
                  }}
                  disabled={activity.composerDisabled || archived}
                  sending={activity.phase === "sending"}
                  placeholderOverride={placeholder}
                  busy={canBreak}
                  onBreak={handleAbort}
                  breaking={pendingAction === "abort"}
                  modelChip={
                    <button
                      type="button"
                      className="composer-pill mono"
                      onClick={() => setModelOpenFor(sessionId)}
                      disabled={!canSwitchModel}
                      title={archived ? "Restore the floppy to switch its model" : `Switch model${pendingModel ? ` (switching to ${pendingModel})` : ""}`}
                    >
                      {shownModel ? (phone ? shownModel.split("/").pop() : shownModel) : "model"}
                      {pendingModel ? " →" : ""} ▾
                    </button>
                  }
                  contextChip={
                    typeof percent === "number" && header.context ? (
                      <span
                        className="composer-pill mono"
                        title={`Context used: ${header.context.tokens.toLocaleString()} of ${header.context.window?.toLocaleString()} tokens`}
                      >
                        <ContextRing percent={percent} />
                        <span className="composer-pill-text">{Math.round(percent)}%</span>
                        <span className="sr-only"> of the context window used</span>
                      </span>
                    ) : null
                  }
                />
                {toast && (
                  <div className="session-toast" role="status">
                    {toast}
                  </div>
                )}
              </div>
            </div>
            {!phone && paneOpen && (
              <aside id="session-pane" className="session-pane" aria-label="Changes and details">
                <div className="pane-tabs" role="tablist" aria-label="Pane">
                  {PANE_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      role="tab"
                      id={`pane-tab-${tab.id}`}
                      aria-selected={paneTab === tab.id}
                      aria-controls={`pane-panel-${tab.id}`}
                      onClick={() => setPaneTab(tab.id)}
                    >
                      {tab.label}
                      {tab.id === "changes" && git.changes && git.changes.files.length > 0 ? ` ${git.changes.files.length}` : ""}
                    </button>
                  ))}
                </div>
                <div className="pane-panel" role="tabpanel" id={`pane-panel-${paneTab}`} aria-labelledby={`pane-tab-${paneTab}`}>
                  {paneTab === "changes" && changesPane}
                  {paneTab === "details" && details(false)}
                </div>
              </aside>
            )}
          </div>
        </div>

        {changesFull && (
          <ChangesFullView title={floppyTitle} onClose={() => setChangesFullFor(null)}>
            {changesPane}
          </ChangesFullView>
        )}

        {prDialog && (
          <CreatePrDialog
            defaultTitle={floppyTitle}
            repo={session?.repo ?? null}
            branch={git.changes?.branch ?? git.status?.branch ?? null}
            base={git.changes?.base ?? git.status?.baseBranch ?? null}
            onSubmit={git.createPr}
            onClose={() => setPrDialogFor(null)}
          />
        )}

        {sheetOpen && (
          <SessionSheet onClose={() => setSheetFor(null)} returnFocus={moreRef} menu={menu(() => setSheetFor(null))}>
            {details(true)}
            {/* On a phone the app bar is gone too: its links and toggles live at the sheet's foot. */}
            <section className="details-sec sheet-foot" aria-label="Outfitter">
              <nav className="sheet-pages" aria-label="Pages">
                {navItems.map((item) => (
                  <NavLink key={item.to} to={item.to} end={item.end} title={item.hint}>
                    {item.label}
                  </NavLink>
                ))}
              </nav>
              <div className="sheet-toggles">
                <SoundToggle />
                <ThemeToggle />
              </div>
              {versionText && <p className="details-empty">Outfitter {versionText}</p>}
            </section>
          </SessionSheet>
        )}

        {modelOpen && session && (
          <SwitchModelDialog
            sessionId={sessionId}
            current={shownModel}
            modelOverride={session.modelOverride}
            guruModel={session.guruModel}
            models={models}
            live={driveGoing}
            onCancel={() => setModelOpenFor(null)}
            onError={(error) => {
              setModelOpenFor(null);
              // The api may have stored the choice before the Drive's send failed: show what it has.
              if (currentSessionId.current === session.id) {
                setApiError(error);
                loadSession();
              }
            }}
            onSwitched={(result) => {
              setModelOpenFor(null);
              setSession((s) => (s && s.id === sessionId ? { ...s, modelOverride: result.modelOverride ?? undefined } : s));
            }}
          />
        )}
        {formatOpen && (
          <FormatFloppyDialog
            sessionId={sessionId}
            title={floppyTitle}
            onCancel={() => setFormatOpen(false)}
            onError={(error) => {
              setFormatOpen(false);
              setApiError(error);
            }}
            onFormatted={() => navigate("/fleet?archived=only")}
          />
        )}
      </div>
    </IdeProvider>
  );
}
