/**
 * @file extension.ts
 *
 * Main VS Code extension entry point for Terminal Agent.
 *
 * Orchestration on activation:
 *  1. Create OutputChannel + initialise logger.
 *  2. Create TerminalManager (scans existing terminals for session recovery).
 *  3. Create McpServer (MCP SDK — tool definitions bound to TerminalManager).
 *  4. Create HttpServer (injected with an MCP request handler + health fn).
 *  5. Start the HttpServer on the configured port (with retry UI on failure).
 *  6. Auto-register in ~/.copilot/mcp-config.json if the setting is enabled.
 *  7. Show a status bar item: `$(terminal) Agent :PORT`.
 *  8. Register commands: start, stop, status, showLog.
 *  9. Push all disposables to context.subscriptions for clean teardown.
 */

import * as http from 'node:http';
import * as vscode from 'vscode';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { HttpServer } from './server/httpServer.js';
import { createMcpServer } from './server/mcpServer.js';
import { TerminalManager } from './terminal/manager.js';
import { initLogger, logger } from './utils/logger.js';
import type { LogLevel } from './utils/logger.js';
import { registerMcpServer, unregisterMcpServer } from './config/autoRegister.js';
import { AgentGraphManager } from './graph/graphManager.js';
import { AgentOrchestrator } from './graph/orchestrator.js';
import { AgentTreeViewProvider } from './webview/agentTreeViewProvider.js';
import { GraphViewState } from './graph/viewState.js';
import { GraphPersistence } from './graph/persistence.js';

// ─── Module-level state (required for deactivate()) ───────────────────────────

let _server: HttpServer | undefined;
let _unregisterOnDeactivate = false;

// ─── MCP request handler (stateless mode) ─────────────────────────────────────

/**
 * Handle a single MCP HTTP request using the SDK's Streamable HTTP transport.
 *
 * In stateless mode the SDK requires a fresh McpServer + transport per request
 * because McpServer.connect() binds to one transport and cannot be reused.
 * The TerminalManager is shared across all requests (it holds the real state).
 */
async function handleMcpRequest(
  terminalManager: TerminalManager,
  orchestrator: AgentOrchestrator,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  try {
    const server = createMcpServer(terminalManager, orchestrator);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    // Close transport after handling to free resources
    await transport.close();
    await server.close();
  } catch (err) {
    logger.error('MCP request failed', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32603, message: String(err) },
        id: null,
      }));
    }
  }
}

// ─── activate ─────────────────────────────────────────────────────────────────

export function activate(context: vscode.ExtensionContext): void {
  // ── Step 1: Output channel + logger ─────────────────────────────
  const channel = vscode.window.createOutputChannel('Terminal Agent');
  context.subscriptions.push(channel);

  const cfg = vscode.workspace.getConfiguration('terminalAgent');
  initLogger(channel, cfg.get<LogLevel>('logLevel', 'info'));
  logger.info('Terminal Agent activating');

  // ── Step 2: TerminalManager ─────────────────────────────────────
  const maxBuffer = cfg.get<number>('maxBufferSize', 1_048_576);
  const terminalManager = new TerminalManager(maxBuffer);
  context.subscriptions.push(terminalManager);

  // ── Step 2b: Agent Graph + Orchestrator ──────────────────────────
  const graphManager = new AgentGraphManager();
  context.subscriptions.push({ dispose: () => graphManager.dispose() });

  const orchestrator = new AgentOrchestrator(graphManager, terminalManager);
  context.subscriptions.push({ dispose: () => orchestrator.dispose() });

  // Sync terminal lifecycle events to graph
  const terminalWatchers = orchestrator.setupTerminalWatchers();
  context.subscriptions.push(terminalWatchers);

  // ── Step 2c: View State + Webview ─────────────────────────────
  const viewState = new GraphViewState();
  context.subscriptions.push({ dispose: () => viewState.dispose() });

  // ── Step 2d: Persistence ──────────────────────────────────────
  const persistence = new GraphPersistence(context, graphManager, viewState);
  persistence.restore();
  persistence.startAutoSave();
  context.subscriptions.push({ dispose: () => persistence.dispose() });

  const treeViewProvider = new AgentTreeViewProvider(
    context.extensionUri,
    orchestrator,
    viewState,
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'terminalAgent.agentTree',
      treeViewProvider,
    ),
  );

  // ── Step 3: MCP Server — created per-request (see handleMcpRequest) ──

  // ── Step 4: HTTP Server ─────────────────────────────────────────
  const healthFn = (): Record<string, unknown> => ({
    status: 'ok',
    uptime: process.uptime(),
    terminals: terminalManager.count,
    graphNodes: graphManager.getSnapshot().version,
  });

  const preferredPort = cfg.get<number>('port', 17_580);
  const autoRegister = cfg.get<boolean>('autoRegister', true);
  _unregisterOnDeactivate = autoRegister;

  const server = new HttpServer(
    (req, res) => handleMcpRequest(terminalManager, orchestrator, req, res),
    healthFn,
    preferredPort,
  );
  _server = server;

  // Safety disposable for the force-quit path where VS Code shuts down
  // without invoking deactivate().
  context.subscriptions.push({
    dispose(): void {
      if (_server) {
        void _server.stop();
        _server = undefined;
      }
    },
  });

  // ── Step 7: Status bar ──────────────────────────────────────────
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBar.command = 'terminalAgent.status';
  statusBar.text = '$(terminal) Agent';
  statusBar.tooltip = 'Terminal Agent — starting…';
  statusBar.show();
  context.subscriptions.push(statusBar);

  function updateStatusBar(): void {
    if (server.isRunning()) {
      const port = server.getPort();
      const n = terminalManager.count;
      statusBar.text = `$(terminal) Agent: ${n} terminals :${port}`;
      statusBar.tooltip =
        `Terminal Agent — port ${port}, ${n} managed terminal(s). Click for details.`;
      statusBar.backgroundColor = undefined;
    } else {
      statusBar.text = '$(terminal) Agent: OFF';
      statusBar.tooltip = 'Terminal Agent — not running. Click for details.';
      statusBar.backgroundColor = new vscode.ThemeColor(
        'statusBarItem.warningBackground',
      );
    }
  }

  // Refresh status bar every 5 seconds.
  const refreshTimer = setInterval(updateStatusBar, 5_000);
  context.subscriptions.push({ dispose: () => clearInterval(refreshTimer) });

  // ── Step 5 + 6: Start server + auto-register ───────────────────

  async function startServer(): Promise<void> {
    try {
      const port = await server.start();
      updateStatusBar();
      logger.info(`Server started on port ${port}`);

      if (autoRegister) {
        await registerMcpServer(port, context);
      }
    } catch (err) {
      logger.error('Server failed to start', err);
      updateStatusBar();

      const msg = err instanceof Error ? err.message : String(err);
      const choice = await vscode.window.showErrorMessage(
        `Terminal Agent: Failed to start server — ${msg}`,
        'Retry',
        'Ignore',
      );
      if (choice === 'Retry') {
        await startServer();
      }
    }
  }

  void startServer();

  // ── Step 8: Commands ────────────────────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'terminalAgent.start',
      () => void startServer(),
    ),

    vscode.commands.registerCommand('terminalAgent.stop', async () => {
      await server.stop();
      updateStatusBar();
      logger.info('Server stopped via command');
      void vscode.window.showInformationMessage(
        'Terminal Agent server stopped.',
      );
    }),

    vscode.commands.registerCommand('terminalAgent.status', () => {
      updateStatusBar();
      if (server.isRunning()) {
        const port = server.getPort();
        const n = terminalManager.count;
        void vscode.window.showInformationMessage(
          `Terminal Agent running on port ${port} — ${n} managed terminal(s).`,
        );
      } else {
        void vscode.window.showWarningMessage(
          'Terminal Agent server is not running. ' +
            'Use "Terminal Agent: Start Server" to start it.',
        );
      }
    }),

    vscode.commands.registerCommand('terminalAgent.showLog', () =>
      channel.show(),
    ),

    vscode.commands.registerCommand('terminal-agent.restart', async () => {
      await server.stop();
      updateStatusBar();
      logger.info('Server restarting via command');
      await startServer();
    }),
  );

  logger.info('Terminal Agent activated');
}

// ─── deactivate ───────────────────────────────────────────────────────────────

/**
 * Called by VS Code before disposing `context.subscriptions`.
 *
 * Returns a `Thenable<void>` so VS Code awaits graceful shutdown of the HTTP
 * server and removal of the MCP config entry before tearing down subscriptions.
 */
export function deactivate(): Thenable<void> | void {
  logger.info('Terminal Agent deactivating');

  const tasks: Promise<void>[] = [];

  const serverToStop = _server;
  _server = undefined;

  if (serverToStop) {
    tasks.push(
      serverToStop.stop().catch((err: unknown) => {
        logger.error('Error stopping server during deactivation', err);
      }),
    );
  }

  if (_unregisterOnDeactivate) {
    _unregisterOnDeactivate = false;
    tasks.push(
      unregisterMcpServer().catch((err: unknown) => {
        logger.error('Error unregistering MCP server during deactivation', err);
      }),
    );
  }

  if (tasks.length === 0) {
    return;
  }

  return Promise.all(tasks).then(() => {
    /* intentionally void */
  });
}
