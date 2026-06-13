import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Key,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import {
  getBooleanField,
  getErrorMessage as getConfigErrorMessage,
  readJsoncConfig,
} from "./lib/jsonc-config.ts";

const BOARD_WIDTH = 10;
const BOARD_HEIGHT = 20;
const TICK_MS = 80;
const PREFERRED_OVERLAY_WIDTH = 48;
const PLAYFIELD_WIDTH = BOARD_WIDTH * 2 + 2;
const SIDE_PANEL_GAP = 2;
const SIDE_PANEL_WIDTH = 14;
const CONFIG_FILE_PATH = ".pi/extensions/tetris.config.jsonc";
const STATUS_KEY = "tetris";
const TETRIS_SAVE_TYPE = "tetris-save";

const PIECE_TYPES = ["I", "O", "T", "S", "Z", "J", "L"] as const;

type PieceType = (typeof PIECE_TYPES)[number];
type Cell = PieceType | null;
type Matrix = Cell[][];
type Mode = "playing" | "paused" | "menu";
type MenuAction = "resume" | "restart" | "hide" | "quit";

interface FallingPiece {
  type: PieceType;
  matrix: Matrix;
  x: number;
  y: number;
}

interface GameState {
  board: Matrix;
  current: FallingPiece;
  next: PieceType;
  bag: PieceType[];
  score: number;
  highScore: number;
  lines: number;
  level: number;
  gameOver: boolean;
  gravityCounter: number;
}

interface TetrisSave {
  state: GameState | null;
  highScore: number;
}

interface TetrisConfig {
  readonly pauseOnPromptCompletion: boolean;
}

interface MenuOption {
  action: MenuAction;
  label: string;
}

const PIECE_MATRICES: Record<PieceType, Matrix> = {
  I: [["I", "I", "I", "I"]],
  J: [
    ["J", null, null],
    ["J", "J", "J"],
  ],
  L: [
    [null, null, "L"],
    ["L", "L", "L"],
  ],
  O: [
    ["O", "O"],
    ["O", "O"],
  ],
  S: [
    [null, "S", "S"],
    ["S", "S", null],
  ],
  T: [
    [null, "T", null],
    ["T", "T", "T"],
  ],
  Z: [
    ["Z", "Z", null],
    [null, "Z", "Z"],
  ],
};

const LINE_CLEAR_POINTS = [0, 100, 300, 500, 800] as const;
const DEFAULT_TETRIS_CONFIG: TetrisConfig = {
  pauseOnPromptCompletion: true,
};

let currentConfig: TetrisConfig = { ...DEFAULT_TETRIS_CONFIG };
let lastConfigError: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createEmptyRow(): Cell[] {
  return Array.from({ length: BOARD_WIDTH }, () => null as Cell);
}

function createBoard(): Matrix {
  return Array.from({ length: BOARD_HEIGHT }, () => createEmptyRow());
}

function cloneMatrix(matrix: Matrix): Matrix {
  return matrix.map((row) => row.slice());
}

function clonePiece(piece: FallingPiece): FallingPiece {
  return {
    matrix: cloneMatrix(piece.matrix),
    type: piece.type,
    x: piece.x,
    y: piece.y,
  };
}

function cloneGameState(state: GameState): GameState {
  return {
    bag: state.bag.slice(),
    board: cloneMatrix(state.board),
    current: clonePiece(state.current),
    gameOver: state.gameOver,
    gravityCounter: state.gravityCounter,
    highScore: state.highScore,
    level: state.level,
    lines: state.lines,
    next: state.next,
    score: state.score,
  };
}

function matrixWidth(matrix: Matrix): number {
  return Math.max(0, ...matrix.map((row) => row.length));
}

function rowIsEmpty(row: readonly Cell[] | undefined): boolean {
  return !row || row.every((cell) => cell === null);
}

function colIsEmpty(matrix: Matrix, col: number): boolean {
  return matrix.every((row) => (row[col] ?? null) === null);
}

function trimMatrix(matrix: Matrix): Matrix {
  let top = 0;
  while (top < matrix.length && rowIsEmpty(matrix[top])) top++;

  let bottom = matrix.length - 1;
  while (bottom >= top && rowIsEmpty(matrix[bottom])) bottom--;

  const width = matrixWidth(matrix);
  let left = 0;
  while (left < width && colIsEmpty(matrix, left)) left++;

  let right = width - 1;
  while (right >= left && colIsEmpty(matrix, right)) right--;

  if (top > bottom || left > right) return [[null]];

  const trimmed: Matrix = [];
  for (let y = top; y <= bottom; y++) {
    const sourceRow = matrix[y];
    const row: Cell[] = [];
    for (let x = left; x <= right; x++) {
      row.push(sourceRow?.[x] ?? null);
    }
    trimmed.push(row);
  }
  return trimmed;
}

function rotateMatrixClockwise(matrix: Matrix): Matrix {
  const height = matrix.length;
  const width = matrixWidth(matrix);
  const rotated: Matrix = [];

  for (let x = 0; x < width; x++) {
    const row: Cell[] = [];
    for (let y = height - 1; y >= 0; y--) {
      row.push(matrix[y]?.[x] ?? null);
    }
    rotated.push(row);
  }

  return trimMatrix(rotated);
}

function createBag(): PieceType[] {
  const bag = [...PIECE_TYPES];
  for (let i = bag.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const current = bag[i]!;
    bag[i] = bag[j]!;
    bag[j] = current;
  }
  return bag;
}

function takeFromBag(bag: PieceType[]): PieceType {
  if (bag.length === 0) bag.push(...createBag());
  return bag.pop() ?? "I";
}

function createPiece(type: PieceType): FallingPiece {
  const matrix = cloneMatrix(PIECE_MATRICES[type]);
  return {
    matrix,
    type,
    x: Math.floor((BOARD_WIDTH - matrixWidth(matrix)) / 2),
    y: 0,
  };
}

function createInitialState(highScore = 0): GameState {
  const bag = createBag();
  const current = createPiece(takeFromBag(bag));
  const next = takeFromBag(bag);

  return {
    bag,
    board: createBoard(),
    current,
    gameOver: false,
    gravityCounter: 0,
    highScore: Math.max(0, Math.floor(highScore)),
    level: 1,
    lines: 0,
    next,
    score: 0,
  };
}

function isEnter(data: string): boolean {
  return matchesKey(data, Key.enter) || matchesKey(data, "return");
}

function isSpace(data: string): boolean {
  return data === " " || matchesKey(data, Key.space);
}

function ansi(code: string, text: string): string {
  return `\x1b[${code}m${text}\x1b[0m`;
}

function dim(text: string): string {
  return ansi("2", text);
}

function pieceColor(type: PieceType, text: string): string {
  switch (type) {
    case "I":
      return ansi("36", text);
    case "J":
      return ansi("34", text);
    case "L":
      return ansi("38;5;208", text);
    case "O":
      return ansi("33", text);
    case "S":
      return ansi("32", text);
    case "T":
      return ansi("35", text);
    case "Z":
      return ansi("31", text);
  }
}

function readTetrisConfig(cwd: string): TetrisConfig {
  lastConfigError = undefined;

  try {
    const record = readJsoncConfig(CONFIG_FILE_PATH, cwd);
    if (!record) return { ...DEFAULT_TETRIS_CONFIG };

    return {
      pauseOnPromptCompletion:
        getBooleanField(record, "pauseOnPromptCompletion") ??
        DEFAULT_TETRIS_CONFIG.pauseOnPromptCompletion,
    };
  } catch (error) {
    lastConfigError = getConfigErrorMessage(error);
    return { ...DEFAULT_TETRIS_CONFIG };
  }
}

function reloadTetrisConfig(cwd: string): void {
  currentConfig = readTetrisConfig(cwd);
}

function notifyConfigError(ctx: ExtensionContext): void {
  if (lastConfigError) {
    ctx.ui.notify(`tetris config ignored: ${lastConfigError}`, "warning");
  }
}

function formatTetrisConfig(config: TetrisConfig): string {
  return [`pauseOnPromptCompletion: ${config.pauseOnPromptCompletion}`].join("\n");
}

function readLatestSave(
  entries: readonly { type: string; customType?: string; data?: unknown }[],
): TetrisSave | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type !== "custom" || entry.customType !== TETRIS_SAVE_TYPE) continue;

    if (!isRecord(entry.data)) return undefined;

    const highScore = typeof entry.data.highScore === "number" ? entry.data.highScore : 0;
    const state = isRecord(entry.data.state) ? (entry.data.state as unknown as GameState) : null;
    return { highScore, state };
  }
  return undefined;
}

class TetrisComponent implements Component {
  private readonly onClose: () => void;
  private readonly onSave: (save: TetrisSave) => void;
  private readonly theme: Theme;
  private readonly tui: TUI;

  private cachedLines: string[] = [];
  private cachedVersion = -1;
  private cachedWidth = 0;
  private closed = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private mode: Mode;
  private promptCompletionPause = false;
  private selectedMenu = 0;
  private state: GameState;
  private version = 0;

  constructor(
    tui: TUI,
    theme: Theme,
    onClose: () => void,
    onSave: (save: TetrisSave) => void,
    save?: TetrisSave,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.onClose = onClose;
    this.onSave = onSave;

    if (save?.state) {
      this.state = cloneGameState(save.state);
      this.state.highScore = Math.max(this.state.highScore, save.highScore);
      this.mode = "paused";
    } else {
      this.state = createInitialState(save?.highScore ?? 0);
      this.mode = "playing";
    }

    this.startTimer();
  }

  pauseForPromptCompletion(): void {
    if (this.closed || this.state.gameOver || this.mode === "menu") return;

    this.mode = "paused";
    this.promptCompletionPause = true;
    this.markChanged();
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.hideToChat();
      return;
    }

    if (this.mode === "menu") {
      this.handleMenuInput(data);
      return;
    }

    if (isEnter(data)) {
      this.openMenu();
      return;
    }

    if (this.state.gameOver) {
      if (isSpace(data)) this.restart();
      return;
    }

    if (this.mode === "paused") {
      if (isSpace(data)) this.resume();
      return;
    }

    if (matchesKey(data, Key.left)) {
      this.tryMove(-1, 0);
    } else if (matchesKey(data, Key.right)) {
      this.tryMove(1, 0);
    } else if (matchesKey(data, Key.down)) {
      this.softDrop();
    } else if (matchesKey(data, Key.up)) {
      this.rotateCurrentPiece();
    } else if (isSpace(data)) {
      this.hardDrop();
    }
  }

  invalidate(): void {
    this.cachedWidth = 0;
  }

  render(width: number): string[] {
    if (width === this.cachedWidth && this.cachedVersion === this.version) {
      return this.cachedLines;
    }

    if (width < 4) return [truncateToWidth("Tetris", width, "")];

    const panelWidth = Math.min(width, PREFERRED_OVERLAY_WIDTH);
    const innerWidth = Math.max(0, panelWidth - 2);
    const lines: string[] = [];

    const border = (text: string) => this.theme.fg("border", text);
    const row = (content: string) =>
      this.padLine(border("│") + this.fit(content, innerWidth) + border("│"), width);

    lines.push(this.padLine(border(`╭${"─".repeat(innerWidth)}╮`), width));
    lines.push(
      row(` ${this.theme.fg("accent", this.theme.bold("TETRIS"))}  ${dim("right-side overlay")}`),
    );
    lines.push(
      row(
        ` Score ${this.theme.fg("warning", String(this.state.score))}  Hi ${this.theme.fg(
          "success",
          String(this.state.highScore),
        )}`,
      ),
    );
    lines.push(row(` Lv ${this.state.level}  Lines ${this.state.lines}`));
    lines.push(this.padLine(border(`├${"─".repeat(innerWidth)}┤`), width));

    const boardLines = this.renderPlayfieldLines();
    const combinedWidth = PLAYFIELD_WIDTH + SIDE_PANEL_GAP + SIDE_PANEL_WIDTH;
    if (innerWidth >= combinedWidth) {
      const sideLines = this.renderSidePanel(SIDE_PANEL_WIDTH);
      for (let i = 0; i < boardLines.length; i++) {
        const line = `${boardLines[i] ?? ""}${" ".repeat(SIDE_PANEL_GAP)}${sideLines[i] ?? ""}`;
        lines.push(row(this.center(line, innerWidth)));
      }
    } else {
      for (const boardLine of boardLines) {
        lines.push(row(this.center(boardLine, innerWidth)));
      }
      for (const previewLine of this.renderCompactNextPreview(innerWidth)) {
        lines.push(row(this.center(previewLine, innerWidth)));
      }
    }

    lines.push(this.padLine(border(`├${"─".repeat(innerWidth)}┤`), width));
    this.renderFooterRows(lines, row);
    lines.push(this.padLine(border(`╰${"─".repeat(innerWidth)}╯`), width));

    this.cachedLines = lines;
    this.cachedVersion = this.version;
    this.cachedWidth = width;
    return lines;
  }

  dispose(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private startTimer(): void {
    this.interval = setInterval(() => {
      if (this.mode !== "playing" || this.state.gameOver) return;

      this.state.gravityCounter++;
      if (this.state.gravityCounter < this.gravityFrames()) return;

      this.state.gravityCounter = 0;
      if (!this.tryMove(0, 1)) this.lockCurrentPiece();
    }, TICK_MS);
  }

  private gravityFrames(): number {
    return Math.max(3, 10 - Math.min(7, this.state.level - 1));
  }

  private canPlace(matrix: Matrix, pieceX: number, pieceY: number): boolean {
    for (let y = 0; y < matrix.length; y++) {
      const row = matrix[y];
      if (!row) continue;

      for (let x = 0; x < row.length; x++) {
        const cell = row[x] ?? null;
        if (!cell) continue;

        const boardX = pieceX + x;
        const boardY = pieceY + y;
        if (boardX < 0 || boardX >= BOARD_WIDTH || boardY >= BOARD_HEIGHT) return false;
        if (boardY < 0) continue;

        const boardRow = this.state.board[boardY];
        if (!boardRow || boardRow[boardX]) return false;
      }
    }
    return true;
  }

  private tryMove(dx: number, dy: number): boolean {
    const nextX = this.state.current.x + dx;
    const nextY = this.state.current.y + dy;
    if (!this.canPlace(this.state.current.matrix, nextX, nextY)) return false;

    this.state.current.x = nextX;
    this.state.current.y = nextY;
    this.markChanged();
    return true;
  }

  private softDrop(): void {
    if (this.tryMove(0, 1)) {
      this.addScore(1);
      this.markChanged();
    } else {
      this.lockCurrentPiece();
    }
  }

  private hardDrop(): void {
    let dropped = 0;
    while (
      this.canPlace(this.state.current.matrix, this.state.current.x, this.state.current.y + 1)
    ) {
      this.state.current.y++;
      dropped++;
    }
    if (dropped > 0) this.addScore(dropped * 2);
    this.lockCurrentPiece();
  }

  private rotateCurrentPiece(): void {
    if (this.state.current.type === "O") return;

    const rotated = rotateMatrixClockwise(this.state.current.matrix);
    for (const kick of [0, -1, 1, -2, 2]) {
      const nextX = this.state.current.x + kick;
      if (!this.canPlace(rotated, nextX, this.state.current.y)) continue;

      this.state.current.matrix = rotated;
      this.state.current.x = nextX;
      this.markChanged();
      return;
    }
  }

  private lockCurrentPiece(): void {
    const { current } = this.state;
    for (let y = 0; y < current.matrix.length; y++) {
      const row = current.matrix[y];
      if (!row) continue;

      for (let x = 0; x < row.length; x++) {
        const cell = row[x] ?? null;
        if (!cell) continue;

        const boardX = current.x + x;
        const boardY = current.y + y;
        if (boardY < 0) continue;

        const boardRow = this.state.board[boardY];
        if (boardRow && boardX >= 0 && boardX < BOARD_WIDTH) {
          boardRow[boardX] = cell;
        }
      }
    }

    this.clearFullRows();
    this.spawnNextPiece();
    this.markChanged();
  }

  private clearFullRows(): void {
    const keptRows = this.state.board.filter((row) => !row.every((cell) => cell !== null));
    const cleared = BOARD_HEIGHT - keptRows.length;
    if (cleared === 0) return;

    const newRows = Array.from({ length: cleared }, () => createEmptyRow());
    this.state.board = [...newRows, ...keptRows];
    this.state.lines += cleared;
    this.state.level = Math.floor(this.state.lines / 10) + 1;
    this.addScore((LINE_CLEAR_POINTS[cleared] ?? 0) * this.state.level);
  }

  private spawnNextPiece(): void {
    this.state.current = createPiece(this.state.next);
    this.state.next = takeFromBag(this.state.bag);
    this.state.gravityCounter = 0;

    if (!this.canPlace(this.state.current.matrix, this.state.current.x, this.state.current.y)) {
      this.state.gameOver = true;
      this.state.highScore = Math.max(this.state.highScore, this.state.score);
    }
  }

  private addScore(points: number): void {
    this.state.score += points;
    this.state.highScore = Math.max(this.state.highScore, this.state.score);
  }

  private openMenu(): void {
    this.mode = "menu";
    this.promptCompletionPause = false;
    this.selectedMenu = 0;
    this.markChanged();
  }

  private resume(): void {
    if (this.state.gameOver) return;
    this.mode = "playing";
    this.promptCompletionPause = false;
    this.markChanged();
  }

  private restart(): void {
    const highScore = this.state.highScore;
    this.state = createInitialState(highScore);
    this.mode = "playing";
    this.promptCompletionPause = false;
    this.selectedMenu = 0;
    this.onSave({ highScore, state: null });
    this.markChanged();
  }

  private hideToChat(): void {
    this.finish({ highScore: this.state.highScore, state: cloneGameState(this.state) });
  }

  private quitGame(): void {
    this.finish({ highScore: this.state.highScore, state: null });
  }

  private finish(save: TetrisSave): void {
    if (this.closed) return;
    this.closed = true;
    this.mode = "paused";
    this.promptCompletionPause = false;
    this.dispose();
    this.onSave(save);
    this.onClose();
  }

  private getMenuOptions(): MenuOption[] {
    const options: MenuOption[] = [];
    if (!this.state.gameOver) options.push({ action: "resume", label: "Resume game" });
    options.push({ action: "restart", label: this.state.gameOver ? "Restart" : "Restart game" });
    options.push({ action: "hide", label: "Hide to chat" });
    options.push({ action: "quit", label: "Quit game" });
    return options;
  }

  private handleMenuInput(data: string): void {
    const options = this.getMenuOptions();
    if (options.length === 0) return;

    if (matchesKey(data, Key.up)) {
      this.selectedMenu = (this.selectedMenu - 1 + options.length) % options.length;
      this.markChanged();
      return;
    }

    if (matchesKey(data, Key.down)) {
      this.selectedMenu = (this.selectedMenu + 1) % options.length;
      this.markChanged();
      return;
    }

    if (!isEnter(data) && !isSpace(data)) return;

    const option = options[this.selectedMenu];
    if (!option) return;

    switch (option.action) {
      case "hide":
        this.hideToChat();
        return;
      case "quit":
        this.quitGame();
        return;
      case "restart":
        this.restart();
        return;
      case "resume":
        this.resume();
        return;
    }
  }

  private getGhostY(): number {
    if (this.mode !== "playing" || this.state.gameOver) return this.state.current.y;

    let ghostY = this.state.current.y;
    while (this.canPlace(this.state.current.matrix, this.state.current.x, ghostY + 1)) {
      ghostY++;
    }
    return ghostY;
  }

  private getDisplayCell(x: number, y: number, ghostY: number): Cell | "ghost" {
    const currentCell = this.pieceCellAt(this.state.current, x, y);
    if (currentCell) return currentCell;

    const boardCell = this.state.board[y]?.[x] ?? null;
    if (boardCell) return boardCell;

    if (
      ghostY !== this.state.current.y &&
      this.pieceCellAt({ ...this.state.current, y: ghostY }, x, y)
    ) {
      return "ghost";
    }

    return null;
  }

  private pieceCellAt(piece: FallingPiece, boardX: number, boardY: number): Cell {
    const pieceX = boardX - piece.x;
    const pieceY = boardY - piece.y;
    if (pieceX < 0 || pieceY < 0) return null;
    return piece.matrix[pieceY]?.[pieceX] ?? null;
  }

  private renderPlayfieldLines(): string[] {
    const ghostY = this.getGhostY();
    const lines = [this.playfieldTopBorder()];

    for (let y = 0; y < BOARD_HEIGHT; y++) {
      let boardLine = "";
      for (let x = 0; x < BOARD_WIDTH; x++) {
        boardLine += this.renderCell(this.getDisplayCell(x, y, ghostY));
      }
      lines.push(this.playfieldRow(boardLine));
    }

    lines.push(this.playfieldBottomBorder());
    return lines;
  }

  private renderSidePanel(width: number): string[] {
    const innerWidth = Math.max(0, width - 2);
    const border = (text: string) => this.theme.fg("border", text);
    const row = (content: string) => `${border("│")}${this.fit(content, innerWidth)}${border("│")}`;
    const separator = () => border(`├${"─".repeat(innerWidth)}┤`);

    return [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(this.center(this.theme.fg("accent", this.theme.bold("NEXT")), innerWidth)),
      row(""),
      ...this.renderNextPreviewRows().map((previewLine) =>
        row(this.center(previewLine, innerWidth)),
      ),
      row(""),
      separator(),
      row(` Score ${this.theme.fg("warning", String(this.state.score))}`),
      row(` High ${this.theme.fg("success", String(this.state.highScore))}`),
      row(` Level ${this.state.level}`),
      row(` Lines ${this.state.lines}`),
      separator(),
      row(" ←→ move"),
      row(" ↑ rotate"),
      row(" ↓ soft"),
      row(" Space drop"),
      row(" Enter menu"),
      row(" Esc hide"),
      row(""),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
  }

  private renderCompactNextPreview(innerWidth: number): string[] {
    return [
      this.center(this.theme.fg("accent", this.theme.bold("NEXT")), innerWidth),
      ...this.renderNextPreviewRows().map((previewLine) => this.center(previewLine, innerWidth)),
    ];
  }

  private renderNextPreviewRows(): string[] {
    const matrix = PIECE_MATRICES[this.state.next];
    const pieceWidth = matrixWidth(matrix);
    const pieceHeight = matrix.length;
    const leftPad = Math.max(0, Math.floor((4 - pieceWidth) / 2));
    const topPad = Math.max(0, Math.floor((4 - pieceHeight) / 2));
    const lines: string[] = [];

    for (let y = 0; y < 4; y++) {
      let line = "";
      for (let x = 0; x < 4; x++) {
        const cell = matrix[y - topPad]?.[x - leftPad] ?? null;
        line += cell ? pieceColor(cell, "██") : "  ";
      }
      lines.push(line);
    }

    return lines;
  }

  private playfieldTopBorder(): string {
    return this.theme.fg("borderAccent", `╔${"═".repeat(PLAYFIELD_WIDTH - 2)}╗`);
  }

  private playfieldRow(cells: string): string {
    return `${this.theme.fg("borderAccent", "║")}${cells}${this.theme.fg("borderAccent", "║")}`;
  }

  private playfieldBottomBorder(): string {
    return this.theme.fg("borderAccent", `╚${"═".repeat(PLAYFIELD_WIDTH - 2)}╝`);
  }

  private renderCell(cell: Cell | "ghost"): string {
    if (!cell) return "  ";
    if (cell === "ghost") return dim("░░");
    return pieceColor(cell, "██");
  }

  private renderFooterRows(lines: string[], row: (content: string) => string): void {
    if (this.mode === "menu") {
      const options = this.getMenuOptions();
      this.selectedMenu = Math.min(this.selectedMenu, Math.max(0, options.length - 1));

      lines.push(row(` ${this.theme.fg("warning", this.theme.bold("PAUSE MENU"))}`));
      for (let i = 0; i < options.length; i++) {
        const option = options[i]!;
        const prefix = i === this.selectedMenu ? this.theme.fg("accent", "▸") : " ";
        const label = i === this.selectedMenu ? this.theme.bold(option.label) : option.label;
        lines.push(row(` ${prefix} ${label}`));
      }
      lines.push(row(` ${dim("↑↓ choose • Enter/Space select • Esc hide")}`));
      return;
    }

    if (this.state.gameOver) {
      lines.push(
        row(` ${this.theme.fg("error", this.theme.bold("GAME OVER"))}  Final ${this.state.score}`),
      );
      lines.push(row(` ${dim("Space restart • Enter menu • Esc hide")}`));
      return;
    }

    if (this.mode === "paused") {
      if (this.promptCompletionPause) {
        lines.push(
          row(` ${this.theme.fg("success", this.theme.bold("PROMPT COMPLETE"))}  Esc to chat`),
        );
        lines.push(row(` ${dim("Space resume game • Enter menu")}`));
        return;
      }

      lines.push(row(` ${this.theme.fg("warning", this.theme.bold("PAUSED"))}  Space resumes`));
      lines.push(row(` ${dim("Enter menu • Esc hide to chat")}`));
      return;
    }

    lines.push(row(` ${dim("←→ move • ↑ rotate • ↓ soft drop")}`));
    lines.push(row(` ${dim("Space hard drop • Enter menu • Esc hide")}`));
  }

  private center(content: string, width: number): string {
    const clipped = truncateToWidth(content, width, "");
    const padding = Math.max(0, width - visibleWidth(clipped));
    const left = Math.floor(padding / 2);
    return `${" ".repeat(left)}${clipped}${" ".repeat(padding - left)}`;
  }

  private fit(content: string, width: number): string {
    const clipped = truncateToWidth(content, width, "");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  private padLine(line: string, width: number): string {
    const clipped = visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }

  private markChanged(): void {
    this.version++;
    this.tui.requestRender();
  }
}

export default function tetrisExtension(pi: ExtensionAPI) {
  reloadTetrisConfig(process.cwd());
  let activeGame: TetrisComponent | undefined;

  pi.on("session_start", (_event, ctx) => {
    reloadTetrisConfig(ctx.cwd);
    notifyConfigError(ctx);
  });

  pi.on("agent_end", (_event, ctx) => {
    reloadTetrisConfig(ctx.cwd);
    if (!currentConfig.pauseOnPromptCompletion) return;
    activeGame?.pauseForPromptCompletion();
  });

  pi.registerCommand("tetris-config", {
    description: "Show /tetris config",
    handler: (_args, ctx) => {
      reloadTetrisConfig(ctx.cwd);
      ctx.ui.notify(`tetris config:\n${formatTetrisConfig(currentConfig)}`, "info");
      notifyConfigError(ctx);
      return Promise.resolve();
    },
  });

  pi.registerCommand("tetris", {
    description:
      "Open a right-side Tetris overlay. Arrows move, Space drops, Enter opens menu, Esc hides.",

    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("Tetris requires interactive mode", "error");
        return;
      }

      reloadTetrisConfig(ctx.cwd);
      notifyConfigError(ctx);

      const saved = readLatestSave(ctx.sessionManager.getEntries());
      ctx.ui.setStatus(STATUS_KEY, "Tetris: Esc hide • Enter menu");
      let component: TetrisComponent | undefined;

      try {
        await ctx.ui.custom(
          (tui, theme, _keybindings, done) => {
            component = new TetrisComponent(
              tui,
              theme,
              () => done(undefined),
              (save) => pi.appendEntry<TetrisSave>(TETRIS_SAVE_TYPE, save),
              saved,
            );
            activeGame = component;
            return component;
          },
          {
            overlay: true,
            overlayOptions: {
              anchor: "right-center",
              margin: { bottom: 1, right: 0, top: 1 },
              maxHeight: "95%",
              width: PREFERRED_OVERLAY_WIDTH,
            },
          },
        );
      } finally {
        if (activeGame === component) activeGame = undefined;
        ctx.ui.setStatus(STATUS_KEY, undefined);
      }
    },
  });
}
