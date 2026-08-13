import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildBoundedBattleDiff,
  fingerprintVisibleWorktree,
  hasBattleFileEdits,
  renderBattleDiffForComparison,
} from "./diff.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function init(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, "init", "--initial-branch=main");
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("buildBoundedBattleDiff", () => {
  it("compares A directly to B and explicitly bounds oversized text", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-arena-diff-"));
    roots.push(root);
    const sideA = join(root, "a");
    const sideB = join(root, "b");
    await Promise.all([init(sideA), init(sideB)]);

    await writeFile(join(sideA, "shared.ts"), "export const side = 'A';\n");
    await writeFile(join(sideB, "shared.ts"), "export const side = 'B';\n");
    await writeFile(join(sideA, "only-a.txt"), "A\n");
    await writeFile(join(sideB, "only-b.txt"), "B\n");
    await writeFile(join(sideA, "large.txt"), "A".repeat(300_000));
    await writeFile(join(sideB, "large.txt"), "B".repeat(300_000));
    await symlink("only-a.txt", join(sideA, "link"));
    await symlink("shared.ts", join(sideB, "link"));
    await Promise.all([git(sideA, "add", "."), git(sideB, "add", ".")]);

    const diff = await buildBoundedBattleDiff(sideA, sideB);

    expect(diff.changedFiles).toBe(5);
    expect(diff.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "shared.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
        }),
        expect.objectContaining({ path: "only-a.txt", status: "added_a" }),
        expect.objectContaining({ path: "only-b.txt", status: "added_b" }),
        expect.objectContaining({
          path: "large.txt",
          status: "modified",
          truncated: true,
        }),
        expect.objectContaining({ path: "link", status: "modified" }),
      ]),
    );
    expect(diff.truncated).toBe(true);
    expect(renderBattleDiffForComparison(diff)).toContain("--- A/shared.ts");
    expect(renderBattleDiffForComparison(diff)).toContain("+++ B/shared.ts");
  });

  it("bounds highly fragmented replacements before rendering them", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-arena-dense-diff-"));
    roots.push(root);
    const sideA = join(root, "a");
    const sideB = join(root, "b");
    await Promise.all([init(sideA), init(sideB)]);
    await writeFile(
      join(sideA, "dense.txt"),
      Array.from({ length: 1_500 }, (_, index) => `A-${index}`).join("\n"),
    );
    await writeFile(
      join(sideB, "dense.txt"),
      Array.from({ length: 1_500 }, (_, index) => `B-${index}`).join("\n"),
    );
    await Promise.all([git(sideA, "add", "."), git(sideB, "add", ".")]);

    const diff = await buildBoundedBattleDiff(sideA, sideB);
    const dense = diff.files.find((file) => file.path === "dense.txt");

    expect(dense).toMatchObject({
      additions: 1_500,
      deletions: 1_500,
      truncated: true,
    });
    expect(dense?.hunks[0]?.lines).toHaveLength(200);
  });
});

describe("hasBattleFileEdits", () => {
  it("detects uncommitted and committed edits relative to the battle base", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-arena-edits-"));
    roots.push(root);
    await init(root);
    await writeFile(join(root, "file.txt"), "base\n");
    await git(root, "add", ".");
    await git(
      root,
      "-c",
      "user.email=arena@example.test",
      "-c",
      "user.name=Arena Test",
      "commit",
      "-m",
      "base",
    );
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    const baseCommit = stdout.trim();

    await expect(hasBattleFileEdits(root, baseCommit)).resolves.toBe(false);
    await writeFile(join(root, "file.txt"), "edited\n");
    await expect(hasBattleFileEdits(root, baseCommit)).resolves.toBe(true);
    await git(root, "add", ".");
    await git(
      root,
      "-c",
      "user.email=arena@example.test",
      "-c",
      "user.name=Arena Test",
      "commit",
      "-m",
      "edit",
    );
    await expect(hasBattleFileEdits(root, baseCommit)).resolves.toBe(true);
  });

  it("detects an agent reverting an uncommitted change from its launch state", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-arena-dirty-baseline-"));
    roots.push(root);
    await init(root);
    await writeFile(join(root, "file.txt"), "committed\n");
    await git(root, "add", ".");
    await git(
      root,
      "-c",
      "user.email=arena@example.test",
      "-c",
      "user.name=Arena Test",
      "commit",
      "-m",
      "base",
    );
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: root,
    });
    const baseCommit = stdout.trim();

    await writeFile(join(root, "file.txt"), "dirty launch state\n");
    const baselineFingerprint = await fingerprintVisibleWorktree(root);
    await expect(hasBattleFileEdits(root, baseCommit, baselineFingerprint)).resolves.toBe(false);

    await writeFile(join(root, "file.txt"), "committed\n");
    await expect(hasBattleFileEdits(root, baseCommit, baselineFingerprint)).resolves.toBe(true);
  });
});
