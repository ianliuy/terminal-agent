/**
 * @file index.ts
 *
 * Public API for the agent graph module.
 * Re-exports all types, helpers, the graph manager, and the view state manager.
 */

export type {
  AgentNode,
  AgentStatus,
  RollupCounts,
  GraphSnapshot,
  GraphEvent,
  GraphPatch,
  GraphSyncMessage,
} from './types.js';

export { ROOT_CHILDREN_KEY } from './types.js';

export {
  generateNodeId,
  isTerminalStatus,
  isActiveStatus,
  isBlockedStatus,
  statusPriority,
  formatElapsed,
  truncateSummary,
  buildBreadcrumb,
} from './helpers.js';

export { AgentGraphManager } from './graphManager.js';

export { AgentOrchestrator } from './orchestrator.js';
export { registerGraphTools } from './mcpTools.js';

export { GraphViewState } from './viewState.js';
export type { ViewStateSnapshot, ViewStateChangeEvent } from './viewState.js';

export { GraphPersistence } from './persistence.js';

export {
  collapseByDefault,
  computeVisibleNodes,
  paginateNodes,
  throttleUpdates,
  batchDomUpdates,
} from './treePerformance.js';
export type { PaginationResult } from './treePerformance.js';
