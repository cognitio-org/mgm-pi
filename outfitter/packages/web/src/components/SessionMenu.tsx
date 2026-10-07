import type { ReactNode } from "react";
import type { ChromeCompanion } from "../hooks/useChromeCompanion.ts";
import { floppyActions, transport } from "../lib/vocabulary.ts";
import { useIde } from "./IdeProvider.tsx";

function Item({
  glyph,
  children,
  note,
  danger,
  disabled,
  title,
  onClick,
}: {
  glyph: string;
  children: ReactNode;
  note?: string;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" role="menuitem" className={`menu-item${danger ? " is-danger" : ""}`} disabled={disabled} title={title} onClick={onClick}>
      <span className="menu-item-glyph" aria-hidden="true">
        {glyph}
      </span>
      <span>{children}</span>
      {note ? <small>{note}</small> : <span />}
    </button>
  );
}

/** "Open in VS Code" from the menu: the same IDE the Details tab's chip drives (IdeProvider). */
function VsCodeItem({ close }: { close: () => void }) {
  const c = useIde();
  if (!c?.ide?.available || c.forbidden) return null;
  if (c.ready && c.ide.url) {
    const url = c.ide.url;
    return (
      <Item
        glyph="⌨"
        note="new tab"
        onClick={() => {
          close();
          window.open(url, "_blank", "noopener,noreferrer");
        }}
      >
        Open VS Code
      </Item>
    );
  }
  return (
    <Item
      glyph="⌨"
      disabled={!c.openable || c.busy !== null}
      title={c.openable ? "Start VS Code in the browser on this Drive" : "The Drive has to be running first."}
      onClick={() => {
        close();
        void c.open();
      }}
    >
      Open in VS Code
    </Item>
  );
}

/**
 * #498: the floppy's ⋯ menu (docs/design/sessions-redesign-demo.html note 2): everything the old
 * title bar's buttons did, minus Play (sending wakes the Drive) and Break (the composer's button and
 * Esc). The same items fill the bottom sheet on a phone.
 */
export function SessionMenu({
  close,
  sessionId,
  floppyTitle,
  onEject,
  chrome,
  splitTargets,
  onSwitchModel,
  canSwitchModel,
  onStop,
  canStop,
  canManage,
  archived,
  shelving,
  onArchive,
  onRestore,
  onFormat,
  guruId,
  onCopyGuruId,
}: {
  close: () => void;
  sessionId: string;
  floppyTitle: string;
  onEject: () => void;
  chrome: ChromeCompanion;
  splitTargets: { id: string; name?: string }[];
  onSwitchModel: () => void;
  canSwitchModel: boolean;
  onStop: () => void;
  canStop: boolean;
  canManage: boolean;
  archived: boolean;
  shelving: boolean;
  onArchive: () => void;
  onRestore: () => void;
  onFormat: () => void;
  guruId?: string;
  onCopyGuruId: () => void;
}) {
  const run = (action: () => void) => () => {
    close();
    action();
  };
  return (
    <>
      <Item glyph={transport.eject.glyph} note="kernal" title={`${transport.eject.word}: ${transport.eject.hint}`} onClick={run(onEject)}>
        {transport.eject.word} to laptop
      </Item>
      <VsCodeItem close={close} />
      {chrome.ready && (
        <>
          <Item glyph="▣" title="Open this Floppy in its own tab group" onClick={run(() => chrome.place("own", floppyTitle))}>
            This Floppy's group
          </Item>
          <Item glyph="▤" title="Open this Floppy in the shared Floppies group" onClick={run(() => chrome.place("shared", floppyTitle))}>
            Floppies group
          </Item>
          <Item glyph="⧉" title="Open this Floppy in a new window" onClick={run(() => chrome.place("window", floppyTitle))}>
            New window
          </Item>
          {chrome.split &&
            splitTargets
              .filter((row) => row.id !== sessionId)
              .slice(0, 6)
              .map((row) => (
                <Item key={row.id} glyph="◫" title="Split this Floppy beside another" onClick={run(() => chrome.splitWith(row.id))}>
                  Split with {row.name ?? `Floppy ${row.id.slice(0, 8)}`}
                </Item>
              ))}
        </>
      )}
      <Item glyph="⚙" disabled={!canSwitchModel} title={archived ? "Restore the floppy to switch its model" : "Switch model"} onClick={run(onSwitchModel)}>
        Switch model…
      </Item>
      <hr />
      <Item glyph={transport.stop.glyph} disabled={!canStop} title="Stop this floppy's run" onClick={run(onStop)}>
        Stop Drive
      </Item>
      {canManage && !archived && (
        <Item glyph="▤" disabled={shelving} title={floppyActions.archive.hint} onClick={run(onArchive)}>
          {floppyActions.archive.word}
        </Item>
      )}
      {canManage && archived && (
        <>
          <Item glyph="↺" disabled={shelving} title={floppyActions.restore.hint} onClick={run(onRestore)}>
            {floppyActions.restore.word}
          </Item>
          <Item glyph="⌫" danger disabled={shelving} title={floppyActions.format.hint} onClick={run(onFormat)}>
            {floppyActions.format.word}…
          </Item>
        </>
      )}
      {guruId && (
        <>
          <hr />
          <Item glyph="⧉" note={guruId.slice(0, 8)} title="Copy full tape id" onClick={run(onCopyGuruId)}>
            Copy tape id
          </Item>
        </>
      )}
    </>
  );
}
