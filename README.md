# Agent Arena

Agent Arena is a blinded A/B testing environment for coding agents, built as an
[AGPL-licensed](LICENSE) fork of [Paseo](https://github.com/getpaseo/paseo). It runs two
OpenCode agents in separate Git worktrees, hides their model identities until a vote, and promotes
the selected worktree into the continuing conversation.

This README is the tester quickstart for the Electron desktop app.

## What you need

- macOS or Linux. The commands below use a POSIX shell (`zsh` or `bash`).
- Git.
- Node.js 22.20.0 (the version pinned in [`.tool-versions`](.tool-versions)) and npm.
- An [OpenRouter](https://openrouter.ai/) API key with available credit.
- The stable `opencode` CLI on your `PATH`. Install it with:

  ```bash
  npm install -g opencode-ai
  opencode --version
  ```

Arena uses OpenCode as the harness, but model inference goes through the local Arena proxy and your
OpenRouter key. You do not need to configure a separate model inside OpenCode.

## 1. Clone and install

```bash
git clone https://github.com/bottomless/agent-arena1.git
cd agent-arena1
npm install --workspaces --include-workspace-root
```

Build the local packages needed by Electron and its managed daemon:

```bash
npm run build:server
npm run build --workspace=@getpaseo/expo-two-way-audio
```

These builds are only required after a fresh clone or after changing dependencies/shared packages.

## 2. Configure Arena

Create the local environment file:

```bash
cp packages/arena-proxy/.env.example packages/arena-proxy/.env
openssl rand -hex 32
```

Open `packages/arena-proxy/.env` and replace:

- `replace-with-a-long-random-token` with the output from `openssl rand -hex 32`.
- `replace-with-an-openrouter-key` with your OpenRouter API key.

Leave the remaining defaults unchanged. In particular, both processes should use
`http://127.0.0.1:6770` for `ARENA_PROXY_URL`.

The `.env` file is ignored by Git. Never commit or share it.

## 3. Start the proxy

From the repository root, open terminal 1 and run:

```bash
set -a
source packages/arena-proxy/.env
set +a
npm run dev:arena
```

Wait for:

```text
Paseo Arena proxy listening on http://127.0.0.1:6770
```

Keep this terminal running.

## 4. Start Electron

From the repository root, open terminal 2 and run:

```bash
set -a
source packages/arena-proxy/.env
set +a
npm run dev:desktop
```

Launch Electron from this terminal, not Finder or an application launcher. Electron must inherit
the Arena environment variables. The desktop launcher starts Metro and its own managed Paseo daemon;
do not start `npm run dev:server` separately.

The first launch can take a minute while Electron and Metro initialize. Keep terminal 2 open while
testing. Arena Electron uses daemon port `6869`, separate from Paseo's usual development port
`6768`, so both checkouts can run at the same time.

## 5. Run a battle

1. In Electron, add or open a local Git repository. The repository must have at least one commit so
   Arena can create worktrees.
2. Create a new workspace/chat.
3. Confirm the **Battle** toggle is on. It defaults to on for a new chat.
4. Enter a coding task and submit it.
5. Watch candidates A and B work side by side. A side becomes selectable when that side finishes.
6. Select **Choose A**, **Choose B**, or **Tie**. A tie is recorded as a tie and advances A.
7. After the vote, the model names are revealed and the battle collapses into the normal timeline.
   Expand the battle summary to inspect both transcripts, the bounded A-vs-B diff, and its summary.
8. Send another message. It should continue from the selected worktree and normal winning transcript.

To test single-agent mode, turn **Battle** off before submitting. The thinking selector appears in
single-agent mode. You can switch between battle and single-agent turns within the same chat.

Arena currently accepts text prompts only.

## Stop everything

- Quit Electron normally or press `Ctrl+C` in terminal 2. The desktop-managed daemon shuts down with
  the app.
- Press `Ctrl+C` in terminal 1 to stop the Arena proxy.

Runtime state remains local:

- Electron/Paseo development state: `.dev/`
- Proxy battle records: `packages/arena-proxy/.data/`
- Local credentials: `packages/arena-proxy/.env`

All three paths are ignored by Git.

## Troubleshooting

### `OpenCode binary not found`

Confirm the same shell that starts Electron can find it:

```bash
command -v opencode
opencode --version
```

If needed, install it with `npm install -g opencode-ai`, then restart terminal 2.

### Arena is unavailable or asks for a newer host

Quit Electron completely and restart it from terminal 2 after sourcing
`packages/arena-proxy/.env`. Do not use an already-installed Paseo app; testers must run this
checkout with `npm run dev:desktop`.

### `Arena requires ARENA_PROXY_URL and ARENA_API_TOKEN`

Electron did not inherit the Arena environment. Quit it and repeat all four lines in the terminal 2
launch block.

### Proxy returns `401`, `Unauthorized`, or an unknown-token error

Stop both processes. Confirm terminal 1 and terminal 2 source the same `.env` file, then restart the
proxy first and Electron second.

### Port `6770` is already in use

Stop the older Arena proxy. If you intentionally choose another port, update both
`ARENA_PROXY_PORT` and `ARENA_PROXY_URL` in `.env` before restarting both processes.

### Port `6869` is already in use

Another Agent Arena development daemon is running. Quit the older Arena Electron development
instance before starting this one. Standard Paseo development uses a different port (`6768`), and
the packaged Paseo app normally uses `6767`.

### Electron opens but stays blank

Wait for Metro to finish in terminal 2. If Metro exited, stop Electron and rerun
`npm run dev:desktop`. On a fresh checkout, also confirm the two build commands in step 1 completed.

## Development notes

- [Arena architecture and model policy](docs/arena.md)
- [Paseo development guide](docs/development.md)
- [Repository testing guide](docs/testing.md)

## License and attribution

Agent Arena is derived from Paseo and remains licensed under
[AGPL-3.0-or-later](LICENSE). Preserve upstream copyright and license notices when redistributing or
modifying this fork.
