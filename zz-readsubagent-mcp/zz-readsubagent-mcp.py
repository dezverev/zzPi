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
       --exclude-tools readsubagent \
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
import math
import os
import re
import subprocess
import sys
from typing import Any

SERVER_NAME = "zz_readsubagent"
SERVER_VERSION = "1.2.1"
DEFAULT_PROTOCOL_VERSION = "2025-11-25"
SUPPORTED_PROTOCOL_VERSIONS = frozenset(
    {DEFAULT_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"}
)

# --- Defaults (overridable via environment) ---------------------------------

DEFAULT_MODEL = "lm-studio/qwen/qwen3.6-35b-a3b"
DEFAULT_PI_BIN = "pi"
DEFAULT_THINKING = "off"
DEFAULT_TOOLS = "read,grep,find,ls"
DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
DEFAULT_REPORT_MAX_CHARS = 16_000
EXCLUDED_CHILD_TOOLS = "readsubagent"
PROHIBITED_REQUEST_MESSAGE = (
    "readsubagent refused this explicit debugging or diagnostic-artifact request "
    "before child launch. Inspect source and diagnostic evidence directly in the "
    "parent, or use a debugger for root-cause diagnosis."
)
DIRECT_DEBUG_COMMAND_RE = re.compile(
    r"\b(?:debug|diagnose|troubleshoot)\b(?!\s+(?:command|function|implementation|"
    r"option|flag|configuration|config|mode|logging|logger)\b)",
    re.IGNORECASE,
)
EXPLICIT_DEBUG_REQUEST_RE = re.compile(
    r"\b(?:debug|diagnos(?:e|ing)|troubleshoot|investigat(?:e|ing)|analy[sz]e|"
    r"examine|inspect|review|look\s+(?:into|over)|figure\s+out|fix|find|identify|"
    r"help\s+me\s+(?:find|understand)|tell\s+me|what\s+caused|"
    r"what\s+went\s+wrong|why)\b.{0,120}\b(?:bug|fail(?:s|ed|ing|ure)?|"
    r"error|regression|flaky[-\s]+test|incident|crash(?:es|ed|ing)?|timeouts?|"
    r"timed\s+out|logs?|stack\s+traces?|failure\s+output|"
    r"unexpected[-\s]+runtime(?:\s+behavior)?)\b",
    re.IGNORECASE | re.DOTALL | re.MULTILINE,
)
STRONG_DEBUG_REQUEST_RE = re.compile(
    r"\b(?:debug|diagnos(?:e|ing)|troubleshoot|investigat(?:e|ing)|look\s+(?:into|over)|"
    r"figure\s+out|fix|find|identify|what\s+caused|what\s+went\s+wrong|why)\b"
    r".{0,120}\b(?:bug|fail(?:s|ed|ing)?|error|crash(?:es|ed|ing)?|timeouts?|"
    r"timed\s+out|root[-\s]+cause)\b",
    re.IGNORECASE | re.DOTALL | re.MULTILINE,
)
DIAGNOSTIC_ARTIFACT_RE = re.compile(
    r"\b(?:logs|log\s+(?:file|output|excerpt|entries)|stack\s+traces?|"
    r"crash\s+reports?|core\s+dumps?|test\s+failure\s+output|failure\s+output|"
    r"execution\s+traces?|profiler\s+output|runtime\s+captures?|"
    r"diagnostic\s+screenshots?)\b|\b\S+\.log\b",
    re.IGNORECASE,
)
CONCRETE_DIAGNOSTIC_EVIDENCE_RE = re.compile(
    r"(?:^|[\s\"'(])(?:[A-Za-z]:\\)?(?:[\w.-]+[\\/])*[\w-][\w.-]*\.log(?:$|[\s\"')])|"
    r"\b(?:this|these|attached)\s+(?:logs?|stack\s+traces?|failure\s+output|"
    r"crash\s+reports?)\b|\b(?:logs?|log\s+output|stack\s+traces?|"
    r"failure\s+output)\s+from\s+(?:runtime|production|staging|the\s+server|"
    r"the\s+request|the\s+test\s+run)\b",
    re.IGNORECASE | re.DOTALL | re.MULTILINE,
)
ORDINARY_TOOLING_TOPIC_RE = re.compile(
    r"(?:\b(?:stack\s+traces?|logs?|log\s+output|failures?)|\.log\s+files?)\s+"
    r"(?:parser|parsing|format(?:ter|ting)?|configuration|config|option|schema|"
    r"extension(?:\s+handling)?|implementation|handler|handling|type|class|"
    r"module)\b|\b(?:parses?|handles?|formats?|configures?|implements?)\s+"
    r"(?:stack\s+traces?|logs?|log\s+output|\.log\s+files?|failures?)\b",
    re.IGNORECASE,
)
DIAGNOSTIC_INSPECTION_RE = re.compile(
    r"\b(?:debug|diagnos(?:e|ing)|troubleshoot|investigat(?:e|ing)|inspect|"
    r"examine|analy[sz]e|summari[sz]e|review|read|explain|interpret|extract|"
    r"check|scan|parse|look\s+at|tell\s+me|what\s+(?:does|is|happened)|why)\b",
    re.IGNORECASE,
)

# Ported verbatim from DEFAULT_READSUBAGENT_CONFIG.systemPrompt in
# clients/pi-plugs/extensions/readsubagent.ts so the child behaves identically.
DEFAULT_SYSTEM_PROMPT = (
    "You are a read-only, non-debug codebase scout and read-planning subagent. "
    "Evaluate task context first. Refuse every request involving debugging, "
    "failure diagnosis, regression or flaky-test investigation, incident "
    "response, or unexpected-runtime investigation. Never inspect or analyze "
    "logs, stack traces, crash reports, core dumps, test failure output, traces, "
    "profiler output, runtime captures, diagnostic screenshots, or similar "
    "diagnostic artifacts. Direct the parent to inspect source, config, "
    "documentation, and diagnostic evidence directly or use a debugger; do not "
    "provide partial diagnostic analysis, scout the debug path, suggest "
    "diagnostic evidence, or gather root-cause evidence. Outside debugging, "
    "inspect only requested repo-relative paths and nearby supporting files. "
    "Prefer a short subsystem map, candidate files, search/symbol/line anchors, "
    "the smallest focused read list, avoid-for-now areas, and explicit "
    "uncertainty. Focused factual answers about ordinary code, config, "
    "documentation, and how-to material remain supported. Do not edit or write "
    "files. Do not create implementation plans, solution proposals, edit "
    "strategies, code-review judgments, bug findings, correctness assessments, "
    "control-flow/type-safety analysis, design advice, or accept/reject "
    "recommendations. Start with the answer or read plan, then cite "
    "repo-relative paths and line numbers. Keep snippets short, never dump whole "
    "files or raw tool output, and ask for a narrower non-debug question when "
    "the request is too broad."
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
            "First evaluate task context. You are only a non-debug codebase "
            "scout/read planner and focused factual file-inspection agent.",
            "Refuse debugging, failure diagnosis, regression or flaky-test "
            "investigation, incident response, and unexpected-runtime "
            "investigation. Never inspect logs, stack traces, crash reports, "
            "core dumps, test failure output, traces, profiler output, runtime "
            "captures, diagnostic screenshots, or similar artifacts. Tell the "
            "parent to inspect them directly or use a debugger, and do not "
            "provide partial diagnostic analysis.",
            "For allowed non-debug work, use read/search tools without modifying "
            "files. Treat target paths, symbols, search terms, and line ranges "
            "as scope. Prefer a short subsystem map, focused read list, anchors, "
            "avoid-for-now areas, and uncertainty; focused factual answers about "
            "ordinary code, config, and documentation remain supported.",
            "Use grep or focused reads so you can cite repo-relative paths and "
            "line numbers. Avoid broad repo-wide searches unless needed to "
            "produce a bounded read plan.",
            "Return the smallest useful report. Do not create implementation "
            "plans, solution proposals, edit strategies, code-review judgments, "
            "bug findings, correctness assessments, control-flow/type-safety "
            "analysis, design advice, or accept/reject recommendations. If the "
            "request crosses the boundary, refuse it rather than returning "
            "partial evidence. If an allowed question is underspecified, state "
            "the narrow non-debug follow-up needed.",
            f"Delegated file-inspection task:\n{task}",
        ]
    )


def truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    marker = f"[… {len(text) - max_chars} characters omitted …]"
    if max_chars <= len(marker) + 2:
        return text[:max_chars]
    available = max_chars - len(marker) - 2
    head_chars = max(1, int(available * 0.65))
    tail_chars = max(0, available - head_chars)
    return f"{text[:head_chars]}\n{marker}\n{text[-tail_chars:] if tail_chars else ''}"


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
        if isinstance(exc.stdout, bytes):
            partial = exc.stdout.decode("utf-8", "replace")
        else:
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
        and parsed["turns"] > 0
        and bool(parsed["output"])
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


def is_prohibited_readsubagent_request(arguments: dict[str, Any]) -> bool:
    parts: list[str] = []
    for name in ("question", "path", "paths", "symbols", "searchTerms", "lineRanges", "output"):
        value = arguments.get(name)
        if isinstance(value, str):
            parts.append(value)
        elif isinstance(value, list):
            parts.extend(item for item in value if isinstance(item, str))
    text = "\n".join(parts)
    if DIRECT_DEBUG_COMMAND_RE.search(text):
        return True
    if CONCRETE_DIAGNOSTIC_EVIDENCE_RE.search(text):
        return True
    if EXPLICIT_DEBUG_REQUEST_RE.search(text):
        if ORDINARY_TOOLING_TOPIC_RE.search(text) and not STRONG_DEBUG_REQUEST_RE.search(text):
            return False
        return True
    if not (
        DIAGNOSTIC_ARTIFACT_RE.search(text) and DIAGNOSTIC_INSPECTION_RE.search(text)
    ):
        return False
    return not bool(ORDINARY_TOOLING_TOPIC_RE.search(text))


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

    if is_prohibited_readsubagent_request(arguments):
        return {
            "content": [
                {"type": "text", "text": truncate_text(PROHIBITED_REQUEST_MESSAGE, report_max)}
            ],
            "isError": True,
        }

    paths = normalize_path_list(arguments.get("path"), arguments.get("paths"))
    symbols = normalize_string_list(arguments.get("symbols"))
    search_terms = normalize_string_list(arguments.get("searchTerms"))
    line_ranges = normalize_string_list(arguments.get("lineRanges"))
    output = arguments.get("output") if isinstance(arguments.get("output"), str) else None

    requested_cwd = arguments.get("cwd")
    if isinstance(requested_cwd, str) and requested_cwd.strip():
        cwd = requested_cwd
        if not os.path.isdir(cwd):
            return {
                "content": [
                    {
                        "type": "text",
                        "text": truncate_text(
                            "invalid 'cwd': readsubagent expected an existing "
                            f"directory, got {cwd!r}.",
                            report_max,
                        ),
                    }
                ],
                "isError": True,
            }
    else:
        cwd = cfg["default_cwd"]
        if not os.path.isdir(cwd):
            cwd = os.getcwd()

    task = format_delegated_task(
        question.strip(), paths, symbols, search_terms, line_ranges, output, report_max
    )
    result = run_pi_child(cfg, task, cwd)

    report = result["output"].strip() or "(no output)"
    footer = "\n".join(
        [
            "",
            "---",
            f"_readsubagent {result['status']} · model {result['model']} · "
            f"{result['turns']} turn(s) · tools: {summarize_tool_calls(result['tool_calls'])}_",
        ]
    )
    response_text = truncate_text(report + "\n" + footer, report_max)
    return {
        "content": [{"type": "text", "text": response_text}],
        "isError": result["status"] != "completed",
    }


# --- MCP tool descriptor ----------------------------------------------------

TOOL_DESCRIPTOR = {
    "name": "readsubagent",
    "description": (
        "Read-only, non-debug codebase scout and read planner running on a LOCAL "
        "model (Qwen via LM Studio, through a headless pi child). Use it first "
        "for a bounded subsystem map, candidate files, anchors, focused read "
        "list, avoid-for-now areas, and uncertainty, or for focused factual "
        "answers about ordinary code, config, and documentation. Never use it "
        "for debugging, failure diagnosis, incidents, regressions, flaky tests, "
        "unexpected runtime behavior, logs, stack traces, crash reports, core "
        "dumps, test failure output, traces, profiler output, runtime captures, "
        "diagnostic screenshots, or similar artifacts. Inspect those directly "
        "or use a debugger. Do NOT use it for review, bug finding, correctness/"
        "type-safety judgments, design, edit strategies, or implementation "
        "planning. The local model can be slow — allow a long timeout and wait."
    ),
    "annotations": {
        "title": "Read Subagent",
        "readOnlyHint": True,
        "destructiveHint": False,
        "idempotentHint": True,
        "openWorldHint": False,
    },
    "inputSchema": {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": (
                    "Non-debug scouting/read-planning or focused factual "
                    "question about ordinary code, config, or documentation. "
                    "Never include debugging work or diagnostic artifacts; do "
                    "not ask for judgment, diagnosis, or review."
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
                    "Desired report shape, preferably a subsystem map, focused "
                    "read list, anchors, avoid-for-now areas, and uncertainty, "
                    "or a concise non-debug factual answer."
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


def send_message(message: Any, framed: bool = False) -> None:
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


def invalid_params(request_id: Any, message: str = "params must be an object") -> dict[str, Any]:
    return make_error(request_id, -32602, message)


def handle_request(request: dict[str, Any]) -> dict[str, Any] | None:
    request_id = request.get("id")
    is_notification = "id" not in request
    valid_id = (
        request_id is None
        or isinstance(request_id, str)
        or (
            isinstance(request_id, (int, float))
            and not isinstance(request_id, bool)
            and (not isinstance(request_id, float) or math.isfinite(request_id))
        )
    )
    if (
        request.get("jsonrpc") != "2.0"
        or not isinstance(request.get("method"), str)
        or (not is_notification and not valid_id)
    ):
        return make_error(request_id if valid_id else None, -32600, "Invalid Request")

    method = request["method"]
    params = request.get("params", {})
    if params is None:
        params = {}
    if not isinstance(params, dict):
        return None if is_notification else invalid_params(request_id)

    # JSON-RPC notifications never receive responses. MCP currently defines no
    # notification here that requires server-side state beyond initialization.
    if is_notification:
        return None

    if method == "initialize":
        client_version = params.get("protocolVersion")
        if not isinstance(client_version, str) or not client_version:
            return invalid_params(request_id, "initialize protocolVersion must be a non-empty string")
        protocol_version = (
            client_version
            if isinstance(client_version, str)
            and client_version in SUPPORTED_PROTOCOL_VERSIONS
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

    if method == "ping":
        return make_result(request_id, {})

    if method == "tools/list":
        return make_result(request_id, {"tools": [TOOL_DESCRIPTOR]})

    if method == "tools/call":
        name = params.get("name")
        arguments = params.get("arguments", {})
        if name != "readsubagent":
            return invalid_params(request_id, f"Unknown tool: {name}")
        if not isinstance(arguments, dict):
            return invalid_params(request_id, "tools/call arguments must be an object")
        try:
            result = run_readsubagent(arguments)
        except Exception as exc:  # noqa: BLE001 - surface any failure as a tool error
            log(f"tools/call failed: {exc!r}")
            result = {
                "content": [{"type": "text", "text": f"readsubagent error: {exc}"}],
                "isError": True,
            }
        return make_result(request_id, result)

    return make_error(request_id, -32601, f"Method not found: {method}")


def process_message(message: Any) -> Any | None:
    if isinstance(message, list):
        if not message:
            return make_error(None, -32600, "Invalid Request")
        responses = [
            make_error(None, -32600, "Invalid Request")
            if not isinstance(item, dict)
            else handle_request(item)
            for item in message
        ]
        filtered = [response for response in responses if response is not None]
        return filtered or None
    if not isinstance(message, dict):
        return make_error(None, -32600, "Invalid Request")
    return handle_request(message)


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

        response = process_message(message)
        if response is not None:
            send_message(response, framed=framed)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
