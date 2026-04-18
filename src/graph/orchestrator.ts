/**
 * AgentOrchestrator — coordination service binding the pure graph state store
 * to the terminal runtime.
 *
 * Responsibilities:
 * 1. Runtime operations (stop / retry subtree) that the pure graph manager
 *    intentionally excludes.
 * 2. Reverse-sync from terminal lifecycle events into graph state.
 * 3. A unified event stream that the Webview can subscribe to.
 *
 * This is the **single coordination point** between {@link AgentGraphManager}
 * and {@link TerminalManager}.
 */

import * as vscode from 'vscode';
import { AgentGraphManager } from './graphManager.js';
import type { AgentNode, GraphPatch, GraphSyncMessage } from './types.js';
import { generateNodeId } from './helpers.js';
import type { TerminalManager } from '../terminal/manager.js';
import { logger } from '../utils/logger.js';

const log = logger.withContext('AgentOrchestrator');

// ---------------------------------------------------------------------------
// AgentOrchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrates interactions between the agent graph (pure state) and the
 * terminal runtime, providing lifecycle sync, subtree operations, and a
 * unified patch stream for Webview consumers.
 */
export class AgentOrchestrator {
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly graph: AgentGraphManager,
    private readonly terminals: TerminalManager,
  ) {}

  // =========================================================================
  // Terminal → Graph sync
  // =========================================================================

  /**
   * Ensure a graph node exists for the given terminal.
   *
   * If a node already maps to `terminalId`, its status is updated to
   * `'running'` and returned. Otherwise a new `'agent'` node is created
   * under `parentId` (root when `null`/`undefined`).
   *
   * @param terminalId - Terminal identifier from {@link TerminalManager}.
   * @param parentId   - Parent node ID, or `null`/`undefined` for root.
   * @param label      - Display label. Defaults to `terminalId`.
   * @param role       - Freeform role descriptor. Defaults to `'agent'`.
   * @returns The created or updated {@link AgentNode}.
   */
  syncTerminalToGraph(
    terminalId: string,
    parentId?: string | null,
    label?: string,
    role?: string,
  ): AgentNode {
    const existing = this.graph.findByTerminalId(terminalId);
    if (existing) {
      log.info(`syncTerminalToGraph: node ${existing.id} already bound to terminal ${terminalId}, updating status`);
      this.graph.updateNode(existing.id, { status: 'running' });
      return this.graph.getNode(existing.id)!;
    }

    const nodeId = generateNodeId();
    log.info(`syncTerminalToGraph: creating node ${nodeId} for terminal ${terminalId}`);
    return this.graph.addNode({
      id: nodeId,
      parentId: parentId ?? null,
      label: label ?? terminalId,
      role: role ?? 'agent',
      nodeType: 'agent',
      status: 'running',
      terminalId,
      lastAction: '',
      summary: '',
      sortOrder: 0,
    });
  }

  /**
   * Subscribe to VS Code terminal lifecycle events and keep the graph in
   * sync automatically.
   *
   * - `onDidOpenTerminal` — ensures a graph node exists for every managed
   *   terminal.
   * - `onDidCloseTerminal` — marks the corresponding graph node as
   *   `'stopped'` and clears its `terminalId` binding.
   *
   * @returns A {@link vscode.Disposable} that tears down all subscriptions.
   */
  setupTerminalWatchers(): vscode.Disposable {
    const subs: vscode.Disposable[] = [];

    subs.push(
      vscode.window.onDidOpenTerminal((terminal) => {
        // Only react to terminals that the TerminalManager knows about.
        const managed = this.terminals.list().terminals;
        const match = managed.find((t) => t.name === terminal.name);
        if (match) {
          log.info(`Terminal opened: ${match.id} (${match.name})`);
          this.syncTerminalToGraph(match.id, null, match.name);
        }
      }),
    );

    subs.push(
      vscode.window.onDidCloseTerminal((terminal) => {
        // Walk graph nodes looking for one bound to this terminal.
        const managed = this.terminals.list().terminals;
        // The terminal may already be gone from the manager's list, so also
        // try matching by name against graph nodes.
        const match = managed.find((t) => t.name === terminal.name);
        const terminalId = match?.id;

        // Search by terminalId first, fall back to name-based heuristic.
        let node: AgentNode | undefined;
        if (terminalId) {
          node = this.graph.findByTerminalId(terminalId);
        }

        if (node) {
          log.info(`Terminal closed: updating node ${node.id} to stopped`);
          this.graph.updateNode(node.id, {
            status: 'stopped',
            terminalId: null,
          });
        }
      }),
    );

    const composite = vscode.Disposable.from(...subs);
    this.disposables.push(composite);
    return composite;
  }

  // =========================================================================
  // Runtime operations
  // =========================================================================

  /**
   * Stop a single node by closing its bound terminal.
   *
   * @param nodeId - The graph node to stop.
   * @returns Count of stopped nodes and any errors encountered.
   */
  async stopNode(
    nodeId: string,
  ): Promise<{ stopped: number; errors: string[] }> {
    return this.stopNodes([nodeId]);
  }

  /**
   * Stop a node and all of its descendants.
   *
   * @param nodeId - Root of the subtree to stop.
   * @returns Count of stopped nodes and any errors encountered.
   */
  async stopSubtree(
    nodeId: string,
  ): Promise<{ stopped: number; errors: string[] }> {
    const descendantIds = this.graph.getSubtreeIds(nodeId);
    return this.stopNodes([nodeId, ...descendantIds]);
  }

  /**
   * Internal helper: stop an array of node IDs, batching all graph updates.
   */
  private async stopNodes(
    nodeIds: string[],
  ): Promise<{ stopped: number; errors: string[] }> {
    let stopped = 0;
    const errors: string[] = [];

    this.graph.beginBatch();
    try {
      for (const nid of nodeIds) {
        const node = this.graph.getNode(nid);
        if (!node?.terminalId) continue;

        this.graph.updateNode(nid, { status: 'stopping' });

        try {
          await this.terminals.close({ terminalId: node.terminalId });
          this.graph.updateNode(nid, {
            status: 'stopped',
            terminalId: null,
          });
          stopped++;
          log.info(`Stopped node ${nid} (terminal ${node.terminalId})`);
        } catch (err) {
          const msg = `Failed to close terminal ${node.terminalId} for node ${nid}: ${err}`;
          log.warn(msg);
          errors.push(msg);
          this.graph.updateNode(nid, { status: 'error' });
        }
      }
    } finally {
      this.graph.endBatch();
    }

    return { stopped, errors };
  }

  /**
   * Retry a failed or stopped node by creating a fresh terminal and
   * re-binding it.
   *
   * @param nodeId - The node to retry.
   * @returns The updated node, or `null` if the node is not retryable.
   */
  async retryNode(nodeId: string): Promise<AgentNode | null> {
    const node = this.graph.getNode(nodeId);
    if (!node) {
      log.warn(`retryNode: node ${nodeId} not found`);
      return null;
    }

    if (node.status !== 'error' && node.status !== 'stopped') {
      log.warn(`retryNode: node ${nodeId} has status '${node.status}', not retryable`);
      return null;
    }

    log.info(`Retrying node ${nodeId}`);

    try {
      const result = await this.terminals.create({
        name: node.label,
      });

      this.graph.updateNode(nodeId, {
        terminalId: result.terminalId,
        status: 'starting',
      });

      return this.graph.getNode(nodeId) ?? null;
    } catch (err) {
      log.warn(`retryNode: failed to create terminal for node ${nodeId}: ${err}`);
      return null;
    }
  }

  // =========================================================================
  // Graph → Webview bridge
  // =========================================================================

  /**
   * Build a full snapshot message for initial Webview hydration.
   *
   * @returns A {@link GraphSyncMessage} of type `'snapshot'`.
   */
  getInitialSyncMessage(): GraphSyncMessage {
    return this.graph.getSyncMessage();
  }

  /**
   * Forward graph patch events to a listener.
   *
   * @param listener - Callback invoked with each {@link GraphPatch}.
   * @returns A {@link vscode.Disposable} that removes the subscription.
   */
  onPatch(listener: (patch: GraphPatch) => void): vscode.Disposable {
    const sub = this.graph.onPatch(listener);
    return new vscode.Disposable(() => sub.dispose());
  }

  // =========================================================================
  // Convenience: high-level agent creation
  // =========================================================================

  /**
   * Create an organisational group node (no terminal binding).
   *
   * @param label    - Display label for the group.
   * @param parentId - Parent node ID, or `null`/`undefined` for root.
   * @param role     - Freeform role descriptor. Defaults to `'group'`.
   * @returns The created {@link AgentNode}.
   */
  createAgentGroup(
    label: string,
    parentId?: string | null,
    role?: string,
  ): AgentNode {
    const nodeId = generateNodeId();
    log.info(`Creating group node ${nodeId}: "${label}"`);
    return this.graph.addNode({
      id: nodeId,
      parentId: parentId ?? null,
      label,
      role: role ?? 'group',
      nodeType: 'group',
      status: 'idle',
      terminalId: null,
      lastAction: '',
      summary: '',
      sortOrder: 0,
    });
  }

  /**
   * Create an agent node, optionally bound to an existing terminal.
   *
   * @param label      - Display label for the agent.
   * @param parentId   - Parent node ID, or `null`/`undefined` for root.
   * @param role       - Freeform role descriptor. Defaults to `'agent'`.
   * @param terminalId - Existing terminal to bind. `null`/`undefined` for unbound.
   * @returns The created {@link AgentNode}.
   */
  createAgent(
    label: string,
    parentId?: string | null,
    role?: string,
    terminalId?: string | null,
  ): AgentNode {
    const nodeId = generateNodeId();
    log.info(`Creating agent node ${nodeId}: "${label}" terminal=${terminalId ?? 'none'}`);
    return this.graph.addNode({
      id: nodeId,
      parentId: parentId ?? null,
      label,
      role: role ?? 'agent',
      nodeType: 'agent',
      status: terminalId ? 'running' : 'idle',
      terminalId: terminalId ?? null,
      lastAction: '',
      summary: '',
      sortOrder: 0,
    });
  }

  /**
   * Create a terminal via {@link TerminalManager} and an agent node bound
   * to it in one step.
   *
   * @param label    - Display label (also used as the terminal tab name).
   * @param parentId - Parent node ID, or `null`/`undefined` for root.
   * @param opts     - Optional shell, cwd, and role overrides.
   * @returns The created {@link AgentNode} with its `terminalId` set.
   */
  async createAgentWithTerminal(
    label: string,
    parentId?: string | null,
    opts?: { shell?: string; cwd?: string; role?: string },
  ): Promise<AgentNode> {
    log.info(`Creating agent with terminal: "${label}"`);

    const termResult = await this.terminals.create({
      name: label,
      shell: opts?.shell as any,
      cwd: opts?.cwd,
    });

    const nodeId = generateNodeId();
    return this.graph.addNode({
      id: nodeId,
      parentId: parentId ?? null,
      label,
      role: opts?.role ?? 'agent',
      nodeType: 'agent',
      status: 'running',
      terminalId: termResult.terminalId,
      lastAction: '',
      summary: '',
      sortOrder: 0,
    });
  }

  // =========================================================================
  // Graph query proxies (thin pass-through to AgentGraphManager)
  // =========================================================================

  /** Get a single node by ID. */
  getNode(id: string) { return this.graph.getNode(id); }

  /** Get ordered children of a node (or roots if parentId is null). */
  getChildren(parentId: string | null) { return this.graph.getChildren(parentId); }

  /** Get all root-level nodes. */
  getRoots() { return this.graph.getRoots(); }

  /** Get all descendant IDs of a node (not including itself). */
  getSubtreeIds(id: string) { return this.graph.getSubtreeIds(id); }

  /** Get rollup counts for a node. */
  getRollup(id: string) { return this.graph.getRollup(id); }

  /** Remove a node and all descendants from the graph. */
  removeNode(id: string) { this.graph.removeNode(id); }

  /** Update node properties. */
  updateNode(id: string, changes: Partial<Pick<AgentNode, 'label' | 'role' | 'status' | 'terminalId' | 'lastAction' | 'summary'>>) {
    this.graph.updateNode(id, changes);
  }

  /** Move a node to a new parent (or root). */
  moveNode(id: string, newParentId: string | null, newIndex?: number) {
    this.graph.moveNode(id, newParentId, newIndex);
  }

  // =========================================================================
  // Dispose
  // =========================================================================

  /**
   * Clean up all subscriptions and watchers created by this orchestrator.
   */
  dispose(): void {
    log.info('Disposing AgentOrchestrator');
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

export default AgentOrchestrator;
