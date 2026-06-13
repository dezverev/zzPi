import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  getPositiveIntegerField,
  getStringField,
  getPercentField,
  readJsoncConfig,
  type ConfigObject,
} from "./jsonc-config.ts";

const REGISTER_EVENT = "right-overlay-tiler:register";
const UNREGISTER_EVENT = "right-overlay-tiler:unregister";
const VISIBILITY_EVENT = "right-overlay-tiler:visibility";
const FOCUS_PANE_EVENT = "right-overlay-tiler:focus-pane";
const SCROLL_TO_BOTTOM_EVENT = "right-overlay-tiler:scroll-bottom";
const RENDER_REQUEST_EVENT = "right-overlay-tiler:render-request";
const QUERY_EVENT = "right-overlay-tiler:query";

const CONFIG_FILE_PATH = ".pi/extensions/right-overlay-tiler.config.jsonc";

interface RightOverlayTilerConfig {
  readonly defaultPaneMinWidth: number;
  readonly focusShortcut: string;
  readonly focusShortcutDebounceMs: number;
  readonly focusShortcutLetter: string;
  readonly focusStatusKey: string;
  readonly mainTileGap: number;
  readonly minMainTileWidth: number;
  readonly minTerminalWidth: number;
  readonly overlayMarginBottom: number;
  readonly overlayMarginTop: number;
  readonly overlayMaxHeightPercent: number;
  readonly overlayWidthPercent: number;
  readonly scrollRepeatIdleStopMs: number;
  readonly scrollRepeatInitialDelayMs: number;
  readonly scrollRepeatIntervalMs: number;
}

const DEFAULT_CONFIG: RightOverlayTilerConfig = {
  defaultPaneMinWidth: 52,
  focusShortcut: "alt+o",
  focusShortcutDebounceMs: 300,
  focusShortcutLetter: "o",
  focusStatusKey: "right-overlay-focus",
  mainTileGap: 1,
  minMainTileWidth: 1,
  minTerminalWidth: 72,
  overlayMarginBottom: 1,
  overlayMarginTop: 1,
  overlayMaxHeightPercent: 90,
  overlayWidthPercent: 36,
  scrollRepeatIdleStopMs: 500,
  scrollRepeatInitialDelayMs: 220,
  scrollRepeatIntervalMs: 35,
};

let currentConfig: RightOverlayTilerConfig = { ...DEFAULT_CONFIG };
const FOCUS_ACTIONS = ["focus", "blur", "toggle", "next", "previous", "top", "bottom"] as const;

type FocusAction = (typeof FOCUS_ACTIONS)[number];

export interface RightOverlayRenderState {
  readonly focused: boolean;
  readonly scrollOffset: number;
}

export interface RightOverlayPaneInputContext {
  readonly paneId: string;
  readonly focused: boolean;
  requestRender(): void;
  focusNextPane(): void;
  focusPreviousPane(): void;
  blur(): void;
  scrollBy(lines: number): void;
  scrollToTop(): void;
  scrollToBottom(): void;
}

export type RightOverlayRender = (width: number, state: RightOverlayRenderState) => string[];
export type RightOverlayPaneInput = (
  data: string,
  context: RightOverlayPaneInputContext,
) => boolean | void;

export interface RightOverlayPaneConfig {
  readonly id: string;
  readonly order: number;
  readonly minWidth?: number;
  readonly focusable?: boolean;
  readonly stickyBottomLines?: number;
  readonly render: RightOverlayRender;
  readonly handleInput?: RightOverlayPaneInput;
  readonly onFocus?: () => void;
  readonly onBlur?: () => void;
  readonly visibleWhen?: (termWidth: number, termHeight: number) => boolean;
}

interface RightOverlayPaneRecord extends RightOverlayPaneConfig {
  visible: boolean;
  scrollOffset: number;
}

interface OverlayHandle {
  hide(): void;
  setHidden(hidden: boolean): void;
}

interface TileableTui {
  terminal: {
    rows: number;
  };
  render(width: number): string[];
  requestRender(force?: boolean): void;
}

interface MainTilePatch {
  readonly tui: TileableTui;
  readonly originalRender: TileableTui["render"];
  readonly patchedRender: TileableTui["render"];
}

interface KeybindingsMatcher {
  matches(data: string, keybinding: string): boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getConfigString(record: ConfigObject, field: string, fallback: string): string {
  const value = getStringField(record, field);
  if (value === undefined) return fallback;
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${field} cannot be empty.`);
  return trimmed;
}

function loadRightOverlayTilerConfig(cwd: string, onError?: (message: string) => void): void {
  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, cwd);
    if (!record) {
      currentConfig = { ...DEFAULT_CONFIG };
      return;
    }

    currentConfig = {
      defaultPaneMinWidth:
        getPositiveIntegerField(record, "defaultPaneMinWidth") ??
        DEFAULT_CONFIG.defaultPaneMinWidth,
      focusShortcut: getConfigString(record, "focusShortcut", DEFAULT_CONFIG.focusShortcut),
      focusShortcutDebounceMs:
        getPositiveIntegerField(record, "focusShortcutDebounceMs") ??
        DEFAULT_CONFIG.focusShortcutDebounceMs,
      focusShortcutLetter: getConfigString(
        record,
        "focusShortcutLetter",
        DEFAULT_CONFIG.focusShortcutLetter,
      ),
      focusStatusKey: getConfigString(record, "focusStatusKey", DEFAULT_CONFIG.focusStatusKey),
      mainTileGap: getPositiveIntegerField(record, "mainTileGap") ?? DEFAULT_CONFIG.mainTileGap,
      minMainTileWidth:
        getPositiveIntegerField(record, "minMainTileWidth") ?? DEFAULT_CONFIG.minMainTileWidth,
      minTerminalWidth:
        getPositiveIntegerField(record, "minTerminalWidth") ?? DEFAULT_CONFIG.minTerminalWidth,
      overlayMarginBottom:
        getPositiveIntegerField(record, "overlayMarginBottom") ??
        DEFAULT_CONFIG.overlayMarginBottom,
      overlayMarginTop:
        getPositiveIntegerField(record, "overlayMarginTop") ?? DEFAULT_CONFIG.overlayMarginTop,
      overlayMaxHeightPercent:
        getPercentField(record, "overlayMaxHeightPercent") ??
        DEFAULT_CONFIG.overlayMaxHeightPercent,
      overlayWidthPercent:
        getPercentField(record, "overlayWidthPercent") ?? DEFAULT_CONFIG.overlayWidthPercent,
      scrollRepeatIdleStopMs:
        getPositiveIntegerField(record, "scrollRepeatIdleStopMs") ??
        DEFAULT_CONFIG.scrollRepeatIdleStopMs,
      scrollRepeatInitialDelayMs:
        getPositiveIntegerField(record, "scrollRepeatInitialDelayMs") ??
        DEFAULT_CONFIG.scrollRepeatInitialDelayMs,
      scrollRepeatIntervalMs:
        getPositiveIntegerField(record, "scrollRepeatIntervalMs") ??
        DEFAULT_CONFIG.scrollRepeatIntervalMs,
    };
  } catch (error) {
    currentConfig = { ...DEFAULT_CONFIG };
    onError?.(
      `right-overlay-tiler config ignored: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isKeybindingsMatcher(value: unknown): value is KeybindingsMatcher {
  return isRecord(value) && typeof value.matches === "function";
}

function toPaneConfig(value: unknown): RightOverlayPaneConfig | undefined {
  if (!isRecord(value)) return undefined;

  const id = typeof value.id === "string" ? value.id : undefined;
  const order =
    typeof value.order === "number" && Number.isFinite(value.order) ? value.order : undefined;
  const render =
    typeof value.render === "function" ? (value.render as RightOverlayRender) : undefined;
  if (!id || order === undefined || !render) return undefined;

  const config: RightOverlayPaneConfig = {
    id,
    order,
    render,
  };

  if (typeof value.minWidth === "number" && Number.isFinite(value.minWidth)) {
    Object.assign(config, { minWidth: Math.max(1, Math.floor(value.minWidth)) });
  }

  if (typeof value.focusable === "boolean") {
    Object.assign(config, { focusable: value.focusable });
  }

  if (typeof value.stickyBottomLines === "number" && Number.isFinite(value.stickyBottomLines)) {
    Object.assign(config, {
      stickyBottomLines: Math.max(1, Math.floor(value.stickyBottomLines)),
    });
  }

  if (typeof value.handleInput === "function") {
    Object.assign(config, { handleInput: value.handleInput as RightOverlayPaneInput });
  }

  if (typeof value.onFocus === "function") {
    Object.assign(config, { onFocus: value.onFocus as () => void });
  }

  if (typeof value.onBlur === "function") {
    Object.assign(config, { onBlur: value.onBlur as () => void });
  }

  if (typeof value.visibleWhen === "function") {
    Object.assign(config, {
      visibleWhen: value.visibleWhen as (termWidth: number, termHeight: number) => boolean,
    });
  }

  return config;
}

function toId(value: unknown): string | undefined {
  return isRecord(value) && typeof value.id === "string" ? value.id : undefined;
}

function toVisibility(value: unknown): { id: string; visible: boolean } | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.visible !== "boolean") {
    return undefined;
  }

  return { id: value.id, visible: value.visible };
}

function parseFocusAction(args: string): FocusAction | undefined {
  const action = args.trim().toLowerCase() || "focus";
  return FOCUS_ACTIONS.includes(action as FocusAction) ? (action as FocusAction) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function matchesRawAltLetter(data: string, letter: string): boolean {
  const lowerCodepoint = letter.toLowerCase().charCodeAt(0);
  const upperCodepoint = letter.toUpperCase().charCodeAt(0);

  if (data === `\x1b${letter.toLowerCase()}` || data === `\x1b${letter.toUpperCase()}`) {
    return true;
  }

  const kittyMatch = data.startsWith("\x1b[")
    ? data.slice(2).match(/^(\d+)(?::\d*)?(?::\d+)?(?:;(\d+))?(?::\d+)?u$/)
    : null;
  if (kittyMatch) {
    const codepoint = Number(kittyMatch[1]);
    const modifier = Number(kittyMatch[2] ?? 1) - 1;
    return (codepoint === lowerCodepoint || codepoint === upperCodepoint) && (modifier & 2) !== 0;
  }

  const modifyOtherKeysMatch = data.startsWith("\x1b[")
    ? data.slice(2).match(/^27;(\d+);(\d+)~$/)
    : null;
  if (modifyOtherKeysMatch) {
    const modifier = Number(modifyOtherKeysMatch[1]) - 1;
    const codepoint = Number(modifyOtherKeysMatch[2]);
    return (codepoint === lowerCodepoint || codepoint === upperCodepoint) && (modifier & 2) !== 0;
  }

  return false;
}

function isRawEscape(data: string): boolean {
  return data === "\x1b";
}

function isRawCtrlC(data: string): boolean {
  return data === "\x03";
}

function keyEventType(data: string): number | undefined {
  const match = data.match(/:([123])(?=(?:u|~|[A-DFH])$)/u);
  return match?.[1] ? Number(match[1]) : undefined;
}

function isKeyReleaseOrRepeat(data: string): boolean {
  const type = keyEventType(data);
  return type === 2 || type === 3;
}

function isKeyRelease(data: string): boolean {
  return keyEventType(data) === 3;
}

function stripKeyEventType(data: string): string {
  return data.replace(/:[123](?=(?:u|~|[A-DFH])$)/u, "");
}

class RightOverlayTilerHost {
  private readonly panes = new Map<string, RightOverlayPaneRecord>();
  private readonly unsubscribers: Array<() => void> = [];
  private readonly paneViewportHeights = new Map<string, number>();
  private handle: OverlayHandle | undefined;
  private mainTilePatch: MainTilePatch | undefined;
  private keybindings: KeybindingsMatcher | undefined;
  private terminalInputUnsubscriber: (() => void) | undefined;
  private requestRender: (() => void) | undefined;
  private hidden = true;
  private overlayFocused = false;
  private focusedPaneId: string | undefined;
  private lastFocusShortcutAt = 0;
  private currentCtx: ExtensionContext | undefined;
  private scrollRepeatStartTimer: ReturnType<typeof setTimeout> | undefined;
  private scrollRepeatInterval: ReturnType<typeof setInterval> | undefined;
  private scrollRepeatStopTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly pi: ExtensionAPI) {
    this.unsubscribers.push(
      this.pi.events.on(REGISTER_EVENT, (data) => this.handleRegister(data)),
      this.pi.events.on(UNREGISTER_EVENT, (data) => this.handleUnregister(data)),
      this.pi.events.on(VISIBILITY_EVENT, (data) => this.handleVisibility(data)),
      this.pi.events.on(FOCUS_PANE_EVENT, (data) => this.handleFocusPane(data)),
      this.pi.events.on(SCROLL_TO_BOTTOM_EVENT, (data) => this.handleScrollToBottom(data)),
      this.pi.events.on(RENDER_REQUEST_EVENT, () => this.requestRender?.()),
    );
  }

  start(ctx: ExtensionContext): void {
    this.currentCtx = ctx;
    if (!ctx.hasUI || this.handle) return;

    this.terminalInputUnsubscriber = ctx.ui.onTerminalInput((data) =>
      this.handleTerminalInput(data),
    );

    void ctx.ui
      .custom<void>(
        (tui, _theme, keybindings) => {
          this.installMainTilePatch(tui);
          this.keybindings = isKeybindingsMatcher(keybindings) ? keybindings : undefined;
          this.requestRender = () => tui.requestRender();

          return {
            render: (width: number): string[] => this.render(width),
            invalidate: () => {},
            dispose: () => {
              this.keybindings = undefined;
              this.requestRender = undefined;
            },
          };
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "top-right",
            width: `${currentConfig.overlayWidthPercent}%`,
            minWidth: currentConfig.defaultPaneMinWidth,
            maxHeight: `${currentConfig.overlayMaxHeightPercent}%`,
            margin: {
              top: currentConfig.overlayMarginTop,
              right: 0,
              bottom: currentConfig.overlayMarginBottom,
            },
            nonCapturing: true,
            visible: (termWidth, termHeight) => this.isOverlayAllowed(termWidth, termHeight),
          },
          onHandle: (handle) => {
            this.handle = handle;
            handle.setHidden(this.hidden);
          },
        },
      )
      .catch((error: unknown) => {
        this.terminalInputUnsubscriber?.();
        this.terminalInputUnsubscriber = undefined;
        this.restoreMainTilePatch();
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Right overlay tiler failed: ${message}`, "error");
      });

    this.pi.events.emit(QUERY_EVENT, {});
  }

  shutdown(): void {
    this.handle?.hide();
    this.handle = undefined;
    this.restoreMainTilePatch();
    this.keybindings = undefined;
    this.terminalInputUnsubscriber?.();
    this.terminalInputUnsubscriber = undefined;
    this.requestRender = undefined;
    this.stopScrollRepeat();
    this.currentCtx?.ui.setStatus(currentConfig.focusStatusKey, undefined);
    this.currentCtx = undefined;
    this.panes.clear();
    this.paneViewportHeights.clear();
    this.hidden = true;
    this.overlayFocused = false;
    this.focusedPaneId = undefined;
    this.lastFocusShortcutAt = 0;

    for (const unsubscribe of this.unsubscribers.splice(0)) {
      unsubscribe();
    }
  }

  focusFirstPane(ctx?: ExtensionContext): boolean {
    const pane = this.focusedPane() ?? this.focusablePanes()[0];
    if (!pane) {
      ctx?.ui.notify("No right overlay pane is visible", "warning");
      return false;
    }

    return this.focusPane(pane);
  }

  focusNextPane(ctx?: ExtensionContext): boolean {
    return this.focusRelativePane(1, ctx);
  }

  focusPreviousPane(ctx?: ExtensionContext): boolean {
    return this.focusRelativePane(-1, ctx);
  }

  blurOverlay(): void {
    if (!this.overlayFocused) return;

    this.focusedPane()?.onBlur?.();
    this.overlayFocused = false;
    this.currentCtx?.ui.setStatus(currentConfig.focusStatusKey, undefined);
    this.requestRender?.();
  }

  toggleFocus(ctx?: ExtensionContext): boolean {
    if (this.overlayFocused) {
      this.blurOverlay();
      return true;
    }

    return this.focusFirstPane(ctx);
  }

  handleCommand(args: string, ctx: ExtensionContext): void {
    const action = parseFocusAction(args);
    if (!action) {
      ctx.ui.notify(`Unknown right-overlay action: ${args.trim()}`, "warning");
      return;
    }

    switch (action) {
      case "focus":
        this.focusFirstPane(ctx);
        return;
      case "blur":
        this.blurOverlay();
        return;
      case "toggle":
        this.toggleFocus(ctx);
        return;
      case "next":
        this.focusNextPane(ctx);
        return;
      case "previous":
        this.focusPreviousPane(ctx);
        return;
      case "top":
        this.scrollFocusedPaneToTop(ctx);
        return;
      case "bottom":
        this.scrollFocusedPaneToBottom(ctx);
        return;
    }
  }

  private handleRegister(data: unknown): void {
    const config = toPaneConfig(data);
    if (!config) return;

    const existing = this.panes.get(config.id);
    this.panes.set(config.id, {
      ...config,
      scrollOffset: existing?.scrollOffset ?? 0,
      visible: existing?.visible ?? false,
    });
    this.updateHiddenState();
    this.requestRender?.();
  }

  private handleUnregister(data: unknown): void {
    const id = toId(data);
    if (!id) return;

    const pane = this.panes.get(id);
    if (this.focusedPaneId === id) {
      if (this.overlayFocused) pane?.onBlur?.();
      this.focusedPaneId = undefined;
    }

    this.panes.delete(id);
    this.paneViewportHeights.delete(id);
    this.updateHiddenState();
    this.requestRender?.();
  }

  private handleVisibility(data: unknown): void {
    const visibility = toVisibility(data);
    if (!visibility) return;

    const pane = this.panes.get(visibility.id);
    if (!pane || pane.visible === visibility.visible) return;

    if (!visibility.visible && this.focusedPaneId === pane.id) {
      if (this.overlayFocused) pane.onBlur?.();
      this.focusedPaneId = undefined;
    }

    pane.visible = visibility.visible;
    this.updateHiddenState();
    this.requestRender?.();
  }

  private handleFocusPane(data: unknown): void {
    const id = toId(data);
    if (!id) return;

    const pane = this.panes.get(id);
    if (!pane?.visible || pane.focusable === false) return;

    this.focusPane(pane);
  }

  private handleScrollToBottom(data: unknown): void {
    const id = toId(data);
    if (!id) return;

    const pane = this.panes.get(id);
    if (!pane) return;

    this.scrollPaneToBottom(pane);
  }

  private visiblePanes(): RightOverlayPaneRecord[] {
    return [...this.panes.values()]
      .filter((pane) => pane.visible)
      .sort((left, right) => {
        const orderDiff = left.order - right.order;
        if (orderDiff !== 0) return orderDiff;
        return left.id.localeCompare(right.id);
      });
  }

  private focusablePanes(): RightOverlayPaneRecord[] {
    return this.visiblePanes().filter((pane) => pane.focusable !== false);
  }

  private focusedPane(): RightOverlayPaneRecord | undefined {
    const pane = this.focusedPaneId ? this.panes.get(this.focusedPaneId) : undefined;
    if (pane?.visible && pane.focusable !== false) return pane;

    return undefined;
  }

  private updateHiddenState(): void {
    this.hidden = this.visiblePanes().length === 0;
    this.handle?.setHidden(this.hidden);

    if (this.hidden) {
      this.blurOverlay();
      this.focusedPaneId = undefined;
      return;
    }

    if (this.overlayFocused && !this.focusedPane()) {
      const pane = this.focusablePanes()[0];
      if (pane) this.focusPane(pane);
    }
  }

  private minWidth(): number {
    return Math.max(
      currentConfig.defaultPaneMinWidth,
      ...this.visiblePanes().map((pane) => pane.minWidth ?? currentConfig.defaultPaneMinWidth),
    );
  }

  private overlayWidth(termWidth: number): number {
    const percentWidth = Math.floor((termWidth * currentConfig.overlayWidthPercent) / 100);
    return Math.max(1, Math.min(termWidth, Math.max(percentWidth, this.minWidth())));
  }

  private canFitMainTile(termWidth: number): boolean {
    return (
      termWidth - this.overlayWidth(termWidth) - currentConfig.mainTileGap >=
      currentConfig.minMainTileWidth
    );
  }

  private isOverlayAllowed(termWidth: number, termHeight: number): boolean {
    const panes = this.visiblePanes();
    if (panes.length === 0) return false;

    const paneAllowed = panes.some(
      (pane) =>
        pane.visibleWhen?.(termWidth, termHeight) ?? termWidth >= currentConfig.minTerminalWidth,
    );
    return paneAllowed && this.canFitMainTile(termWidth);
  }

  private mainTileWidth(termWidth: number, termHeight: number): number | undefined {
    if (this.hidden || !this.isOverlayAllowed(termWidth, termHeight)) return undefined;

    return termWidth - this.overlayWidth(termWidth) - currentConfig.mainTileGap;
  }

  private overlayMaxHeight(): number | undefined {
    const termHeight = this.mainTilePatch?.tui.terminal.rows;
    if (!termHeight) return undefined;

    const availableHeight = Math.max(
      1,
      termHeight - currentConfig.overlayMarginTop - currentConfig.overlayMarginBottom,
    );
    const percentHeight = Math.floor((termHeight * currentConfig.overlayMaxHeightPercent) / 100);
    return Math.max(1, Math.min(availableHeight, percentHeight));
  }

  /**
   * Pi overlays are composited on top of the base UI, so reserve a left tile by
   * rendering the base UI at the remaining width whenever the right pane is visible.
   */
  private installMainTilePatch(tui: TileableTui): void {
    if (this.mainTilePatch?.tui === tui) return;

    this.restoreMainTilePatch();

    const originalRender = tui.render.bind(tui);
    const patchedRender = (width: number): string[] => {
      const mainWidth = this.mainTileWidth(width, tui.terminal.rows);
      return originalRender(mainWidth ?? width);
    };

    tui.render = patchedRender;
    this.mainTilePatch = { originalRender, patchedRender, tui };
  }

  private restoreMainTilePatch(): void {
    if (!this.mainTilePatch) return;

    const { originalRender, patchedRender, tui } = this.mainTilePatch;
    if (tui.render === patchedRender) {
      tui.render = originalRender;
    }
    this.mainTilePatch = undefined;
  }

  private focusPane(pane: RightOverlayPaneRecord): boolean {
    const previous = this.focusedPane();
    const wasOverlayFocused = this.overlayFocused;
    if (previous?.id !== pane.id) {
      if (wasOverlayFocused) previous?.onBlur?.();
      this.focusedPaneId = pane.id;
      pane.onFocus?.();
    } else if (!wasOverlayFocused) {
      pane.onFocus?.();
    }

    this.overlayFocused = true;
    this.currentCtx?.ui.setStatus(
      currentConfig.focusStatusKey,
      `right pane: ${pane.id} (Esc blur · ↑↓/j/k scroll · ${currentConfig.focusShortcut} toggle)`,
    );
    this.requestRender?.();
    return true;
  }

  private focusRelativePane(delta: number, ctx?: ExtensionContext): boolean {
    const panes = this.focusablePanes();
    if (panes.length === 0) {
      ctx?.ui.notify("No right overlay pane is visible", "warning");
      return false;
    }

    const current = this.focusedPane();
    const currentIndex = current ? panes.findIndex((pane) => pane.id === current.id) : -1;
    const nextIndex = (currentIndex + delta + panes.length) % panes.length;
    const pane = panes[nextIndex];
    return pane ? this.focusPane(pane) : false;
  }

  private scrollPaneBy(pane: RightOverlayPaneRecord, lines: number): void {
    pane.scrollOffset = Math.max(0, pane.scrollOffset + lines);
    this.requestRender?.();
  }

  private stopScrollRepeat(): void {
    if (this.scrollRepeatStartTimer) clearTimeout(this.scrollRepeatStartTimer);
    if (this.scrollRepeatInterval) clearInterval(this.scrollRepeatInterval);
    if (this.scrollRepeatStopTimer) clearTimeout(this.scrollRepeatStopTimer);
    this.scrollRepeatStartTimer = undefined;
    this.scrollRepeatInterval = undefined;
    this.scrollRepeatStopTimer = undefined;
  }

  private refreshScrollRepeatStop(): void {
    if (this.scrollRepeatStopTimer) clearTimeout(this.scrollRepeatStopTimer);
    this.scrollRepeatStopTimer = setTimeout(
      () => this.stopScrollRepeat(),
      currentConfig.scrollRepeatIdleStopMs,
    );
  }

  private beginScrollRepeat(pane: RightOverlayPaneRecord, lines: number): void {
    this.stopScrollRepeat();
    this.scrollRepeatStartTimer = setTimeout(() => {
      this.scrollRepeatStartTimer = undefined;
      this.scrollRepeatInterval = setInterval(
        () => this.scrollPaneBy(pane, lines),
        currentConfig.scrollRepeatIntervalMs,
      );
    }, currentConfig.scrollRepeatInitialDelayMs);
    this.refreshScrollRepeatStop();
  }

  private scrollPaneByInput(pane: RightOverlayPaneRecord, lines: number, data: string): void {
    this.scrollPaneBy(pane, lines);
    if (isKeyRelease(data)) {
      this.stopScrollRepeat();
      return;
    }

    this.beginScrollRepeat(pane, lines);
  }

  private scrollPaneToTop(pane: RightOverlayPaneRecord): void {
    pane.scrollOffset = 0;
    this.requestRender?.();
  }

  private scrollPaneToBottom(pane: RightOverlayPaneRecord): void {
    pane.scrollOffset = Number.MAX_SAFE_INTEGER;
    this.requestRender?.();
  }

  private scrollFocusedPaneToTop(ctx?: ExtensionContext): void {
    const pane = this.focusedPane() ?? this.focusablePanes()[0];
    if (!pane) {
      ctx?.ui.notify("No right overlay pane is visible", "warning");
      return;
    }

    this.scrollPaneToTop(pane);
  }

  private scrollFocusedPaneToBottom(ctx?: ExtensionContext): void {
    const pane = this.focusedPane() ?? this.focusablePanes()[0];
    if (!pane) {
      ctx?.ui.notify("No right overlay pane is visible", "warning");
      return;
    }

    this.scrollPaneToBottom(pane);
  }

  private paneInputContext(pane: RightOverlayPaneRecord): RightOverlayPaneInputContext {
    return {
      paneId: pane.id,
      focused: this.overlayFocused && this.focusedPaneId === pane.id,
      requestRender: () => this.requestRender?.(),
      focusNextPane: () => this.focusNextPane(),
      focusPreviousPane: () => this.focusPreviousPane(),
      blur: () => this.blurOverlay(),
      scrollBy: (lines) => this.scrollPaneBy(pane, lines),
      scrollToTop: () => this.scrollPaneToTop(pane),
      scrollToBottom: () => this.scrollPaneToBottom(pane),
    };
  }

  private matchesKeybinding(data: string, keybinding: string): boolean {
    const normalized = stripKeyEventType(data);
    return (
      this.keybindings?.matches(data, keybinding) ??
      (normalized !== data ? this.keybindings?.matches(normalized, keybinding) : false) ??
      false
    );
  }

  private normalizedInput(data: string): string {
    return stripKeyEventType(data);
  }

  private isUpInput(data: string): boolean {
    const normalized = this.normalizedInput(data);
    const csi = normalized.startsWith("\x1b[") ? normalized.slice(2) : "";
    return (
      this.matchesKeybinding(data, "tui.select.up") ||
      this.matchesKeybinding(data, "tui.editor.cursorUp") ||
      normalized === "k" ||
      /^(?:1;\d+)?A$/u.test(csi)
    );
  }

  private isDownInput(data: string): boolean {
    const normalized = this.normalizedInput(data);
    const csi = normalized.startsWith("\x1b[") ? normalized.slice(2) : "";
    return (
      this.matchesKeybinding(data, "tui.select.down") ||
      this.matchesKeybinding(data, "tui.editor.cursorDown") ||
      normalized === "j" ||
      /^(?:1;\d+)?B$/u.test(csi)
    );
  }

  private isPageUpInput(data: string): boolean {
    const normalized = this.normalizedInput(data);
    const csi = normalized.startsWith("\x1b[") ? normalized.slice(2) : "";
    return (
      this.matchesKeybinding(data, "tui.select.pageUp") ||
      this.matchesKeybinding(data, "tui.editor.pageUp") ||
      /^5(?:;\d+)?~$/u.test(csi)
    );
  }

  private isPageDownInput(data: string): boolean {
    const normalized = this.normalizedInput(data);
    const csi = normalized.startsWith("\x1b[") ? normalized.slice(2) : "";
    return (
      this.matchesKeybinding(data, "tui.select.pageDown") ||
      this.matchesKeybinding(data, "tui.editor.pageDown") ||
      /^6(?:;\d+)?~$/u.test(csi)
    );
  }

  private shouldIgnoreFocusShortcutDuplicate(data: string): boolean {
    if (isKeyReleaseOrRepeat(data)) return true;

    const now = Date.now();
    if (now - this.lastFocusShortcutAt < currentConfig.focusShortcutDebounceMs) return true;

    this.lastFocusShortcutAt = now;
    return false;
  }

  private handleTerminalInput(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.overlayFocused) {
      if (matchesRawAltLetter(data, currentConfig.focusShortcutLetter)) {
        if (!this.shouldIgnoreFocusShortcutDuplicate(data)) this.focusFirstPane();
        return { consume: true };
      }
      return undefined;
    }

    const pane = this.focusedPane() ?? this.focusablePanes()[0];
    if (!pane) {
      this.blurOverlay();
      return undefined;
    }

    if (matchesRawAltLetter(data, currentConfig.focusShortcutLetter)) {
      if (!this.shouldIgnoreFocusShortcutDuplicate(data)) this.blurOverlay();
      return { consume: true };
    }

    if (
      isRawEscape(data) ||
      isRawCtrlC(data) ||
      this.matchesKeybinding(data, "tui.select.cancel") ||
      this.matchesKeybinding(data, "app.interrupt")
    ) {
      this.stopScrollRepeat();
      this.blurOverlay();
      return { consume: true };
    }

    const normalizedData = this.normalizedInput(data);
    const consumedByPane = pane.handleInput?.(data, this.paneInputContext(pane)) === true;
    if (consumedByPane) {
      this.requestRender?.();
      return { consume: true };
    }

    if (this.matchesKeybinding(data, "tui.input.tab") || data === "\t") {
      this.stopScrollRepeat();
      this.focusNextPane();
      return { consume: true };
    }

    if (normalizedData === "\x1b[Z") {
      this.stopScrollRepeat();
      this.focusPreviousPane();
      return { consume: true };
    }

    if (this.isUpInput(data)) {
      this.scrollPaneByInput(pane, -1, data);
      return { consume: true };
    }

    if (this.isDownInput(data)) {
      this.scrollPaneByInput(pane, 1, data);
      return { consume: true };
    }

    if (this.isPageUpInput(data)) {
      this.scrollPaneByInput(pane, -this.pageScrollSize(pane), data);
      return { consume: true };
    }

    if (this.isPageDownInput(data)) {
      this.scrollPaneByInput(pane, this.pageScrollSize(pane), data);
      return { consume: true };
    }

    if (
      this.matchesKeybinding(data, "tui.editor.cursorLineStart") ||
      normalizedData === "g" ||
      normalizedData === "\x1b[H" ||
      normalizedData === "\x1b[1~"
    ) {
      this.stopScrollRepeat();
      this.scrollPaneToTop(pane);
      return { consume: true };
    }

    if (
      this.matchesKeybinding(data, "tui.editor.cursorLineEnd") ||
      normalizedData === "G" ||
      normalizedData === "\x1b[F" ||
      normalizedData === "\x1b[4~"
    ) {
      this.stopScrollRepeat();
      this.scrollPaneToBottom(pane);
      return { consume: true };
    }

    if (isKeyReleaseOrRepeat(data)) {
      return { consume: true };
    }

    this.stopScrollRepeat();
    this.blurOverlay();
    return undefined;
  }

  private pageScrollSize(pane: RightOverlayPaneRecord): number {
    return Math.max(1, (this.paneViewportHeights.get(pane.id) ?? 8) - 1);
  }

  private render(width: number): string[] {
    const panes = this.visiblePanes();
    if (panes.length === 0) return [];

    if (this.overlayFocused && !this.focusedPane()) {
      const pane = this.focusablePanes()[0];
      if (pane) this.focusedPaneId = pane.id;
    }

    const renderedPanes = panes.map((pane) => {
      const focused = this.overlayFocused && this.focusedPaneId === pane.id;
      try {
        return {
          lines: pane.render(width, { focused, scrollOffset: pane.scrollOffset }),
          pane,
        };
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return { lines: [`Overlay ${pane.id} failed: ${message}`], pane };
      }
    });

    const maxHeight = this.overlayMaxHeight();
    const fullHeight =
      renderedPanes.reduce((sum, pane) => sum + pane.lines.length, 0) + renderedPanes.length - 1;

    if (!maxHeight || fullHeight <= maxHeight) {
      for (const { lines, pane } of renderedPanes) {
        pane.scrollOffset = 0;
        this.paneViewportHeights.set(pane.id, Math.max(1, lines.length - 2));
      }
      return this.joinRenderedPanes(renderedPanes.map(({ lines }) => lines));
    }

    const separatorRows = renderedPanes.length - 1;
    const paneRowsAvailable = Math.max(1, maxHeight - separatorRows);
    const paneHeights = this.allocatePaneHeights(
      renderedPanes.map(({ lines }) => lines.length),
      paneRowsAvailable,
    );

    return this.joinRenderedPanes(
      renderedPanes.map(({ lines, pane }, index) =>
        this.renderPaneViewport(pane, lines, paneHeights[index] ?? 0),
      ),
    );
  }

  private allocatePaneHeights(desiredHeights: number[], availableRows: number): number[] {
    if (desiredHeights.length === 0) return [];
    if (availableRows <= desiredHeights.length) {
      return desiredHeights.map((_height, index) => (index < availableRows ? 1 : 0));
    }

    const allocated = desiredHeights.map(() => 0);
    const remaining = new Set(desiredHeights.map((_height, index) => index));
    let rowsLeft = availableRows;

    while (remaining.size > 0) {
      const fairShare = Math.max(1, Math.floor(rowsLeft / remaining.size));
      let settled = false;

      for (const index of [...remaining]) {
        const desiredHeight = desiredHeights[index] ?? 0;
        if (desiredHeight <= fairShare) {
          allocated[index] = desiredHeight;
          rowsLeft -= desiredHeight;
          remaining.delete(index);
          settled = true;
        }
      }

      if (!settled) break;
    }

    const remainingIndexes = [...remaining];
    remainingIndexes.forEach((index, offset) => {
      const share = Math.floor(rowsLeft / remainingIndexes.length);
      const extra = offset < rowsLeft % remainingIndexes.length ? 1 : 0;
      allocated[index] = Math.max(1, share + extra);
    });

    return allocated;
  }

  private renderPaneViewport(
    pane: RightOverlayPaneRecord,
    lines: string[],
    maxHeight: number,
  ): string[] {
    if (maxHeight <= 0) return [];
    const stickyBottomLines = Math.min(
      Math.max(1, pane.stickyBottomLines ?? 1),
      Math.max(1, lines.length - 1),
    );

    if (lines.length <= maxHeight) {
      pane.scrollOffset = 0;
      this.paneViewportHeights.set(pane.id, Math.max(1, lines.length - 1 - stickyBottomLines));
      return lines;
    }

    if (maxHeight <= 2 || lines.length <= 2) {
      this.paneViewportHeights.set(pane.id, maxHeight);
      return lines.slice(0, maxHeight);
    }

    const top = lines[0] ?? "";
    const footer = lines.slice(-stickyBottomLines);
    const body = lines.slice(1, -stickyBottomLines);
    const bodyHeight = maxHeight - 1 - footer.length;

    if (bodyHeight <= 0) {
      this.paneViewportHeights.set(pane.id, 1);
      return [top, ...footer.slice(-(maxHeight - 1))];
    }

    const maxScroll = Math.max(0, body.length - bodyHeight);
    pane.scrollOffset = clamp(pane.scrollOffset, 0, maxScroll);
    this.paneViewportHeights.set(pane.id, bodyHeight);

    return [top, ...body.slice(pane.scrollOffset, pane.scrollOffset + bodyHeight), ...footer];
  }

  private joinRenderedPanes(panes: string[][]): string[] {
    const lines: string[] = [];
    for (const paneLines of panes) {
      if (paneLines.length === 0) continue;
      if (lines.length > 0) lines.push("");
      lines.push(...paneLines);
    }
    return lines;
  }
}

export class RightOverlayPaneClient {
  private visible = false;
  private readonly unsubscribeQuery: () => void;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly config: RightOverlayPaneConfig,
  ) {
    this.unsubscribeQuery = this.pi.events.on(QUERY_EVENT, () => this.publishRegistration());
    this.publishRegistration();
    this.setVisible(false);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.pi.events.emit(VISIBILITY_EVENT, { id: this.config.id, visible });
  }

  requestRender(): void {
    this.publishRegistration();
    this.pi.events.emit(RENDER_REQUEST_EVENT, { id: this.config.id });
  }

  focus(): void {
    this.publishRegistration();
    this.pi.events.emit(FOCUS_PANE_EVENT, { id: this.config.id });
  }

  scrollToBottom(): void {
    this.publishRegistration();
    this.pi.events.emit(SCROLL_TO_BOTTOM_EVENT, { id: this.config.id });
  }

  dispose(): void {
    this.setVisible(false);
    this.unsubscribeQuery();
    this.pi.events.emit(UNREGISTER_EVENT, { id: this.config.id });
  }

  private publishRegistration(): void {
    this.pi.events.emit(REGISTER_EVENT, this.config);
    this.pi.events.emit(VISIBILITY_EVENT, { id: this.config.id, visible: this.visible });
  }
}

export function installRightOverlayTilerHost(pi: ExtensionAPI): void {
  let host: RightOverlayTilerHost | undefined;
  loadRightOverlayTilerConfig(process.cwd());

  pi.on("session_start", (_event, ctx) => {
    loadRightOverlayTilerConfig(ctx.cwd, (message) => ctx.ui.notify(message, "warning"));
    host = new RightOverlayTilerHost(pi);
    host.start(ctx);
  });

  pi.on("session_shutdown", () => {
    host?.shutdown();
    host = undefined;
  });

  pi.registerShortcut(
    currentConfig.focusShortcut as Parameters<ExtensionAPI["registerShortcut"]>[0],
    {
      description: "Focus or cycle the right overlay panes",
      handler: (ctx) => {
        if (host?.toggleFocus(ctx)) return;
        ctx.ui.notify("No right overlay pane is visible", "warning");
      },
    },
  );

  pi.registerCommand("right-overlay", {
    description:
      "Focus and scroll right overlay panes: focus, blur, toggle, next, previous, top, bottom",
    getArgumentCompletions: (prefix) => {
      const trimmed = prefix.trim().toLowerCase();
      return FOCUS_ACTIONS.filter((action) => action.startsWith(trimmed)).map((action) => ({
        label: action,
        value: action,
      }));
    },
    handler: (args, ctx) => {
      host?.handleCommand(args, ctx);
      if (!host) ctx.ui.notify("Right overlay tiler is not active", "warning");
      return Promise.resolve();
    },
  });
}

export function registerRightOverlayPane(
  pi: ExtensionAPI,
  config: RightOverlayPaneConfig,
): RightOverlayPaneClient {
  return new RightOverlayPaneClient(pi, config);
}
