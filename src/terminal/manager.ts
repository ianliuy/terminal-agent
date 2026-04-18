/**
 * @file manager.ts
 *
 * Central TerminalManager that the MCP server uses to create, send, read,
 * list, and close terminals.  Coordinates between {@link ShellIntegrationManager}
 * (normal mode) and {@link AgentPseudoterminal} (PTY mode).
 *
 * Based on V2 with:
 * - Cherry-pick from V1: 30-second grace period on external close
 * - Cherry-pick from V3: adopt ALL existing terminals on activation
 * - Bug fix: `text` vs `command` naming — standardized on `text` (matches MCP schema)
 * - Bug fix: `waitForIdle` consistently treated as number (ms)
 * - Bug fix: `waitForString` argument key corrected (was reading wrong field)
 */

import * as vscode from 'vscode';
import * as os from 'node:os';
import { OutputBuffer, ReadResult } from './outputBuffer.js';
import { ShellIntegrationManager } from './shellIntegration.js';
import { AgentPseudoterminal, PtyShellOptions } from './pseudoTerminal.js';
import { stripAnsi } from '../utils/ansiStrip.js';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ShellType = 'pwsh' | 'bash' | 'wsl' | 'cmd' | 'zsh' | 'fish';

export interface ManagedTerminal {
  id: string;
  terminal: vscode.Terminal;
  name: string;
  shellType: ShellType | undefined;
  mode: 'normal' | 'pty';
  outputBuffer: OutputBuffer;
  pseudoTerminal?: AgentPseudoterminal;
  createdAt: number;
  /**
   * Set to `true` when the terminal is closed externally (user clicks ×).
   * The entry stays in the map for {@link CLOSE_GRACE_PERIOD_MS} so pending
   * reads can still return buffered data.
   */
  closed: boolean;
}

// --- Tool parameter / result interfaces -------------------------------------

export interface TerminalCreateParams {
  /** Human-readable display name for the terminal tab. Defaults to the generated ID. */
  name?: string;
  /** Shell to launch. Defaults to the system default. */
  shell?: ShellType;
  /**
   * Terminal mode.
   * - `'normal'` (default): standard VS Code terminal with Shell Integration output capture.
   * - `'pty'`: extension-controlled pseudoterminal that spawns a real shell process.
   */
  mode?: 'normal' | 'pty';
  /** Initial working directory for the shell. Defaults to the OS home directory. */
  cwd?: string;
  /** Additional environment variables to merge into the shell environment. */
  env?: Record<string, string>;
  /** Extra arguments forwarded to the shell binary. */
  shellArgs?: string[];
  /** Whether to bring the terminal panel into view after creation. Defaults to `true`. */
  show?: boolean;
  /**
   * Where to place the new terminal.
   * - `'panel'` (default): new tab in the terminal panel.
   * - `'editor'`: open as an editor tab (side by side with code).
   * - `'split'`: split alongside an existing terminal (specify `splitTerminalId`).
   */
  location?: 'panel' | 'editor' | 'split';
  /** When `location` is `'split'`, the ID of the terminal to split from. If omitted, splits from the active terminal. */
  splitTerminalId?: string;
}

export interface TerminalCreateResult {
  terminalId: string;
  name: string;
  mode: 'normal' | 'pty';
  /**
   * `true` if the VS Code Shell Integration API became ready within the wait
   * window (normal mode only).  Always `false` for PTY mode.
   */
  shellIntegrationReady: boolean;
}

export interface TerminalSendParams {
  terminalId: string;
  /** Text to write to the terminal (command string). */
  text: string;
  /**
   * Append a newline after the text.
   * Applies to PTY mode and the `sendText` fallback in normal mode.
   * Shell Integration's `executeCommand` always submits with Enter.
   * Defaults to `true`.
   */
  addNewline?: boolean;
}

export interface TerminalSendResult {
  /**
   * `true` when the VS Code Shell Integration `executeCommand` API was used
   * (preferred path).  `false` when `terminal.sendText` was the fallback.
   */
  usedShellIntegration: boolean;
}

export interface TerminalSendKeysParams {
  terminalId: string;
  /**
   * Ordered list of keys to transmit.  Each entry is one of:
   * - A named key: `'enter'`, `'tab'`, `'escape'`, `'ctrl+c'`, `'alt+b'`, `'f1'`, …
   * - A literal string which is sent verbatim.
   */
  keys: string[];
}

export interface TerminalSendKeysResult {
  /** The resolved VT sequences that were actually transmitted, in order. */
  sent: string[];
}

export interface TerminalReadParams {
  terminalId: string;
  /**
   * Cursor value returned by a previous `read` call.  Only chunks at or after
   * this index are included.  Omit to receive all buffered output.
   */
  since?: number;
  /**
   * Long-poll delay in milliseconds.
   * - Without a `waitFor*` flag: plain sleep before the read.
   * - With a `waitFor*` flag: maximum wait timeout (default: 30 s).
   */
  waitMs?: number;
  /** Wait until any new output arrives (up to `waitMs`). */
  waitForOutput?: boolean;
  /**
   * Wait until the terminal produces no output for this many consecutive
   * milliseconds.  Always a number (ms), never boolean.
   * Uses `waitMs` as the total timeout (default: 30 s).
   */
  waitForIdle?: number;
  /**
   * Wait until the output since `since` contains this substring.
   * Checked against ANSI-stripped output and raw output.
   * Uses `waitMs` as the total timeout (default: 30 s).
   */
  waitForString?: string;
  /** When `true`, `rawOutput` in the result includes ANSI escape codes. */
  raw?: boolean;
  /** Limit the returned output to this many trailing lines. */
  maxLines?: number;
}

export interface TerminalListItem {
  id: string;
  name: string;
  shellType: ShellType | undefined;
  mode: 'normal' | 'pty';
  createdAt: number;
  isCommandRunning: boolean;
  /** Index in the VS Code terminals array — adjacent indices with same group are split panes. */
  arrayIndex: number;
  /** Diagnostic: location info from creationOptions if available. */
  locationInfo?: string;
}

export interface TerminalListResult {
  terminals: TerminalListItem[];
}

export interface TerminalCloseParams {
  terminalId: string;
}

export interface TerminalCloseResult {
  closed: boolean;
}

export interface TerminalScreenshotParams {
  terminalId: string;
  /**
   * Number of trailing lines to return (approximates the visible screen height).
   * Defaults to 50.
   */
  maxLines?: number;
}

export interface TerminalScreenshotResult {
  /** Plain-text content of the approximated visible screen, ANSI codes stripped. */
  content: string;
  lineCount: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default timeout used for `waitFor*` options when `waitMs` is not specified. */
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;

/** Maximum milliseconds to wait for Shell Integration to become ready on creation. */
const SHELL_INTEGRATION_WAIT_MS = 5_000;

/**
 * Grace period after a terminal is closed externally — the entry stays in the
 * map so pending reads can still return buffered data.
 * Cherry-picked from V1.
 */
const CLOSE_GRACE_PERIOD_MS = 30_000;

/**
 * Full VT100/xterm escape-sequence table (case-insensitive keys).
 *
 * Named keys are looked up after lowercasing and trimming the input.
 * `alt+<key>` patterns are handled dynamically in {@link TerminalManager.keyToSequence}.
 */
const KEY_SEQUENCES: ReadonlyMap<string, string> = new Map([
  // ── Control characters ─────────────────────────────────────────────────
  ['ctrl+a', '\x01'],
  ['ctrl+b', '\x02'],
  ['ctrl+c', '\x03'],
  ['ctrl+d', '\x04'],
  ['ctrl+e', '\x05'],
  ['ctrl+f', '\x06'],
  ['ctrl+g', '\x07'],
  ['ctrl+h', '\x08'],
  ['ctrl+i', '\x09'], // same as tab
  ['ctrl+j', '\x0a'], // same as newline
  ['ctrl+k', '\x0b'],
  ['ctrl+l', '\x0c'],
  ['ctrl+m', '\x0d'], // same as carriage return
  ['ctrl+n', '\x0e'],
  ['ctrl+o', '\x0f'],
  ['ctrl+p', '\x10'],
  ['ctrl+q', '\x11'],
  ['ctrl+r', '\x12'],
  ['ctrl+s', '\x13'],
  ['ctrl+t', '\x14'],
  ['ctrl+u', '\x15'],
  ['ctrl+v', '\x16'],
  ['ctrl+w', '\x17'],
  ['ctrl+x', '\x18'],
  ['ctrl+y', '\x19'],
  ['ctrl+z', '\x1a'],
  // ── Named special keys ──────────────────────────────────────────────────
  ['enter',     '\r'],
  ['return',    '\r'],
  ['tab',       '\t'],
  ['escape',    '\x1b'],
  ['esc',       '\x1b'],
  ['backspace', '\x7f'],
  ['delete',    '\x1b[3~'],
  ['insert',    '\x1b[2~'],
  // ── Cursor movement ─────────────────────────────────────────────────────
  ['up',    '\x1b[A'],
  ['down',  '\x1b[B'],
  ['right', '\x1b[C'],
  ['left',  '\x1b[D'],
  // ── Navigation ──────────────────────────────────────────────────────────
  ['home',     '\x1b[H'],
  ['end',      '\x1b[F'],
  ['pageup',   '\x1b[5~'],
  ['pagedown', '\x1b[6~'],
  // ── Function keys (xterm: SS3 for F1–F4, CSI tilde for F5–F12) ─────────
  ['f1',  '\x1bOP'],
  ['f2',  '\x1bOQ'],
  ['f3',  '\x1bOR'],
  ['f4',  '\x1bOS'],
  ['f5',  '\x1b[15~'],
  ['f6',  '\x1b[17~'],
  ['f7',  '\x1b[18~'],
  ['f8',  '\x1b[19~'],
  ['f9',  '\x1b[20~'],
  ['f10', '\x1b[21~'],
  ['f11', '\x1b[23~'],
  ['f12', '\x1b[24~'],
]);

// ---------------------------------------------------------------------------
// TerminalManager
// ---------------------------------------------------------------------------

/**
 * Central manager for agent-controlled VS Code terminals.
 *
 * ### Modes
 * - **normal** (default): Creates a `vscode.Terminal` with standard shell options.
 *   The {@link ShellIntegrationManager} listens for execution start/end events
 *   and pipes output into an {@link OutputBuffer}.
 * - **pty**: Creates a `vscode.Terminal` with `ExtensionTerminalOptions` backed by
 *   an {@link AgentPseudoterminal} that spawns a real shell via `child_process.spawn`
 *   and captures all stdout/stderr output directly.
 *
 * ### Terminal adoption (cherry-picked from V3)
 * On construction the manager scans `vscode.window.terminals` and adopts ALL
 * existing terminals.  Agent-prefixed terminals get full tracking; user
 * terminals are tracked read-only so shell integration output is captured.
 *
 * ### Session recovery
 * Agent-prefixed terminals (`"agent-"`) survive extension reloads with
 * rebuilt tracking state (fresh OutputBuffer, historical output lost).
 *
 * ### Concurrency
 * Create and close operations are serialised through a promise-chain mutex to
 * avoid race conditions when the MCP server handles concurrent requests.
 *
 * @implements {vscode.Disposable}
 */
export class TerminalManager implements vscode.Disposable {
  private readonly terminals = new Map<string, ManagedTerminal>();
  private readonly shellIntegration: ShellIntegrationManager;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly maxBufferBytes: number;
  private readonly log = logger.withContext('TerminalManager');

  /** Monotonic counter appended to generated IDs to guarantee uniqueness. */
  private idCounter = 0;

  /** Simple mutex: every mutually-exclusive operation is chained onto this promise. */
  private operationQueue: Promise<unknown> = Promise.resolve();

  /**
   * @param maxBufferBytes  Maximum byte capacity of each terminal's ring-buffer.
   *                        Defaults to 1 MiB (1 048 576 bytes).
   */
  constructor(maxBufferBytes = 1_048_576) {
    this.maxBufferBytes = maxBufferBytes;

    this.shellIntegration = new ShellIntegrationManager(
      (terminal) => this.findBuffer(terminal),
    );

    // React to terminals closed externally (user clicks ×, another extension, etc.).
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) =>
        this.handleExternalClose(terminal),
      ),
    );

    // Auto-adopt any terminal opened by the user or other extensions.
    this.disposables.push(
      vscode.window.onDidOpenTerminal((terminal) =>
        this.adoptTerminal(terminal),
      ),
    );

    this.adoptExistingTerminals();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new managed terminal.
   *
   * For **normal** mode, a standard `vscode.Terminal` is created and the manager
   * waits up to {@link SHELL_INTEGRATION_WAIT_MS} for the Shell Integration API
   * to become available.
   *
   * For **pty** mode, an `AgentPseudoterminal` is created first and passed as
   * the `pty` property of `ExtensionTerminalOptions`.  The pseudoterminal spawns
   * the real shell process when VS Code calls its `open()` method.
   *
   * @param params  Creation options.
   * @returns       Metadata including the assigned `terminalId`.
   */
  async create(params: TerminalCreateParams): Promise<TerminalCreateResult> {
    return this.withMutex(async () => {
      const mode = params.mode ?? 'normal';
      const id = this.generateId();
      const name = params.name ?? id;
      const show = params.show ?? true;
      const shellType = params.shell;
      const shellPath = this.resolveShellPath(shellType);

      this.log.info(
        `Creating terminal: id=${id} name=${name} mode=${mode} shell=${shellType ?? 'default'}`,
      );

      let terminal: vscode.Terminal;
      let outputBuffer: OutputBuffer;
      let pseudoTerminal: AgentPseudoterminal | undefined;

      if (mode === 'pty') {
        const resolvedShellPath = shellPath ?? this.defaultShellPath();
        const ptyOptions: PtyShellOptions = {
          shellPath: resolvedShellPath,
          shellArgs: params.shellArgs,
          cwd: params.cwd,
          env: params.env,
        };

        pseudoTerminal = new AgentPseudoterminal(ptyOptions, this.maxBufferBytes);
        // The buffer is owned by the pseudoterminal; share the reference.
        outputBuffer = pseudoTerminal.outputBuffer;

        const termOptions: vscode.ExtensionTerminalOptions = {
          name,
          pty: pseudoTerminal,
        };
        terminal = vscode.window.createTerminal(termOptions);
      } else {
        // Normal mode: TerminalManager owns the OutputBuffer.
        outputBuffer = new OutputBuffer(this.maxBufferBytes);

        const loc = params.location ?? 'split';

        if (loc === 'split') {
          // === AgentLink Pattern ===
          // VS Code bug #205254: createTerminal({ location: { parentTerminal } })
          // silently fails in Remote/Tunnel due to a race condition in ID resolution.
          // Workaround: focus parent → onDidOpenTerminal listener → split command → rename.

          // 1. Find the parent terminal to split from
          let parent: vscode.Terminal | undefined;
          if (params.splitTerminalId) {
            // Look up by managed ID first, then by name in all VS Code terminals
            parent = this.terminals.get(params.splitTerminalId)?.terminal
              ?? vscode.window.terminals.find(t => t.name === params.splitTerminalId);
          } else {
            // Default: split from the active terminal (where user's focus is)
            parent = vscode.window.activeTerminal
              ?? vscode.window.terminals[vscode.window.terminals.length - 1];
          }

          if (!parent) {
            throw new Error(
              'No terminal available to split from. Create a terminal first or specify splitTerminalId.',
            );
          }

          // 2. Focus the parent so the split command targets it
          parent.show(false);
          await new Promise(r => setTimeout(r, 150));

          // 3. Register one-shot listener BEFORE executing split command
          const newTerminalPromise = new Promise<vscode.Terminal>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              disposable.dispose();
              reject(new Error('Split terminal creation timed out after 5s'));
            }, 5000);

            const disposable = vscode.window.onDidOpenTerminal(t => {
              clearTimeout(timeoutId);
              disposable.dispose();
              resolve(t);
            });
          });

          // 4. Execute split with config (forwards cwd/env/shell to the new pane)
          const splitConfig: Record<string, unknown> = {};
          if (params.cwd) { splitConfig.cwd = params.cwd; }
          if (params.env) { splitConfig.env = params.env; }
          if (shellPath) { splitConfig.executable = shellPath; }
          if (params.shellArgs) { splitConfig.args = params.shellArgs; }

          if (Object.keys(splitConfig).length > 0) {
            await vscode.commands.executeCommand('workbench.action.terminal.split', {
              config: splitConfig,
            });
          } else {
            await vscode.commands.executeCommand('workbench.action.terminal.split');
          }

          // 5. Wait for the split terminal to appear
          const splitTerminal = await newTerminalPromise;

          // 6. Rename — split command doesn't reliably pass name through
          splitTerminal.show(false);
          await new Promise(r => setTimeout(r, 50));
          await vscode.commands.executeCommand(
            'workbench.action.terminal.renameWithArg',
            { name },
          );

          terminal = splitTerminal;

          this.log.info(
            `Split created: name=${name}, parent=${parent.name}`,
          );
        } else if (loc === 'editor') {
          terminal = vscode.window.createTerminal({
            name,
            ...(shellPath !== undefined && { shellPath }),
            ...(params.shellArgs !== undefined && { shellArgs: params.shellArgs }),
            ...(params.cwd !== undefined && { cwd: params.cwd }),
            ...(params.env !== undefined && { env: params.env }),
            location: vscode.TerminalLocation.Editor,
          });
        } else {
          terminal = vscode.window.createTerminal({
            name,
            ...(shellPath !== undefined && { shellPath }),
            ...(params.shellArgs !== undefined && { shellArgs: params.shellArgs }),
            ...(params.cwd !== undefined && { cwd: params.cwd }),
            ...(params.env !== undefined && { env: params.env }),
          });
        }
      }

      if (show) {
        terminal.show(/* preserveFocus */ true);
      }

      // Clean up any duplicate entry created by adoptTerminal race:
      // onDidOpenTerminal fires for ALL listeners; the constructor's adoptTerminal
      // may have already added this terminal before our AgentLink/create resolves.
      for (const [existingId, existing] of this.terminals.entries()) {
        if (existing.terminal === terminal) {
          existing.outputBuffer.dispose();
          this.terminals.delete(existingId);
          this.log.debug(`Removed duplicate adopt entry: ${existingId} (superseded by ${id})`);
          break;
        }
      }

      const managed: ManagedTerminal = {
        id,
        terminal,
        name,
        shellType,
        mode,
        outputBuffer,
        pseudoTerminal,
        createdAt: Date.now(),
        closed: false,
      };
      this.terminals.set(id, managed);

      // For normal mode, wait briefly for Shell Integration to initialise.
      let shellIntegrationReady = false;
      if (mode === 'normal') {
        shellIntegrationReady = await this.shellIntegration.waitForReady(
          terminal,
          SHELL_INTEGRATION_WAIT_MS,
        );
      }

      this.log.info(
        `Terminal ready: id=${id} shellIntegration=${shellIntegrationReady}`,
      );

      return { terminalId: id, name, mode, shellIntegrationReady };
    });
  }

  /**
   * Send a command string to a terminal.
   *
   * **Normal mode** — uses the Shell Integration `executeCommand` API when
   * available (which fires execution-boundary events captured by the output
   * buffer).  Falls back to `terminal.sendText()` when Shell Integration is
   * not yet ready (e.g. cmd.exe or very early after creation).
   *
   * **PTY mode** — writes the command directly to the shell's stdin via
   * {@link AgentPseudoterminal.writeToShell}.
   *
   * @param params  Terminal ID, text, and newline preference.
   * @returns       Whether Shell Integration was used.
   */
  async send(params: TerminalSendParams): Promise<TerminalSendResult> {
    const managed = this.getManagedForAction(params.terminalId);
    const addNewline = params.addNewline ?? true;

    this.log.debug(`send: id=${params.terminalId} addNewline=${addNewline}`);

    if (managed.mode === 'pty') {
      const text = addNewline ? params.text + '\n' : params.text;
      managed.pseudoTerminal!.writeToShell(text);
      return { usedShellIntegration: false };
    }

    // Show the terminal but preserve focus to avoid sending a focus-in
    // event (\x1B[I) to the process. ConPTY can fragment the 3-byte
    // sequence, and Copilot CLI's Ink-based TUI disambiguates a lone
    // \x1B as an Escape keypress after 50ms — triggering "Operation
    // cancelled by user" during active operations. (See GitHub issue
    // github/copilot-cli#2502.)
    managed.terminal.show(/* preserveFocus */ true);
    await new Promise((r) => setTimeout(r, 150));

    // Normal mode: prefer Shell Integration for tracked execution boundaries.
    const si = managed.terminal.shellIntegration;
    if (si) {
      si.executeCommand(params.text);
      return { usedShellIntegration: true };
    }

    // Fallback: sendText (Shell Integration not yet ready).
    managed.terminal.sendText(params.text, addNewline);
    return { usedShellIntegration: false };
  }

  /**
   * Type text into a terminal by simulating keyboard input through xterm.js.
   *
   * Unlike {@link send} which writes directly to the process's stdin via
   * `terminal.sendText()`, this method uses VS Code's
   * `workbench.action.terminal.sendSequence` command which feeds characters
   * through xterm.js's input handler — the same path as physical keyboard
   * typing. This is critical for TUI applications (like Copilot CLI) that
   * distinguish between stdin writes and keyboard events.
   *
   * The target terminal is focused first (required for sendSequence), then
   * each character is sent as a keyboard event. This allows typing into
   * busy TUI applications without triggering their cancel/abort handlers.
   *
   * @param params  Terminal ID, text, and optional submit flag.
   * @returns       Confirmation of what was typed.
   */
  async type(params: { terminalId: string; text: string; submit?: boolean }): Promise<{ typed: string; submitted: boolean }> {
    const managed = this.getManagedForAction(params.terminalId);
    const submit = params.submit ?? false;

    this.log.debug(`type: id=${params.terminalId} submit=${submit} len=${params.text.length}`);

    // Focus the terminal — sendSequence only works on the active terminal
    managed.terminal.show(/* preserveFocus */ false);
    await new Promise((r) => setTimeout(r, 200));

    // Send text through xterm.js via sendSequence
    // sendSequence interprets \n as Enter, \x1b as Escape, etc.
    // We send the text as-is (no \n) to avoid premature submission
    await vscode.commands.executeCommand(
      'workbench.action.terminal.sendSequence',
      { text: params.text },
    );

    if (submit) {
      // Brief pause then send Enter (\r) through the same xterm.js path
      await new Promise((r) => setTimeout(r, 50));
      await vscode.commands.executeCommand(
        'workbench.action.terminal.sendSequence',
        { text: '\r' },
      );
    }

    return { typed: params.text, submitted: submit };
  }

  /**
   * Send one or more special keys or literal text to a terminal.
   *
   * Each entry in `params.keys` is resolved through the built-in VT100/xterm
   * key map (e.g. `'ctrl+c'` → `\x03`, `'up'` → `\x1b[A`, `'alt+b'` →
   * `\x1bb`).  Entries that do not match any known key are forwarded verbatim.
   *
   * @param params  Terminal ID and ordered key list.
   * @returns       The resolved VT sequences that were transmitted.
   */
  async sendKeys(params: TerminalSendKeysParams): Promise<TerminalSendKeysResult> {
    const managed = this.getManagedForAction(params.terminalId);
    const sent: string[] = [];

    // Show terminal with preserveFocus=true to avoid phantom Escape key.
    // See comment in send() for the full ConPTY/Ink race condition explanation.
    if (managed.mode !== 'pty') {
      managed.terminal.show(/* preserveFocus */ true);
      await new Promise((r) => setTimeout(r, 150));
    }

    for (const key of params.keys) {
      const seq = this.keyToSequence(key);
      sent.push(seq);

      if (managed.mode === 'pty') {
        managed.pseudoTerminal!.writeToShell(seq);
      } else {
        // addNewLine=false so the escape sequence is sent raw, without appending \n.
        managed.terminal.sendText(seq, /* addNewLine */ false);
      }
    }

    this.log.debug(
      `sendKeys: id=${params.terminalId} keys=[${params.keys.join(', ')}]`,
    );

    return { sent };
  }

  /**
   * Read buffered output from a terminal, with optional long-poll waiting.
   *
   * Wait conditions are evaluated in priority order (highest priority first):
   * 1. `waitForString` — resolves when output since `since` contains the needle.
   * 2. `waitForIdle`   — resolves after `waitForIdle` ms of consecutive silence.
   * 3. `waitForOutput` — resolves on any new output.
   * 4. `waitMs`        — plain sleep before the read (no other wait condition).
   *
   * Timed-out wait conditions do **not** throw; the method reads and returns
   * whatever is currently buffered.
   *
   * @param params  Read options.
   * @returns       A {@link ReadResult} snapshot of the output buffer.
   */
  async read(params: TerminalReadParams): Promise<ReadResult> {
    const managed = this.getManagedForRead(params.terminalId);
    const buffer = managed.outputBuffer;
    const waitMs = params.waitMs ?? 0;
    const timeout = waitMs > 0 ? waitMs : DEFAULT_WAIT_TIMEOUT_MS;

    // BUG FIX: waitForString — was reading wrong argument key in V2's mcpHandler.
    // Now correctly mapped: the MCP schema field `waitForString` is read here directly.
    if (params.waitForString !== undefined) {
      // Anchor the search at the caller's cursor so we don't match stale output.
      const searchCursor = params.since ?? buffer.cursor;
      const found = await buffer.waitForString(params.waitForString, searchCursor, timeout);
      if (!found) {
        this.log.debug(
          `read: waitForString="${params.waitForString}" timed out after ${timeout}ms`,
        );
      }
    } else if (params.waitForIdle !== undefined) {
      // BUG FIX: waitForIdle is always a number (ms), not boolean.
      // Schema and code are now consistent.
      const idle = await buffer.waitForIdle(params.waitForIdle, timeout);
      if (!idle) {
        this.log.debug(
          `read: waitForIdle=${params.waitForIdle}ms timed out after ${timeout}ms`,
        );
      }
    } else if (params.waitForOutput === true) {
      const got = await buffer.waitForOutput(timeout);
      if (!got) {
        this.log.debug(`read: waitForOutput timed out after ${timeout}ms`);
      }
    } else if (waitMs > 0) {
      await sleep(waitMs);
    }

    const result = buffer.read(params.since);

    if (params.maxLines !== undefined && params.maxLines > 0) {
      return {
        ...result,
        output:    trimToLastNLines(result.output,    params.maxLines),
        rawOutput: trimToLastNLines(result.rawOutput, params.maxLines),
      };
    }

    return result;
  }

  /**
   * List all currently tracked terminals (excluding closed ones past grace period).
   *
   * @returns  Summary information for every managed terminal.
   */
  list(): TerminalListResult {
    const terminals: TerminalListItem[] = [];

    // Walk vscode.window.terminals in order — this preserves group-adjacent ordering.
    // Terminals in the same split group are adjacent in this array.
    const vsTerminals = vscode.window.terminals;

    for (let i = 0; i < vsTerminals.length; i++) {
      const vsTerm = vsTerminals[i];
      // Find our managed entry for this VS Code terminal
      const managed = [...this.terminals.values()].find(
        (m) => m.terminal === vsTerm && !m.closed,
      );
      if (!managed) {
        continue;
      }

      // Probe creationOptions for any group/location info
      let locationInfo: string | undefined;
      try {
        const opts = vsTerm.creationOptions as any;
        if (opts?.location !== undefined) {
          if (typeof opts.location === 'object' && opts.location?.parentTerminal) {
            const parent = opts.location.parentTerminal;
            locationInfo = `split:parent=${parent.name ?? parent._id ?? 'unknown'}`;
          } else if (typeof opts.location === 'number') {
            // TerminalLocation enum: Panel=1, Editor=2
            locationInfo = opts.location === 1 ? 'panel' : opts.location === 2 ? 'editor' : `loc:${opts.location}`;
          } else {
            locationInfo = JSON.stringify(opts.location);
          }
        }
      } catch { /* ignore */ }

      terminals.push({
        id:               managed.id,
        name:             vsTerm.name,
        shellType:        managed.shellType,
        mode:             managed.mode,
        createdAt:        managed.createdAt,
        isCommandRunning: managed.outputBuffer.isCommandRunning,
        arrayIndex:       i,
        ...(locationInfo && { locationInfo }),
      });
    }

    return { terminals };
  }

  /**
   * Close a managed terminal and release all associated resources.
   *
   * @param params  Identifies the terminal to close.
   * @returns       `{ closed: true }` on success.
   */
  async close(params: TerminalCloseParams): Promise<TerminalCloseResult> {
    return this.withMutex(async () => {
      const managed = this.getManagedForAction(params.terminalId);

      this.log.info(`Closing terminal: ${params.terminalId}`);

      // Remove from map before disposing to prevent re-entrant handling.
      this.terminals.delete(params.terminalId);

      // PTY: dispose kills the child process and frees the buffer it owns.
      managed.pseudoTerminal?.dispose();

      // Normal: the buffer was created by TerminalManager; we free it here.
      if (managed.mode === 'normal') {
        managed.outputBuffer.dispose();
      }

      // Dispose the VS Code terminal last (triggers tab close animation).
      managed.terminal.dispose();

      return { closed: true };
    });
  }

  /**
   * Return an approximation of the terminal's current visible screen content.
   *
   * @param params  Terminal ID and optional line-count limit.
   * @returns       Plain-text screen snapshot and its line count.
   */
  screenshot(params: TerminalScreenshotParams): TerminalScreenshotResult {
    const managed = this.getManagedForRead(params.terminalId);
    const maxLines = params.maxLines ?? 50;

    const result = managed.outputBuffer.read();
    // Use stripAnsi on rawOutput for an explicit, accurate strip pass.
    const plain = stripAnsi(result.rawOutput);
    const content = trimToLastNLines(plain, maxLines);
    const lineCount = content.length === 0 ? 0 : content.split('\n').length;

    return { content, lineCount };
  }

  /** Number of currently managed terminals. */
  get count(): number {
    return this.terminals.size;
  }

  /**
   * Dispose all managed terminals and release extension-level resources.
   *
   * Safe to call multiple times.  After disposal the manager must not be used.
   */
  dispose(): void {
    this.log.info('Disposing TerminalManager');

    for (const managed of this.terminals.values()) {
      try {
        managed.pseudoTerminal?.dispose();
        if (managed.mode === 'normal') {
          managed.outputBuffer.dispose();
        }
        managed.terminal.dispose();
      } catch (err) {
        this.log.warn(`Error disposing terminal ${managed.id}`, err);
      }
    }
    this.terminals.clear();

    this.shellIntegration.dispose();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Look up a managed terminal by ID for mutating actions (send, close, sendKeys).
   * Throws if the terminal is not found or is closed.
   */
  private getManagedForAction(terminalId: string): ManagedTerminal {
    const managed = this.terminals.get(terminalId);
    if (!managed) {
      const known = [...this.terminals.keys()].join(', ') || '(none)';
      throw new Error(
        `Terminal not found: "${terminalId}". ` +
        `Active terminal IDs: [${known}]`,
      );
    }
    if (managed.closed) {
      throw new Error(
        `Terminal is closed: "${terminalId}". It was closed externally and ` +
        `is in a grace period — reads are allowed but mutations are not.`,
      );
    }
    return managed;
  }

  /**
   * Look up a managed terminal by ID for read operations.
   * Allows reads on closed-but-within-grace-period terminals (cherry-pick from V1).
   */
  private getManagedForRead(terminalId: string): ManagedTerminal {
    const managed = this.terminals.get(terminalId);
    if (!managed) {
      const known = [...this.terminals.keys()].join(', ') || '(none)';
      throw new Error(
        `Terminal not found: "${terminalId}". ` +
        `Active terminal IDs: [${known}]`,
      );
    }
    return managed;
  }

  /**
   * Find the {@link OutputBuffer} associated with a VS Code terminal instance.
   *
   * This is the {@link BufferLookup} callback passed to {@link ShellIntegrationManager}
   * so that Shell Integration events can route output to the correct buffer.
   */
  private findBuffer(terminal: vscode.Terminal): OutputBuffer | undefined {
    for (const managed of this.terminals.values()) {
      if (managed.terminal === terminal) {
        return managed.outputBuffer;
      }
    }
    return undefined;
  }

  /**
   * Resolve a {@link ShellType} to an absolute or PATH-relative shell binary path.
   *
   * Returns `undefined` when `shellType` is `undefined` so that callers can
   * signal "use the system default" to VS Code's terminal creation API.
   */
  private resolveShellPath(shellType?: ShellType): string | undefined {
    if (!shellType) {
      return undefined;
    }

    const isWindows = os.platform() === 'win32';

    switch (shellType) {
      case 'pwsh':
        return 'pwsh';

      case 'bash':
        return isWindows ? 'C:\\Windows\\System32\\bash.exe' : '/bin/bash';

      case 'wsl':
        return 'wsl.exe';

      case 'cmd':
        return 'cmd.exe';

      case 'zsh':
        return '/bin/zsh';

      case 'fish':
        // fish is rarely installed system-wide on macOS/Linux; try common paths.
        return isWindows ? 'fish' : '/usr/bin/fish';

      default: {
        // TypeScript exhaustiveness guard — fails to compile if ShellType gains values.
        const _exhaustive: never = shellType;
        return _exhaustive;
      }
    }
  }

  /**
   * Return a reasonable default shell path for the current OS.
   */
  private defaultShellPath(): string {
    switch (os.platform()) {
      case 'win32':  return 'pwsh';
      case 'darwin': return '/bin/zsh';
      default:       return '/bin/bash';
    }
  }

  /**
   * Resolve a key name to its VT100/xterm escape sequence.
   */
  private keyToSequence(key: string): string {
    const lower = key.toLowerCase().trim();

    // 1. Direct static match.
    const mapped = KEY_SEQUENCES.get(lower);
    if (mapped !== undefined) {
      return mapped;
    }

    // 2. alt+<key> → ESC prefix + inner key resolution.
    const altMatch = /^alt\+(.+)$/.exec(lower);
    if (altMatch) {
      const innerKey = altMatch[1];
      const innerSeq = KEY_SEQUENCES.get(innerKey) ?? innerKey;
      return '\x1b' + innerSeq;
    }

    // 3. Return as literal text (e.g. a plain character string).
    return key;
  }

  /**
   * Execute `fn` within the global operation mutex.
   */
  private withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(() => fn());
    // Attach a no-op catch so a failed operation does not block the queue.
    this.operationQueue = result.catch(() => undefined);
    return result;
  }

  /**
   * Adopt ALL existing terminals on activation (cherry-picked from V3).
   *
   * Agent-prefixed terminals get full tracking for session recovery.
   * Other existing terminals are also tracked so shell integration output
   * capture works if the user runs commands in them.
   */
  private adoptExistingTerminals(): void {
    for (const terminal of vscode.window.terminals) {
      this.adoptTerminal(terminal);
    }
  }

  /**
   * Adopt a single terminal into the managed map (if not already tracked).
   * Called both at startup (for existing terminals) and at runtime (via onDidOpenTerminal).
   */
  private adoptTerminal(terminal: vscode.Terminal): void {
    // Skip if already tracked.
    const alreadyTracked = [...this.terminals.values()].some(
      (m) => m.terminal === terminal,
    );
    if (alreadyTracked) {
      return;
    }

    // For agent-prefixed terminals, reuse the name as the ID (session recovery).
    // For all others, generate a new ID.
    const isAgentTerminal = terminal.name.startsWith('agent-');
    const id = isAgentTerminal ? terminal.name : this.generateId();

    this.log.info(
      `Adopting terminal: "${terminal.name}" as id=${id}` +
      (isAgentTerminal ? ' (agent session recovery)' : ' (user/external)'),
    );

    const outputBuffer = new OutputBuffer(this.maxBufferBytes);
    const managed: ManagedTerminal = {
      id,
      terminal,
      name: terminal.name,
      shellType: undefined,
      mode: 'normal',
      outputBuffer,
      createdAt: Date.now(),
      closed: false,
    };
    this.terminals.set(id, managed);
  }

  /**
   * Handle a terminal being closed from outside TerminalManager.
   *
   * Cherry-pick from V1: keep the entry in the map for {@link CLOSE_GRACE_PERIOD_MS}
   * so pending reads can still return buffered data, then clean up.
   */
  private handleExternalClose(terminal: vscode.Terminal): void {
    for (const [id, managed] of this.terminals.entries()) {
      if (managed.terminal !== terminal) {
        continue;
      }

      this.log.info(`Terminal closed externally: ${id}`);

      // Mark as closed but keep in map for grace period (V1 cherry-pick).
      managed.closed = true;

      // PTY: dispose immediately — process is gone.
      managed.pseudoTerminal?.dispose();

      // Schedule cleanup after grace period.
      setTimeout(() => {
        const current = this.terminals.get(id);
        if (current?.closed) {
          this.terminals.delete(id);
          if (current.mode === 'normal') {
            current.outputBuffer.dispose();
          }
          this.log.debug(`Grace period expired, removed terminal: ${id}`);
        }
      }, CLOSE_GRACE_PERIOD_MS);

      break;
    }
  }

  /**
   * Generate a unique terminal ID with the `"agent-"` prefix.
   */
  private generateId(): string {
    return `agent-${Date.now()}-${(++this.idCounter).toString().padStart(4, '0')}`;
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/** Promisified `setTimeout`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Return the last `n` lines of `text`.
 */
function trimToLastNLines(text: string, n: number): string {
  const lines = text.split('\n');
  if (lines.length <= n) {
    return text;
  }
  return lines.slice(lines.length - n).join('\n');
}
