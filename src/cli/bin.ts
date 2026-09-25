import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "./main.js";

/**
 * The entry point the `nomin` command runs.
 *
 * Credentials are read here rather than in the model layer because a terminal
 * is started from a shell that may have exported nothing, and a CLI that only
 * works when you remember to `source .env` is a CLI people stop using.
 */
function loadEnv(): void {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [join(here, "..", ".env"), join(process.cwd(), ".env")]) {
    try {
      const text = readFileSync(candidate, "utf8");
      for (const line of text.split(/\r?\n/)) {
        const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
        if (!match) continue;
        const key = match[1]!;
        // An exported value always wins over the file.
        if (!process.env[key]) process.env[key] = match[2]!.replace(/^["']|["']$/g, "");
      }
      return;
    } catch {
      // Try the next candidate; running without a file is legitimate.
    }
  }
}

loadEnv();
process.exitCode = await main(process.argv.slice(2));
