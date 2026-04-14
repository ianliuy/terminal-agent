/**
 * @file shellIntegration.ts
 *
 * Manages VS Code Shell Integration API integration for tracked terminals.
 *
 * Based on V2 with:
 * - BUG FIX: null-check on `execution.commandLine.value` before accessing it
 * - CHERRY-PICK from V3: listen on ALL terminals (not just agent-created ones)
 *   so output is captured for adopted/user terminals too
 * - ANSI stripping is handled by OutputBuffer at read time (via ansiStrip util)
 * - All event listeners properly disposed via Disposable pattern
 */

import * as vscode from 'vscode';
import { OutputBuffer } from './outputBuffer.js';

/** Callback to look up the OutputBuffer for a given vscode.Terminal. */
export type BufferLookup = (terminal: vscode.Terminal) => OutputBuffer | undefined;

/**
 * Manages VS Code Shell Integration API integration for tracked terminals.
 *
 * Responsibilities:
 * - Listen for shell execution start/end events and pipe output into OutputBuffers
 * - Track which terminals have active shell integration
 * - Provide `executeCommand()` with a graceful fallback to `sendText()`
 * - Use AbortController to cancel read loops when terminals close
 * - Clean up all event subscriptions on dispose
 *
 * ### Listening on ALL terminals (cherry-pick from V3)
 * Shell Integration events fire for all terminals, not just ones the extension
 * created.  We listen globally so that adopted user terminals also get output
 * captured into their OutputBuffers (if they have one).  Terminals without a
 * buffer are silently skipped.
 */
export class ShellIntegrationManager implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  /** Terminals whose shell integration has fired at least once. */
  private readonly readyTerminals = new Set<vscode.Terminal>();

  /**
   * AbortControllers keyed by active execution so we can cancel the async
   * read loop if the terminal closes before the command finishes.
   */
  private readonly activeReaders = new Map<
    vscode.TerminalShellExecution,
    { controller: AbortController; terminal: vscode.Terminal }
  >();

  constructor(private readonly getBuffer: BufferLookup) {
    // Track terminals as their shell integration becomes available.
    this.disposables.push(
      vscode.window.onDidChangeTerminalShellIntegration(({ terminal }) => {
        this.readyTerminals.add(terminal);
      }),
    );

    // Listen on ALL terminals for execution start — output capture for
    // any terminal that has a buffer (including adopted user terminals).
    this.disposables.push(
      vscode.window.onDidStartTerminalShellExecution(async (event) => {
        await this.handleExecutionStart(event);
      }),
    );

    this.disposables.push(
      vscode.window.onDidEndTerminalShellExecution((event) => {
        this.handleExecutionEnd(event);
      }),
    );

    // When a terminal closes, cancel any in-flight read loops for it and
    // remove it from the ready set so waitForReady resolvers never fire.
    this.disposables.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        this.readyTerminals.delete(terminal);

        // Cancel all active readers belonging to this terminal.
        for (const [execution, entry] of this.activeReaders) {
          if (entry.terminal === terminal) {
            entry.controller.abort();
            this.activeReaders.delete(execution);
          }
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Returns `true` if the given terminal has shell integration ready.
   *
   * Note: cmd.exe never provides shell integration and will always return
   * `false` here.
   */
  hasShellIntegration(terminal: vscode.Terminal): boolean {
    return this.readyTerminals.has(terminal);
  }

  /**
   * Waits up to `timeoutMs` for shell integration to become ready on
   * `terminal`.
   *
   * Resolves `true` immediately if integration is already active, `false` if
   * the timeout elapses first.  The promise always resolves — it never rejects.
   */
  waitForReady(terminal: vscode.Terminal, timeoutMs: number): Promise<boolean> {
    if (this.readyTerminals.has(terminal)) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        integrationSub.dispose();
        closeSub.dispose();
        resolve(false);
      }, timeoutMs);

      const integrationSub = vscode.window.onDidChangeTerminalShellIntegration(
        ({ terminal: t }) => {
          if (t === terminal) {
            clearTimeout(timer);
            integrationSub.dispose();
            closeSub.dispose();
            resolve(true);
          }
        },
      );

      // If the terminal closes while we wait, resolve false immediately.
      const closeSub = vscode.window.onDidCloseTerminal((t) => {
        if (t === terminal) {
          clearTimeout(timer);
          integrationSub.dispose();
          closeSub.dispose();
          resolve(false);
        }
      });
    });
  }

  /**
   * Sends `command` to `terminal`, preferring the Shell Integration API when
   * available so that start/end events fire and output is captured
   * automatically.
   *
   * Falls back to `terminal.sendText()` when shell integration is unavailable
   * (e.g. cmd.exe, or before integration has initialised).
   *
   * @returns `true` if shell integration was used, `false` if `sendText` was
   *          used as a fallback.
   */
  executeCommand(terminal: vscode.Terminal, command: string): boolean {
    const si = terminal.shellIntegration;
    if (si) {
      si.executeCommand(command);
      return true;
    }

    // Fallback: no shell integration — send the text as a raw keypress.
    terminal.sendText(command, /* addNewLine */ true);
    return false;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async handleExecutionStart(
    event: vscode.TerminalShellExecutionStartEvent,
  ): Promise<void> {
    const { terminal, execution } = event;
    const buffer = this.getBuffer(terminal);

    // BUG FIX: null-check on commandLine.value before accessing it.
    // The VS Code API can return undefined commandLine when the shell
    // integration cannot determine the command being executed.
    const commandLine = execution.commandLine?.value ?? '(unknown)';

    if (buffer) {
      buffer.markCommandStart(commandLine);
    }

    // Even if there's no buffer, we still start the read loop so the
    // async iterator is consumed (VS Code requires this). We just won't
    // store the output anywhere.

    // IMPORTANT: read() must be called immediately — output produced before the
    // first read() call is permanently lost.
    const controller = new AbortController();
    this.activeReaders.set(execution, { controller, terminal });

    try {
      const stream = execution.read();
      for await (const chunk of stream) {
        if (controller.signal.aborted) {
          break;
        }
        // The OutputBuffer stores raw data; ANSI stripping happens at read time.
        buffer?.append(chunk);
      }
    } catch (err) {
      // Stream errors are non-fatal: the end event will still fire and record
      // the exit code.  Log at debug level so we don't spam the output panel.
      if (!controller.signal.aborted) {
        console.debug('[ShellIntegrationManager] read() error:', err);
      }
    } finally {
      this.activeReaders.delete(execution);
    }
  }

  private handleExecutionEnd(
    event: vscode.TerminalShellExecutionEndEvent,
  ): void {
    const { terminal, execution, exitCode } = event;

    // Cancel the read loop if it is somehow still running.
    const entry = this.activeReaders.get(execution);
    if (entry) {
      entry.controller.abort();
      this.activeReaders.delete(execution);
    }

    // Only record exit code if the terminal has a tracked buffer.
    // This prevents the exitCode map leak (BUG #15 from V3) — we don't
    // store exit codes for untracked terminals.
    const buffer = this.getBuffer(terminal);
    if (buffer) {
      // exitCode is undefined when the shell could not report it.
      buffer.markCommandEnd(exitCode ?? null);
    }
  }

  /**
   * Dispose all resources: abort in-flight readers, clear state, remove listeners.
   */
  dispose(): void {
    // Abort all in-flight read loops before tearing down event listeners so
    // the async loops exit cleanly rather than trying to write to a buffer
    // that may already be disposed.
    for (const entry of this.activeReaders.values()) {
      entry.controller.abort();
    }
    this.activeReaders.clear();
    this.readyTerminals.clear();

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
