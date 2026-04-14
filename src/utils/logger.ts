import * as vscode from 'vscode';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric priority for each log level — higher = more severe. */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO ',
  warn: 'WARN ',
  error: 'ERROR',
};

/**
 * Structured logger that writes formatted lines to a VS Code OutputChannel.
 *
 * Each line follows the format:
 *   `[ISO-TIMESTAMP] [LEVEL] [prefix] message`
 *
 * The channel is supplied externally (by the extension host) so this module
 * carries no hard dependency on a specific channel name.
 */
export class Logger implements vscode.Disposable {
  private channel: vscode.OutputChannel | null = null;
  private level: LogLevel = 'info';
  private readonly prefix: string;

  /**
   * @param prefix  Optional context prefix added after the level tag.
   *                Child loggers created via `withContext` pass their prefix here.
   */
  constructor(prefix = '') {
    this.prefix = prefix;
  }

  /**
   * Attach an OutputChannel and set the minimum log level.
   * Must be called before any log methods produce output.
   */
  init(channel: vscode.OutputChannel, level: LogLevel = 'info'): void {
    this.channel = channel;
    this.level = level;
  }

  /** Change the minimum log level at runtime. */
  setLevel(level: LogLevel): void {
    this.level = level;
  }

  /** Log a debug-level message. Filtered out unless level is `'debug'`. */
  debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  /** Log an informational message. */
  info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  /** Log a warning. */
  warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  /** Log an error. Accepts an optional `Error` as the last arg for stack traces. */
  error(message: string, ...args: unknown[]): void {
    this.write('error', message, args);
  }

  /**
   * Log an outgoing / completed tool request in a consistent structured format.
   */
  logRequest(
    method: string,
    tool: string,
    durationMs: number,
    success: boolean,
  ): void {
    const status = success ? 'OK' : 'FAIL';
    this.write(
      success ? 'info' : 'warn',
      `[REQUEST] ${method.toUpperCase()} ${tool} → ${status} (${durationMs}ms)`,
      [],
    );
  }

  /**
   * Create a child logger that prepends an additional context prefix to every
   * message.  The child shares the same channel and level as the parent.
   */
  withContext(contextPrefix: string): Logger {
    const combined = this.prefix
      ? `${this.prefix}:${contextPrefix}`
      : contextPrefix;
    const child = new Logger(combined);
    // Share the live channel reference via a property override so later
    // `init()` calls on the root logger propagate automatically.
    Object.defineProperty(child, 'channel', {
      get: () => this.channel,
      set: (v) => { (this as unknown as Record<string, unknown>)['channel'] = v; },
      configurable: true,
    });
    Object.defineProperty(child, 'level', {
      get: () => this.level,
      set: (v) => { (this as unknown as Record<string, unknown>)['level'] = v; },
      configurable: true,
    });
    return child;
  }

  /** Release the OutputChannel reference (does not dispose the channel itself). */
  dispose(): void {
    this.channel = null;
  }

  // ─── private ──────────────────────────────────────────────────────────────

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (!this.channel) {
      return;
    }
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.level]) {
      return;
    }

    const ts = new Date().toISOString();
    const tag = LEVEL_LABEL[level];
    const ctx = this.prefix ? ` [${this.prefix}]` : '';
    const extra = args.length ? ' ' + this.formatArgs(args) : '';

    this.channel.appendLine(`[${ts}] [${tag}]${ctx} ${message}${extra}`);
  }

  private formatArgs(args: unknown[]): string {
    return args
      .map((a) => {
        if (a instanceof Error) {
          return `${a.message}\n${a.stack ?? ''}`;
        }
        if (typeof a === 'object' && a !== null) {
          try {
            return JSON.stringify(a);
          } catch {
            return String(a);
          }
        }
        return String(a);
      })
      .join(' ');
  }
}

/** Singleton logger used across the extension. Call `initLogger` once at activation. */
export const logger = new Logger();

/**
 * Initialise the singleton `logger` with a channel and minimum level.
 * Call this inside your extension's `activate()` function.
 *
 * @example
 * ```ts
 * const channel = vscode.window.createOutputChannel('Terminal Agent');
 * initLogger(channel, 'debug');
 * ```
 */
export function initLogger(
  channel: vscode.OutputChannel,
  level: LogLevel = 'info',
): void {
  logger.init(channel, level);
}
