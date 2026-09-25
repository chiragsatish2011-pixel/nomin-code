import { useEffect, useMemo, useRef, useState } from "react";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  group: string;
  /** Extra words that should match, beyond the label. */
  keywords?: string;
  run: () => void;
}

/**
 * The command palette.
 *
 * Everything the workspace can do is reachable from here, which matters more
 * than it sounds: the alternative is hiding actions behind icons whose meaning
 * has to be learned. Typing what you want is the shortest path, and it is the
 * same path whether you know where the button is or not.
 *
 * Opens on Ctrl/Cmd+K, closes on Escape, and never traps focus anywhere the
 * keyboard cannot leave.
 */
export function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => rank(commands, query), [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setIndex(0);
    // The input has to be focused after the element exists, not before.
    const timer = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(0, matches.length - 1)));
  }, [matches.length]);

  // Keep the highlighted row in view when arrowing past the fold.
  useEffect(() => {
    const row = listRef.current?.children[index] as HTMLElement | undefined;
    row?.scrollIntoView({ block: "nearest" });
  }, [index]);

  if (!open) return null;

  const choose = (command?: Command) => {
    if (!command) return;
    onClose();
    // Let the palette close before the action changes the view underneath it.
    window.setTimeout(() => command.run(), 0);
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          placeholder="What do you want to do?"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              setIndex((current) => Math.min(current + 1, matches.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setIndex((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              choose(matches[index]);
            }
          }}
        />

        {matches.length ? (
          <ul className="palette-list" ref={listRef}>
            {matches.map((command, i) => (
              <li key={command.id}>
                <button
                  className={i === index ? "on" : ""}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(command)}
                  type="button"
                >
                  <span className="palette-label">{command.label}</span>
                  {command.hint && <span className="palette-hint">{command.hint}</span>}
                  <span className="palette-group">{command.group}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="palette-empty">Nothing matches “{query}”.</p>
        )}

        <footer className="palette-foot">
          <span>↑↓ to move</span>
          <span>↵ to run</span>
          <span>esc to close</span>
        </footer>
      </div>
    </div>
  );
}

/**
 * Rank by how well the query matches, not merely whether it does: a command
 * whose label starts with what you typed is almost always the one you meant.
 */
function rank(commands: Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;

  return commands
    .map((command) => {
      const label = command.label.toLowerCase();
      const haystack = `${label} ${command.keywords ?? ""} ${command.group}`.toLowerCase();
      let score = 0;
      if (label.startsWith(needle)) score = 100;
      else if (label.includes(needle)) score = 70;
      else if (haystack.includes(needle)) score = 40;
      else if (subsequence(label, needle)) score = 20;
      return { command, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.command);
}

/** "dl" should still find "download" — letters in order, gaps allowed. */
function subsequence(text: string, needle: string): boolean {
  let at = 0;
  for (const character of needle) {
    at = text.indexOf(character, at);
    if (at === -1) return false;
    at += 1;
  }
  return true;
}
