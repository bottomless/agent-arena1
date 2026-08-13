# Paseo Arena

Arena is a web and Electron coding-agent evaluation mode built on Paseo's existing daemon and OpenCode harness.

## Runtime shape

```text
Paseo app
  └─ WebSocket RPC
      └─ Paseo daemon
          ├─ Git worktree A ─ OpenCode session A ─┐
          ├─ Git worktree B ─ OpenCode session B ─┼─ Arena proxy ─ OpenRouter
          └─ local battle archive                 ┘
```

The proxy owns model assignment and never sends real battle model IDs to the app or daemon before a vote. OpenCode receives an opaque model token, and the proxy rewrites model/provider metadata and model-bearing error text in both JSON and streamed SSE responses. Model-inference credentials are separate from the daemon's battle-control credential.

OpenCode exposes session forking, but a fork remains bound to its original directory. Because Arena requires independent worktrees, each side starts a fresh OpenCode session with the source timeline copied into Paseo history and rendered into the new session's system context.

Switching a winning battle thread to single mode likewise starts a fresh OpenCode session in the winning worktree, then archives the side-scoped session after the new run starts. This preserves the winning filesystem and normal transcript while replacing its battle-only inference credential.

## Model policy

- Single agent: `~deepseek/deepseek-v4-flash-latest`, with Low, High, and Max thinking controls. High is the default.
- Battle pool: GLM 5.2, Qwen 3.8 Max, and the newest DeepSeek V4 Pro returned by OpenRouter. Two distinct models are sampled and randomly assigned to A/B.
- AI comparison: `openai/gpt-oss-120b:nitro` with low reasoning.

Battle models use their default reasoning configuration. Ties are recorded as ties but operationally promote A.

## Local development

Install dependencies and configure the proxy:

```bash
npm install --workspaces --include-workspace-root
cp packages/arena-proxy/.env.example packages/arena-proxy/.env
```

Put your OpenRouter key in `packages/arena-proxy/.env`. This file is gitignored and must stay
untracked. Generate a separate long random value for `ARENA_API_TOKEN`, then load the file and
start the proxy:

```bash
set -a
source packages/arena-proxy/.env
set +a
npm run dev:arena
```

In a second terminal, load the same file before starting the Paseo daemon. The file contains
`ARENA_PROXY_URL`, so the daemon and proxy share one configuration source:

```bash
set -a
source packages/arena-proxy/.env
set +a
npm run dev:server
```

Then run either `npm run dev:app` for the browser or `npm run dev:desktop` for Electron.

The first Arena protocol accepts text prompts only. Attachment entry points are hidden in Arena composers until attachment fields are added to the typed RPC.

## Persistence and limits

The proxy stores blinded assignments and votes under `ARENA_DATA_DIR`. The daemon stores the UI-safe battle record, opaque side tokens, archived transcript references, and bounded A-vs-B diff under `$PASEO_HOME/arena`. Chat mode preferences are persisted in the app's existing AsyncStorage layer.

Diff generation compares the two battle worktrees directly, including committed, staged, unstaged, deleted, and untracked files. It caps the file count, bytes per file, diff lines per file, and total serialized diff size. Truncation is explicit in the stored result and comparison prompt.

An early vote is accepted only for a successfully completed side. The daemon cancels the other OpenCode run and archives its agent and worktree. All side-scoped inference tokens are revoked once a vote is recorded; successor turns receive fresh credentials. Because the other side did not finish, no two-sided diff or AI comparison is produced.
