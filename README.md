# Terminal Agent — VS Code Extension

### Before:
### 🤖 $\color{red}{Agent}$
### After:
### 🤖 $\color{red}{Agent}$ .new( 🖥️ $\color{green}{Terminal}$ .new( 🤖 $\color{blue}{Agent}$ ) )


> *An agent opens a terminal. Inside, another agent wakes up. It opens more terminals. More agents wake up. **All the way down.***

```
while (true) {
  agent.createTerminal().launchAgent();  // you are here
}
```

**The missing `agent.fork()` for Claude Code, Codex CLI, Gemini CLI, and Copilot CLI.**

```
                          You (watching)
                               │
                          ┌────┴────┐
                          │ Agent 0 │  ← your Copilot CLI session
                          └────┬────┘
                    ┌──────────┼──────────┐
               ┌────┴────┐ ┌──┴───┐ ┌────┴────┐
               │ Agent 1 │ │ ...  │ │ Agent N │  ← each in a visible terminal
               └────┬────┘ └──────┘ └────┬────┘
            ┌───────┼───────┐          ┌──┴───┐
       ┌────┴──┐ ┌──┴───┐ ┌┴─────┐   │ ...  │
       │ 1.1   │ │ 1.2  │ │ 1.3  │   └──────┘  ← agents spawning agents
       └───────┘ └──────┘ └──────┘
```

Each agent can see, type, read, and spawn more of itself. You just watch.

## Features

- 🖥️ **Create visible terminals** — agent opens new terminal tabs you can see
- ⌨️ **Send commands** — agent types commands, you watch in real-time
- 📖 **Read output** — agent reads terminal output with cursor-based incremental reads
- 🔑 **Send keystrokes** — Ctrl+C, arrow keys, function keys, etc.
- 📸 **Screenshot** — capture current terminal screen content
- 🔄 **Multiple sessions** — manage any number of terminals simultaneously
- 🔒 **Localhost only** — server binds to `127.0.0.1`, no remote access

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    VS Code                           │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │         Terminal Agent Extension                │  │
│  │                                                │  │
│  │  ┌──────────────┐    ┌──────────────────────┐  │  │
│  │  │  Terminal     │    │  MCP Server (SDK)    │  │  │
│  │  │  Manager      │◄───│  + HTTP transport    │  │  │
│  │  │  (VS Code     │    │  127.0.0.1:17580     │  │  │
│  │  │   API)        │    └──────────┬───────────┘  │  │
│  │  └──────────────┘               │              │  │
│  │                                 │ on activate: │  │
│  │      ┌──────────────────────────┼──────────┐   │  │
│  │      │ 1. Write mcp-config.json            │   │  │
│  │      │ 2. Write ~/.terminal-agent-port     │   │  │
│  │      │ 3. Register VS Code MCP API         │   │  │
│  │      └──────────────────────────┼──────────┘   │  │
│  └─────────────────────────────────┼──────────────┘  │
│                                    │                 │
│  ┌─────────────────────────────────┼──────────────┐  │
│  │  Terminal: copilot              │              │  │
│  │  ┌────────────────┐             │              │  │
│  │  │  Copilot CLI   │─────────────┘              │  │
│  │  │  reads mcp-    │  POST /mcp (JSON-RPC)      │  │
│  │  │  config.json   │                            │  │
│  │  └────────────────┘                            │  │
│  ├────────────────────────────────────────────────┤  │
│  │  Terminal: agent-controlled (visible to you)   │  │
│  │  Terminal: agent-controlled (visible to you)   │  │
│  └────────────────────────────────────────────────┘  │
│                                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  VS Code Copilot Chat (sidebar / agent mode)  │  │
│  │  Discovers via registerMcpServerDef... API     │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
```

## Installation

```bash
# Build
npm install && npm run build

# Package
npx @vscode/vsce package

# Install
code --install-extension terminal-agent-0.1.0.vsix
```

Or press **F5** in VS Code to launch the Extension Development Host for development.

## Configuration

The extension auto-registers as an MCP server on activation. **No manual setup needed.**

It writes to `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "terminal-agent": {
      "type": "http",
      "url": "http://127.0.0.1:17580/mcp",
      "tools": ["*"]
    }
  }
}
```

It also writes `~/.terminal-agent-port` with the port number for non-MCP discovery.

### Extension Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `terminalAgent.port` | `17580` | Preferred HTTP port (falls back to random if busy) |
| `terminalAgent.maxBufferSize` | `1048576` | Max output buffer per terminal (bytes) |
| `terminalAgent.logLevel` | `info` | Log level: `debug`, `info`, `warn`, `error` |

## MCP Tools

The extension exposes 7 tools via the MCP protocol:

---

### `terminal_create`

Create a new visible terminal tab in VS Code.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `name` | string | No | Display name for the terminal tab |
| `shell` | string | No | Shell executable (e.g. `pwsh`, `/bin/bash`) |
| `cwd` | string | No | Working directory |
| `env` | object | No | Additional environment variables |

**Example request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": {
    "name": "terminal_create",
    "arguments": {
      "name": "build-server",
      "cwd": "/home/user/project",
      "shell": "/bin/bash"
    }
  }
}
```

**Example response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"terminalId\":\"term-1\",\"name\":\"build-server\",\"shell\":\"/bin/bash\",\"pid\":12345}"
      }
    ]
  }
}
```

---

### `terminal_send`

Send a command or text to a terminal. By default appends a newline (executes the command).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `terminalId` | string | Yes | Terminal ID from `terminal_create` |
| `text` | string | Yes | Text/command to send |
| `newline` | boolean | No | Append newline (default: `true`) |
| `waitForOutput` | boolean | No | Wait for output after sending (default: `false`) |
| `waitForString` | string | No | Wait until this string appears in output |
| `waitTimeoutMs` | number | No | Max wait time in ms (default: `30000`) |

**Example request:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "tools/call",
  "params": {
    "name": "terminal_send",
    "arguments": {
      "terminalId": "term-1",
      "text": "npm run build",
      "waitForString": "Build complete"
    }
  }
}
```

**Example response:**
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"sent\":true,\"output\":\"...Build complete in 3.2s\\n\",\"cursor\":42}"
      }
    ]
  }
}
```

---

### `terminal_read`

Read terminal output. Supports cursor-based incremental reads so you only get new output.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `terminalId` | string | Yes | Terminal ID |
| `since` | number | No | Cursor from a previous read (omit for all buffered output) |
| `waitForOutput` | boolean | No | Block until new output arrives |
| `waitForString` | string | No | Block until this string appears |
| `waitTimeoutMs` | number | No | Max wait time in ms (default: `30000`) |

**Example request:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "terminal_read",
    "arguments": {
      "terminalId": "term-1",
      "since": 42,
      "waitForOutput": true,
      "waitTimeoutMs": 5000
    }
  }
}
```

**Example response:**
```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"output\":\"✓ All 247 tests passed\\n\",\"cursor\":89,\"isActive\":true}"
      }
    ]
  }
}
```

---

### `terminal_send_keys`

Send special keystrokes (Ctrl+C, arrow keys, function keys, etc.) to a terminal.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `terminalId` | string | Yes | Terminal ID |
| `keys` | string[] | Yes | Array of key identifiers |

Supported key identifiers:
- Modifiers: `ctrl+c`, `ctrl+d`, `ctrl+z`, `ctrl+l`, `ctrl+a`, `ctrl+e`, etc.
- Navigation: `up`, `down`, `left`, `right`, `home`, `end`, `pageup`, `pagedown`
- Editing: `enter`, `tab`, `backspace`, `delete`, `escape`
- Function keys: `f1` through `f12`

**Example request:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "tools/call",
  "params": {
    "name": "terminal_send_keys",
    "arguments": {
      "terminalId": "term-1",
      "keys": ["ctrl+c"]
    }
  }
}
```

**Example response:**
```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"sent\":true,\"keys\":[\"ctrl+c\"]}"
      }
    ]
  }
}
```

---

### `terminal_screenshot`

Capture the current visible content of a terminal (what you'd see on screen).

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `terminalId` | string | Yes | Terminal ID |
| `lines` | number | No | Number of lines to capture (default: all visible) |

**Example request:**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "tools/call",
  "params": {
    "name": "terminal_screenshot",
    "arguments": {
      "terminalId": "term-1",
      "lines": 20
    }
  }
}
```

**Example response:**
```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"screen\":\"user@host:~/project$ npm test\\n\\n  PASS  src/utils.test.ts\\n  PASS  src/config.test.ts\\n\\nTest Suites: 2 passed, 2 total\\nTests:       14 passed, 14 total\\n\",\"rows\":20,\"cols\":120}"
      }
    ]
  }
}
```

---

### `terminal_list`

List all managed terminal sessions and their status.

**Parameters:** None

**Example request:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "tools/call",
  "params": {
    "name": "terminal_list",
    "arguments": {}
  }
}
```

**Example response:**
```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"terminals\":[{\"terminalId\":\"term-1\",\"name\":\"build-server\",\"isActive\":true,\"pid\":12345},{\"terminalId\":\"term-2\",\"name\":\"test-runner\",\"isActive\":true,\"pid\":12346}]}"
      }
    ]
  }
}
```

---

### `terminal_close`

Close a terminal session and clean up its resources.

**Parameters:**

| Name | Type | Required | Description |
|------|------|----------|-------------|
| `terminalId` | string | Yes | Terminal ID to close |

**Example request:**
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "method": "tools/call",
  "params": {
    "name": "terminal_close",
    "arguments": {
      "terminalId": "term-1"
    }
  }
}
```

**Example response:**
```json
{
  "jsonrpc": "2.0",
  "id": 7,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "{\"closed\":true,\"terminalId\":\"term-1\"}"
      }
    ]
  }
}
```

## Requirements

- **VS Code 1.93+** (Shell Integration API)
- **PowerShell** or **Bash** with shell integration enabled
- Node.js 18+ (bundled with VS Code)

## How It Works

1. On activation, the extension starts an HTTP server on `127.0.0.1:17580`
2. It registers itself in `~/.copilot/mcp-config.json` so Copilot CLI discovers it
3. Copilot CLI (or any MCP client) sends JSON-RPC requests to `/mcp`
4. The extension creates/controls real VS Code terminal tabs via the VS Code API
5. All terminals are **visible** — you see exactly what the agent is doing
6. On deactivation, the extension unregisters and cleans up

## Development

```bash
# Install dependencies
npm install

# Build (one-time)
npm run build

# Watch mode (rebuild on change)
npm run watch

# Launch Extension Development Host
# Press F5 in VS Code

# Package for distribution
npx @vscode/vsce package
```

### Project Structure

```
src/
├── extension.ts              # Extension entry point, lifecycle management
├── config/
│   └── autoRegister.ts       # MCP server registration (config file + VS Code API)
├── server/
│   ├── httpServer.ts         # HTTP server with auto-restart + socket tracking
│   └── mcpServer.ts          # MCP tool definitions (via @modelcontextprotocol/sdk)
├── terminal/
│   ├── manager.ts            # Terminal lifecycle, create/send/read/close
│   ├── outputBuffer.ts       # Ring buffer with cursor-based reads + waitFor*
│   ├── shellIntegration.ts   # VS Code Shell Integration API wrapper
│   └── pseudoTerminal.ts     # PTY mode for advanced terminal control
└── utils/
    ├── logger.ts             # Structured leveled logging to OutputChannel
    └── ansiStrip.ts          # Comprehensive ANSI escape sequence removal
```

## Troubleshooting

### Server not starting
Check the output channel: **View → Output → Terminal Agent**

### Copilot CLI can't find the server
Verify the config: `cat ~/.copilot/mcp-config.json`

Expected:
```json
{
  "mcpServers": {
    "terminal-agent": {
      "type": "http",
      "url": "http://127.0.0.1:17580/mcp",
      "tools": ["*"]
    }
  }
}
```

### Port conflict
If port 17580 is busy, the extension auto-selects a random port. Check `~/.terminal-agent-port` for the actual port, or look in the Output channel.

## License

MIT
