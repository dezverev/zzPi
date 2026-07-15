#!/usr/bin/env python3
"""zz readsubagent — stdio MCP server for Claude Code.

Exposes a single read-only tool, ``readsubagent``, that spawns a headless
``pi`` child agent running on a local Qwen model (via LM Studio) and returns its
concise, cited factual report. This lets a Claude Code session delegate
factual file-inspection and read-planning to the local model without routing
the main session through a proxy.

The child invocation mirrors the Pi ``readsubagent`` extension
(clients/pi-plugs/extensions/readsubagent.ts) and the headless child-agent
runner (clients/zz-lib/extensions/zz-lib/child-pi-agent.ts):

    pi --mode json -p --no-session --model <selector> --thinking off \
       --exclude-tools readsubagent,explorationsubagent \
       --tools read,grep,find,ls \
       --append-system-prompt "<system prompt>" "<delegated task>"

The LM Studio endpoint is NOT passed on the CLI: the ``lm-studio`` provider is
resolved by Pi's ``zzLocalModels`` extension. The spawned ``pi`` therefore
needs that provider available (pi-plugs installed in the working repo, or a
global Pi ``lm-studio`` provider) and LM Studio reachable.

Pure standard library, zero dependencies. JSON-RPC 2.0 over stdio. Supports
both Content-Length framed MCP messages and newline-delimited JSON messages.
Everything non-protocol goes to stderr.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from typing import Any

SERVER_NAME = "zz_readsubagent"
SERVER_VERSION = "1.1.0"
DEFAULT_PROTOCOL_VERSION = "2025-06-18"

# --- Defaults (overridable via environment) ---------------------------------

DEFAULT_MODEL = "lm-studio/qwen/qwen3.6-35b-a3b"
DEFAULT_PI_BIN = "pi"
DEFAULT_THINKING = "off"
DEFAULT_TOOLS = "read,grep,find,ls"
DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
DEFAULT_REPORT_MAX_CHARS = 16_000
EXCLUDED_CHILD_TOOLS = "readsubagent,explorationsubagent"

# Ported verbatim from DEFAULT_READSUBAGENT_CONFIG.systemPrompt in
# clients/pi-plugs/extensions/readsubagent.ts so the child behaves identically.
DEFAULT_SYSTEM_PROMPT = (
    "You are a read-only file-inspection subagent spawned by Pi. The parent "
    "delegates to you instead of reading files directly when it needs factual "
    "answers, summaries, extracted snippets, symbol locations, docs/config "
    "details, or line ranges without raw contents in the parent context. Use "
    "tools as needed to inspect only the requested repo-relative paths and "
    "nearby supporting files. Do not edit or write files. Do not create "
    "implementation plans, solution proposals, edit strategies, code-review "
    "judgments, bug findings, correctness assessments, control-flow/type-safety "
    "analysis, or accept/reject recommendations. Your job is factual "
    "inspection, evidence, descriptive API/flow maps, and line-range pointers "
    "only. If the parent asks for hard logic, review, or whether code is "
    "correct/acceptable, state that this is outside readsubagent scope and "
    "return only the factual evidence/locations that would support a separate "
    "review. Start with the answer, then cite evidence with repo-relative paths "
    "and line numbers when possible. Prefer summaries and exact line ranges the "
    "parent can read later; include concrete snippets only when necessary and "
    "keep them short. Never dump whole files or raw tool output; if the question "
    "is too broad, propose a narrower factual follow-up."
)


def env_str(name: str, default: str) -> str:
    value = os.environ.get(name)
    return value if value and value.strip() else default


def env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if not raw or not raw.strip():
        return default
    try:
        parsed = int(raw.strip())
    except ValueError:
        return default
    return parsed if parsed > 0 else default


def config() -> dict[str, Any]:
    return {
        "model": env_str("ZZ_READSUBAGENT_MODEL", DEFAULT_MODEL),
        "pi_bin": env_str("ZZ_READSUBAGENT_PI_BIN", DEFAULT_PI_BIN),
        "thinking": env_str("ZZ_READSUBAGENT_THINKING", DEFAULT_THINKING),
        "tools": env_str("ZZ_READSUBAGENT_TOOLS", DEFAULT_TOOLS),
        "timeout_ms": env_int("ZZ_READSUBAGENT_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
        "report_max_chars": env_int(
            "ZZ_READSUBAGENT_REPORT_MAX_CHARS", DEFAULT_REPORT_MAX_CHARS
        ),
        "system_prompt": env_str("ZZ_READSUBAGENT_SYSTEM_PROMPT", DEFAULT_SYSTEM_PROMPT),
        "default_cwd": env_str(
            "ZZ_READSUBAGENT_DEFAULT_CWD",
            os.environ.get("CLAUDE_PROJECT_DIR", "") or os.getcwd(),
        ),
    }


# --- Task / prompt shaping (ported from readsubagent.ts) --------------------


def log(message: str) -> None:
    print(f"[zz-readsubagent] {message}", file=sys.stderr, flush=True)


def normalize_string_list(items: Any) -> list[str]:
    if not isinstance(items, list):
        return []
    seen: list[str] = []
    for item in items:
        if not isinstance(item, str):
            continue
        trimmed = item.strip()
        if trimmed and trimmed not in seen:
            seen.append(trimmed)
    return seen


def normalize_path_list(path: Any, paths: Any) -> list[str]:
    combined: list[str] = []
    if isinstance(paths, list):
        combined.extend(paths)
    if isinstance(path, str):
        combined.append(path)
    return normalize_string_list(combined)


def format_list_section(items: list[str]) -> str:
    if not items:
        return "- none specified"
    return "\n".join(f"- {item}" for item in items)


def format_delegated_task(
    question: str,
    paths: list[str],
    symbols: list[str],
    search_terms: list[str],
    line_ranges: list[str],
    output: str | None,
    max_report_chars: int,
) -> str:
    report_budget = (
        f"Aim to keep the final parent-visible report under "
        f"{max_report_chars:,} characters."
    )
    desired_output = (output or "").strip() or (
        "- Direct answer first, then concise evidence and only the shortest "
        "useful snippets."
    )
    return "\n".join(
        [
            "Question:",
            question,
            "",
            "Target paths:",
            format_list_section(paths),
            "",
            "Target symbols/functions/types/config keys:",
            format_list_section(symbols),
            "",
            "Search terms or regexes:",
            format_list_section(search_terms),
            "",
            "Specific line ranges:",
            format_list_section(line_ranges),
            "",
            "Desired output:",
            desired_output,
            "",
            "Report constraints:",
            f"- {report_budget}",
            "- Cite repo-relative paths and line numbers when possible.",
            "- Include exact snippets or oldText blocks only when they are "
            "needed for the parent agent's next action.",
            "- Avoid dumping whole files, whole functions unrelated to the "
            "question, or raw tool output.",
            "- If the question is underspecified, answer what you can and state "
            "the narrow follow-up question the parent should ask next.",
        ]
    )


def build_child_prompt(task: str) -> str:
    return "\n\n".join(
        [
            "You are running as the child process for the parent readsubagent "
            "tool.",
            "Your job is to answer a targeted factual file-inspection question "
            "without sending full file contents back to the parent context.",
            "Use read/search tools as needed to deliver the best factual "
            "report. Do not modify files. Treat target paths, symbols, search "
            "terms, and line ranges as the intended scope.",
            "Use grep or focused reads so you can cite repo-relative paths and "
            "line numbers. Avoid broad repo-wide searches unless the question "
            "has no target path and no search terms.",
            "Return the smallest useful report: direct answer first, citations "
            "second, and exact short snippets only where useful. Do not create "
            "implementation plans, solution proposals, edit strategies, "
            "code-review judgments, bug findings, correctness assessments, "
            "control-flow/type-safety analysis, or accept/reject "
            "recommendations; provide factual repo evidence and line ranges "
            "only. If asked for hard logic or review, say that is outside "
            "readsubagent scope and provide only factual evidence/locations. If "
            "you cannot answer precisely from the supplied scope, state the "
            "narrow factual follow-up needed.",
            f"Delegated file-inspection task:\n{task}",
        ]
    )


def truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    omitted = len(text) - max_chars
    head_chars = max(1, int(max_chars * 0.65))
    tail_chars = max(1, max_chars - head_chars - 120)
    return (
        f"{text[:head_chars]}\n\n[… {omitted} characters omitted …]\n\n"
        f"{text[-tail_chars:]}"
    )


# --- Running the headless pi child ------------------------------------------


def text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            text = block.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts)


def run_pi_child(cfg: dict[str, Any], task: str, cwd: str) -> dict[str, Any]:
    """Spawn ``pi`` headlessly and parse the newline-delimited JSON events."""
    prompt = build_child_prompt(task)
    args = [
        cfg["pi_bin"],
        "--mode",
        "json",
        "-p",
        "--no-session",
        "--model",
        cfg["model"],
        "--thinking",
        cfg["thinking"],
        "--exclude-tools",
        EXCLUDED_CHILD_TOOLS,
    ]
    if cfg["tools"].strip():
        args += ["--tools", cfg["tools"]]
    if cfg["system_prompt"].strip():
        args += ["--append-system-prompt", cfg["system_prompt"]]
    args.append(prompt)

    child_env = dict(os.environ)
    child_env["PI_CHILD_PI_AGENT"] = "1"

    log(f"spawning pi child: model={cfg['model']} cwd={cwd}")
    try:
        proc = subprocess.run(
            args,
            cwd=cwd,
            env=child_env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=cfg["timeout_ms"] / 1000.0,
        )
    except FileNotFoundError:
        return {
            "status": "failed",
            "output": (
                f"pi binary not found: {cfg['pi_bin']!r}. Install Pi and ensure "
                "it is on PATH, with the LM Studio (lm-studio) provider "
                "available so the model selector resolves."
            ),
            "model": cfg["model"],
            "turns": 0,
            "tool_calls": {},
            "exit_code": 127,
        }
    except subprocess.TimeoutExpired as exc:
        partial = exc.stdout if isinstance(exc.stdout, str) else ""
        parsed = parse_pi_events(partial)
        report = parsed["output"] or (
            f"readsubagent timed out after {cfg['timeout_ms']}ms with no output. "
            "The local model may be busy or unreachable."
        )
        return {
            "status": "timeout",
            "output": report,
            "model": parsed["model"] or cfg["model"],
            "turns": parsed["turns"],
            "tool_calls": parsed["tool_calls"],
            "exit_code": -1,
        }

    parsed = parse_pi_events(proc.stdout or "")
    stderr_text = (proc.stderr or "").strip()
    output = parsed["output"] or parsed["error_message"] or stderr_text or "(no output)"
    completed = (
        proc.returncode == 0
        and parsed["stop_reason"] != "error"
        and parsed["error_message"] is None
    )
    if not completed and stderr_text:
        log(f"pi stderr: {stderr_text[:2000]}")
    return {
        "status": "completed" if completed else "failed",
        "output": output,
        "model": parsed["model"] or cfg["model"],
        "turns": parsed["turns"],
        "tool_calls": parsed["tool_calls"],
        "exit_code": proc.returncode,
    }


def parse_pi_events(stdout: str) -> dict[str, Any]:
    """Extract the final assistant text + run stats from pi's JSON event stream."""
    final_output = ""
    model: str | None = None
    stop_reason: str | None = None
    error_message: str | None = None
    turns = 0
    tool_calls: dict[str, int] = {}

    for line in stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(event, dict):
            continue
        etype = event.get("type")
        if etype == "tool_execution_start":
            name = event.get("toolName")
            if isinstance(name, str):
                tool_calls[name] = tool_calls.get(name, 0) + 1
            continue
        if etype != "message_end":
            continue
        message = event.get("message")
        if not isinstance(message, dict) or not isinstance(message.get("role"), str):
            continue
        if message["role"] == "assistant":
            turns += 1
            if isinstance(message.get("model"), str):
                model = message["model"]
            if isinstance(message.get("stopReason"), str):
                stop_reason = message["stopReason"]
            if isinstance(message.get("errorMessage"), str):
                error_message = message["errorMessage"]
            text = text_from_content(message.get("content")).strip()
            if text:
                final_output = text

    return {
        "output": final_output,
        "model": model,
        "stop_reason": stop_reason,
        "error_message": error_message,
        "turns": turns,
        "tool_calls": tool_calls,
    }


def summarize_tool_calls(tool_calls: dict[str, int]) -> str:
    if not tool_calls:
        return "none"
    return ", ".join(f"{name} ×{count}" for name, count in tool_calls.items())


def run_readsubagent(arguments: dict[str, Any]) -> dict[str, Any]:
    cfg = config()
    question = arguments.get("question")
    if not isinstance(question, str) or not question.strip():
        return {
            "content": [
                {"type": "text", "text": "readsubagent requires a non-empty 'question'."}
            ],
            "isError": True,
        }

    requested_max = arguments.get("maxReportChars")
    report_max = cfg["report_max_chars"]
    if isinstance(requested_max, (int, float)) and requested_max >= 1:
        report_max = min(report_max, int(requested_max))

    paths = normalize_path_list(arguments.get("path"), arguments.get("paths"))
    symbols = normalize_string_list(arguments.get("symbols"))
    search_terms = normalize_string_list(arguments.get("searchTerms"))
    line_ranges = normalize_string_list(arguments.get("lineRanges"))
    output = arguments.get("output") if isinstance(arguments.get("output"), str) else None

    cwd = arguments.get("cwd")
    if not isinstance(cwd, str) or not cwd.strip():
        cwd = cfg["default_cwd"]
    if not os.path.isdir(cwd):
        cwd = os.getcwd()

    task = format_delegated_task(
        question.strip(), paths, symbols, search_terms, line_ranges, output, report_max
    )
    result = run_pi_child(cfg, task, cwd)

    report = truncate_text(result["output"].strip() or "(no output)", report_max)
    footer = "\n".join(
        [
            "",
            "---",
            f"_readsubagent {result['status']} · model {result['model']} · "
            f"{result['turns']} turn(s) · tools: {summarize_tool_calls(result['tool_calls'])}_",
        ]
    )
    return {
        "content": [{"type": "text", "text": report + "\n" + footer}],
        "isError": result["status"] not in ("completed",),
    }


# --- MCP tool descriptor ----------------------------------------------------

TOOL_DESCRIPTOR = {
    "name": "readsubagent",
    "description": (
        "Read-only codebase scout running on a LOCAL model (Qwen via LM Studio, "
        "through a headless pi child). Ask it targeted factual questions about "
        "files when you need an answer, summary, symbol location, descriptive "
        "API/flow map, or exact line ranges rather than raw file contents in "
        "your context. It inspects files read-only and returns a concise, cited "
        "report. Do NOT use it for code review, bug finding, correctness/"
        "type-safety judgments, edit strategies, or implementation planning. "
        "The local model can be slow — allow a long timeout and wait."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": (
                    "Targeted factual question for the child file-inspection "
                    "agent: what to find, summarize, compare, extract, or "
                    "explain from file contents. Do not ask it to judge "
                    "correctness or review code."
                ),
            },
            "path": {
                "type": "string",
                "description": "Single repo-relative path to inspect.",
            },
            "paths": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Repo-relative file or directory paths to inspect, ordered "
                    "by relevance."
                ),
            },
            "symbols": {
                "type": "array",
                "items": {"type": "string"},
                "description": (
                    "Specific functions, classes, types, config keys, or other "
                    "symbols to inspect."
                ),
            },
            "searchTerms": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Focused search terms or regexes to use before reading.",
            },
            "lineRanges": {
                "type": "array",
                "items": {"type": "string"},
                "description": "Specific repo-relative line ranges, e.g. src/file.ts:120-180.",
            },
            "output": {
                "type": "string",
                "description": (
                    "Desired report shape and level of detail, e.g. concise "
                    "answer, exact oldText block, or API summary."
                ),
            },
            "maxReportChars": {
                "type": "number",
                "description": (
                    "Optional maximum characters to return. Clamped to the "
                    "configured report budget."
                ),
            },
            "cwd": {
                "type": "string",
                "description": (
                    "Optional working directory for the child process. Defaults "
                    "to the Claude project directory."
                ),
            },
        },
        "required": ["question"],
    },
}


# --- JSON-RPC / MCP transport ----------------------------------------------


def send_message(message: dict[str, Any], framed: bool = False) -> None:
    payload = json.dumps(message).encode("utf-8")
    if framed:
        sys.stdout.buffer.write(f"Content-Length: {len(payload)}\r\n\r\n".encode("ascii"))
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()
        return
    sys.stdout.write(payload.decode("utf-8") + "\n")
    sys.stdout.flush()


def make_result(request_id: Any, result: dict[str, Any]) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def make_error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}


def handle_request(request: dict[str, Any]) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    is_notification = "id" not in request

    if method == "initialize":
        params = request.get("params") or {}
        client_version = params.get("protocolVersion")
        protocol_version = (
            client_version
            if isinstance(client_version, str) and client_version.strip()
            else DEFAULT_PROTOCOL_VERSION
        )
        return make_result(
            request_id,
            {
                "protocolVersion": protocol_version,
                "capabilities": {"tools": {"listChanged": False}},
                "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
            },
        )

    if method in ("notifications/initialized", "initialized"):
        return None

    if method == "ping":
        return make_result(request_id, {})

    if method == "tools/list":
        return make_result(request_id, {"tools": [TOOL_DESCRIPTOR]})

    if method == "tools/call":
        params = request.get("params") or {}
        name = params.get("name")
        arguments = params.get("arguments") or {}
        if name != "readsubagent":
            return make_error(request_id, -32602, f"Unknown tool: {name}")
        try:
            result = run_readsubagent(arguments)
        except Exception as exc:  # noqa: BLE001 - surface any failure as a tool error
            log(f"tools/call failed: {exc!r}")
            result = {
                "content": [{"type": "text", "text": f"readsubagent error: {exc}"}],
                "isError": True,
            }
        return make_result(request_id, result)

    if is_notification:
        return None
    return make_error(request_id, -32601, f"Method not found: {method}")


def read_framed_body(first_header_line: bytes) -> bytes | None:
    headers = [first_header_line]
    while True:
        line = sys.stdin.buffer.readline()
        if line in (b"", b"\r\n", b"\n"):
            break
        headers.append(line)

    content_length: int | None = None
    for raw_header in headers:
        name, separator, value = raw_header.decode("ascii", "replace").partition(":")
        if separator and name.lower() == "content-length":
            try:
                content_length = int(value.strip())
            except ValueError:
                return None
            break

    if content_length is None or content_length < 0:
        return None
    return sys.stdin.buffer.read(content_length)


def iter_input_messages() -> Any:
    while True:
        first = sys.stdin.buffer.readline()
        if not first:
            break
        if not first.strip():
            continue
        if first.lower().startswith(b"content-length:"):
            body = read_framed_body(first)
            if body is None:
                yield None, True
            else:
                yield body.decode("utf-8", "replace"), True
            continue
        yield first.decode("utf-8", "replace").strip(), False


def main() -> int:
    log(f"starting {SERVER_NAME} v{SERVER_VERSION}")
    for line, framed in iter_input_messages():
        try:
            message = json.loads(line)
        except (TypeError, json.JSONDecodeError):
            send_message(make_error(None, -32700, "Parse error"), framed=framed)
            continue

        messages = message if isinstance(message, list) else [message]
        for item in messages:
            if not isinstance(item, dict):
                continue
            response = handle_request(item)
            if response is not None:
                send_message(response, framed=framed)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
