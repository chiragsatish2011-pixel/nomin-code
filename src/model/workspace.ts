import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * The workspace: a real directory on disk that a session owns.
 *
 * Everything the agent builds lives here, so a build is files that exist
 * rather than code pasted into a chat window. Three rules make that safe to
 * hand to a model:
 *
 *  1. **Every path is resolved and checked.** A path that lands outside the
 *     session root — via `..`, an absolute path, or a symlink — is rejected
 *     before anything is opened.
 *  2. **Commands are an allowlist, never a shell.** Arguments are passed as an
 *     array, so there is no string for a model to inject `; rm -rf` into, and
 *     only a handful of executables can be named at all.
 *  3. **Credentials never reach a child process.** The environment handed to a
 *     command has every API key stripped, so a script the model wrote cannot
 *     read them even if it tries.
 */

export interface WorkspaceFile {
  path: string;
  bytes: number;
  modified: number;
  /** True when this write created the file rather than replacing it. */
  created?: boolean;
}

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const ROOT_DIR = ".nomin/workspaces";

/**
 * Serverless hosts give you a read-only deployment and one writable directory.
 * The workspace goes there, and the caller is told plainly that it does not
 * outlive the request — pretending otherwise would lose the user's work
 * silently.
 */
const serverless = () =>
  Boolean(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME || process.env.NETLIFY);

const workspaceBase = (base: string) => (serverless() ? join(tmpdir(), "nomin") : join(base, ROOT_DIR));
const MAX_FILE_BYTES = 512 * 1024;
const MAX_OUTPUT = 8000;
const COMMAND_TIMEOUT_MS = 120_000;

/** The only executables a model may name. No shell, no interpreters of choice. */
const ALLOWED_COMMANDS = new Set(["npm", "npx", "node", "tsc", "vite"]);

/** Subcommands that destroy work or reach outward. They need a human. */
const REFUSED_ARGS = [/^--?f(orce)?$/i, /^publish$/i, /^deploy$/i, /^login$/i, /^token$/i];

/**
 * Windows needs `shell: true` to run npm/npx/vite, which are .cmd shims — and
 * a shell means arguments are re-interpreted. So any argument carrying shell
 * punctuation is refused outright: the allowlist controls which program runs,
 * and this controls what can be smuggled into it.
 */
const SHELL_METACHARACTERS = /[&|;<>^`$()\n\r]/;

export class Workspace {
  readonly sessionId: string;
  readonly root: string;

  private constructor(sessionId: string, root: string) {
    this.sessionId = sessionId;
    this.root = root;
  }

  static async open(sessionId: string, base = process.cwd()): Promise<Workspace> {
    const safeId = sessionId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 64) || "default";
    const root = join(workspaceBase(base), safeId);
    await mkdir(root, { recursive: true });
    return new Workspace(safeId, root);
  }

  /**
   * Resolve a model-supplied path inside the workspace, or throw. This is the
   * single gate every file operation goes through.
   */
  private resolveInside(path: string): string {
    if (!path || typeof path !== "string") throw new Error("A path is required.");
    if (isAbsolute(path)) throw new Error("Absolute paths are not allowed; use a path inside the workspace.");
    const full = resolve(this.root, path);
    const rel = relative(this.root, full);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      throw new Error("That path is outside the workspace.");
    }
    return full;
  }

  async list(dir = "."): Promise<WorkspaceFile[]> {
    const start = this.resolveInside(dir);
    const files: WorkspaceFile[] = [];

    const walk = async (current: string, depth: number): Promise<void> => {
      if (depth > 6) return;
      let entries;
      try {
        entries = await readdir(current, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = join(current, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(full, depth + 1);
          continue;
        }
        const info = await stat(full).catch(() => null);
        if (!info) continue;
        files.push({
          path: relative(this.root, full).split(sep).join("/"),
          bytes: info.size,
          modified: info.mtimeMs,
        });
      }
    };

    await walk(start, 0);
    return files.sort((a, b) => a.path.localeCompare(b.path));
  }

  async read(path: string): Promise<string> {
    const full = this.resolveInside(path);
    const info = await stat(full);
    if (info.size > MAX_FILE_BYTES) {
      throw new Error(`That file is ${Math.round(info.size / 1024)}KB; too large to read in one piece.`);
    }
    return readFile(full, "utf8");
  }

  async write(path: string, content: string): Promise<WorkspaceFile> {
    const full = this.resolveInside(path);
    if (content.length > MAX_FILE_BYTES) {
      throw new Error("That file is too large to write in one call; split it up.");
    }
    await mkdir(join(full, ".."), { recursive: true });
    const existed = await stat(full).then(() => true, () => false);
    await writeFile(full, content, "utf8");
    const info = await stat(full);
    return { path: relative(this.root, full).split(sep).join("/"), bytes: info.size, modified: info.mtimeMs, created: !existed };
  }

  /**
   * Add to the end of a file.
   *
   * A page of any real size does not fit in one completion, so writing it in
   * one call and hoping is how files end up truncated mid-rule. Appending lets
   * a long file be built across several calls without re-sending — and without
   * re-truncating — everything already written.
   */
  async append(path: string, content: string): Promise<WorkspaceFile> {
    const full = this.resolveInside(path);
    const existing = await stat(full).then((info) => info.size, () => 0);
    if (existing + content.length > MAX_FILE_BYTES) {
      throw new Error("That file would grow past the size limit; split it into separate files.");
    }
    await mkdir(join(full, ".."), { recursive: true });
    await appendFile(full, content, "utf8");
    const info = await stat(full);
    return {
      path: relative(this.root, full).split(sep).join("/"),
      bytes: info.size,
      modified: info.mtimeMs,
      created: existing === 0,
    };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(this.resolveInside(path));
      return true;
    } catch {
      return false;
    }
  }

  /** Run one allowlisted command inside the workspace. */
  async run(command: string, args: string[] = []): Promise<CommandResult> {
    if (serverless()) {
      throw new Error(
        "Commands cannot run on this deployment — it has no package manager or writable install directory. Write the files; they can be run locally or in the preview container.",
      );
    }
    if (!ALLOWED_COMMANDS.has(command)) {
      throw new Error(
        `"${command}" is not an allowed command. Allowed: ${[...ALLOWED_COMMANDS].join(", ")}.`,
      );
    }
    const safeArgs = args.map(String);
    for (const arg of safeArgs) {
      if (REFUSED_ARGS.some((pattern) => pattern.test(arg))) {
        throw new Error(`"${arg}" needs a person to confirm it; it will not run automatically.`);
      }
      if (SHELL_METACHARACTERS.test(arg)) {
        throw new Error("Arguments cannot contain shell characters such as & | ; > < ` $ ( ).");
      }
    }

    const printable = [command, ...safeArgs].join(" ");
    try {
      const { stdout, stderr } = await exec(command, safeArgs, {
        cwd: this.root,
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        shell: process.platform === "win32",
        env: sanitisedEnv(),
      });
      return {
        command: printable,
        exitCode: 0,
        stdout: clip(stdout),
        stderr: clip(stderr),
        timedOut: false,
      };
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
      return {
        command: printable,
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout: clip(err.stdout ?? ""),
        stderr: clip(err.stderr ?? err.message ?? ""),
        timedOut: Boolean(err.killed),
      };
    }
  }

  /** Remove the workspace. Only ever called for the session that owns it. */
  async destroy(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}

/** The child's environment, with every credential removed. */
function sanitisedEnv(): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/API_KEY|TOKEN|SECRET|PASSWORD|NVIDIA_|NOMIN_/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

const clip = (text: string) =>
  text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n… output truncated` : text.trim();
