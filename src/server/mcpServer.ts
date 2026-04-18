/**
 * @file mcpServer.ts
 *
 * MCP server definition using the official MCP SDK.
 *
 * Defines all 7 terminal tools with Zod schemas for input validation.
 * Each tool handler maps MCP parameters to V2's TerminalManager API
 * (which expects structured param objects).
 *
 * The SDK handles JSON-RPC protocol compliance, schema validation,
 * `isError` semantics, and response formatting automatically.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { TerminalManager } from '../terminal/manager.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create and configure an MCP server with all terminal-control tools.
 *
 * The returned server is *not* connected to a transport — the HTTP layer
 * calls `server.connect(transport)` per request (stateless mode).
 */
export function createMcpServer(terminalManager: TerminalManager): McpServer {
  const server = new McpServer({
    name: 'terminal-agent',
    version: '0.3.0',
  });

  // ── terminal_create ──────────────────────────────────────────────

  server.tool(
    'terminal_create',
    'Create a new visible terminal tab in VS Code. Returns a terminalId for subsequent operations.',
    {
      name: z.string().optional().describe('Display name for the terminal tab'),
      shell: z
        .enum(['pwsh', 'bash', 'wsl', 'cmd', 'zsh', 'fish'])
        .optional()
        .describe('Shell type to launch'),
      cwd: z.string().optional().describe('Working directory for the terminal'),
      env: z
        .record(z.string())
        .optional()
        .describe('Additional environment variables'),
      mode: z
        .enum(['normal', 'pty'])
        .optional()
        .describe(
          "Terminal mode: 'normal' (default) uses VS Code Shell Integration; " +
            "'pty' uses an extension-controlled pseudoterminal",
        ),
      location: z
        .enum(['panel', 'editor', 'split'])
        .optional()
        .describe(
          "Where to place the terminal: 'panel' (default) = new tab in terminal panel; " +
            "'editor' = open in editor area (side by side with code); " +
            "'split' = split alongside an existing terminal",
        ),
      splitTerminalId: z
        .string()
        .optional()
        .describe("When location is 'split', the ID of the terminal to split from. Defaults to the active terminal."),
    },
    async ({ name, shell, cwd, env, mode, location, splitTerminalId }) => {
      try {
        const result = await terminalManager.create({ name, shell, cwd, env, mode, location, splitTerminalId });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── terminal_send ────────────────────────────────────────────────

  server.tool(
    'terminal_send',
    'Send text to a terminal, like typing a command. By default appends a newline (executes the command).',
    {
      terminalId: z.string().describe('Terminal ID from terminal_create or terminal_list'),
      text: z.string().describe('Text to send (e.g. a shell command)'),
      addNewline: z
        .boolean()
        .optional()
        .default(true)
        .describe('Append newline to execute the command (default: true)'),
    },
    async ({ terminalId, text, addNewline }) => {
      try {
        const result = await terminalManager.send({
          terminalId,
          text,
          addNewline,
        });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── terminal_send_keys ───────────────────────────────────────────

  server.tool(
    'terminal_send_keys',
    'Send special key sequences to a terminal (e.g. ctrl+c to interrupt, up for history). ' +
      'Supported keys: ctrl+c, ctrl+d, ctrl+z, ctrl+l, ctrl+a, ctrl+e, ctrl+k, ctrl+u, ctrl+w, ' +
      'enter, tab, escape, backspace, up, down, left, right, home, end, delete, pageup, pagedown.',
    {
      terminalId: z.string().describe('Terminal ID'),
      keys: z
        .array(z.string())
        .min(1)
        .describe('Array of key names, e.g. ["ctrl+c"] or ["up", "enter"]'),
    },
    async ({ terminalId, keys }) => {
      try {
        const result = await terminalManager.sendKeys({ terminalId, keys });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── terminal_type ─────────────────────────────────────────────────
  // Types text through xterm.js (like physical keyboard), safe for busy TUIs.

  server.tool(
    'terminal_type',
    'Type text into a terminal by simulating keyboard input through xterm.js. ' +
      'Unlike terminal_send (which writes to stdin directly), this goes through the same ' +
      'path as physical keyboard typing. Use this when the target terminal is running a TUI ' +
      'app (like Copilot CLI) that may be busy/executing — it will queue the input instead of ' +
      'triggering cancel. Set submit=true to press Enter after typing.',
    {
      terminalId: z.string().describe('Terminal ID'),
      text: z.string().describe('Text to type into the terminal'),
      submit: z
        .boolean()
        .optional()
        .default(false)
        .describe('Whether to press Enter after typing (default: false)'),
    },
    async ({ terminalId, text, submit }) => {
      try {
        const result = await terminalManager.type({ terminalId, text, submit });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── terminal_read ────────────────────────────────────────────────

  server.tool(
    'terminal_read',
    'Read terminal output incrementally using a cursor. First call with since=0 returns all ' +
      'buffered output. Subsequent calls with the returned cursor get only new data. ' +
      'Use waitMs with a waitFor* flag for blocking reads.',
    {
      terminalId: z.string().describe('Terminal ID'),
      since: z
        .number()
        .optional()
        .default(0)
        .describe('Cursor from a previous read (0 = all buffered output)'),
      waitMs: z
        .number()
        .optional()
        .default(0)
        .describe(
          'Max milliseconds to wait. Without a waitFor* flag this is a plain sleep; ' +
            'with a flag it is the timeout (default 30 s when a flag is set)',
        ),
      waitForOutput: z
        .boolean()
        .optional()
        .describe('Wait until any new output arrives (up to waitMs)'),
      waitForIdle: z
        .number()
        .optional()
        .describe(
          'Wait until the terminal is silent for this many consecutive milliseconds',
        ),
      waitForString: z
        .string()
        .optional()
        .describe('Wait until output contains this substring'),
      raw: z
        .boolean()
        .optional()
        .describe('When true, rawOutput includes ANSI escape codes'),
      maxLines: z
        .number()
        .optional()
        .describe('Limit returned output to this many trailing lines'),
    },
    async ({
      terminalId,
      since,
      waitMs,
      waitForOutput,
      waitForIdle,
      waitForString,
      raw,
      maxLines,
    }) => {
      try {
        const result = await terminalManager.read({
          terminalId,
          since,
          waitMs,
          waitForOutput,
          waitForIdle,
          waitForString,
          raw,
          maxLines,
        });
        return jsonResult({
          output: result.output,
          cursor: result.cursor,
          isComplete: result.isComplete,
          ...(result.exitCode !== null && { exitCode: result.exitCode }),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── terminal_list ────────────────────────────────────────────────

  server.tool(
    'terminal_list',
    'List all tracked terminal tabs with their IDs, names, mode, and status.',
    {},
    async () => {
      try {
        const result = terminalManager.list();
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── terminal_close ───────────────────────────────────────────────

  server.tool(
    'terminal_close',
    'Close and dispose a terminal tab.',
    {
      terminalId: z.string().describe('Terminal ID to close'),
    },
    async ({ terminalId }) => {
      try {
        const result = await terminalManager.close({ terminalId });
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── terminal_screenshot ──────────────────────────────────────────

  server.tool(
    'terminal_screenshot',
    'Get a text snapshot of the terminal\'s recent output (ANSI codes stripped). ' +
      'Useful for seeing what is currently visible in the terminal viewport.',
    {
      terminalId: z.string().describe('Terminal ID'),
      maxLines: z
        .number()
        .optional()
        .default(50)
        .describe('Number of trailing lines to return (default: 50)'),
    },
    async ({ terminalId, maxLines }) => {
      try {
        const result = terminalManager.screenshot({ terminalId, maxLines });
        return {
          content: [{ type: 'text' as const, text: result.content }],
        };
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wrap an arbitrary value as a successful MCP tool result. */
function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** Wrap an error as an MCP tool error (`isError: true`). */
function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}
