import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ArenaBattle } from "@getpaseo/protocol/arena";

export interface StoredArenaBattle {
  battle: ArenaBattle;
  secrets: {
    baseCommit?: string;
    comparisonDetectionVersion?: number;
    A: {
      modelToken: string;
      configPath: string | null;
      worktreePath: string | null;
      agentCwd: string | null;
      baselineTimelineSeq?: number;
      baselineWorktreeFingerprint?: string;
    };
    B: {
      modelToken: string;
      configPath: string | null;
      worktreePath: string | null;
      agentCwd: string | null;
      baselineTimelineSeq?: number;
      baselineWorktreeFingerprint?: string;
    };
  };
}

export class ArenaBattleStore {
  private readonly root: string;

  constructor(paseoHome: string) {
    this.root = join(paseoHome, "arena", "battles");
  }

  private pathFor(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid battle id");
    return join(this.root, `${id}.json`);
  }

  async get(id: string): Promise<StoredArenaBattle | null> {
    try {
      return JSON.parse(await readFile(this.pathFor(id), "utf8")) as StoredArenaBattle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(): Promise<StoredArenaBattle[]> {
    await mkdir(this.root, { recursive: true });
    const records = await Promise.all(
      (await readdir(this.root))
        .filter((name) => name.endsWith(".json"))
        .map((name) => this.get(name.slice(0, -5))),
    );
    return records
      .filter((record): record is StoredArenaBattle => record !== null)
      .sort((left, right) => right.battle.createdAt.localeCompare(left.battle.createdAt));
  }

  async put(record: StoredArenaBattle): Promise<void> {
    const target = this.pathFor(record.battle.id);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, target);
  }
}
