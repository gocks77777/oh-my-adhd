import { execFile as execFileCb } from "child_process";
import { promisify } from "util";

const execFile = promisify(execFileCb);
const GIT_OPTS = { maxBuffer: 1024 * 1024, timeout: 3000 } as const;

export async function git(...args: string[]): Promise<string> {
  try {
    const { stdout } = await execFile("git", args, GIT_OPTS);
    return stdout.trim();
  } catch { return ""; }
}

export async function captureGitContext(): Promise<string> {
  try {
    const [branch, head, statusOut] = await Promise.all([
      git("branch", "--show-current"),
      git("rev-parse", "--short", "HEAD"),
      git("status", "--porcelain=v1"),
    ]);
    const dirty = statusOut
      ? statusOut.split("\n").filter(Boolean).map(l => l.slice(3).trim())
      : [];
    if (!branch && !head) return "";
    return `\n[git: ${branch}@${head}${dirty.length ? ` | dirty: ${dirty.slice(0, 3).join(", ")}` : ""}]`;
  } catch { return ""; }
}
