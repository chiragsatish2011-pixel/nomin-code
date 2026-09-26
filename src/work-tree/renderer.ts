import type { NodeState } from "./events.js";
import { flatten, type FlatRow, type TreeState } from "./model.js";
import { scribblePath } from "./scribble.js";
import { glyphFor, krakenAurora, metrics, motion, type Theme } from "./theme.js";

const NS = "http://www.w3.org/2000/svg";

function svg<K extends keyof SVGElementTagNameMap>(
  name: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

interface Visual {
  row: FlatRow;
  group: SVGGElement;
  line: SVGPathElement;
  trace: SVGPathElement;
  halo: SVGCircleElement;
  dot: SVGCircleElement;
  mark: SVGTextElement;
  label: SVGTextElement;
  detail: SVGTSpanElement;
  ellipsis: SVGTSpanElement;
  blob?: SVGPathElement;
  blobGroup?: SVGGElement;
  glow?: SVGCircleElement;
  blobLength: number;
  /** Tweened position; `ty` is where layout wants it. */
  y: number;
  ty: number;
  /** Tweened spine origin — the previous sibling (or parent) it hangs from. */
  anchorY: number;
  tAnchorY: number;
  /** Entrance progress, 0 to 1. */
  enter: number;
  born: number;
}

export interface RendererOptions {
  theme?: Theme;
  /** Headline beside the blob. Defaults to the root node's label. */
  title?: string;
  reducedMotion?: boolean;
  /** Keep the newest branch in view when the host is scrolled to the end. */
  follow?: boolean;
  /**
   * Hide the root node and start at its branches. Used when the host already
   * shows a head of its own (the thinking orb) and a second one would be noise.
   */
  rootless?: boolean;
  /**
   * Called when a row carrying evidence is clicked. The tree does not show the
   * evidence itself — the host decides where a panel of that size belongs.
   */
  onSelect?: (nodeId: string) => void;
}

/**
 * Draws the tree the sketch describes — a scribbled head node, a spine that
 * grows downward, elbow branches that draw themselves out to a dot and a
 * label — and keeps it honest: every stroke here comes from a real node in
 * `TreeState`, and every position is eased rather than snapped.
 */
export class TreeRenderer {
  private readonly root: SVGSVGElement;
  private readonly lines: SVGGElement;
  private readonly nodes: SVGGElement;
  private readonly visuals = new Map<string, Visual>();
  private readonly theme: Theme;
  private readonly reduced: boolean;
  private readonly follow: boolean;
  private readonly rootless: boolean;
  private readonly onSelect: ((nodeId: string) => void) | undefined;
  private readonly defs: SVGDefsElement;
  private readonly auroraGradient: SVGLinearGradientElement;
  private readonly uid = `nomin-${Math.random().toString(36).slice(2, 8)}`;
  private state: TreeState | null = null;
  private title: string | undefined;
  private frame = 0;
  private last = 0;
  private width = metrics.minWidth;
  private height = 200;

  constructor(private readonly host: HTMLElement, options: RendererOptions = {}) {
    this.theme = options.theme ?? krakenAurora;
    this.title = options.title;
    this.follow = options.follow ?? true;
    this.rootless = options.rootless ?? false;
    this.onSelect = options.onSelect;
    this.reduced =
      options.reducedMotion ??
      (typeof matchMedia === "function" &&
        matchMedia("(prefers-reduced-motion: reduce)").matches);

    this.root = svg("svg", { xmlns: NS, width: this.width, height: this.height });
    this.root.style.display = "block";
    this.root.style.overflow = "visible";
    this.defs = svg("defs");
    this.auroraGradient = this.buildAurora();
    this.lines = svg("g");
    this.nodes = svg("g");
    this.root.append(this.defs, this.lines, this.nodes);
    this.host.append(this.root);

    this.last = performance.now();
    this.frame = requestAnimationFrame(this.tick);
  }

  /**
   * The aurora: a repeating purple-to-cyan sweep in user space, so a single
   * gradient can paint every live branch at once and drift across all of them.
   */
  private buildAurora(): SVGLinearGradientElement {
    const gradient = svg("linearGradient", {
      id: `${this.uid}-aurora`,
      gradientUnits: "userSpaceOnUse",
      spreadMethod: "repeat",
      x1: 0,
      y1: 0,
      x2: 360,
      y2: 120,
    });
    for (const stop of this.theme.aurora) {
      gradient.append(
        svg("stop", { offset: `${(stop.at * 100).toFixed(1)}%`, "stop-color": stop.color }),
      );
    }

    const glow = svg("radialGradient", { id: `${this.uid}-glow` });
    glow.append(
      svg("stop", { offset: "0%", "stop-color": this.theme.glow }),
      svg("stop", { offset: "100%", "stop-color": this.theme.glow, "stop-opacity": 0 }),
    );

    this.defs.append(gradient, glow);
    return gradient;
  }

  private get aurora(): string {
    return `url(#${this.uid}-aurora)`;
  }

  /** Point the renderer at a (mutable) tree state. Call once. */
  attach(state: TreeState): void {
    this.state = state;
  }

  /** Drop every visual — used when a new task starts. */
  reset(): void {
    this.visuals.clear();
    this.lines.replaceChildren();
    this.nodes.replaceChildren();
  }

  setTitle(title: string): void {
    this.title = title;
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    this.root.remove();
  }

  /** Current rendered size, so hosts can size or scroll their container. */
  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  private tick = (now: number) => {
    this.frame = requestAnimationFrame(this.tick);
    const dt = Math.min(now - this.last, 64);
    this.last = now;
    if (!this.state) return;

    this.auroraGradient.setAttribute(
      "gradientTransform",
      `translate(${((now / (motion.auroraSweep * 10)) % 360).toFixed(1)},0)`,
    );

    const rows = flatten(this.state);
    this.sync(rows, now);
    this.layout(rows, dt, now);
  };

  /** Create a visual for every node that does not have one yet. */
  private sync(rows: FlatRow[], now: number): void {
    rows.forEach((row, index) => {
      const existing = this.visuals.get(row.node.id);
      if (existing) {
        existing.row = row;
        return;
      }
      this.visuals.set(row.node.id, this.build(row, index, now));
      row.node.fresh = false;
    });
  }

  private build(row: FlatRow, index: number, now: number): Visual {
    const isRoot = row.depth === 0;
    const group = svg("g");
    const line = svg("path", {
      fill: "none",
      "stroke-width": 1.25,
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
    });
    const trace = svg("path", {
      fill: "none",
      "stroke-width": 1.9,
      "stroke-linecap": "round",
      opacity: 0,
    });
    this.lines.append(line, trace);

    const halo = svg("circle", {
      r: metrics.dotRadius,
      fill: "none",
      "stroke-width": 1.1,
      opacity: 0,
    });
    const dot = svg("circle", { r: metrics.dotRadius });
    const mark = svg("text", {
      "font-size": 10,
      "font-family": this.theme.fontUi,
      "text-anchor": "middle",
      "dominant-baseline": "central",
      opacity: 0,
    });
    const label = svg("text", {
      "font-size": isRoot ? 17 : 14,
      "font-family": isRoot ? this.theme.fontDisplay : this.theme.fontUi,
      "font-weight": isRoot ? 400 : 500,
      "letter-spacing": isRoot ? 1.4 : 0,
      "dominant-baseline": "central",
    });
    const detail = svg("tspan", {
      "font-size": 12,
      "font-family": this.theme.fontMono,
      fill: this.theme.mutedSoft,
      dx: 9,
    });
    const ellipsis = svg("tspan", { fill: this.theme.muted });
    label.append(document.createTextNode(""), ellipsis, detail);
    group.append(halo, dot, mark, label);

    // A row with evidence behind it opens on click. Rows without it stay inert
    // rather than offering a gesture that does nothing.
    if (this.onSelect && !isRoot) {
      const reach = svg("rect", {
        x: -14,
        y: -metrics.rowHeight / 2,
        height: metrics.rowHeight,
        width: 520,
        fill: "transparent",
      });
      group.prepend(reach);
      group.addEventListener("click", () => {
        if (row.node.body) this.onSelect?.(row.node.id);
      });
    }

    let blob: SVGPathElement | undefined;
    let blobGroup: SVGGElement | undefined;
    let glow: SVGCircleElement | undefined;
    if (isRoot) {
      glow = svg("circle", { r: metrics.rootRadius * 2.1, fill: `url(#${this.uid}-glow)` });
      group.prepend(glow);
      blobGroup = svg("g");
      blob = svg("path", {
        d: scribblePath(metrics.rootRadius),
        fill: "none",
        "stroke-width": 1.15,
        "stroke-linecap": "round",
        opacity: 0.9,
      });
      blobGroup.append(blob);
      group.append(blobGroup);
      dot.setAttribute("r", "3");
    }
    this.nodes.append(group);

    return {
      row,
      group,
      line,
      trace,
      halo,
      dot,
      mark,
      label,
      detail,
      ellipsis,
      blob,
      blobGroup,
      glow,
      blobLength: blob ? blob.getTotalLength() : 0,
      y: 0,
      ty: 0,
      anchorY: 0,
      tAnchorY: 0,
      enter: this.reduced ? 1 : 0,
      born: now + (this.reduced ? 0 : Math.min(index, 1) * motion.stagger),
    };
  }

  /** Position, ease and paint every row. Runs each frame. */
  private layout(rows: FlatRow[], dt: number, now: number): void {
    const { padTop, padLeft, rowHeight, indent, rootRadius, labelGap } = metrics;
    const lastSiblingY = new Map<string, number>();
    let cursor = padTop;
    let widest = metrics.minWidth;

    for (const row of rows) {
      const v = this.visuals.get(row.node.id);
      if (!v) continue;
      const isRoot = row.depth === 0;

      // --- target geometry -------------------------------------------------
      const hidden = isRoot && this.rootless;
      if (hidden) {
        v.ty = cursor;
        v.y = v.ty;
        v.group.setAttribute("opacity", "0");
        v.line.setAttribute("d", "");
        continue;
      }
      if (isRoot) cursor += rootRadius + 6;
      v.ty = cursor;
      cursor += isRoot ? rootRadius + 18 : rowHeight;

      const parentId = row.node.parent;
      const parentVisual = parentId ? this.visuals.get(parentId) : undefined;
      const prev = parentId ? lastSiblingY.get(parentId) : undefined;
      v.tAnchorY =
        prev ??
        (parentVisual
          ? parentVisual.y +
            (parentVisual.row.depth === 0 ? (this.rootless ? 4 : rootRadius) : 6)
          : v.ty);
      if (parentId) lastSiblingY.set(parentId, v.ty);

      // --- easing ----------------------------------------------------------
      const k = this.reduced ? 1 : 1 - Math.exp(-dt / (motion.rowSettle / 3));
      v.y = v.y === 0 ? v.ty : v.y + (v.ty - v.y) * k;
      v.anchorY = v.anchorY === 0 ? v.tAnchorY : v.anchorY + (v.tAnchorY - v.anchorY) * k;
      // Time-based, not accumulated: if the tab is backgrounded and rAF stops,
      // the entrance is already finished when the reader comes back.
      v.enter = this.reduced
        ? 1
        : Math.max(0, Math.min(1, (now - v.born) / motion.draw));

      const level = this.rootless ? row.depth - 1 : row.depth;
      const x = padLeft + level * indent;
      const spineX = padLeft + (level - 1) * indent;
      widest = Math.max(widest, x + labelGap + this.textWidth(v, row));

      this.paint(v, row, x, spineX, now);
    }

    this.resize(widest + 32, cursor + 24);
  }

  private paint(v: Visual, row: FlatRow, x: number, spineX: number, now: number): void {
    const { node } = row;
    const theme = this.theme;
    const stroke = theme.states[node.state];
    const ease = easeOutCubic(v.enter);
    const isRoot = row.depth === 0;

    // Connector: down the parent spine, round the corner, out to the dot.
    if (!isRoot) {
      const r = Math.min(11, Math.max(0, (v.y - v.anchorY) / 2));
      const d =
        `M${spineX},${v.anchorY.toFixed(1)}` +
        `V${(v.y - r).toFixed(1)}` +
        (r > 0.5
          ? `Q${spineX},${v.y.toFixed(1)} ${(spineX + r).toFixed(1)},${v.y.toFixed(1)}`
          : "") +
        `H${x.toFixed(1)}`;
      const len = Math.max(1, v.y - v.anchorY - r + r * 1.6 + (x - spineX - r));
      v.line.setAttribute("d", d);
      v.line.setAttribute(
        "stroke",
        node.state === "active" ? this.aurora : lineTone(theme, node.state),
      );
      v.line.setAttribute("stroke-dasharray", isWaiting(node.state) ? "4 5" : `${len} ${len}`);
      v.line.setAttribute(
        "stroke-dashoffset",
        isWaiting(node.state) ? String((-now / 26) % 9) : ((1 - ease) * len).toFixed(1),
      );

      // A light travelling along the branch while the step is live.
      const live = node.state === "active" && v.enter >= 1;
      v.trace.setAttribute("opacity", live ? "0.85" : "0");
      if (live) {
        v.trace.setAttribute("d", d);
        v.trace.setAttribute("stroke", this.aurora);
        v.trace.setAttribute("stroke-dasharray", `14 ${len}`);
        v.trace.setAttribute("stroke-dashoffset", String(len - ((now / 3.2) % (len + 14))));
      }
    } else {
      v.line.setAttribute("d", "");
      v.trace.setAttribute("opacity", "0");
    }

    // Node marker.
    const pop = isRoot ? 1 : overshoot(v.enter);
    v.group.setAttribute("transform", `translate(${x},${v.y.toFixed(1)})`);
    v.dot.setAttribute("transform", `scale(${pop.toFixed(3)})`);
    const tone = node.state === "active" ? this.aurora : stroke;
    v.dot.setAttribute("fill", node.state === "pending" ? theme.surface : tone);
    v.dot.setAttribute("stroke", tone);
    v.dot.setAttribute("stroke-width", "1.2");

    const pulsing = node.state === "active" || isWaiting(node.state);
    if (pulsing && v.enter >= 1) {
      const phase = (now % motion.pulse) / motion.pulse;
      v.halo.setAttribute("r", (metrics.dotRadius + 2 + phase * 7).toFixed(2));
      v.halo.setAttribute("stroke", node.state === "active" ? this.aurora : stroke);
      v.halo.setAttribute("opacity", (0.45 * (1 - phase)).toFixed(3));
    } else {
      v.halo.setAttribute("opacity", "0");
    }

    if (node.state === "failed") {
      v.mark.textContent = "✕";
      v.mark.setAttribute("fill", theme.surface);
      v.mark.setAttribute("opacity", String(ease));
    } else {
      v.mark.setAttribute("opacity", "0");
    }

    // The scribbled head — drawn on once, then breathing while work is live.
    if (isRoot && v.blob && v.blobGroup) {
      const drawn = easeOutCubic(Math.min(1, v.enter * 1.1));
      v.blob.setAttribute(
        "stroke",
        node.state === "done" ? theme.states.done : this.aurora,
      );
      const len = v.blobLength || 1400;
      v.blob.setAttribute("stroke-dasharray", `${len} ${len}`);
      v.blob.setAttribute("stroke-dashoffset", ((1 - drawn) * len).toFixed(0));
      const busy = node.state === "active";
      if (v.glow) {
        const breath = busy ? 0.55 + Math.sin(now / 700) * 0.25 : 0.18;
        v.glow.setAttribute("opacity", (breath * ease).toFixed(3));
      }
      const spin = busy ? (now / 90) % 360 : 0;
      const breathe = busy ? 1 + Math.sin(now / 620) * 0.035 : 1;
      v.blobGroup.setAttribute(
        "transform",
        `rotate(${spin.toFixed(1)}) scale(${breathe.toFixed(3)})`,
      );
    }

    // Label plus muted detail suffix.
    const labelX = isRoot ? metrics.rootRadius + 18 : metrics.labelGap;
    v.label.setAttribute("x", String(labelX));
    v.label.setAttribute("fill", labelTone(theme, node.state));
    v.label.setAttribute("opacity", ease.toFixed(3));
    v.label.setAttribute("transform", `translate(${((1 - ease) * -8).toFixed(1)},0)`);
    const text = isRoot ? (this.title ?? node.label).toUpperCase() : node.label;
    if (v.label.firstChild && v.label.firstChild.textContent !== text) {
      v.label.firstChild.textContent = text;
    }
    // A row only advertises itself as openable once its evidence has arrived.
    if (this.onSelect) {
      const openable = Boolean(node.body);
      if (v.group.style.cursor !== (openable ? "pointer" : "")) {
        v.group.style.cursor = openable ? "pointer" : "";
      }
    }

    v.ellipsis.textContent =
      node.state === "active" && !isRoot ? ".".repeat(1 + Math.floor((now / 420) % 3)) : "";

    const detail = detailText(node.waitUntil, node.detail);
    if (v.detail.textContent !== detail) v.detail.textContent = detail;
    v.detail.setAttribute("fill", isWaiting(node.state) ? theme.states.waiting : theme.mutedSoft);
  }

  private textWidth(v: Visual, row: FlatRow): number {
    const base = row.depth === 0 ? metrics.rootRadius + 18 : 0;
    const label =
      (row.depth === 0 ? (this.title ?? row.node.label) : row.node.label).length * 8.2;
    const detail = (v.detail.textContent?.length ?? 0) * 7.4 + 12;
    return base + label + detail;
  }

  private resize(width: number, height: number): void {
    const w = Math.round(width);
    const h = Math.round(height);
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.root.setAttribute("width", String(w));
    this.root.setAttribute("height", String(h));
    this.root.setAttribute("viewBox", `0 0 ${w} ${h}`);
    this.keepInView();
  }

  /** Follow the newest branch, but only while the reader is already at the end. */
  private keepInView(): void {
    if (!this.follow) return;
    let parent: HTMLElement | null = this.host;
    while (parent && parent.scrollHeight <= parent.clientHeight) parent = parent.parentElement;
    if (!parent) return;
    const distance = parent.scrollHeight - parent.scrollTop - parent.clientHeight;
    if (distance < 160) parent.scrollTop = parent.scrollHeight;
  }
}

function detailText(waitUntil: number | undefined, detail: string | undefined): string {
  if (waitUntil) {
    const left = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));
    return detail ? `${detail} · ${left}s` : `${left}s`;
  }
  return detail ?? "";
}

const isWaiting = (state: NodeState) => state === "waiting";
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

/** Slight overshoot so a new dot lands rather than blinks into place. */
function overshoot(t: number): number {
  if (t >= 1) return 1;
  const e = easeOutCubic(t);
  return e + Math.sin(Math.min(1, t) * Math.PI) * 0.22;
}

/**
 * Branch lines stay quiet — the dots carry state. Only a waiting branch tints,
 * because its marching dashes are the point, and an active branch takes the
 * aurora (applied by the caller).
 */
function lineTone(theme: Theme, state: NodeState): string {
  if (state === "waiting") return theme.states.waiting;
  return theme.hairline;
}

function labelTone(theme: Theme, state: NodeState): string {
  if (state === "pending") return theme.mutedSoft;
  if (state === "done") return theme.muted;
  if (state === "failed") return theme.states.failed;
  return theme.ink;
}

export { glyphFor };
