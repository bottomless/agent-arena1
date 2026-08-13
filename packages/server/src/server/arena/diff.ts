import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";

import type { ArenaBattleDiff, ArenaDiffFile } from "@getpaseo/protocol/arena";
import { runGitCommand } from "../../utils/run-git-command.js";

const MAX_FILES = 200;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_DIFF_LINES_PER_FILE = 200;
const MAX_TOTAL_DIFF_BYTES = 256 * 1024;
const MAX_LCS_CELLS = 1_000_000;
const TEXT_PROBE_BYTES = 8_000;

interface FileSnapshot {
  path: string;
  size: number;
  hash: string;
  kind: "file" | "symlink";
  text: boolean;
  content: Buffer | null;
}

async function listVisibleFiles(root: string): Promise<string[]> {
  const result = await runGitCommand(
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: root,
      maxOutputBytes: 20 * 1024 * 1024,
    },
  );
  return result.stdout.split("\0").filter(Boolean);
}

async function snapshot(root: string, path: string): Promise<FileSnapshot | null> {
  const absolute = join(root, path);
  const stats = await lstat(absolute).catch(() => null);
  if (!stats || (!stats.isFile() && !stats.isSymbolicLink())) return null;
  const kind = stats.isSymbolicLink() ? "symlink" : "file";
  if (kind === "symlink") {
    const content = Buffer.from(await readlink(absolute));
    return {
      path,
      size: content.length,
      hash: createHash("sha256").update(content).digest("hex"),
      kind,
      text: true,
      content,
    };
  }
  if (stats.size > MAX_FILE_BYTES) {
    const hash = createHash("sha256");
    const probeChunks: Buffer[] = [];
    let probeBytes = 0;
    for await (const chunk of createReadStream(absolute)) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      hash.update(buffer);
      if (probeBytes < TEXT_PROBE_BYTES) {
        const probeChunk = buffer.subarray(0, TEXT_PROBE_BYTES - probeBytes);
        probeChunks.push(probeChunk);
        probeBytes += probeChunk.length;
      }
    }
    const probe = Buffer.concat(probeChunks);
    return {
      path,
      size: stats.size,
      hash: hash.digest("hex"),
      kind,
      text: !probe.includes(0),
      content: null,
    };
  }
  const content = await readFile(absolute);
  return {
    path,
    size: content.length,
    hash: createHash("sha256").update(content).digest("hex"),
    kind,
    text: !content.subarray(0, TEXT_PROBE_BYTES).includes(0),
    content,
  };
}

function isText(content: Buffer | null): content is Buffer {
  return content !== null && !content.subarray(0, TEXT_PROBE_BYTES).includes(0);
}

interface DiffOperation {
  kind: "same" | "add" | "remove";
  line: string;
}

function buildLongestCommonSubsequenceTable(linesA: string[], linesB: string[]): Uint32Array[] {
  const table = Array.from({ length: linesA.length + 1 }, () => new Uint32Array(linesB.length + 1));
  for (let a = linesA.length - 1; a >= 0; a--) {
    for (let b = linesB.length - 1; b >= 0; b--) {
      const diagonal = table[a + 1]?.[b + 1] ?? 0;
      const below = table[a + 1]?.[b] ?? 0;
      const right = table[a]?.[b + 1] ?? 0;
      table[a]![b] = linesA[a] === linesB[b] ? diagonal + 1 : Math.max(below, right);
    }
  }
  return table;
}

function shouldAddLine(
  table: Uint32Array[],
  a: number,
  b: number,
  linesA: string[],
  linesB: string[],
): boolean {
  if (b >= linesB.length) return false;
  if (a >= linesA.length) return true;
  return (table[a]?.[b + 1] ?? 0) >= (table[a + 1]?.[b] ?? 0);
}

function traceLineOperations(
  table: Uint32Array[],
  linesA: string[],
  linesB: string[],
): DiffOperation[] {
  const operations: DiffOperation[] = [];
  let a = 0;
  let b = 0;
  while (a < linesA.length || b < linesB.length) {
    const left = linesA[a];
    const right = linesB[b];
    if (left !== undefined && right !== undefined && left === right) {
      operations.push({ kind: "same", line: left });
      a++;
      b++;
      continue;
    }
    if (shouldAddLine(table, a, b, linesA, linesB)) {
      operations.push({ kind: "add", line: right ?? "" });
      b++;
      continue;
    }
    operations.push({ kind: "remove", line: left ?? "" });
    a++;
  }
  return operations;
}

function lineOperations(linesA: string[], linesB: string[]): DiffOperation[] {
  return traceLineOperations(buildLongestCommonSubsequenceTable(linesA, linesB), linesA, linesB);
}

function operationPrefix(kind: DiffOperation["kind"]): string {
  if (kind === "same") return " ";
  return kind === "add" ? "+" : "-";
}

function renderOperations(operations: DiffOperation[]): {
  lines: string[];
  additions: number;
  deletions: number;
  truncated: boolean;
} {
  const changedIndexes = operations
    .map((operation, index) => (operation.kind === "same" ? -1 : index))
    .filter((index) => index >= 0);
  if (changedIndexes.length === 0)
    return { lines: [], additions: 0, deletions: 0, truncated: false };
  const include = new Set<number>();
  for (const index of changedIndexes) {
    for (
      let cursor = Math.max(0, index - 3);
      cursor <= Math.min(operations.length - 1, index + 3);
      cursor++
    ) {
      include.add(cursor);
    }
  }
  const full = [...include]
    .sort((left, right) => left - right)
    .map((index) => {
      const operation = operations[index]!;
      return `${operationPrefix(operation.kind)}${operation.line}`;
    });
  return {
    lines: full.slice(0, MAX_DIFF_LINES_PER_FILE),
    additions: operations.filter((operation) => operation.kind === "add").length,
    deletions: operations.filter((operation) => operation.kind === "remove").length,
    truncated: full.length > MAX_DIFF_LINES_PER_FILE,
  };
}

function renderLargeReplacement(linesA: string[], linesB: string[]) {
  const lines: string[] = [];
  for (const line of linesA) {
    if (lines.length >= MAX_DIFF_LINES_PER_FILE) break;
    lines.push(`-${line}`);
  }
  for (const line of linesB) {
    if (lines.length >= MAX_DIFF_LINES_PER_FILE) break;
    lines.push(`+${line}`);
  }
  return {
    lines,
    additions: linesB.length,
    deletions: linesA.length,
    truncated: linesA.length + linesB.length > MAX_DIFF_LINES_PER_FILE,
  };
}

function splitTextLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

function renderTextDiff(leftText: string, rightText: string) {
  const linesA = splitTextLines(leftText);
  const linesB = splitTextLines(rightText);
  if (linesA.length * linesB.length > MAX_LCS_CELLS) {
    return renderLargeReplacement(linesA, linesB);
  }
  return renderOperations(lineOperations(linesA, linesB));
}

function fileStatus(
  left: FileSnapshot | null,
  right: FileSnapshot | null,
): ArenaDiffFile["status"] {
  if (!left) return "added_b";
  if (!right) return "added_a";
  if (left.kind !== right.kind) return "type_changed";
  if (!left.text || !right.text) return "binary";
  return "modified";
}

function hasTruncatedSnapshot(left: FileSnapshot | null, right: FileSnapshot | null): boolean {
  return left?.content === null || right?.content === null;
}

function buildFileDiff(
  path: string,
  left: FileSnapshot | null,
  right: FileSnapshot | null,
): ArenaDiffFile {
  const status = fileStatus(left, right);
  if (status === "binary" || status === "type_changed") {
    return {
      path,
      status,
      additions: 0,
      deletions: 0,
      bytesA: left?.size,
      bytesB: right?.size,
      hunks: [],
      truncated: hasTruncatedSnapshot(left, right),
    };
  }
  const leftContent = left?.content ?? null;
  const rightContent = right?.content ?? null;
  const leftText = isText(leftContent) ? leftContent.toString("utf8") : "";
  const rightText = isText(rightContent) ? rightContent.toString("utf8") : "";
  const rendered = renderTextDiff(leftText, rightText);
  const hunks = rendered.lines.length
    ? [
        {
          header: "@@ A → B @@",
          lines: rendered.lines,
          truncated: rendered.truncated,
        },
      ]
    : [];
  return {
    path,
    status,
    additions: rendered.additions,
    deletions: rendered.deletions,
    bytesA: left?.size,
    bytesB: right?.size,
    hunks,
    truncated: rendered.truncated || hasTruncatedSnapshot(left, right),
  };
}

export async function buildBoundedBattleDiff(
  rootA: string,
  rootB: string,
): Promise<ArenaBattleDiff> {
  const allPaths = [
    ...new Set([...(await listVisibleFiles(rootA)), ...(await listVisibleFiles(rootB))]),
  ].sort();
  const files: ArenaDiffFile[] = [];
  let changedFiles = 0;
  let serializedBytes = 0;
  let truncated = false;
  for (const path of allPaths) {
    const [left, right] = await Promise.all([snapshot(rootA, path), snapshot(rootB, path)]);
    if (left?.hash === right?.hash && left?.kind === right?.kind) continue;
    changedFiles++;
    if (files.length >= MAX_FILES || serializedBytes >= MAX_TOTAL_DIFF_BYTES) {
      truncated = true;
      continue;
    }
    const file = buildFileDiff(path, left, right);
    serializedBytes += Buffer.byteLength(JSON.stringify(file));
    if (serializedBytes > MAX_TOTAL_DIFF_BYTES) {
      truncated = true;
      continue;
    }
    files.push(file);
    truncated ||= file.truncated === true;
  }
  return {
    files,
    totalFiles: allPaths.length,
    changedFiles,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    truncated,
    generatedAt: new Date().toISOString(),
  };
}

export async function fingerprintVisibleWorktree(root: string): Promise<string> {
  const paths = (await listVisibleFiles(root)).sort();
  const fingerprint = createHash("sha256");
  const batchSize = 32;
  for (let index = 0; index < paths.length; index += batchSize) {
    const batch = paths.slice(index, index + batchSize);
    const entries = await Promise.all(batch.map((path) => snapshot(root, path)));
    for (let offset = 0; offset < batch.length; offset++) {
      const path = batch[offset]!;
      const entry = entries[offset];
      fingerprint.update(path).update("\0");
      if (!entry) {
        fingerprint.update("missing\0");
        continue;
      }
      fingerprint
        .update(entry.kind)
        .update("\0")
        .update(String(entry.size))
        .update("\0")
        .update(entry.hash)
        .update("\0");
    }
  }
  return fingerprint.digest("hex");
}

export async function hasBattleFileEdits(
  root: string,
  baseCommit?: string,
  baselineFingerprint?: string,
): Promise<boolean> {
  if (baselineFingerprint) {
    return (await fingerprintVisibleWorktree(root)) !== baselineFingerprint;
  }
  const status = await runGitCommand(["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
    cwd: root,
    maxOutputBytes: 20 * 1024 * 1024,
  });
  if (status.stdout.length > 0) return true;
  if (!baseCommit) return false;
  const committed = await runGitCommand(["diff", "--name-only", "-z", baseCommit, "--"], {
    cwd: root,
    maxOutputBytes: 20 * 1024 * 1024,
  });
  return committed.stdout.length > 0;
}

export function renderBattleDiffForComparison(diff: ArenaBattleDiff): string {
  const lines = [
    `Changed files shown: ${diff.files.length}/${diff.changedFiles}${
      diff.truncated ? " (bounded/truncated)" : ""
    }`,
    `Additions: ${diff.additions}; deletions: ${diff.deletions}`,
  ];
  for (const file of diff.files) {
    lines.push("", `--- A/${file.path}`, `+++ B/${file.path}`);
    for (const hunk of file.hunks) lines.push(hunk.header, ...hunk.lines);
    if (file.truncated) lines.push("[file diff truncated]");
  }
  return lines.join("\n");
}
