/**
 * @file httpServer.ts
 *
 * Production-grade HTTP server for the Terminal Agent VS Code extension.
 *
 * Based on V2's robust infrastructure with modifications to delegate MCP
 * requests to the official MCP SDK's StreamableHTTPServerTransport.
 *
 * Key features:
 * - Binds to 127.0.0.1 only — never exposed externally.
 * - Tries the preferred port; falls back to an OS-assigned ephemeral port
 *   on EADDRINUSE.
 * - Auto-restarts on unexpected errors (max 3, exponential back-off).
 * - Connection/socket tracking for instant, clean shutdown.
 * - Discovery file (~/.copilot-terminal-bridge/server.json).
 * - Per-request read timeout (30 s).
 * - NO CORS headers — MCP clients use Node HTTP, not browser fetch.
 *
 * Routes:
 *   POST /mcp          → MCP JSON-RPC (delegated to SDK transport)
 *   GET  /mcp          → 405 (stateless mode — no SSE sessions)
 *   DELETE /mcp        → 405 (stateless mode — no session teardown)
 *   GET  /health       → health-check JSON
 *   *                  → 404
 */

import type { Socket } from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { logger } from '../utils/logger.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Handler that receives the raw Node.js request/response pair.
 * The MCP SDK transport manages body parsing and response writing internally.
 */
export type McpRequestHandler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => Promise<void>;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DISCOVERY_DIR = path.join(os.homedir(), '.copilot-terminal-bridge');
const DISCOVERY_FILE = path.join(DISCOVERY_DIR, 'server.json');

/** Per-request read timeout in milliseconds. */
const REQUEST_TIMEOUT_MS = 30_000;

/** Maximum number of automatic restart attempts after an unexpected crash. */
const MAX_RESTARTS = 3;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface DiscoveryPayload {
  port: number;
  pid: number;
  startedAt: string;
  version: string;
}

// ---------------------------------------------------------------------------
// HttpServer
// ---------------------------------------------------------------------------

/**
 * HTTP server that exposes the MCP endpoint and a health-check route.
 *
 * ### Lifecycle
 * ```ts
 * const server = new HttpServer(mcpHandler, healthFn, 17580);
 * const port = await server.start();
 * // ...
 * await server.stop();
 * ```
 *
 * Implements {@link vscode.Disposable} for automatic cleanup.
 */
export class HttpServer implements vscode.Disposable {
  private server: http.Server | null = null;
  private port = 0;
  private restartCount = 0;
  private readonly maxRestarts = MAX_RESTARTS;

  /** Tracks all open sockets for clean, prompt shutdown. */
  private readonly activeConnections = new Set<Socket>();

  private readonly log = logger.withContext('HttpServer');

  /** Set to `true` by an explicit {@link stop} call to suppress auto-restart. */
  private stopped = false;

  /** Handle for a pending restart timer so it can be cancelled by {@link stop}. */
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param mcpHandler      Receives the raw `(req, res)` for every `/mcp`
   *                        request.  The MCP SDK transport handles body
   *                        parsing and response writing.
   * @param healthHandler   Called on `GET /health`; return value is serialised
   *                        as JSON.
   * @param preferredPort   Port to try first (default: 17580).  Falls back to
   *                        an ephemeral port if this one is already bound.
   */
  constructor(
    private readonly mcpHandler: McpRequestHandler,
    private readonly healthHandler: () => unknown,
    private readonly preferredPort: number = 17580,
  ) {}

  // ─── Public API ────────────────────────────────────────────────────────────

  /**
   * Start the server and write the discovery file.
   * @returns The actual TCP port the server is listening on.
   */
  async start(): Promise<number> {
    this.stopped = false;
    this.restartCount = 0;
    return this.startInternal();
  }

  /**
   * Gracefully stop the server.
   *
   * - Cancels any pending restart timer.
   * - Deletes the discovery file.
   * - Destroys all live sockets so `server.close()` resolves immediately.
   */
  async stop(): Promise<void> {
    this.stopped = true;

    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }

    this.deleteDiscoveryFile();

    const server = this.server;
    if (server === null) {
      return;
    }

    this.server = null;
    this.port = 0;

    for (const socket of this.activeConnections) {
      socket.destroy();
    }
    this.activeConnections.clear();

    return new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  /** The port the server is listening on, or 0 when not running. */
  getPort(): number {
    return this.port;
  }

  /** `true` when the server socket is open and accepting connections. */
  isRunning(): boolean {
    return this.server !== null && this.server.listening;
  }

  /** Dispose implementation — delegates to {@link stop}. */
  dispose(): void {
    this.stop().catch((err: unknown) => {
      this.log.error('Error while stopping server during dispose', err);
    });
  }

  // ─── Private: startup ──────────────────────────────────────────────────────

  private async startInternal(): Promise<number> {
    const server = http.createServer(this.handleRequest.bind(this));

    // Track every incoming socket for clean shutdown.
    server.on('connection', (socket: Socket) => {
      this.activeConnections.add(socket);
      socket.once('close', () => this.activeConnections.delete(socket));
    });

    // Unexpected runtime errors → schedule a restart.
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (!this.stopped) {
        this.log.error('Unexpected server error — scheduling restart', err);
        this.scheduleRestart();
      }
    });

    await this.bindServer(server, this.preferredPort);

    this.server = server;
    const addr = server.address() as { port: number } | null;
    this.port = addr?.port ?? 0;

    this.log.info(`HTTP server listening on 127.0.0.1:${this.port}`);
    this.writeDiscoveryFile();

    return this.port;
  }

  /**
   * Attempt to bind to `preferredPort`.  Falls back to an OS-assigned
   * ephemeral port on EADDRINUSE.
   */
  private bindServer(server: http.Server, preferredPort: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let done = false;
      let triedFallback = false;

      const finish = (err?: Error): void => {
        if (done) {
          return;
        }
        done = true;
        server.removeListener('listening', onListening);
        server.removeListener('error', onError);
        if (err !== undefined) {
          reject(err);
        } else {
          resolve();
        }
      };

      const onListening = (): void => finish();

      const onError = (err: NodeJS.ErrnoException): void => {
        if (!triedFallback && err.code === 'EADDRINUSE') {
          triedFallback = true;
          this.log.warn(
            `Port ${preferredPort} already in use — falling back to random port`,
          );
          server.listen(0, '127.0.0.1');
        } else {
          finish(err);
        }
      };

      server.on('listening', onListening);
      server.on('error', onError);
      server.listen(preferredPort, '127.0.0.1');
    });
  }

  /**
   * Schedule an automatic restart with exponential back-off.
   * Gives up after {@link maxRestarts} consecutive failures.
   */
  private scheduleRestart(): void {
    if (this.restartCount >= this.maxRestarts) {
      this.log.error(
        `Server crashed ${this.maxRestarts} time(s) — giving up on restarts`,
      );
      return;
    }

    const delay = Math.pow(2, this.restartCount) * 1_000;
    this.restartCount++;

    this.log.warn(
      `Scheduling restart attempt ${this.restartCount}/${this.maxRestarts} in ${delay} ms`,
    );

    this.restartTimer = setTimeout(async () => {
      this.restartTimer = null;
      try {
        await this.closeCurrentServer();
        await this.startInternal();
      } catch (err: unknown) {
        this.log.error('Restart attempt failed', err);
        this.scheduleRestart();
      }
    }, delay);
  }

  /**
   * Close the currently-running server without touching `stopped`.
   * Used by the restart path.
   */
  private async closeCurrentServer(): Promise<void> {
    const server = this.server;
    if (server === null) {
      return;
    }

    this.server = null;
    this.port = 0;

    for (const socket of this.activeConnections) {
      socket.destroy();
    }
    this.activeConnections.clear();

    return new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  // ─── Private: request handling ─────────────────────────────────────────────

  private handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Per-request read timeout.
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      if (!res.headersSent) {
        this.sendJson(res, 408, { error: 'Request timeout' });
      }
    });

    const url = req.url ?? '/';

    // ── Health endpoint ────────────────────────────────────────────
    if (req.method === 'GET' && url === '/health') {
      this.sendJson(res, 200, this.healthHandler());
      return;
    }

    // ── MCP endpoint ───────────────────────────────────────────────
    if (url === '/mcp') {
      if (req.method === 'POST') {
        this.handleMcpPost(req, res);
        return;
      }
      // GET /mcp and DELETE /mcp: stateless mode — no SSE sessions.
      if (req.method === 'GET' || req.method === 'DELETE') {
        this.sendJson(res, 405, {
          error: 'Method not allowed — server is stateless, no SSE sessions',
        });
        return;
      }
      // OPTIONS pre-flight (no CORS, but respond cleanly).
      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    this.sendJson(res, 404, { error: 'Not found', path: url });
  }

  /**
   * Delegate the POST /mcp request entirely to the MCP SDK transport.
   * The transport handles body parsing, JSON-RPC dispatch, and response writing.
   */
  private handleMcpPost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    let aborted = false;

    req.on('aborted', () => {
      aborted = true;
    });

    req.on('error', (err: Error) => {
      aborted = true;
      this.log.error('MCP request stream error', err);
      if (!res.headersSent) {
        this.sendJson(res, 400, { error: 'Bad request' });
      }
    });

    // Fire off the async handler; catch any errors.
    void (async () => {
      if (aborted) {
        return;
      }

      try {
        await this.mcpHandler(req, res);
      } catch (err: unknown) {
        this.log.error('MCP handler threw an unhandled error', err);
        if (!res.headersSent) {
          this.sendJson(res, 500, { error: 'Internal server error' });
        }
      }
    })();
  }

  /** Serialise `body` as JSON and write an HTTP response. */
  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
  ): void {
    if (res.headersSent) {
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(payload);
  }

  // ─── Private: discovery file ───────────────────────────────────────────────

  private writeDiscoveryFile(): void {
    const payload: DiscoveryPayload = {
      port: this.port,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: '0.3.0',
    };

    try {
      fs.mkdirSync(DISCOVERY_DIR, { recursive: true });
      fs.writeFileSync(
        DISCOVERY_FILE,
        JSON.stringify(payload, null, 2),
        'utf8',
      );
      this.log.debug(`Discovery file written → ${DISCOVERY_FILE}`);
    } catch (err: unknown) {
      this.log.warn('Could not write discovery file', err);
    }
  }

  private deleteDiscoveryFile(): void {
    try {
      fs.unlinkSync(DISCOVERY_FILE);
      this.log.debug('Discovery file removed');
    } catch {
      // File may not exist.
    }
  }
}
