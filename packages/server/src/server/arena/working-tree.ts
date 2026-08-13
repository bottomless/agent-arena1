import { cp, lstat, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { runGitCommand } from "../../utils/run-git-command.js";

function assertRelativePath(path: string): void {
  if (!path || isAbsolute(path) || path.split(/[\\/]/).includes("..")) {
    throw new Error(`Unsafe git path: ${path}`);
  }
}

async function copyEntry(sourceRoot: string, targetRoot: string, path: string): Promise<void> {
  assertRelativePath(path);
  const source = resolve(sourceRoot, path);
  const target = resolve(targetRoot, path);
  if (relative(targetRoot, target).startsWith("..")) throw new Error(`Unsafe target path: ${path}`);
  const sourceStats = await lstat(source).catch(() => null);
  if (!sourceStats) {
    await rm(target, { recursive: true, force: true });
    return;
  }
  await mkdir(dirname(target), { recursive: true });
  await rm(target, { recursive: true, force: true });
  if (sourceStats.isSymbolicLink()) {
    await symlink(await readlink(source), target);
    return;
  }
  await cp(source, target, { recursive: sourceStats.isDirectory(), preserveTimestamps: true });
}

function parseNullSeparated(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

/** Copy the source checkout's committed-independent filesystem state into a new worktree. */
export async function copyWorkingTreeState(sourceRoot: string, targetRoot: string): Promise<void> {
  const [changed, untracked] = await Promise.all([
    runGitCommand(["diff", "--no-renames", "--name-only", "-z", "HEAD"], {
      cwd: sourceRoot,
      maxOutputBytes: 20 * 1024 * 1024,
    }),
    runGitCommand(["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: sourceRoot,
      maxOutputBytes: 20 * 1024 * 1024,
    }),
  ]);
  const paths = new Set([
    ...parseNullSeparated(changed.stdout),
    ...parseNullSeparated(untracked.stdout),
  ]);
  for (const path of paths) await copyEntry(sourceRoot, targetRoot, path);
}
