/**
 * autoRegister.ts
 *
 * Registers / unregisters a `terminal-agent` entry in the Copilot CLI MCP
 * config file (`~/.copilot/mcp-config.json`) and writes a port discovery file
 * (`~/.terminal-agent-port`) so the Copilot CLI — and any other MCP client —
 * can discover and invoke the extension's HTTP MCP server automatically.
 *
 * Also attempts to register via VS Code's built-in MCP server API
 * (`vscode.lm.registerMcpServerDefinitionProvider`) for VS Code Copilot Chat
 * integration, falling back gracefully if the API is not available.
 *
 * CRITICAL: Uses `mcpServers` root key (NOT `servers`) and targets
 * `mcp-config.json` (NOT `mcp.json`) per Copilot CLI spec.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as vscode from 'vscode';
import { logger } from '../utils/logger.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVER_KEY = 'terminal-agent';
const COPILOT_DIR = path.join(os.homedir(), '.copilot');
const CONFIG_FILE = path.join(COPILOT_DIR, 'mcp-config.json');
const PORT_FILE = path.join(os.homedir(), '.terminal-agent-port');

// ─── Local types ──────────────────────────────────────────────────────────────

interface McpServerEntry {
  type: string;
  url: string;
  tools?: string[];
}

/**
 * Minimal schema for the Copilot CLI MCP config file.
 * The index signature allows round-tripping unknown top-level keys.
 */
interface McpConfig {
  mcpServers?: Record<string, McpServerEntry>;
  [key: string]: unknown;
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Read and JSON-parse the config file.
 * Returns `{}` when the file does not exist.
 * Re-throws IO errors other than ENOENT.
 */
function readConfig(): McpConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(CONFIG_FILE, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw err;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as McpConfig;
    }
  } catch {
    // Malformed JSON — start fresh rather than corrupt the file further.
  }
  return {};
}

/**
 * Serialise `config` and write it to the config file, creating parent
 * directories as needed.
 */
function writeConfig(config: McpConfig): void {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

/**
 * Write a plain-text port file for non-MCP discovery.
 */
function writePortFile(port: number): void {
  fs.writeFileSync(PORT_FILE, String(port), 'utf8');
}

/**
 * Remove the port discovery file.
 */
function removePortFile(): void {
  try {
    fs.unlinkSync(PORT_FILE);
  } catch {
    // Ignore — file may not exist.
  }
}

// ─── VS Code API registration ────────────────────────────────────────────────

/**
 * Attempt to register via VS Code's built-in MCP server definition provider.
 * This makes the server visible to VS Code Copilot Chat (agent mode).
 * Returns a Disposable if successful, or undefined if the API is unavailable.
 */
function tryRegisterVsCodeMcpProvider(
  port: number,
  context: vscode.ExtensionContext,
): vscode.Disposable | undefined {
  const log = logger.withContext('autoRegister');

  try {
    // The API may not exist in older VS Code versions or Insiders builds.
    const lm = vscode.lm;
    if (!lm || typeof (lm as Record<string, unknown>).registerMcpServerDefinitionProvider !== 'function') {
      log.debug('vscode.lm.registerMcpServerDefinitionProvider not available — skipping');
      return undefined;
    }

    const emitter = new vscode.EventEmitter<void>();
    const disposable = (lm as any).registerMcpServerDefinitionProvider(SERVER_KEY, {
      onDidChangeMcpServerDefinitions: emitter.event,
      provideMcpServerDefinitions: async () => {
        // McpHttpServerDefinition may not exist; guard it.
        const McpHttpDef = (vscode as any).McpHttpServerDefinition;
        if (!McpHttpDef) { return []; }
        return [
          new McpHttpDef({
            label: SERVER_KEY,
            uri: vscode.Uri.parse(`http://127.0.0.1:${port}/mcp`),
            version: '0.1.0',
          }),
        ];
      },
      resolveMcpServerDefinition: async (server: unknown) => server,
    });

    context.subscriptions.push(emitter, disposable);
    log.info('Registered MCP server via VS Code API (Copilot Chat)');
    return disposable;
  } catch (err) {
    log.debug('VS Code MCP API registration failed (non-fatal)', err);
    return undefined;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Register the terminal-agent MCP server for discovery.
 *
 * 1. Writes/merges an entry in `~/.copilot/mcp-config.json` (for Copilot CLI).
 * 2. Writes `~/.terminal-agent-port` (for non-MCP discovery).
 * 3. Attempts VS Code API registration (for VS Code Copilot Chat).
 *
 * All steps are non-fatal: registration failure never blocks extension activation.
 */
export async function registerMcpServer(
  port: number,
  context: vscode.ExtensionContext,
): Promise<void> {
  const log = logger.withContext('autoRegister');

  // 1. Write mcp-config.json
  try {
    const config = readConfig();
    if (!config.mcpServers || typeof config.mcpServers !== 'object') {
      config.mcpServers = {};
    }

    const entry: McpServerEntry = {
      type: 'http',
      url: `http://127.0.0.1:${port}/mcp`,
      tools: ['*'],
    };
    config.mcpServers[SERVER_KEY] = entry;
    writeConfig(config);

    log.info(`Registered ${SERVER_KEY} → ${entry.url}  (${CONFIG_FILE})`);
  } catch (err) {
    log.error('Failed to register MCP server in Copilot config', err);
  }

  // 2. Write port discovery file
  try {
    writePortFile(port);
    log.debug(`Wrote port file: ${PORT_FILE}`);
  } catch (err) {
    log.error('Failed to write port file', err);
  }

  // 3. VS Code API registration (optional)
  tryRegisterVsCodeMcpProvider(port, context);
}

/**
 * Remove the terminal-agent entry from Copilot CLI config and clean up
 * the port discovery file.
 *
 * No-ops gracefully when:
 * - The config file does not exist.
 * - The `mcpServers` key is absent.
 * - The `terminal-agent` entry is already gone.
 */
export async function unregisterMcpServer(): Promise<void> {
  const log = logger.withContext('autoRegister');

  // 1. Remove from mcp-config.json
  try {
    const config = readConfig();

    if (config.mcpServers && SERVER_KEY in config.mcpServers) {
      delete config.mcpServers[SERVER_KEY];

      // Remove the now-empty mcpServers object so the file stays tidy.
      if (Object.keys(config.mcpServers).length === 0) {
        delete config.mcpServers;
      }

      writeConfig(config);
      log.info(`Unregistered ${SERVER_KEY} from ${CONFIG_FILE}`);
    }
  } catch (err) {
    log.error('Failed to unregister MCP server from Copilot config', err);
  }

  // 2. Remove port file
  removePortFile();
}
