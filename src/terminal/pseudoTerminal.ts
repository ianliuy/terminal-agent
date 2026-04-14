/**
 * @file pseudoTerminal.ts
 *
 * A {@link vscode.Pseudoterminal} implementation that drives a real shell via
 * `child_process.spawn` (no native node-pty required).  All output is mirrored
 * into an {@link OutputBuffer} so MCP tools can read it at any time.
 *
 * Based on V2 with:
 * - BUG FIX: `writeToShell` throws when stdin is not writable (instead of silent drop)
 * - Proper cleanup on close (kill child process, dispose emitters and buffer)
 *
 * @remarks
 * ### Limitations (TODO)
 * Because we use `child_process.spawn` with plain pipes instead of a real PTY
 * (node-pty), the following limitations apply:
 * - **No job control**: `ctrl+z` (SIGTSTP), `fg`, `bg` do not work.
 * - **No readline/ncurses**: Interactive programs that require termios
 *   (vim, less, htop, ssh) will not render correctly.
 * - **`isatty()` returns false**: Some tools change behavior — e.g., `ls` won't
 *   colorize, `git` won't use a pager.
 * - **`TERM=xterm-256color` is misleading**: We advertise terminal capabilities
 *   that aren't backed by a real PTY. Programs querying terminfo may crash or
 *   produce garbled output.
 * - **No SIGWINCH**: Terminal resize events are not propagated to the child process.
 *
 * For AI-agent-driven command execution (`ls && grep && make`-style), these
 * trade-offs are acceptable.  For interactive use, consider a node-pty backend.
 */

import * as vscode from 'vscode';
import { spawn, ChildProcess } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { OutputBuffer } from './outputBuffer.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options forwarded to the underlying shell process. */
export interface PtyShellOptions {
  /** Absolute path to the shell binary. */
  shellPath: string;
  /** Arguments passed to the shell (e.g. `['--nologo']`). */
  shellArgs?: string[];
  /** Working directory for the shell process.  Defaults to the OS home directory. */
  cwd?: string;
  /** Extra environment variables merged on top of the inherited `process.env`. */
  env?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Wraps a shell child-process behind the {@link vscode.Pseudoterminal} interface.
 *
 * All text written to the terminal is also appended to {@link outputBuffer} so
 * MCP tools can read captured output without scraping the UI.
 */
export class AgentPseudoterminal implements vscode.Pseudoterminal {
  // VS Code Pseudoterminal event emitters
  private readonly writeEmitter = new vscode.EventEmitter<string>();
  private readonly closeEmitter = new vscode.EventEmitter<number | void>();
  private readonly nameEmitter = new vscode.EventEmitter<string>();

  /** Fires text that should be rendered in the VS Code terminal. */
  readonly onDidWrite = this.writeEmitter.event;
  /** Fires when the shell process exits (exit code or void for forced close). */
  readonly onDidClose = this.closeEmitter.event;
  /** Fires when the terminal tab name should change. */
  readonly onDidChangeName = this.nameEmitter.event;

  /** Ring-buffer of all output written to this terminal. */
  readonly outputBuffer: OutputBuffer;

  private process: ChildProcess | null = null;
  private closed = false;
  private cols = 80;
  private rows = 24;

  /**
   * @param options       Shell binary and launch options.
   * @param maxBufferBytes  Maximum byte capacity of the output ring-buffer.
   */
  constructor(
    private readonly options: PtyShellOptions,
    maxBufferBytes?: number,
  ) {
    this.outputBuffer = new OutputBuffer(maxBufferBytes);
  }

  // -------------------------------------------------------------------------
  // vscode.Pseudoterminal interface
  // -------------------------------------------------------------------------

  /**
   * Called by VS Code when the terminal is shown.  Spawns the shell and wires
   * up I/O pipes.
   */
  open(initialDimensions: vscode.TerminalDimensions | undefined): void {
    if (initialDimensions) {
      this.cols = initialDimensions.columns;
      this.rows = initialDimensions.rows;
    }

    const shellName = path.basename(this.options.shellPath);
    this.emit(
      `\r\n\x1b[1;32m▶ Terminal Agent\x1b[0m — shell: \x1b[33m${shellName}\x1b[0m\r\n\r\n`,
    );

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...this.options.env,
      COLUMNS: String(this.cols),
      LINES: String(this.rows),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
    };

    const isWindows = os.platform() === 'win32';

    try {
      this.process = spawn(this.options.shellPath, this.options.shellArgs ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.options.cwd ?? os.homedir(),
        env,
        shell: false,
        ...(isWindows ? { windowsHide: true } : {}),
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.emit(`\r\n\x1b[1;31mFailed to spawn shell:\x1b[0m ${msg}\r\n`);
      this.closeEmitter.fire(1);
      return;
    }

    // stdout → terminal + buffer
    this.process.stdout?.on('data', (chunk: Buffer) => {
      const text = toVtNewlines(chunk.toString('utf8'));
      this.emit(text);
      this.outputBuffer.append(text);
    });

    // stderr → terminal + buffer  (shown in-band so the user sees errors)
    this.process.stderr?.on('data', (chunk: Buffer) => {
      const text = toVtNewlines(chunk.toString('utf8'));
      this.emit(text);
      this.outputBuffer.append(text);
    });

    // Spawn / pipe errors (e.g. stdin broken pipe after early exit)
    this.process.on('error', (err: Error) => {
      const text = toVtNewlines(`\nShell process error: ${err.message}\n`);
      this.emit(`\x1b[31m${text}\x1b[0m`);
      this.outputBuffer.append(text);
    });

    // Shell exit
    this.process.on('close', (code: number | null) => {
      if (this.closed) {
        return;
      }
      this.closed = true;
      const exitCode = code ?? 0;
      const notice = `\r\n\x1b[90mProcess exited with code ${exitCode}\x1b[0m\r\n`;
      this.outputBuffer.append(notice);
      this.writeEmitter.fire(notice);
      this.closeEmitter.fire(exitCode);
    });
  }

  /**
   * Called by VS Code for every keystroke / paste the user makes in the
   * terminal UI.  Raw VT sequences are forwarded verbatim to stdin.
   */
  handleInput(data: string): void {
    this.process?.stdin?.write(data);
  }

  /**
   * Called by VS Code when the terminal panel is resized.
   *
   * Without a real PTY we cannot send `SIGWINCH`, but we update the cached
   * dimensions so that subsequent `COLUMNS`/`LINES` queries reflect reality.
   */
  setDimensions(dims: vscode.TerminalDimensions): void {
    this.cols = dims.columns;
    this.rows = dims.rows;
  }

  /**
   * Called by VS Code when the user closes the terminal tab (or the extension
   * disposes it).  Kills the underlying shell process.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;

    const proc = this.process;
    if (proc !== null) {
      // Gracefully close stdin first; this signals EOF to shells like bash.
      try {
        proc.stdin?.end();
      } catch {
        // ignore — the stream may already be destroyed
      }
      // Give the process a moment to exit cleanly, then force-kill.
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          // already gone
        }
      }, 500);
      proc.once('close', () => clearTimeout(killTimer));
      proc.kill();
      this.process = null;
    }

    this.closeEmitter.fire();
  }

  // -------------------------------------------------------------------------
  // Agent-facing API
  // -------------------------------------------------------------------------

  /**
   * Programmatically write text to the shell's stdin.
   *
   * BUG FIX: Throws an error when the process is not running or stdin is not
   * writable, instead of silently dropping data.
   *
   * @param text Text to write to the shell's stdin (e.g. `'ls -la\n'`).
   * @throws Error if the shell process is not running or stdin is closed.
   */
  writeToShell(text: string): void {
    if (!this.process || !this.process.stdin || this.process.stdin.destroyed) {
      throw new Error(
        'Cannot write to shell: process is not running or stdin is closed. ' +
        'The shell may have exited.',
      );
    }
    this.process.stdin.write(text);
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Release all resources.  Safe to call multiple times. */
  dispose(): void {
    this.close();
    this.writeEmitter.dispose();
    this.closeEmitter.dispose();
    this.nameEmitter.dispose();
    this.outputBuffer.dispose();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Fire text to the VS Code terminal UI, suppressed after close. */
  private emit(text: string): void {
    if (!this.closed) {
      this.writeEmitter.fire(text);
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers
// ---------------------------------------------------------------------------

/**
 * Normalise line endings so VS Code's terminal (which expects `\r\n`) renders
 * output correctly.  Bare `\n` and existing `\r\n` are both handled.
 */
function toVtNewlines(text: string): string {
  return text.replace(/\r?\n/g, '\r\n');
}
