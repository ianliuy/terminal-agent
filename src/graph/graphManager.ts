/**
 * AgentGraphManager — pure state store for the agent graph.
 *
 * Owns the canonical tree of AgentNodes, provides CRUD + query operations,
 * maintains rollup counts, and emits batched GraphPatch events for
 * downstream consumers (webview, persistence, orchestrator).
 *
 * Design principles:
 * - No runtime operations (stop / retry) — those belong in an orchestrator.
 * - Flat Map + ordered child arrays for O(1) lookup + stable ordering.
 * - Strict tree invariants (no cycles, no orphans, unique IDs).
 * - Transactional event batching via beginBatch / endBatch.
 * - Monotonically increasing version counter.
 * - Rollups recomputed along ancestor chain, not full-tree recompute.
 */

import { EventEmitter } from 'node:events';
import type {
  AgentNode,
  AgentStatus,
  RollupCounts,
  GraphSnapshot,
  GraphEvent,
  GraphPatch,
  GraphSyncMessage,
} from './types.js';

const ROOT_KEY = '__root__';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyRollup(): RollupCounts {
  return {
    directChildCount: 0,
    subtreeNodeCount: 0,
    subtreeRunningCount: 0,
    subtreeErrorCount: 0,
    subtreeBlockedCount: 0,
  };
}

function isStatusRunning(s: AgentStatus): boolean {
  return s === 'running';
}

function isStatusError(s: AgentStatus): boolean {
  return s === 'error';
}

function isStatusBlocked(s: AgentStatus): boolean {
  return s === 'blocked';
}

// ---------------------------------------------------------------------------
// AgentGraphManager
// ---------------------------------------------------------------------------

/**
 * Core state manager for the agent execution graph.
 *
 * Provides CRUD, queries, rollup maintenance, batched event emission,
 * and snapshot serialization — all without any VS Code dependencies so it
 * is fully testable in plain Node.js.
 */
export class AgentGraphManager {
  // -- State ----------------------------------------------------------------

  private nodes: Map<string, AgentNode> = new Map();
  private childOrder: Map<string, string[]> = new Map();
  private rollups: Map<string, RollupCounts> = new Map();
  private version = 0;
  private batchDepth = 0;
  private pendingEvents: GraphEvent[] = [];
  private readonly emitter: EventEmitter;

  constructor() {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
    this.childOrder.set(ROOT_KEY, []);
  }

  // =========================================================================
  // CRUD
  // =========================================================================

  /**
   * Add a node to the graph.
   *
   * @param node - Node data. `createdAt` / `updatedAt` default to `Date.now()`.
   * @returns The fully-hydrated node that was inserted.
   * @throws If the ID is already taken or the parentId does not exist.
   */
  addNode(
    node: Omit<AgentNode, 'createdAt' | 'updatedAt'> & {
      createdAt?: number;
      updatedAt?: number;
    },
  ): AgentNode {
    if (this.nodes.has(node.id)) {
      throw new Error(`Node "${node.id}" already exists`);
    }
    this.validateParentExists(node.parentId);

    const now = Date.now();
    const full: AgentNode = {
      ...node,
      createdAt: node.createdAt ?? now,
      updatedAt: node.updatedAt ?? now,
    };

    this.nodes.set(full.id, full);

    // Append to parent's child list (or insert at sortOrder position)
    const parentKey = full.parentId ?? ROOT_KEY;
    let siblings = this.childOrder.get(parentKey);
    if (!siblings) {
      siblings = [];
      this.childOrder.set(parentKey, siblings);
    }

    if (
      full.sortOrder !== undefined &&
      full.sortOrder >= 0 &&
      full.sortOrder < siblings.length
    ) {
      siblings.splice(full.sortOrder, 0, full.id);
    } else {
      siblings.push(full.id);
    }

    // Ensure this node has a childOrder entry (even if empty)
    if (!this.childOrder.has(full.id)) {
      this.childOrder.set(full.id, []);
    }

    this.version++;
    this.recomputeRollups(full.id);

    this.emitEvent({ type: 'node-added', nodeId: full.id, node: full });

    return full;
  }

  /**
   * Remove a node and all of its descendants from the graph.
   *
   * @throws If the node does not exist.
   */
  removeNode(id: string): void {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node "${id}" not found`);
    }

    const parentKey = node.parentId ?? ROOT_KEY;
    const descendants = this.getSubtreeIds(id); // depth-first, excludes self
    const allIds = [id, ...descendants];

    // Remove from parent's childOrder
    const siblings = this.childOrder.get(parentKey);
    if (siblings) {
      const idx = siblings.indexOf(id);
      if (idx !== -1) siblings.splice(idx, 1);
    }

    // Remove each node + its childOrder entry
    for (const nid of allIds) {
      this.nodes.delete(nid);
      this.childOrder.delete(nid);
      this.rollups.delete(nid);
    }

    this.version++;

    // Recompute rollups for the former parent chain
    if (node.parentId) {
      this.recomputeRollups(node.parentId);
    } else {
      // Was a root — nothing above to recompute, but clean up the rollup key
    }

    // Emit events bottom-up so listeners can tear down children first
    for (let i = allIds.length - 1; i >= 0; i--) {
      this.emitEvent({ type: 'node-removed', nodeId: allIds[i] });
    }
  }

  /**
   * Update mutable fields of a node.
   *
   * @throws If the node does not exist.
   */
  updateNode(
    id: string,
    changes: Partial<
      Pick<
        AgentNode,
        'label' | 'role' | 'status' | 'terminalId' | 'lastAction' | 'summary'
      >
    >,
  ): void {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node "${id}" not found`);
    }

    const statusChanged =
      changes.status !== undefined && changes.status !== node.status;

    Object.assign(node, changes, { updatedAt: Date.now() });

    this.version++;

    if (statusChanged) {
      this.recomputeRollups(id);
    }

    this.emitEvent({ type: 'node-updated', nodeId: id, changes });
  }

  /**
   * Move a node to a new parent (or make it a root if `newParentId` is null).
   *
   * @param newIndex - Position among new siblings. Appends if omitted.
   * @throws If the node doesn't exist, the new parent doesn't exist, or the
   *         move would create a cycle (moving under own descendant).
   */
  moveNode(id: string, newParentId: string | null, newIndex?: number): void {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node "${id}" not found`);
    }
    this.validateParentExists(newParentId);

    // Cycle check: newParentId must not be a descendant of id
    if (newParentId !== null && this.isDescendantOf(newParentId, id)) {
      throw new Error(
        `Cannot move "${id}" under "${newParentId}" — it is a descendant`,
      );
    }

    const oldParentId = node.parentId;
    const oldParentKey = oldParentId ?? ROOT_KEY;
    const newParentKey = newParentId ?? ROOT_KEY;

    // Remove from old parent
    const oldSiblings = this.childOrder.get(oldParentKey);
    if (oldSiblings) {
      const idx = oldSiblings.indexOf(id);
      if (idx !== -1) oldSiblings.splice(idx, 1);
    }

    // Add to new parent
    let newSiblings = this.childOrder.get(newParentKey);
    if (!newSiblings) {
      newSiblings = [];
      this.childOrder.set(newParentKey, newSiblings);
    }
    if (newIndex !== undefined && newIndex >= 0 && newIndex < newSiblings.length) {
      newSiblings.splice(newIndex, 0, id);
    } else {
      newSiblings.push(id);
    }

    node.parentId = newParentId;
    node.updatedAt = Date.now();

    this.version++;

    // Recompute rollups for both ancestor chains
    if (oldParentId) this.recomputeRollups(oldParentId);
    if (newParentId) this.recomputeRollups(newParentId);
    // Also recompute for the moved node itself
    this.recomputeRollups(id);

    this.emitEvent({
      type: 'node-moved',
      nodeId: id,
      oldParentId: oldParentId ?? null,
      newParentId,
      newIndex: newIndex ?? newSiblings.indexOf(id),
    });
  }

  /**
   * Reorder a node within its current parent.
   *
   * @throws If the node doesn't exist.
   */
  reorderNode(id: string, newIndex: number): void {
    const node = this.nodes.get(id);
    if (!node) {
      throw new Error(`Node "${id}" not found`);
    }

    const parentKey = node.parentId ?? ROOT_KEY;
    const siblings = this.childOrder.get(parentKey);
    if (!siblings) return;

    const oldIdx = siblings.indexOf(id);
    if (oldIdx === -1) return;

    siblings.splice(oldIdx, 1);
    const clampedIndex = Math.max(0, Math.min(newIndex, siblings.length));
    siblings.splice(clampedIndex, 0, id);

    node.updatedAt = Date.now();
    this.version++;

    this.emitEvent({ type: 'node-updated', nodeId: id, changes: {} });
  }

  // =========================================================================
  // Queries
  // =========================================================================

  /** Get a single node by ID, or `undefined` if not found. */
  getNode(id: string): AgentNode | undefined {
    return this.nodes.get(id);
  }

  /**
   * Get ordered children of a parent. Pass `null` for root-level nodes.
   */
  getChildren(parentId: string | null): AgentNode[] {
    const key = parentId ?? ROOT_KEY;
    const ids = this.childOrder.get(key) ?? [];
    const result: AgentNode[] = [];
    for (const cid of ids) {
      const n = this.nodes.get(cid);
      if (n) result.push(n);
    }
    return result;
  }

  /** Get all root-level nodes in order. */
  getRoots(): AgentNode[] {
    return this.getChildren(null);
  }

  /**
   * Walk up the parentId chain and return ancestors from immediate parent to root.
   */
  getAncestors(id: string): AgentNode[] {
    const result: AgentNode[] = [];
    let current = this.nodes.get(id);
    if (!current) return result;

    let pid = current.parentId;
    while (pid !== null && pid !== undefined) {
      const parent = this.nodes.get(pid);
      if (!parent) break;
      result.push(parent);
      pid = parent.parentId;
    }
    return result;
  }

  /**
   * Return all descendant IDs via depth-first traversal.
   * Does **not** include the node itself.
   */
  getSubtreeIds(id: string): string[] {
    const result: string[] = [];
    const stack = [...(this.childOrder.get(id) ?? [])];
    while (stack.length > 0) {
      const cid = stack.pop()!;
      result.push(cid);
      const grandchildren = this.childOrder.get(cid);
      if (grandchildren) {
        // Push in reverse so left-most child is processed first
        for (let i = grandchildren.length - 1; i >= 0; i--) {
          stack.push(grandchildren[i]);
        }
      }
    }
    return result;
  }

  /**
   * Find a node by its associated terminal ID (linear scan).
   */
  findByTerminalId(terminalId: string): AgentNode | undefined {
    for (const node of this.nodes.values()) {
      if (node.terminalId === terminalId) return node;
    }
    return undefined;
  }

  /** Find all nodes with a given role. */
  findByRole(role: string): AgentNode[] {
    const result: AgentNode[] = [];
    for (const node of this.nodes.values()) {
      if (node.role === role) result.push(node);
    }
    return result;
  }

  /** Get the computed rollup counts for a node. */
  getRollup(id: string): RollupCounts {
    return this.rollups.get(id) ?? emptyRollup();
  }

  // =========================================================================
  // Rollup computation
  // =========================================================================

  /**
   * Recompute rollups for `nodeId` and walk up the ancestor chain,
   * recomputing each ancestor's rollup.
   */
  private recomputeRollups(nodeId: string): void {
    // Recompute for the node itself, then walk up
    let current: string | null | undefined = nodeId;
    while (current !== null && current !== undefined) {
      const node = this.nodes.get(current);
      if (!node) break;
      this.rollups.set(current, this.computeRollupForNode(current));
      current = node.parentId;
    }
  }

  /**
   * Compute rollup counts for a single node based on its direct children
   * and their pre-computed rollups.
   */
  private computeRollupForNode(id: string): RollupCounts {
    const childIds = this.childOrder.get(id) ?? [];
    const rollup = emptyRollup();
    rollup.directChildCount = childIds.length;

    for (const cid of childIds) {
      const child = this.nodes.get(cid);
      if (!child) continue;

      const childRollup = this.rollups.get(cid) ?? emptyRollup();

      // +1 for the child itself, plus all of its subtree
      rollup.subtreeNodeCount += 1 + childRollup.subtreeNodeCount;
      rollup.subtreeRunningCount +=
        (isStatusRunning(child.status) ? 1 : 0) +
        childRollup.subtreeRunningCount;
      rollup.subtreeErrorCount +=
        (isStatusError(child.status) ? 1 : 0) + childRollup.subtreeErrorCount;
      rollup.subtreeBlockedCount +=
        (isStatusBlocked(child.status) ? 1 : 0) +
        childRollup.subtreeBlockedCount;
    }

    return rollup;
  }

  // =========================================================================
  // Event system
  // =========================================================================

  /**
   * Begin a batch transaction. Events emitted during the batch are
   * accumulated and flushed as a single `GraphPatch` when `endBatch()` is
   * called (and the depth returns to 0). Batches may nest.
   */
  beginBatch(): void {
    this.batchDepth++;
  }

  /**
   * End a batch transaction. When the outermost batch closes, all
   * accumulated events are emitted as one `GraphPatch`.
   *
   * @throws If called without a matching `beginBatch`.
   */
  endBatch(): void {
    if (this.batchDepth <= 0) {
      throw new Error('endBatch() called without matching beginBatch()');
    }
    this.batchDepth--;

    if (this.batchDepth === 0 && this.pendingEvents.length > 0) {
      const patch: GraphPatch = {
        version: this.version,
        events: this.pendingEvents.splice(0),
      };
      this.emitter.emit('patch', patch);
    }
  }

  /**
   * Internal: emit or accumulate a single graph event.
   */
  private emitEvent(event: GraphEvent): void {
    if (this.batchDepth > 0) {
      this.pendingEvents.push(event);
      return;
    }

    // Not batching — emit immediately as a single-event patch
    const patch: GraphPatch = {
      version: this.version,
      events: [event],
    };
    this.emitter.emit('patch', patch);
  }

  /**
   * Subscribe to `GraphPatch` events.
   *
   * @returns A disposable that removes the listener when `dispose()` is called.
   */
  onPatch(listener: (patch: GraphPatch) => void): { dispose(): void } {
    this.emitter.on('patch', listener);
    return {
      dispose: () => {
        this.emitter.removeListener('patch', listener);
      },
    };
  }

  // =========================================================================
  // Snapshot / serialization
  // =========================================================================

  /** Return a full snapshot of the current graph state for hydration. */
  getSnapshot(): GraphSnapshot {
    return {
      version: this.version,
      nodes: Object.fromEntries(this.nodes),
      childOrder: Object.fromEntries(this.childOrder),
    };
  }

  /** Build a sync message suitable for posting to a webview. */
  getSyncMessage(): GraphSyncMessage {
    return {
      type: 'snapshot',
      data: this.getSnapshot(),
    };
  }

  /**
   * Replace all internal state from a snapshot and recompute rollups.
   * Emits a 'reset' event.
   */
  loadSnapshot(snapshot: GraphSnapshot): void {
    this.nodes.clear();
    this.childOrder.clear();
    this.rollups.clear();

    for (const [id, node] of Object.entries(snapshot.nodes)) {
      this.nodes.set(id, node);
    }

    for (const [key, ids] of Object.entries(snapshot.childOrder)) {
      this.childOrder.set(key, [...ids]);
    }

    // Ensure root key exists
    if (!this.childOrder.has(ROOT_KEY)) {
      this.childOrder.set(ROOT_KEY, []);
    }

    this.version = snapshot.version;

    // Recompute all rollups bottom-up: process leaves first
    this.recomputeAllRollups();

    this.batchDepth = 0;
    this.pendingEvents = [];

    this.emitEvent({ type: 'reset' });
  }

  /** Alias for `getSnapshot()` — useful for JSON.stringify. */
  toJSON(): object {
    return this.getSnapshot();
  }

  /**
   * Validate and load state from a JSON-parsed object.
   *
   * @throws If the data is not a valid snapshot shape.
   */
  fromJSON(data: unknown): void {
    if (
      typeof data !== 'object' ||
      data === null ||
      !('nodes' in data) ||
      !('childOrder' in data) ||
      !('version' in data)
    ) {
      throw new Error('Invalid snapshot data');
    }
    this.loadSnapshot(data as GraphSnapshot);
  }

  // =========================================================================
  // Validation helpers
  // =========================================================================

  /**
   * Throw if `parentId` is non-null and not present in the nodes map.
   */
  private validateParentExists(parentId: string | null | undefined): void {
    if (parentId !== null && parentId !== undefined && !this.nodes.has(parentId)) {
      throw new Error(`Parent node "${parentId}" not found`);
    }
  }

  /**
   * Check whether `nodeId` is a descendant of `potentialAncestorId` by
   * walking up the parentId chain.
   */
  private isDescendantOf(
    nodeId: string,
    potentialAncestorId: string,
  ): boolean {
    let current = this.nodes.get(nodeId);
    while (current) {
      if (current.parentId === potentialAncestorId) return true;
      if (current.parentId === null || current.parentId === undefined) {
        return false;
      }
      current = this.nodes.get(current.parentId);
    }
    return false;
  }

  /**
   * Recompute rollups for every node, processing leaves before parents.
   */
  private recomputeAllRollups(): void {
    // Topological order: compute children before parents.
    // Iterate all nodes; for each, compute once its children are done.
    // Simple approach: repeated passes (fine for < 300 nodes) or BFS from leaves.

    const computed = new Set<string>();
    const remaining = new Set(this.nodes.keys());

    // Keep iterating until all are computed
    while (remaining.size > 0) {
      let progress = false;
      for (const id of remaining) {
        const childIds = this.childOrder.get(id) ?? [];
        const allChildrenComputed = childIds.every((c) => computed.has(c));
        if (allChildrenComputed) {
          this.rollups.set(id, this.computeRollupForNode(id));
          computed.add(id);
          remaining.delete(id);
          progress = true;
        }
      }
      if (!progress) {
        // Safety: break to avoid infinite loop in degenerate data
        for (const id of remaining) {
          this.rollups.set(id, emptyRollup());
        }
        break;
      }
    }
  }

  // =========================================================================
  // Dispose
  // =========================================================================

  /** Clear all state and remove all event listeners. */
  dispose(): void {
    this.nodes.clear();
    this.childOrder.clear();
    this.rollups.clear();
    this.pendingEvents = [];
    this.batchDepth = 0;
    this.version = 0;
    this.emitter.removeAllListeners();
  }
}

export default AgentGraphManager;
