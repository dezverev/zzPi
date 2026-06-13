import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Internal marker extension for the shared child-Pi subagent runtime.
 *
 * Installing this plug places the reusable helpers/config under:
 * - .pi/extensions/lib/child-agent-model-options.ts
 * - .pi/extensions/lib/child-pi-agent.ts
 * - .pi/extensions/lib/jsonc-config.ts
 * - .pi/extensions/local-model-endpoints.config.jsonc
 *
 * Repo-local custom subagent extensions can then import:
 *
 *   import { runChildPiAgent } from "./lib/child-pi-agent.ts";
 *   import { readChildAgentModelOptions } from "./lib/child-agent-model-options.ts";
 */
export default function zzSubagentRuntime(_pi: ExtensionAPI): void {
  // No commands/tools are registered here; this plug is dependency plumbing.
}
