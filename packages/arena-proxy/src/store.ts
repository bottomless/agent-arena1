import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { StoredProxyBattle } from "./types.js";

export class ProxyBattleStore {
  constructor(private readonly root: string) {}

  private pathFor(id: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid battle id");
    return join(this.root, `${id}.json`);
  }

  async get(id: string): Promise<StoredProxyBattle | null> {
    try {
      const raw = await readFile(this.pathFor(id), "utf8");
      return JSON.parse(raw) as StoredProxyBattle;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async list(): Promise<StoredProxyBattle[]> {
    await mkdir(this.root, { recursive: true });
    const names = await readdir(this.root);
    const records = await Promise.all(
      names.filter((name) => name.endsWith(".json")).map((name) => this.get(name.slice(0, -5))),
    );
    return records
      .filter((record): record is StoredProxyBattle => record !== null)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async put(record: StoredProxyBattle): Promise<void> {
    const target = this.pathFor(record.id);
    await mkdir(dirname(target), { recursive: true });
    const temporary = `${target}.tmp-${process.pid}-${Date.now()}`;
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, target);
  }
}
