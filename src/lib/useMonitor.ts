import { useEffect, useRef, useState } from "react";
import type { CanvasState } from "./artifacts.js";
import { assemble, type WorkspaceSnapshot } from "./workspace.js";
import { probeRuntime, type RuntimeCheck } from "./runtime.js";
import { captureDocument } from "./snapshot.js";
import type { ChatMessage, Verdict } from "./useAgent.js";

export interface MonitorState {
  status: "idle" | "capturing" | "reviewing" | "done" | "failed";
  /** Which turn this verdict belongs to, so a repair is only tried once. */
  turn?: number;
  verdict?: Verdict;
  /** What the page threw when it was actually executed. */
  runtimeErrors?: string[];
  /** The build that was reviewed, so a fix can name it. */
  reviewed?: string;
  /** True when the monitor was given a rendering to look at. */
  sawRendering: boolean;
  error?: string;
}

/**
 * Runs the monitor once per finished turn.
 *
 * It waits until the turn is over — the review is about the delivered result,
 * and running it mid-stream would judge half a page. When the result is
 * previewable it rasterises it first so the monitor can actually look at what
 * was built rather than only reading the code.
 */
export function useMonitor(
  messages: ChatMessage[],
  canvas: CanvasState,
  running: boolean,
  workspace?: WorkspaceSnapshot,
  activeBuild?: string | null,
): MonitorState {
  const [state, setState] = useState<MonitorState>({ status: "idle", sawRendering: false });
  const reviewed = useRef<string>("");

  useEffect(() => {
    if (running) return;
    const lastIndex = messages.length - 1;
    const last = messages[lastIndex];
    // A manager note is the review's own output arriving back as a message.
    // Reviewing it would judge the verdict instead of the work, and would
    // overwrite the verdict this one belongs to.
    if (!last || last.role !== "assistant" || !last.content || last.error || last.manager) return;

    // A conversational turn has nothing to verify. Reviewing it wastes a call
    // and puts a meaningless "Verified" badge under a one-line answer.
    const build = workspace?.builds.find((item) => item.entry === activeBuild) ?? workspace?.builds[0];
    const document = build && workspace ? assemble(build, workspace.files) : canvas.document;
    const fileList = workspace?.files.length
      ? workspace.files.map((file) => ({
          name: file.path,
          lines: file.content.split("\n").length,
        }))
      : canvas.artifacts
          // A fence that never closed is work in progress, not a deliverable.
          .filter((file) => !file.partial)
          .map((file) => ({
            name: file.name,
            lines: file.code.split("\n").length,
          }));

    const producedWork =
      Boolean(workspace?.files.length) ||
      canvas.artifacts.length > 0 ||
      (last.events ?? []).some((event) =>
        ["file.created", "file.modified", "tool.started", "command.started", "build.started", "test.started"].includes(
          event.type,
        ),
      );
    if (!producedWork) {
      setState({ status: "idle", sawRendering: false });
      return;
    }

    // One review per turn, keyed by what was actually produced.
    const key = `${lastIndex}:${last.content.length}:${fileList.length}:${document?.length ?? 0}`;
    if (reviewed.current === key) return;
    reviewed.current = key;

    let live = true;

    const run = async () => {
      const request =
        [...messages].reverse().find((message) => message.role === "user")?.content ?? "";

      let screenshot: string | null = null;
      let runtime: RuntimeCheck | null = null;
      if (document) {
        setState((prev) => ({ ...prev, status: "capturing" }));
        // Look at it, and run it: a picture cannot show a broken handler.
        [screenshot, runtime] = await Promise.all([
          captureDocument(document),
          probeRuntime(document),
        ]);
      }
      if (!live) return;

      setState((prev) => ({ ...prev, status: "reviewing" }));
      try {
        const response = await fetch("/api/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            digest: {
              request,
              answer: last.content,
              // Verification events are previous opinions — including them lets
              // a provisional verdict be quoted back as though it were a
              // finding — and round measurements are instrumentation for a
              // person reading the tree. Neither is evidence about the work,
              // and both crowd the manager's short event window.
              events: (last.events ?? [])
                .filter(
                  (event) =>
                    !event.type.startsWith("verification.") && event.type !== "round.measured",
                )
                .map((event) => ({
                  type: event.type,
                  label: event.label,
                  detail: event.detail,
                })),
              durationMs: Date.now() - last.at,
              rateLimited: (last.events ?? []).some((event) => event.type === "cooldown.started"),
              empty: !last.content.trim(),
              // `fileList` above already prefers the workspace and falls back to
              // the canvas. Sending the canvas directly meant that every build
              // whose files live in the workspace — which is all of them now —
              // reached the manager as "FILES PRODUCED: none", so it judged
              // completeness with the one fact that would have settled it
              // missing, and a finished page looked like an empty turn.
              files: fileList,
              screenshot: screenshot ?? undefined,
              runtime: runtime ?? undefined,
            },
          }),
        });
        const verdict = (await response.json()) as Verdict;
        if (!live) return;
        setState({
          status: "done",
          turn: lastIndex,
          verdict,
          sawRendering: Boolean(verdict.sawRendering),
          runtimeErrors: runtime?.errors ?? [],
          reviewed: build?.entry,
        });
      } catch (error) {
        if (!live) return;
        setState({
          status: "failed",
          sawRendering: false,
          error: error instanceof Error ? error.message : "The monitor could not run.",
        });
      }
    };

    void run();
    return () => {
      live = false;
    };
  }, [messages, canvas, running, workspace, activeBuild]);

  return state;
}
