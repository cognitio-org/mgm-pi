import { useMemo, useState } from "react";
import type { ModelRow } from "../api/client.ts";
import { filterModels } from "../lib/model-filter.ts";

interface Props {
  id: string;
  label: string;
  models: ModelRow[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

function badges(m: ModelRow): string {
  const parts: string[] = [];
  if (m.auto) parts.push("auto");
  if (m.local) parts.push("local");
  return parts.join(" · ");
}

function kTokens(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
}

/** Filterable list of the LiteLLM router's models (GET /api/models) plus config.localModels,
 * with a free-text fallback: a guru may name any `provider/id`, including one this deployment's
 * router doesn't currently expose (EPIC.md E3.7). Typing directly into the input always sets
 * `value`; the dropdown below is a shortcut for picking one without typing the id out. */
export function ModelPicker({ id, label, models, value, onChange, placeholder }: Props) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(() => filterModels(models, filter), [models, filter]);

  return (
    <div className="form-row model-picker">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        value={value}
        placeholder={placeholder ?? "provider/id"}
        onChange={(e) => {
          onChange(e.target.value);
          setFilter(e.target.value);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        autoComplete="off"
      />
      {open && filtered.length > 0 && (
        <ul className="model-picker-list" role="listbox">
          {filtered.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onChange(m.id);
                  setFilter(m.id);
                  setOpen(false);
                }}
              >
                <span className="mono">{m.id}</span>
                <span className="model-picker-meta">
                  {badges(m)}
                  {m.contextWindow ? ` · ${kTokens(m.contextWindow)} window` : ""}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
