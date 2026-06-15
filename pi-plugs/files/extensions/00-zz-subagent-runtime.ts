import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Internal marker extension for the shared child-Pi subagent runtime.
 *
 * Installing this plug places the pi-plugs model-option helper/config under:
 * - .pi/extensions/lib/child-agent-model-options.ts
 * - .pi/extensions/local-model-endpoints.config.jsonc
 *
 * The shared child-Pi agent and JSONC helpers come from zz-lib under:
 * - .pi/extensions/zz-lib/child-pi-agent.ts
 * - .pi/extensions/zz-lib/jsonc-config.ts
 *
 * Repo-local custom subagent extensions can then import:
 *
 *   import { runChildPiAgent } from "./zz-lib/child-pi-agent.ts";
 *   import { readChildAgentModelOptions } from "./lib/child-agent-model-options.ts";
 */
export default function zzSubagentRuntime(_pi: ExtensionAPI): void {
  // No commands/tools are registered here; this plug is dependency plumbing.
}
