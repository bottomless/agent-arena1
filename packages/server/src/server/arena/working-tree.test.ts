import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import { copyWorkingTreeState } from "./working-tree.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("copyWorkingTreeState", () => {
  it("copies staged, unstaged, untracked, and deleted state into a battle worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-arena-working-tree-"));
    roots.push(root);
    const source = join(root, "source");
    const target = join(root, "target");
    await git(root, "init", "--initial-branch=main", source);
    await writeFile(join(source, "mixed.txt"), "baseline\n");
    await writeFile(join(source, "staged.txt"), "baseline\n");
    await writeFile(join(source, "deleted.txt"), "delete me\n");
    await git(source, "add", ".");
    await git(
      source,
      "-c",
      "user.name=Paseo Arena",
      "-c",
      "user.email=arena@example.invalid",
      "commit",
      "-m",
      "baseline",
    );
    await git(source, "worktree", "add", "-b", "target", target, "HEAD");

    await writeFile(join(source, "mixed.txt"), "staged\n");
    await git(source, "add", "mixed.txt");
    await writeFile(join(source, "mixed.txt"), "final unstaged\n");
    await writeFile(join(source, "staged.txt"), "staged only\n");
    await git(source, "add", "staged.txt");
    await writeFile(join(source, "untracked.txt"), "untracked\n");
    await unlink(join(source, "deleted.txt"));

    await copyWorkingTreeState(source, target);

    await expect(readFile(join(target, "mixed.txt"), "utf8")).resolves.toBe("final unstaged\n");
    await expect(readFile(join(target, "staged.txt"), "utf8")).resolves.toBe("staged only\n");
    await expect(readFile(join(target, "untracked.txt"), "utf8")).resolves.toBe("untracked\n");
    await expect(readFile(join(target, "deleted.txt"), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
