# External Control Plane Boundary — Architecture Decision Record

**Status:** Accepted  
**Date:** 2026-04-17  
**Deciders:** Terminal Agent core team

---

## Context

Terminal Agent is a VS Code extension that orchestrates recursive agent trees. Each agent node spawns a shell session, sends commands, reads output, and makes decisions — potentially spawning child agents that do the same.

Prior research concluded that **VS Code's terminal API is not the ideal TUI host**. An external PTY layer (ConPTY + node-pty) provides stronger primitives for true TUI control. The current architecture uses VS Code's terminal API for all execution, which introduces several limitations:

| Limitation | Impact |
|---|---|
| **TUI output reading** | Shell Integration doesn't reliably capture output from TUI apps (e.g., `vim`, `htop`, interactive CLIs). The VS Code terminal wasn't designed to be read programmatically at the ANSI level. |
| **Scale** | Hundreds of VS Code terminal tabs are impractical. The UI becomes unmanageable, and VS Code's per-terminal overhead adds up. |
| **Persistence** | Terminals die on VS Code restart. Long-running agent sessions cannot survive window reloads or crashes. |
| **Decoupling** | Execution is tightly coupled to the VS Code process. You can't run agents headlessly or on a remote machine. |

These limitations don't block Phase 1 (small-scale, command-oriented agents), but they **will** block advanced use cases: TUI-heavy workflows, large agent swarms, and distributed orchestration.

---

## Decision

Define a clear **control plane / execution plane boundary**.

### Control Plane (inside VS Code extension)

The VS Code extension owns orchestration, state, and UI. It never directly manages PTY file descriptors or parses raw ANSI escape sequences.

Responsibilities:

- **Agent graph state management** — `AgentGraphManager` tracks the DAG of agent nodes, their status, parent-child relationships, and metadata.
- **Orchestration logic** — `AgentOrchestrator` decides when to spawn agents, route messages, and handle lifecycle events.
- **Visual UI** — Webview panel renders the agent tree, status indicators, and allows user interaction.
- **MCP server endpoint** — Exposes tools (`spawn_agent`, `send_command`, etc.) for LLM-driven orchestration.
- **Configuration and registration** — Extension settings, agent type definitions, capability declarations.
- **Session persistence** — Saves and restores agent graph state across VS Code restarts (the graph, not the PTY sessions themselves).

### Execution Plane (outside VS Code — future)

A standalone daemon process owns all PTY interactions. It can run independently of VS Code and survive restarts.

Responsibilities:

- **PTY process management** — Spawns and manages shell processes via ConPTY (Windows) or native PTY (Unix).
- **node-pty integration** — Uses `node-pty` for cross-platform PTY creation and I/O.
- **Output buffering and ANSI parsing** — Uses `xterm-headless` to maintain a virtual terminal state per session, enabling reliable screen reading.
- **Long-lived sessions** — Agent sessions persist across VS Code restarts. The daemon keeps running.
- **Process resource limits** — Monitors memory/CPU per agent session, enforces timeouts, kills runaway processes.

---

## Interface Contract Between Planes

### Transport

Communication between the control plane (VS Code extension) and execution plane (daemon) uses one of:

- **localhost HTTP + WebSocket** — HTTP for request/response operations, WebSocket for streaming output events.
- **Unix domain socket** (or named pipe on Windows) — Lower overhead, suitable for same-machine communication.

The daemon listens on a configurable port/socket path. The extension discovers it via a well-known location (e.g., `~/.terminal-agent/daemon.sock` or `localhost:19275`).

### Protocol

JSON-RPC 2.0 over the chosen transport. This aligns with MCP's wire format and keeps the door open for the daemon to speak MCP directly in Phase 4.

### Core Operations

```typescript
// Session lifecycle
create_session(params: {
  shell: string;          // e.g., "powershell", "bash", "/bin/zsh"
  cwd: string;            // working directory
  env?: Record<string, string>;  // environment overrides
  cols?: number;           // terminal width (default: 120)
  rows?: number;           // terminal height (default: 40)
}) → { session_id: string }

close_session(params: {
  session_id: string;
}) → void

list_sessions() → {
  sessions: Array<{
    session_id: string;
    shell: string;
    cwd: string;
    pid: number;
    created_at: string;    // ISO 8601
    status: "running" | "exited";
    exit_code?: number;
  }>
}

// I/O operations
send(params: {
  session_id: string;
  text: string;            // text to write to PTY stdin
}) → void

send_keys(params: {
  session_id: string;
  keys: string[];          // e.g., ["\x03"] for Ctrl-C, ["\x1b[A"] for Up arrow
}) → void

read(params: {
  session_id: string;
  since_cursor?: number;   // only return output after this cursor position
}) → {
  output: string;          // raw output since cursor (includes ANSI)
  cursor: number;          // new cursor position for next read call
  screen?: string[][];     // optional: parsed screen buffer (rows × cols)
}

// Resize
resize(params: {
  session_id: string;
  cols: number;
  rows: number;
}) → void
```

### Events (WebSocket / streaming)

```typescript
// Server → Client events
{ event: "session_created",  session_id: string }
{ event: "session_output",   session_id: string, data: string, cursor: number }
{ event: "session_exited",   session_id: string, exit_code: number }
{ event: "session_error",    session_id: string, error: string }
```

---

## Where to Add the Integration Point

The key abstraction is the `TerminalManager` interface. Today it wraps VS Code's `Terminal` API. To support the external daemon, introduce a second implementation:

```
src/
  terminal/
    ITerminalBackend.ts        ← interface (already exists conceptually as TerminalManager)
    VscodeTerminalBackend.ts   ← current implementation (VS Code terminal API)
    DaemonTerminalBackend.ts   ← future: talks to external daemon via JSON-RPC
    TerminalBackendFactory.ts  ← picks backend based on config / daemon availability
```

The `AgentOrchestrator` and `AgentNode` classes should only depend on `ITerminalBackend`, never on VS Code terminal APIs directly. This is the **seam** where the swap happens.

```typescript
// Simplified interface — the contract both backends must satisfy
interface ITerminalBackend {
  createSession(shell: string, cwd: string, env?: Record<string, string>): Promise<string>;
  send(sessionId: string, text: string): Promise<void>;
  sendKeys(sessionId: string, keys: string[]): Promise<void>;
  read(sessionId: string, sinceCursor?: number): Promise<{ output: string; cursor: number }>;
  close(sessionId: string): Promise<void>;
  onOutput(sessionId: string, callback: (data: string) => void): Disposable;
  onExit(sessionId: string, callback: (code: number) => void): Disposable;
}
```

---

## Migration Path

### Phase 1 — VS Code Terminal API (current)

- All execution goes through `VscodeTerminalBackend`.
- Sufficient for <50 agents doing command-oriented work (not TUI).
- Shell Integration provides basic output capture.
- Limitations are known and accepted for this phase.

### Phase 2 — Optional External PTY Daemon

- Ship a daemon binary (Node.js process using `node-pty` + `xterm-headless`).
- Extension auto-starts it on demand, or user starts it manually.
- `TerminalBackendFactory` checks: if daemon is available, use `DaemonTerminalBackend`; otherwise fall back to `VscodeTerminalBackend`.
- TUI-heavy agents opt into the daemon backend; simple agents can stay on VS Code terminals.
- **Trigger:** Phase 2 starts when VS Code terminal limits become blocking — e.g., TUI output reading failures or >50 concurrent agents needed.

### Phase 3 — External Daemon as Default

- VS Code extension only does UI + orchestration.
- All PTY work goes through the daemon.
- VS Code terminal tabs become optional "peek" views into daemon sessions.
- Agent sessions survive VS Code restarts.

### Phase 4 — Distributed Daemon

- Daemon can run on remote machines (SSH, containers, cloud VMs).
- Control plane talks to multiple daemons.
- Agent tree can span machines — e.g., a coordinator on local machine, workers on remote build servers.
- Communication upgrades to TLS + auth tokens.

---

## Consequences

### What This Means for Current Development

1. **`TerminalManager` must be interface-driven.** Any code that touches terminal I/O should go through the `ITerminalBackend` interface, not call VS Code APIs directly. This is the most important near-term action.

2. **Agent nodes must not assume VS Code terminal semantics.** Don't rely on `Terminal.processId`, `window.terminals`, or other VS Code-specific APIs in agent logic. Use the backend interface.

3. **The MCP tool surface stays stable.** `spawn_agent`, `send_command`, `read_output` — these tools work the same regardless of whether the backend is VS Code terminals or an external daemon. LLM callers don't see the difference.

4. **Output format may change.** The daemon backend can provide richer output (parsed screen buffers, cursor positions) that the VS Code backend cannot. Agent logic should handle both raw text and structured screen data gracefully.

5. **Testing gets easier.** With a clean interface, we can mock `ITerminalBackend` for unit tests without spinning up VS Code or a daemon.

---

## References

- Prior research: `~/vscode_pseudoterminal_proxy_research.md`
- Prior research: `~/node_pty_tui_control_research.md`
- Prior research: `~/playwright_cdp_vscode_terminal_tui_guide.md`
- ConPTY documentation: [Microsoft docs](https://learn.microsoft.com/en-us/windows/console/creating-a-pseudoconsole-session)
- node-pty: [github.com/microsoft/node-pty](https://github.com/microsoft/node-pty)
- xterm-headless: [npmjs.com/package/xterm-headless](https://www.npmjs.com/package/xterm-headless)
