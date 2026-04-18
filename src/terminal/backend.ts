/**
 * @file backend.ts
 *
 * Abstract terminal backend interface — the seam between the orchestrator
 * (control plane) and the terminal runtime (execution plane).
 *
 * Implementations:
 * - {@link TerminalManager} (current) — uses VS Code terminal API directly.
 * - DaemonTerminalBackend (future, Phase 3) — delegates to an external PTY
 *   daemon process, enabling the execution plane to outlive the VS Code window.
 *
 * The interface is intentionally a subset of TerminalManager's public API,
 * covering only the operations the orchestrator and MCP tools actually call.
 * TerminalManager satisfies this interface via structural typing — no explicit
 * `implements` clause required.
 */

import type {
  TerminalCreateParams,
  TerminalCreateResult,
  TerminalSendParams,
  TerminalSendResult,
  TerminalSendKeysParams,
  TerminalSendKeysResult,
  TerminalReadParams,
  TerminalCloseParams,
  TerminalCloseResult,
  TerminalScreenshotParams,
  TerminalScreenshotResult,
  TerminalListResult,
} from './manager.js';
import type { ReadResult } from './outputBuffer.js';

// ---------------------------------------------------------------------------
// ITerminalBackend
// ---------------------------------------------------------------------------

export interface ITerminalBackend {
  /** Number of currently managed terminals. */
  readonly count: number;

  /** Create a new managed terminal. */
  create(params: TerminalCreateParams): Promise<TerminalCreateResult>;

  /** Send text to a terminal (like typing a command). */
  send(params: TerminalSendParams): Promise<TerminalSendResult>;

  /** Send special key sequences (ctrl+c, arrows, etc.). */
  sendKeys(params: TerminalSendKeysParams): Promise<TerminalSendKeysResult>;

  /** Type text via keyboard simulation (TUI-safe). */
  type(params: { terminalId: string; text: string; submit?: boolean }): Promise<{ typed: string; submitted: boolean }>;

  /** Read terminal output incrementally with optional long-poll waiting. */
  read(params: TerminalReadParams): Promise<ReadResult>;

  /** Get a text snapshot of recent terminal output. */
  screenshot(params: TerminalScreenshotParams): TerminalScreenshotResult;

  /** Close and dispose a terminal. */
  close(params: TerminalCloseParams): Promise<TerminalCloseResult>;

  /** List all currently tracked terminals. */
  list(): TerminalListResult;

  /**
   * Get the VS Code Terminal object by managed ID.
   *
   * Returns `undefined` if no live terminal matches, or if the backend
   * is non-VS Code (e.g. future daemon backend). The orchestrator must
   * check for existence before calling.
   */
  getVscodeTerminal?(id: string): unknown;
}
