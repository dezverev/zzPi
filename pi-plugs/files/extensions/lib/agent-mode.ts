import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

interface AgentModeState {
  readonly enabled: boolean;
}

export interface AgentModeController {
  readonly applyStatus: (ctx: ExtensionContext) => void;
  readonly clearStatus: (ctx: ExtensionContext) => void;
  readonly handleAction: (action: string, ctx: ExtensionContext) => boolean;
  readonly isEnabled: () => boolean;
  readonly restore: (ctx: ExtensionContext) => void;
  readonly setEnabled: (enabled: boolean, ctx: ExtensionContext) => void;
  readonly statusText: () => string;
  readonly toggle: (ctx: ExtensionContext) => void;
}

export function createAgentMode(pi: ExtensionAPI, options: {
  readonly id: string;
  readonly label: string;
  readonly stateEntryType?: string | undefined;
  readonly statusKey?: string | undefined;
  readonly tools: readonly string[];
  readonly enabledByDefault: () => boolean;
  readonly shortcut?: string | undefined;
  readonly onChange?: ((enabled: boolean) => void) | undefined;
}): AgentModeController {
  const stateEntryType = options.stateEntryType ?? `${options.id}-mode-state`;
  const statusKey = options.statusKey ?? `${options.id}-mode`;
  let enabled = options.enabledByDefault();

  function notifyChange(ctx: ExtensionContext): void {
    options.onChange?.(enabled);
    applyTools();
    applyStatus(ctx);
  }

  function applyTools(): void {
    const active = pi.getActiveTools();
    const next = new Set(active);
    for (const tool of options.tools) {
      if (enabled) next.add(tool);
      else next.delete(tool);
    }
    const updated = [...next];
    if (updated.length !== active.length || updated.some((tool, index) => tool !== active[index])) {
      pi.setActiveTools(updated);
    }
  }

  function applyStatus(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(statusKey, enabled ? `${options.label}: on` : undefined);
  }

  function clearStatus(ctx: ExtensionContext): void {
    if (ctx.hasUI) ctx.ui.setStatus(statusKey, undefined);
  }

  function savedEnabled(ctx: ExtensionContext): boolean | undefined {
    let saved: boolean | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== stateEntryType) continue;
      if (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
      const value = (entry.data as Record<string, unknown>).enabled;
      if (typeof value === "boolean") saved = value;
    }
    return saved;
  }

  function persist(): void {
    pi.appendEntry<AgentModeState>(stateEntryType, { enabled });
  }

  const controller: AgentModeController = {
    applyStatus,
    clearStatus,
    handleAction(action, ctx) {
      const normalized = action.trim().toLowerCase();
      if (normalized === "on" || normalized === "off") {
        controller.setEnabled(normalized === "on", ctx);
        ctx.ui.notify(`${options.label} mode ${normalized}`, "info");
        return true;
      }
      if (normalized === "toggle") {
        controller.toggle(ctx);
        ctx.ui.notify(controller.statusText(), "info");
        return true;
      }
      if (normalized === "status") {
        controller.applyStatus(ctx);
        ctx.ui.notify(controller.statusText(), "info");
        return true;
      }
      return false;
    },
    isEnabled: () => enabled,
    restore(ctx) {
      enabled = savedEnabled(ctx) ?? options.enabledByDefault();
      notifyChange(ctx);
    },
    setEnabled(nextEnabled, ctx) {
      enabled = nextEnabled;
      persist();
      notifyChange(ctx);
    },
    statusText: () => `${options.label} mode: ${enabled ? "on" : "off"}`,
    toggle(ctx) {
      controller.setEnabled(!enabled, ctx);
    },
  };

  if (options.shortcut) {
    pi.registerShortcut(options.shortcut, {
      description: `Toggle ${options.label} mode`,
      handler: async (ctx) => {
        controller.toggle(ctx);
        ctx.ui.notify(controller.statusText(), "info");
      },
    });
  }

  return controller;
}
