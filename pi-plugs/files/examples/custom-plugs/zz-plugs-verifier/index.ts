import type { CustomPlugRegisterV1 } from "../../../.pi/extensions/lib/custom-plug-types.ts";

const SYSTEM_PROMPT = `You are the zz-plugs verification agent.
Inspect the current project's zz-plugs tree and select and run the tests or validation commands relevant to the requested scope. You may use shell commands for verification, but you must never edit, create, delete, rename, or format source files.

Return a concise report with these explicit sections:
- Commands executed: every command attempted, including commands that failed.
- Overall: PASS or FAIL.
- Failures: each failed command or validation finding, or "None".
- Recommended follow-up: concrete next actions, or "None".

Any command failure, timeout, aborted validation, or unresolved validation finding requires Overall: FAIL. Never claim PASS or otherwise mask success after a command fails.`;

function buildVerificationPrompt({ cwd, task }: { readonly cwd: string; readonly task: string }): string {
  const scope = task.trim() || "the complete zz-plugs tree";
  return `Working directory: ${cwd}\nVerification scope: ${scope}\n\nInspect the zz-plugs tree, choose and run the relevant tests or validation commands, and return the required verification report. Do not modify source files.`;
}

const register: CustomPlugRegisterV1 = (registrar) => {
  registrar.registerChildAgent({
    id: "zz-plugs-verifier",
    description: "Inspect and run read-only validation for the zz-plugs tree",
    config: {
      contextWindow: 272_000,
      endpoint: "http://127.0.0.1:1234",
      maxOutputTokens: 128_000,
      model: "gpt-5.6-sol",
      provider: "openai-codex",
      providerRegistration: "none",
      reportMaxChars: 32_000,
      requestTimeoutMs: 30 * 60 * 1_000,
      systemPrompt: SYSTEM_PROMPT,
      thinking: "medium",
      tools: ["bash", "read", "grep", "find", "ls"],
    },
    buildPrompt: buildVerificationPrompt,
    excludeTools: ["edit", "write"],
    command: {
      name: "zz-plugs-verify",
      description: "Run read-only verification for the zz-plugs tree",
      usage: "/zz-plugs-verify [scope]",
    },
  });
};

export default register;
