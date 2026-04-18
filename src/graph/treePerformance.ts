/**
 * @file treePerformance.ts
 *
 * Performance utilities for rendering large agent trees (100-300+ nodes).
 *
 * All functions are pure (no VS Code imports) and work in both the
 * extension host (Node.js) and the webview (browser) contexts.
 */

import type { AgentNode } from './types.js';
import type { AgentGraphManager } from './graphManager.js';

// ---------------------------------------------------------------------------
// collapseByDefault
// ---------------------------------------------------------------------------

/**
 * Determine which nodes should be collapsed by default so the initial
 * render stays small.  Any node whose depth exceeds `maxExpandDepth` is
 * returned in the collapsed list.
 *
 * Depth is zero-based: root nodes are depth 0, their children depth 1, etc.
 *
 * @param graph          - The graph manager to query.
 * @param maxExpandDepth - Nodes deeper than this are collapsed.  Default: 2.
 * @returns An array of node IDs that should start collapsed.
 */
export function collapseByDefault(
  graph: AgentGraphManager,
  maxExpandDepth = 2,
): string[] {
  const collapsed: string[] = [];

  const walk = (parentId: string | null, depth: number): void => {
    const children = graph.getChildren(parentId);
    for (const child of children) {
      if (depth > maxExpandDepth) {
        collapsed.push(child.id);
      }
      walk(child.id, depth + 1);
    }
  };

  walk(null, 0);
  return collapsed;
}

// ---------------------------------------------------------------------------
// computeVisibleNodes
// ---------------------------------------------------------------------------

/**
 * Compute the ordered list of node IDs that should actually be rendered,
 * given the current collapsed state and an optional filter.
 *
 * This is the core "virtual window" computation that keeps DOM size small:
 *
 * 1. DFS from roots, respecting `childOrder`.
 * 2. Children of collapsed nodes are skipped entirely.
 * 3. When `filterFn` is provided, only nodes that satisfy the predicate
 *    **and** their ancestors (up to root) are included.  This ensures that
 *    a matching deep node is still reachable in the tree.
 *
 * @param graph        - The graph manager to query.
 * @param collapsedIds - Set of node IDs whose children should be hidden.
 * @param filterFn     - Optional predicate.  When present, only matching
 *                       nodes and their ancestors appear in the result.
 * @returns Ordered array of visible node IDs (DFS pre-order).
 */
export function computeVisibleNodes(
  graph: AgentGraphManager,
  collapsedIds: Set<string>,
  filterFn?: (node: AgentNode) => boolean,
): string[] {
  // When filtering, pre-compute the set of IDs that should be retained:
  // every matching node + all of its ancestors.
  let allowedIds: Set<string> | undefined;

  if (filterFn) {
    allowedIds = new Set<string>();
    const snapshot = graph.getSnapshot();

    for (const node of Object.values(snapshot.nodes)) {
      if (filterFn(node)) {
        // Add the node itself
        allowedIds.add(node.id);
        // Walk up to root, adding ancestors
        const ancestors = graph.getAncestors(node.id);
        for (const ancestor of ancestors) {
          allowedIds.add(ancestor.id);
        }
      }
    }
  }

  const result: string[] = [];

  const dfs = (parentId: string | null): void => {
    const children = graph.getChildren(parentId);
    for (const child of children) {
      // Skip nodes not in the allowed set
      if (allowedIds && !allowedIds.has(child.id)) {
        continue;
      }

      result.push(child.id);

      // Skip children of collapsed nodes
      if (!collapsedIds.has(child.id)) {
        dfs(child.id);
      }
    }
  };

  dfs(null);
  return result;
}

// ---------------------------------------------------------------------------
// paginateNodes
// ---------------------------------------------------------------------------

/**
 * Result of a pagination operation.
 */
export interface PaginationResult {
  /** Node IDs for the requested page. */
  ids: string[];
  /** Total number of pages. */
  totalPages: number;
  /** Whether there are more pages after the current one. */
  hasMore: boolean;
}

/**
 * Paginate an array of visible node IDs for very large trees.
 *
 * @param visibleIds - Full ordered list of visible node IDs.
 * @param pageSize   - Maximum nodes per page.  Default: 100.
 * @param pageIndex  - Zero-based page index.  Default: 0.
 * @returns The slice of IDs for the requested page plus pagination metadata.
 */
export function paginateNodes(
  visibleIds: string[],
  pageSize = 100,
  pageIndex = 0,
): PaginationResult {
  const totalPages = Math.max(1, Math.ceil(visibleIds.length / pageSize));
  const clamped = Math.max(0, Math.min(pageIndex, totalPages - 1));
  const start = clamped * pageSize;
  const end = Math.min(start + pageSize, visibleIds.length);

  return {
    ids: visibleIds.slice(start, end),
    totalPages,
    hasMore: end < visibleIds.length,
  };
}

// ---------------------------------------------------------------------------
// throttleUpdates
// ---------------------------------------------------------------------------

/**
 * Return a throttled wrapper around `fn` that invokes at most once per
 * `intervalMs` milliseconds.  Trailing calls are guaranteed: if a call
 * arrives during the cool-down window the latest argument is saved and
 * `fn` is invoked once the window expires.
 *
 * Works in both Node.js (setTimeout) and browser contexts.
 *
 * @param fn         - The function to throttle.
 * @param intervalMs - Minimum interval between invocations.  Default: 100.
 * @returns A throttled version of `fn`.
 */
export function throttleUpdates<T>(
  fn: (arg: T) => void,
  intervalMs = 100,
): (arg: T) => void {
  let lastRun = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingArg: T | undefined;

  return (arg: T): void => {
    const now = Date.now();
    const elapsed = now - lastRun;

    if (elapsed >= intervalMs) {
      lastRun = now;
      fn(arg);
    } else {
      // Save latest arg and schedule trailing call
      pendingArg = arg;
      if (timer === null) {
        timer = setTimeout(() => {
          timer = null;
          lastRun = Date.now();
          fn(pendingArg as T);
        }, intervalMs - elapsed);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// batchDomUpdates
// ---------------------------------------------------------------------------

/**
 * Schedule an array of DOM-mutating callbacks to run inside a single
 * `requestAnimationFrame` tick, reducing layout thrashing.
 *
 * In non-browser environments (Node.js extension host) the callbacks are
 * executed synchronously via `setTimeout(0)` as a safe fallback.
 *
 * @param updates - Array of zero-argument callbacks that perform DOM writes.
 */
export function batchDomUpdates(updates: Array<() => void>): void {
  if (updates.length === 0) return;

  const run = (): void => {
    for (const update of updates) {
      update();
    }
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run);
  } else {
    // Node.js fallback — run on next tick
    setTimeout(run, 0);
  }
}
