// #458: a model-valued setting (model.default, compaction.summaryModel) as a searchable dropdown
// instead of a free-text box. Typing searches the list; Enter or a click picks. "Other…" switches
// to typing any id, for a model the list doesn't have. A stored value that isn't in the list is
// still shown, marked "not in the list", so nothing is lost. Disabled (a value the Sysop locks)
// it is read-only. With no list (loading, unreadable, or a provider with none), it is the plain
// text box it used to be.

import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { filterChoices, inList, type ChoiceSet, type ModelChoice } from "../../lib/model-choices.ts";

type Item =
  | { kind: "unset" }
  | { kind: "current"; value: string }
  | { kind: "model"; value: string; group: string }
  | { kind: "other"; query: string };

interface Props {
  /** The setting's key: the field is labelled "<key> value". */
  settingKey: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  /** The options; null while they load or when they couldn't be read. */
  set: ChoiceSet | null;
  /** What applies when nothing is set here ("default: x", "not set"). */
  placeholder: string;
}

/** The menu for a query: "not set" (no query), the stored value when it isn't listed, the
 * matching models, then "Other…". Exported for tests. */
export function menuItems(choices: readonly ModelChoice[], value: string, query: string): Item[] {
  const q = query.trim();
  const items: Item[] = [];
  if (!q) items.push({ kind: "unset" });
  if (value && !inList(choices, value) && (!q || value.toLowerCase().includes(q.toLowerCase()))) items.push({ kind: "current", value });
  for (const c of filterChoices(choices, q)) items.push({ kind: "model", value: c.value, group: c.group });
  items.push({ kind: "other", query: q && !choices.some((c) => c.value === q) ? q : "" });
  return items;
}

function itemLabel(item: Item): string {
  switch (item.kind) {
    case "unset":
      return "not set here";
    case "current":
      return item.value;
    case "model":
      return item.value;
    case "other":
      return item.query ? `Other: use "${item.query}"` : "Other…";
  }
}

export function ModelField({ settingKey, value, onChange, disabled, set, placeholder }: Props) {
  const id = useId();
  const aria = `${settingKey} value`;
  const [mode, setMode] = useState<"list" | "other">("list");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const focusAfter = useRef(false);

  const choices = set?.choices ?? [];
  const hasList = choices.length > 0;
  const listMode = hasList && mode === "list";
  const notListed = hasList && value !== "" && !inList(choices, value);
  const items = listMode ? menuItems(choices, value, query) : [];
  const activeIndex = items.length === 0 ? 0 : Math.min(active, items.length - 1);
  const menuId = `${id}-menu`;
  const optionId = (i: number) => `${id}-opt-${i}`;

  useEffect(() => {
    if (focusAfter.current) {
      focusAfter.current = false;
      inputRef.current?.focus();
    }
  }, [mode]);

  // A lock (or a save in progress) closes the menu.
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function show() {
    if (disabled) return;
    if (!open) {
      setQuery("");
      // Start on the stored value when it is listed.
      const start = menuItems(choices, value, "").findIndex((it) => it.kind !== "unset" && "value" in it && it.value === value);
      setActive(start >= 0 ? start : 0);
    }
    setOpen(true);
  }

  function close() {
    setOpen(false);
    setQuery("");
  }

  /** Leaving the box (Tab, a click elsewhere, Save) with something typed keeps it: a listed
   * model when it is one (any case), else the text as typed, as Other… would. */
  function commitTyped() {
    const q = query.trim();
    if (open && q) {
      const hit = choices.find((c) => c.value.toLowerCase() === q.toLowerCase());
      if (hit) onChange(hit.value);
      else {
        onChange(q);
        setMode("other");
      }
    }
    close();
  }

  function choose(item: Item) {
    if (item.kind === "unset") onChange("");
    else if (item.kind === "model") onChange(item.value);
    else if (item.kind === "other") {
      if (item.query) onChange(item.query);
      focusAfter.current = true;
      setMode("other");
    }
    close();
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) return show();
      setActive((cur) => {
        const i = Math.min(cur, items.length - 1);
        return e.key === "ArrowDown" ? Math.min(items.length - 1, i + 1) : Math.max(0, i - 1);
      });
      return;
    }
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter" && open) {
      // Picks from the menu instead of submitting the form.
      e.preventDefault();
      const item = items[activeIndex];
      if (item) choose(item);
    }
  }

  const marker = notListed ? (
    <span className="pill model-field-unlisted" title="Saved as typed: no provider lists it right now">
      not in the list
    </span>
  ) : null;
  const note = set?.note ? <div className="session-meta">{set.note}</div> : null;

  if (!listMode) {
    return (
      <div className="model-field">
        <div className="model-field-row">
          <input
            ref={inputRef}
            type="text"
            className="mono"
            value={value}
            disabled={disabled}
            placeholder={placeholder}
            onChange={(e) => onChange(e.target.value)}
            aria-label={aria}
            autoComplete="off"
            spellCheck={false}
          />
          {marker}
          {hasList && !disabled && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                focusAfter.current = true;
                setMode("list");
              }}
            >
              Choose from the list
            </button>
          )}
        </div>
        {note}
      </div>
    );
  }

  // Grouped for display; the index into `items` drives the keyboard and aria-activedescendant.
  let lastGroup: string | undefined;
  return (
    <div className="model-field">
      <div className="model-field-row">
        <input
          ref={inputRef}
          type="text"
          className="mono"
          role="combobox"
          aria-label={aria}
          aria-expanded={open}
          aria-autocomplete="list"
          aria-controls={open ? menuId : undefined}
          aria-activedescendant={open && items.length ? optionId(activeIndex) : undefined}
          value={open ? query : value}
          placeholder={open ? value || placeholder : placeholder}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
          onClick={show}
          onChange={(e) => {
            const q = e.target.value;
            setQuery(q);
            // The first listed match, not the unlisted stored value, is what Enter picks.
            const next = menuItems(choices, value, q);
            const firstModel = next.findIndex((it) => it.kind === "model");
            setActive(firstModel >= 0 ? firstModel : 0);
            setOpen(true);
          }}
          onBlur={commitTyped}
          onKeyDown={onKeyDown}
        />
        {marker}
      </div>
      {open && (
        <div id={menuId} className="model-menu" role="listbox" aria-label={`${settingKey} models`} onMouseDown={(e) => e.preventDefault()}>
          {items.map((item, i) => {
            const group = item.kind === "model" ? item.group : undefined;
            const heading = group && group !== lastGroup ? group : null;
            lastGroup = group ?? lastGroup;
            const selected = (item.kind === "model" || item.kind === "current") && item.value === value;
            return (
              <div key={`${item.kind}:${"value" in item ? item.value : ""}`} role="presentation">
                {heading && (
                  <div className="model-menu-group" role="presentation">
                    {heading}
                  </div>
                )}
                <button
                  id={optionId(i)}
                  type="button"
                  role="option"
                  tabIndex={-1}
                  aria-selected={i === activeIndex}
                  data-current={selected ? "true" : undefined}
                  className={i === activeIndex ? "is-active" : undefined}
                  onClick={() => choose(item)}
                >
                  <span className={item.kind === "model" || item.kind === "current" ? "mono" : undefined}>{itemLabel(item)}</span>
                  {item.kind === "current" && <span className="model-menu-meta">not in the list</span>}
                  {selected && <span className="model-menu-meta">current</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {note}
    </div>
  );
}
