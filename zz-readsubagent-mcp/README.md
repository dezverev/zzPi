# zz-readsubagent-mcp — a harness-neutral pi readsubagent bridge

`zz-readsubagent-mcp.py` is a single, zero-dependency (pure stdlib Python) stdio
**MCP server**. It supports normal Content-Length-framed MCP messages and the
newline-delimited JSON fallback used by some harnesses. It exposes one tool,
`readsubagent`, that spawns a headless `pi` child running on a **local model**
(Qwen via LM Studio) and returns its concise, cited factual report.

This is the reusable core. Any MCP-capable harness (Claude Code, Copilot/VS
Code, Codex, Cursor, Zed, your own client) can register this one server and
consume it — directly, or wrapped in that harness's own subagent / instructions.
The Claude Code and Copilot wrappers that ship in this repo
(`clients/install-claude-readsubagent.*`, `clients/install-copilot-readsubagent.*`)
are examples.

## What the tool does

`readsubagent` takes a targeted factual question (plus optional `paths`,
`symbols`, `searchTerms`, `lineRanges`, `output`, `maxReportChars`, `cwd`) and
returns a short answer with repo-relative citations and line ranges — without
pulling large file contents into the calling model's context. It is read-only
and explicitly **not** a code-review / bug-finding / correctness-judgment agent.

Under the hood it runs:

```bash
pi --mode json -p --no-session --model lm-studio/qwen/qwen3.6-35b-a3b \
   --thinking off \
   --exclude-tools readsubagent,explorationsubagent,reviewsubagent,simpletasksubagent \
   --tools read,grep,find,ls \
   --append-system-prompt "<readsubagent prompt>" "<delegated task>"
```

## Prerequisite

The LM Studio endpoint is **not** passed on the CLI — the `lm-studio` provider is
resolved by Pi's `zzLocalModels` extension. So the host needs:

- `pi` on `PATH`,
- the `lm-studio` provider available to `pi` (install the repo-local pi plugs,
  which include `zzLocalModels`, or define a global Pi `lm-studio` provider), and
- LM Studio reachable (default `http://127.0.0.1:11444/v1`).

## Configuration (environment)

| Variable | Default |
|---|---|
| `ZZ_READSUBAGENT_MODEL` | `lm-studio/qwen/qwen3.6-35b-a3b` |
| `ZZ_READSUBAGENT_PI_BIN` | `pi` |
| `ZZ_READSUBAGENT_THINKING` | `off` |
| `ZZ_READSUBAGENT_TOOLS` | `read,grep,find,ls` |
| `ZZ_READSUBAGENT_TIMEOUT_MS` | `1800000` |
| `ZZ_READSUBAGENT_REPORT_MAX_CHARS` | `16000` |
| `ZZ_READSUBAGENT_SYSTEM_PROMPT` | the readsubagent prompt |
| `ZZ_READSUBAGENT_DEFAULT_CWD` | `$CLAUDE_PROJECT_DIR` or the process cwd |

## Install

Drop the server into a repo at `./.zz-mcp/zz-readsubagent-mcp.py`:

```bash
curl -fsSL https://raw.githubusercontent.com/dezverev/zzPi/main/install-zz-readsubagent-mcp.sh | bash
```

```powershell
irm https://raw.githubusercontent.com/dezverev/zzPi/main/install-zz-readsubagent-mcp.ps1 | iex
```

Or just copy the single file anywhere (repo-local or e.g.
`~/.local/share/zz-readsubagent-mcp/`) and register it.

## Registering it in a harness

The MCP **server name** is `zz_readsubagent` and the tool is therefore callable
as `mcp__zz_readsubagent__readsubagent`.

**Generic stdio MCP server config:**

```json
{
  "command": "python3",
  "args": [".zz-mcp/zz-readsubagent-mcp.py"],
  "env": { "ZZ_READSUBAGENT_MODEL": "lm-studio/qwen/qwen3.6-35b-a3b" }
}
```

The `args` path is relative to the **repo root**, which is the cwd the harness
launches the server in (Claude Code does this). Use an absolute path instead if
your harness launches the server from somewhere else. Note: Claude Code does
**not** expand `${CLAUDE_PROJECT_DIR}` inside `.mcp.json` `args`, so use a
relative or absolute path there — not that variable.

**Claude Code** — project `.mcp.json`:

```json
{ "mcpServers": { "zz_readsubagent": { "type": "stdio",
  "command": "python3",
  "args": [".zz-mcp/zz-readsubagent-mcp.py"],
  "env": { "ZZ_READSUBAGENT_MODEL": "lm-studio/qwen/qwen3.6-35b-a3b" } } } }
```

or:

```bash
claude mcp add --scope project --transport stdio \
  --env ZZ_READSUBAGENT_MODEL=lm-studio/qwen/qwen3.6-35b-a3b \
  -- zz_readsubagent python3 ./.zz-mcp/zz-readsubagent-mcp.py
```

**Copilot / VS Code** — workspace `.vscode/mcp.json`:

```json
{ "servers": { "zz_readsubagent": { "type": "stdio",
  "command": "python3",
  "args": [".zz-mcp/zz-readsubagent-mcp.py"],
  "env": { "ZZ_READSUBAGENT_MODEL": "lm-studio/qwen/qwen3.6-35b-a3b" } } } }
```

Then wrap it however your harness prefers — a dedicated subagent restricted to
`mcp__zz_readsubagent__readsubagent`, or a directive in your project/system
instructions telling the main agent to use it for read planning before focused
reads. The Claude Code wrapper here does the former; the Copilot wrapper writes
project instructions for the latter. See `clients/CLAUDE_READSUBAGENT_INSTALL.md`
and `clients/COPILOT_READSUBAGENT_INSTALL.md`.
