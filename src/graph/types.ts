// ---------------------------------------------------------------------------
// Graph Model – Core Type Definitions
// ---------------------------------------------------------------------------
//
// Canonical types for the agent hierarchy graph used by the Terminal Agent
// VS Code extension.
//
// Design invariants:
//   • Only two node types: 'group' and 'agent' (no 'terminal' node type).
//   • No view state here (collapsed / pinned / selected live in ViewState).
//   • Children are ordered arrays, not Sets.
//   • terminalId is an ephemeral runtime binding, not durable identity.
// ---------------------------------------------------------------------------

// ---- Status ---------------------------------------------------------------

/**
 * Rich status model for an agent node.
 *
 * Lifecycle:  idle → queued → starting → running → stopping → stopped
 * Branches:   running → blocked | waiting-input | error | done
 * Detached:   disconnected (terminal/process lost contact)
 */
export type AgentStatus =
  | 'idle'
  | 'queued'
  | 'starting'
  | 'running'
  | 'blocked'
  | 'waiting-input'
  | 'stopping'
  | 'stopped'
  | 'error'
  | 'done'
  | 'disconnected';

// ---- Node -----------------------------------------------------------------

/**
 * The canonical node in the agent hierarchy.
 *
 * Every node is either a **group** (organising container) or an **agent**
 * (leaf that may bind to a terminal at runtime).
 */
export interface AgentNode {
  /** Stable unique identifier (nanoid-style short ID). */
  id: string;

  /** Parent node ID, or `null` for root-level nodes. */
  parentId: string | null;

  /** Human-readable display name. */
  label: string;

  /**
   * Freeform role descriptor.
   *
   * Examples: `"M2"`, `"M1"`, `"SDE"`, `"intern"`, `"worker"`, `"manager"`.
   * Not an enum — consumers should treat it as an opaque string.
   */
  role: string;

  /** Discriminator between organisational groups and executable agents. */
  nodeType: 'group' | 'agent';

  /** Current lifecycle status of the node. */
  status: AgentStatus;

  /** Epoch-millisecond timestamp of node creation. */
  createdAt: number;

  /** Epoch-millisecond timestamp of last mutation. */
  updatedAt: number;

  /**
   * Ephemeral link to a terminal managed by `TerminalManager`.
   *
   * Only meaningful when `nodeType === 'agent'`.  This is a runtime binding
   * and must **not** be persisted across sessions.
   */
  terminalId: string | null;

  /** Brief description of the most recent activity. */
  lastAction: string;

  /** One-line summary of the node's purpose or current state. */
  summary: string;

  /**
   * Position within siblings (integer).
   *
   * Siblings are sorted ascending by `sortOrder`.  Values are renumbered on
   * reorder operations to keep gaps reasonable.
   */
  sortOrder: number;
}

// ---- Rollups --------------------------------------------------------------

/**
 * Computed rollup counts for a subtree rooted at a given node.
 *
 * These are **not** stored on `AgentNode` — they are derived on demand so
 * the domain model stays normalised.
 */
export interface RollupCounts {
  /** Number of immediate children of this node. */
  directChildCount: number;

  /** Total number of nodes in the subtree (excluding the root node itself). */
  subtreeNodeCount: number;

  /** Nodes in the subtree whose status is `'running'`. */
  subtreeRunningCount: number;

  /** Nodes in the subtree whose status is `'error'`. */
  subtreeErrorCount: number;

  /** Nodes in the subtree whose status is `'blocked'`. */
  subtreeBlockedCount: number;
}

// ---- Snapshot -------------------------------------------------------------

/**
 * Sentinel key used in {@link GraphSnapshot.childOrder} to represent the
 * ordered list of root-level nodes (those with `parentId === null`).
 */
export const ROOT_CHILDREN_KEY = '__root__';

/**
 * Full serialisable state of the agent hierarchy.
 *
 * Can be persisted to disk, sent over `postMessage`, or used as the
 * canonical source of truth in a state-management layer.
 */
export interface GraphSnapshot {
  /** Monotonically increasing version counter. */
  version: number;

  /** All nodes keyed by their stable ID. */
  nodes: Record<string, AgentNode>;

  /**
   * Ordered child IDs for every parent.
   *
   * Key is the parent's `id`, or {@link ROOT_CHILDREN_KEY} for root-level
   * nodes.  Value is an ordered array of child node IDs.
   */
  childOrder: Record<string, string[]>;
}

// ---- Events & Patches -----------------------------------------------------

/**
 * A single atomic change to the graph.
 */
export interface GraphEvent {
  /** Discriminator for the kind of mutation. */
  type: 'node-added' | 'node-removed' | 'node-updated' | 'node-moved';

  /** ID of the node affected by this event. */
  nodeId: string;

  /** Epoch-millisecond timestamp of when the event was created. */
  timestamp: number;

  /**
   * Partial node fields that changed.
   *
   * Present when `type === 'node-updated'`.
   */
  changes?: Partial<AgentNode>;

  /**
   * Previous parent ID before the move.
   *
   * Present when `type === 'node-moved'`.  `null` means the node was at root.
   */
  oldParentId?: string | null;

  /**
   * New parent ID after the move.
   *
   * Present when `type === 'node-moved'`.  `null` means the node moved to root.
   */
  newParentId?: string | null;

  /**
   * Target index within the new parent's child list.
   *
   * Present when `type === 'node-moved'` (or a reorder).
   */
  newIndex?: number;
}

/**
 * A batch of {@link GraphEvent}s that should be applied atomically.
 *
 * Patches carry version bookkeeping so consumers can detect missed updates
 * and request a full resync when necessary.
 */
export interface GraphPatch {
  /** Graph version **after** applying this patch. */
  version: number;

  /** Graph version **before** applying this patch. */
  previousVersion: number;

  /** Ordered list of events in this batch. */
  events: GraphEvent[];
}

// ---- Webview Sync ---------------------------------------------------------

/**
 * Messages exchanged between the extension host and the Webview for graph
 * synchronisation.
 *
 * - `snapshot` — full initial hydration (or re-hydration after reset).
 * - `patch`    — incremental update.
 * - `reset`    — Webview requests a full resync from the host.
 */
export type GraphSyncMessage =
  | { type: 'snapshot'; data: GraphSnapshot }
  | { type: 'patch'; data: GraphPatch }
  | { type: 'reset' };
