/**
 * @file outputBuffer.ts
 *
 * Ring-buffer based output buffer for terminal output in a VS Code extension.
 * Supports cursor-based incremental reads, event-driven long-poll waiting,
 * idle detection, substring watching, and per-command boundary tracking.
 *
 * Based on V2 with bug fixes:
 * - Eviction keeps at least one chunk (prevents empty buffer on large appends)
 * - Proper dispose() clears all waiters and buffers
 * - exitCode tracking cleaned up on terminal close (via dispose)
 *
 * Deliberately free of any `vscode` import so the module is testable in
 * plain Node.js without a VS Code environment.
 */

import { EventEmitter } from 'node:events';
import { stripAnsi } from '../utils/ansiStrip.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single unit of terminal output stored in the ring buffer. */
export interface OutputChunk {
  /** Monotonically-increasing sequence number assigned at write time. */
  index: number;
  /** Raw terminal data, potentially containing ANSI escape sequences. */
  data: string;
  /** Unix timestamp (ms) when this chunk was appended. */
  timestamp: number;
}

/**
 * The result of a {@link OutputBuffer.read} call.
 * All fields reflect the state of the buffer at the moment of the call.
 */
export interface ReadResult {
  /** Human-readable output since the requested cursor (ANSI codes stripped). */
  output: string;
  /** Raw output since the requested cursor, including any ANSI escape codes. */
  rawOutput: string;
  /** Pass this value as `since` to the next {@link OutputBuffer.read} call to
   *  receive only chunks that arrive after this read. */
  cursor: number;
  /** `true` when no command is currently executing (or no command was ever
   *  started). `false` while a command boundary is open. */
  isComplete: boolean;
  /** Exit code of the most recently completed command, or `null` when the
   *  command is still running or the exit code was never reported. */
  exitCode: number | null;
}

/**
 * Tracks a single command's lifetime within the output stream.
 * Boundaries are created by {@link OutputBuffer.markCommandStart} and closed
 * by {@link OutputBuffer.markCommandEnd}.
 */
export interface CommandBoundary {
  /** The command line string that was executed. */
  commandLine: string;
  /** Cursor value at the moment the command started. */
  startCursor: number;
  /** Cursor value at the moment the command ended, or `null` if still running. */
  endCursor: number | null;
  /** Exit code reported by {@link OutputBuffer.markCommandEnd}, or `null`. */
  exitCode: number | null;
}

// ---------------------------------------------------------------------------
// Internal event names (kept as constants to avoid typos)
// ---------------------------------------------------------------------------

const EV_DATA = 'data' as const;
const EV_DISPOSE = 'dispose' as const;

// ---------------------------------------------------------------------------
// OutputBuffer
// ---------------------------------------------------------------------------

/**
 * A ring-buffer backed store for terminal output.
 *
 * ### Ring-buffer semantics
 * Chunks are appended and assigned a monotonically-increasing `index`.
 * When the total buffered byte count exceeds `maxBytes`, the oldest chunks are
 * evicted from the front.  Evicted chunks are permanently gone; callers that
 * hold a stale `since` cursor will simply receive output starting from the
 * oldest surviving chunk.
 *
 * ### BUG FIX: Eviction guard
 * The eviction loop keeps at least one chunk (`chunks.length > 1`) to prevent
 * the buffer from being completely emptied by a single large append.  This
 * matches V1's guard and prevents data loss.
 *
 * ### Cursor-based reads
 * Every write increments an internal sequence counter.  {@link read} accepts
 * an optional `since` cursor and returns only chunks whose `index ≥ since`.
 * The returned {@link ReadResult.cursor} is the value to pass on the *next*
 * incremental call.
 *
 * ### Event-driven waiting
 * {@link waitForOutput}, {@link waitForIdle}, and {@link waitForString} each
 * return a `Promise<boolean>` that resolves `true` on success or `false` on
 * timeout / disposal.  All pending waiters are resolved immediately when
 * {@link dispose} is called.
 *
 * ### Implements `vscode.Disposable`
 * The class exposes a `dispose()` method compatible with the VS Code
 * `Disposable` interface without importing `vscode`.
 */
export class OutputBuffer {
  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  /** Live ring-buffer contents. Oldest chunk is at index 0. */
  private chunks: OutputChunk[] = [];

  /** Accumulated byte length of all chunks currently in `chunks`. */
  private totalBytes = 0;

  /** Hard upper bound on buffered bytes. */
  private readonly maxBytes: number;

  /** Shared event bus.  Listeners are attached and removed per-waiter. */
  private readonly emitter = new EventEmitter();

  /** Ordered list of command lifetimes. */
  private commands: CommandBoundary[] = [];

  /**
   * The index that will be assigned to the **next** chunk that is appended.
   * This is also the value returned by {@link cursor} and used as the
   * `endCursor` / `startCursor` in command boundaries.
   */
  private nextChunkIndex = 0;

  /** Set to `true` permanently once {@link dispose} has been called. */
  private disposed = false;

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * @param maxBytes Maximum number of bytes to keep in the ring buffer.
   *                 When the limit is reached, the oldest chunks are dropped.
   *                 Defaults to 1 MiB (1 048 576 bytes).
   */
  constructor(maxBytes = 1_048_576) {
    this.maxBytes = maxBytes;
    // Allow many concurrent waiters without Node.js printing a warning.
    this.emitter.setMaxListeners(256);
  }

  // -------------------------------------------------------------------------
  // Write API
  // -------------------------------------------------------------------------

  /**
   * Append raw terminal output to the buffer.
   *
   * Fires the internal `data` event so that any active waiters are notified
   * synchronously before this method returns.  If the buffer exceeds
   * `maxBytes`, the oldest chunks are evicted until the limit is satisfied
   * (keeping at least one chunk to prevent total data loss).
   *
   * @param data Raw string (may contain ANSI escape sequences).
   */
  append(data: string): void {
    if (this.disposed) {
      return;
    }

    const chunk: OutputChunk = {
      index: this.nextChunkIndex++,
      data,
      timestamp: Date.now(),
    };

    this.chunks.push(chunk);
    this.totalBytes += Buffer.byteLength(data, 'utf8');

    // BUG FIX: Evict oldest chunks but always keep at least one.
    // V2 had `chunks.length > 0` which could empty the buffer entirely.
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const evicted = this.chunks.shift()!;
      this.totalBytes -= Buffer.byteLength(evicted.data, 'utf8');
    }

    // Notify all active waiters.  EventEmitter.emit() is synchronous.
    this.emitter.emit(EV_DATA, chunk);
  }

  /**
   * Record the start of a new command execution.
   *
   * Opens a {@link CommandBoundary} whose `startCursor` is the current
   * {@link cursor} value (i.e., the index of the *next* chunk to be written).
   * Call {@link markCommandEnd} when the command finishes.
   *
   * @param commandLine The full command string that was executed.
   */
  markCommandStart(commandLine: string): void {
    this.commands.push({
      commandLine,
      startCursor: this.nextChunkIndex,
      endCursor: null,
      exitCode: null,
    });
  }

  /**
   * Close the most recent open command boundary.
   *
   * If no open boundary exists this call is a no-op.
   *
   * @param exitCode The process exit code, or `null` if unknown.
   */
  markCommandEnd(exitCode: number | null): void {
    const last = this.commands[this.commands.length - 1];
    if (last !== undefined && last.endCursor === null) {
      last.endCursor = this.nextChunkIndex;
      last.exitCode = exitCode;
    }
  }

  // -------------------------------------------------------------------------
  // Read API
  // -------------------------------------------------------------------------

  /**
   * Read buffered output, optionally limiting to chunks newer than a cursor.
   *
   * Chunks that were evicted from the ring buffer before `since` are
   * permanently lost; the returned output will start from the oldest surviving
   * chunk whose index is `≥ since`.
   *
   * @param since Exclusive lower bound on chunk index.  Pass the
   *              {@link ReadResult.cursor} from a previous call to receive
   *              only new data.  Omit (or pass `0`) to receive all buffered
   *              output.
   * @returns A {@link ReadResult} snapshot.
   */
  read(since?: number): ReadResult {
    const fromIndex = since ?? 0;

    // Collect relevant chunks in arrival order (chunks array is already sorted).
    const relevant = this.chunks.filter(c => c.index >= fromIndex);

    const rawOutput = relevant.map(c => c.data).join('');
    const output = stripAnsi(rawOutput);

    const lastCommand = this.commands[this.commands.length - 1] ?? null;

    return {
      output,
      rawOutput,
      cursor: this.nextChunkIndex,
      isComplete: lastCommand === null || lastCommand.endCursor !== null,
      exitCode: lastCommand?.exitCode ?? null,
    };
  }

  /**
   * The index that will be assigned to the next chunk written to the buffer.
   * Pass this to {@link read} as `since` to obtain only output that arrives
   * *after* the moment you captured the cursor.
   */
  get cursor(): number {
    return this.nextChunkIndex;
  }

  // -------------------------------------------------------------------------
  // Asynchronous waiting
  // -------------------------------------------------------------------------

  /**
   * Resolve as soon as any new output is appended to the buffer.
   *
   * @param timeoutMs Maximum time to wait in milliseconds.
   * @returns `true` if new output arrived before the timeout; `false`
   *          if the timeout expired or the buffer was disposed.
   */
  waitForOutput(timeoutMs: number): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>(resolve => {
      let cleanup!: () => void;

      const onData = (): void => {
        cleanup();
        resolve(true);
      };

      const onTimeout = (): void => {
        cleanup();
        resolve(false);
      };

      const onDispose = (): void => {
        cleanup();
        resolve(false);
      };

      const timer = setTimeout(onTimeout, timeoutMs);

      cleanup = (): void => {
        clearTimeout(timer);
        this.emitter.off(EV_DATA, onData);
        this.emitter.off(EV_DISPOSE, onDispose);
      };

      this.emitter.once(EV_DATA, onData);
      this.emitter.once(EV_DISPOSE, onDispose);
    });
  }

  /**
   * Resolve once the terminal has been idle (no new output) for `idleMs`
   * consecutive milliseconds, or reject after `timeoutMs` total wait.
   *
   * Every time a new chunk arrives the idle countdown is reset.  The idle
   * timer starts immediately upon calling this method, so if there is already
   * no ongoing output it resolves after `idleMs`.
   *
   * @param idleMs   Duration of silence required to consider the terminal idle.
   * @param timeoutMs Maximum total wait time.
   * @returns `true` if the idle condition was met; `false` on timeout or
   *          disposal.
   */
  waitForIdle(idleMs: number, timeoutMs: number): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>(resolve => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let cleanup!: () => void;

      const armIdleTimer = (): void => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout((): void => {
          cleanup();
          resolve(true);
        }, idleMs);
      };

      const totalTimer = setTimeout((): void => {
        cleanup();
        resolve(false);
      }, timeoutMs);

      const onDispose = (): void => {
        cleanup();
        resolve(false);
      };

      cleanup = (): void => {
        clearTimeout(idleTimer);
        clearTimeout(totalTimer);
        this.emitter.off(EV_DATA, armIdleTimer);
        this.emitter.off(EV_DISPOSE, onDispose);
      };

      this.emitter.on(EV_DATA, armIdleTimer);
      this.emitter.once(EV_DISPOSE, onDispose);

      // Start the idle countdown immediately; if nothing writes during idleMs
      // the promise resolves without ever needing a data event.
      armIdleTimer();
    });
  }

  /**
   * Resolve once the accumulated output since `sinceCursor` contains `needle`.
   *
   * The check is performed against the ANSI-stripped output so that plain-text
   * needles are matched even when the terminal interleaves colour codes within
   * the target string.  The raw output is also checked as a fallback.
   *
   * If `needle` is already present in the buffered output at the time of the
   * call, the promise resolves on the next microtask tick.
   *
   * @param needle      Substring to search for.
   * @param sinceCursor Only consider output at or after this cursor position.
   * @param timeoutMs   Maximum wait time in milliseconds.
   * @returns `true` if `needle` was found; `false` on timeout or disposal.
   */
  waitForString(
    needle: string,
    sinceCursor: number,
    timeoutMs: number,
  ): Promise<boolean> {
    if (this.disposed) {
      return Promise.resolve(false);
    }

    // Fast-path: the needle may already be present in the buffered data.
    const immediate = this.read(sinceCursor);
    if (
      immediate.output.includes(needle) ||
      immediate.rawOutput.includes(needle)
    ) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>(resolve => {
      let cleanup!: () => void;

      const checkNeedle = (): void => {
        const result = this.read(sinceCursor);
        if (
          result.output.includes(needle) ||
          result.rawOutput.includes(needle)
        ) {
          cleanup();
          resolve(true);
        }
      };

      const onTimeout = (): void => {
        cleanup();
        resolve(false);
      };

      const onDispose = (): void => {
        cleanup();
        resolve(false);
      };

      const timer = setTimeout(onTimeout, timeoutMs);

      cleanup = (): void => {
        clearTimeout(timer);
        this.emitter.off(EV_DATA, checkNeedle);
        this.emitter.off(EV_DISPOSE, onDispose);
      };

      this.emitter.on(EV_DATA, checkNeedle);
      this.emitter.once(EV_DISPOSE, onDispose);
    });
  }

  // -------------------------------------------------------------------------
  // Command-boundary helpers
  // -------------------------------------------------------------------------

  /**
   * Exit code of the most recently *completed* command.
   *
   * Searches backwards through the command list so that a currently-running
   * command does not obscure the previous completed exit code.
   *
   * @returns The exit code, or `null` if no command has completed yet.
   */
  get lastExitCode(): number | null {
    for (let i = this.commands.length - 1; i >= 0; i--) {
      const cmd = this.commands[i];
      if (cmd.endCursor !== null) {
        return cmd.exitCode;
      }
    }
    return null;
  }

  /**
   * `true` while a command boundary is open (i.e., {@link markCommandStart}
   * has been called but the corresponding {@link markCommandEnd} has not).
   */
  get isCommandRunning(): boolean {
    const last = this.commands[this.commands.length - 1];
    return last !== undefined && last.endCursor === null;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Release all resources held by this buffer.
   *
   * - All active {@link waitForOutput} / {@link waitForIdle} /
   *   {@link waitForString} promises resolve immediately with `false`.
   * - All timers are cancelled (via the waiter cleanup functions).
   * - The chunk ring-buffer and command history are cleared.
   * - The exitCode map (if external) should be cleaned by the caller.
   *
   * Calling any method after `dispose()` is safe but a no-op (reads return
   * empty results; appends are silently discarded).
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    // Synchronously notify all pending waiters before clearing listeners.
    this.emitter.emit(EV_DISPOSE);
    this.emitter.removeAllListeners();

    this.chunks = [];
    this.commands = [];
    this.totalBytes = 0;
  }
}
