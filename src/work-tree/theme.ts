import type { NodeKind, NodeState } from "./events.js";

/**
 * Nomin Code runs on the Kraken design system: white surfaces, Kraken Purple
 * as the primary, 12px radii, Kraken-Brand / Kraken-Product type.
 *
 * `aurora` is the one addition — a moving purple-to-cyan gradient used for
 * anything that is *live* (the thinking head, an active branch). It is drawn
 * from the Kraken purple scale so it reads as brand energy, not decoration.
 */
export interface Theme {
  name: string;
  surface: string;
  surfaceSoft: string;
  hairline: string;
  ink: string;
  muted: string;
  mutedSoft: string;
  accent: string;
  /** Aurora gradient stops (`at` = 0..1 along one sweep), used for live work. */
  aurora: Array<{ at: number; color: string }>;
  /** Glow tint behind the thinking head. */
  glow: string;
  states: Record<NodeState, string>;
  fontDisplay: string;
  fontUi: string;
  fontMono: string;
}

export const krakenAurora: Theme = {
  name: "kraken-aurora",
  surface: "#ffffff",
  surfaceSoft: "#faf9ff",
  hairline: "#dedee5",
  ink: "#101114",
  muted: "#686b82",
  mutedSoft: "#9497a9",
  accent: "#7132f5",
  aurora: [
    { at: 0, color: "#7132f5" },
    { at: 0.34, color: "#855bfb" },
    { at: 0.58, color: "#5b1ecf" },
    { at: 0.8, color: "#2ed3c6" },
    { at: 1, color: "#7132f5" },
  ],
  glow: "rgba(133,91,251,0.28)",
  states: {
    pending: "#9497a9",
    active: "#7132f5",
    waiting: "#5741d8",
    done: "#149e61",
    failed: "#c93a3a",
  },
  fontDisplay: '"Kraken-Brand", "IBM Plex Sans", Helvetica, Arial, sans-serif',
  fontUi: '"Kraken-Product", "IBM Plex Sans", "Helvetica Neue", Helvetica, Arial, sans-serif',
  fontMono: '"IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

/** Dark variant of the same system — same purple, inverted surfaces. */
export const krakenDark: Theme = {
  ...krakenAurora,
  name: "kraken-aurora-dark",
  surface: "#101114",
  surfaceSoft: "#17181d",
  hairline: "#2a2c36",
  ink: "#f5f5f8",
  muted: "#9497a9",
  mutedSoft: "#686b82",
  aurora: [
    { at: 0, color: "#855bfb" },
    { at: 0.34, color: "#a07dff" },
    { at: 0.58, color: "#7132f5" },
    { at: 0.82, color: "#2ed3c6" },
    { at: 1, color: "#855bfb" },
  ],
  glow: "rgba(133,91,251,0.4)",
  states: {
    pending: "#686b82",
    active: "#855bfb",
    waiting: "#7b6cf0",
    done: "#1fc17a",
    failed: "#e05a5a",
  },
};

/** Geometry — built on the Kraken spacing scale. */
export const metrics = {
  padTop: 28,
  padLeft: 40,
  rowHeight: 34,
  indent: 34,
  /** Horizontal run from the spine to the node dot. */
  stub: 26,
  dotRadius: 4.5,
  rootRadius: 24,
  labelGap: 15,
  minWidth: 420,
};

/** Motion timings, in ms. Slow enough to read, quick enough to feel live. */
export const motion = {
  rowSettle: 420,
  draw: 460,
  fade: 320,
  pulse: 1900,
  stagger: 70,
  /** Seconds for one full sweep of the aurora gradient. */
  auroraSweep: 7,
};

const GLYPH: Record<NodeKind, string> = {
  task: "◆",
  question: "?",
  plan: "▣",
  thinking: "✳",
  step: "•",
  tool: "▸",
  file: "▤",
  command: "$",
  build: "⬡",
  test: "◇",
  cooldown: "⏳",
  verify: "✓",
  artifact: "◈",
  doctor: "✚",
};

export const glyphFor = (kind: NodeKind) => GLYPH[kind] ?? "•";
