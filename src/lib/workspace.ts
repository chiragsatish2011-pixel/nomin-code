/**
 * The workspace, as the canvas sees it.
 *
 * A session builds more than one thing. Asking for a change should update what
 * is already on screen; asking for something different should show the new
 * thing without throwing the old one away. Both fall out of one rule: **the
 * files decide**.
 *
 * Each HTML file in the workspace is an entry point, and an entry point plus
 * the files it references is a *build*. A modification overwrites paths that
 * already exist, so the build keeps its identity and the preview simply
 * refreshes. A different task writes a new entry point, so a new build appears
 * and the canvas moves to it — with the earlier one still there to go back to.
 */

export interface WorkspaceFile {
  path: string;
  bytes: number;
  modified: number;
  content: string;
}

export interface Build {
  /** The HTML file this build renders. */
  entry: string;
  /** A readable name taken from the document's title, falling back to the path. */
  title: string;
  /** Entry plus everything it references. */
  files: string[];
  /** Newest modification time across the build's files. */
  updatedAt: number;
}

export interface WorkspaceSnapshot {
  files: WorkspaceFile[];
  builds: Build[];
  /** Paths present but not readable here — large or binary. */
  others: Array<{ path: string; bytes: number }>;
}

export const emptySnapshot: WorkspaceSnapshot = { files: [], builds: [], others: [] };

/**
 * Fold the files a turn reported into the snapshot the client holds.
 *
 * This is the durable copy. On a serverless host each request runs on a fresh
 * instance with an empty disk, so anything the server wrote is gone by the
 * next call — the client's copy is what survives, and it is what travels back
 * with the following turn.
 */
export function mergeFiles(
  snapshot: WorkspaceSnapshot,
  incoming: Array<{ path: string; bytes: number; content?: string }>,
): WorkspaceSnapshot {
  const byPath = new Map(snapshot.files.map((file) => [file.path, file]));
  const others = new Map(snapshot.others.map((file) => [file.path, file]));

  for (const file of incoming) {
    if (typeof file.content === "string") {
      others.delete(file.path);
      byPath.set(file.path, {
        path: file.path,
        bytes: file.bytes,
        modified: Date.now(),
        content: file.content,
      });
    } else if (!byPath.has(file.path)) {
      others.set(file.path, { path: file.path, bytes: file.bytes });
    }
  }

  const files = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { files, builds: findBuilds(files), others: [...others.values()] };
}

/** What to send back so the agent resumes against what it built before. */
export const filesForTurn = (snapshot: WorkspaceSnapshot) =>
  snapshot.files.map((file) => ({ path: file.path, content: file.content }));

export async function fetchWorkspace(sessionId: string): Promise<WorkspaceSnapshot> {
  try {
    const response = await fetch("/api/files", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) return emptySnapshot;
    const data = (await response.json()) as {
      files?: WorkspaceFile[];
      others?: Array<{ path: string; bytes: number }>;
    };
    const files = data.files ?? [];
    return { files, builds: findBuilds(files), others: data.others ?? [] };
  } catch {
    return emptySnapshot;
  }
}

/** Every HTML file is a build; everything it references belongs to it. */
export function findBuilds(files: WorkspaceFile[]): Build[] {
  const byPath = new Map(files.map((file) => [file.path, file]));

  return files
    .filter((file) => /\.html?$/i.test(file.path))
    .map((entry) => {
      const referenced = references(entry, byPath);
      const involved = [entry.path, ...referenced];
      const updatedAt = Math.max(
        ...involved.map((path) => byPath.get(path)?.modified ?? 0),
        entry.modified,
      );
      return {
        entry: entry.path,
        title: documentTitle(entry.content) || entry.path,
        files: involved,
        updatedAt,
      };
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Assemble a build into one document the preview can render: stylesheets and
 * scripts the page references are inlined from the workspace, because the
 * iframe has no server to fetch them from.
 */
export function assemble(build: Build, files: WorkspaceFile[]): string {
  const byPath = new Map(files.map((file) => [file.path, file]));
  const entry = byPath.get(build.entry);
  if (!entry) return "";

  let document = entry.content;

  document = document.replace(
    /<link\b[^>]*rel=["']?stylesheet["']?[^>]*>/gi,
    (tag) => {
      const href = attribute(tag, "href");
      const file = href && byPath.get(resolvePath(build.entry, href));
      return file ? `<style>\n${file.content}\n</style>` : tag;
    },
  );

  document = document.replace(
    /<script\b([^>]*)\bsrc=["']([^"']+)["']([^>]*)><\/script>/gi,
    (tag, before: string, src: string, after: string) => {
      const file = byPath.get(resolvePath(build.entry, src));
      if (!file) return tag;
      const type = /type=["']module["']/i.test(`${before}${after}`) ? ' type="module"' : "";
      return `<script${type}>\n${file.content}\n</script>`;
    },
  );

  return document;
}

/** Read one attribute out of a tag. */
function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}=["']([^"']+)["']`, "i").exec(tag);
  return match?.[1] ?? null;
}

/** Which files a page pulls in. Relative paths only; the workspace is flat-ish. */
function references(entry: WorkspaceFile, byPath: Map<string, WorkspaceFile>): string[] {
  const found = new Set<string>();
  const patterns = [
    /<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi,
    /<script\b[^>]*src=["']([^"']+)["'][^>]*>/gi,
    /<img\b[^>]*src=["']([^"']+)["'][^>]*>/gi,
  ];

  for (const pattern of patterns) {
    for (const match of entry.content.matchAll(pattern)) {
      const raw = match[1];
      if (!raw || /^(https?:|data:|#|mailto:)/i.test(raw)) continue;
      const path = resolvePath(entry.path, raw);
      if (byPath.has(path)) found.add(path);
    }
  }
  return [...found];
}

/** Resolve a href against the page that used it, without leaving the workspace. */
function resolvePath(from: string, href: string): string {
  const clean = href.split(/[?#]/)[0] ?? "";
  if (clean.startsWith("/")) return clean.slice(1);
  const base = from.split("/").slice(0, -1);
  const parts = clean.split("/");
  for (const part of parts) {
    if (part === "." || part === "") continue;
    if (part === "..") base.pop();
    else base.push(part);
  }
  return base.join("/");
}

function documentTitle(html: string): string {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  const title = match?.[1]?.trim();
  if (title) return title.slice(0, 60);
  const heading = /<h1[^>]*>([^<]+)<\/h1>/i.exec(html);
  return heading?.[1]?.trim().slice(0, 60) ?? "";
}

/**
 * Which build to show after a turn.
 *
 * A new entry point means a new thing was built, so the canvas moves to it. If
 * only existing files changed, the current build is a modification and the
 * canvas stays where the user was looking.
 */
export function chooseBuild(
  previous: WorkspaceSnapshot,
  next: WorkspaceSnapshot,
  current: string | null,
): string | null {
  const before = new Set(previous.builds.map((build) => build.entry));
  const fresh = next.builds.find((build) => !before.has(build.entry));
  if (fresh) return fresh.entry;
  if (current && next.builds.some((build) => build.entry === current)) return current;
  return next.builds[0]?.entry ?? null;
}
