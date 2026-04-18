import type { AgentStatus } from './types.js';

const TERMINAL_STATUSES: ReadonlySet<AgentStatus> = new Set(['done', 'stopped', 'error']);
const ACTIVE_STATUSES: ReadonlySet<AgentStatus> = new Set(['running', 'starting', 'stopping', 'waiting-input']);
const BLOCKED_STATUSES: ReadonlySet<AgentStatus> = new Set(['blocked', 'disconnected']);

const STATUS_PRIORITY: Record<AgentStatus, number> = {
  error: 100,
  blocked: 90,
  disconnected: 80,
  'waiting-input': 70,
  running: 50,
  starting: 40,
  stopping: 30,
  queued: 20,
  idle: 10,
  done: 5,
  stopped: 0,
};

/**
 * Generate a short, human-readable, collision-resistant node ID.
 * Format: `node-{timestamp36}-{random4}`
 */
export function generateNodeId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
  return `node-${timestamp}-${random}`;
}

/** Returns `true` if the status represents a terminal/final state. */
export function isTerminalStatus(status: AgentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Returns `true` if the status represents an active (in-progress) state. */
export function isActiveStatus(status: AgentStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

/** Returns `true` if the status represents a blocked or disconnected state. */
export function isBlockedStatus(status: AgentStatus): boolean {
  return BLOCKED_STATUSES.has(status);
}

/**
 * Returns a numeric priority for a status (higher = more urgent).
 * Useful for sorting nodes by urgency in display.
 */
export function statusPriority(status: AgentStatus): number {
  return STATUS_PRIORITY[status] ?? 0;
}

/**
 * Format elapsed time between two timestamps in human-readable form.
 * @param fromMs - Start timestamp in milliseconds.
 * @param toMs - End timestamp in milliseconds (defaults to `Date.now()`).
 */
export function formatElapsed(fromMs: number, toMs: number = Date.now()): string {
  const totalSec = Math.max(0, Math.floor((toMs - fromMs) / 1000));

  const days = Math.floor(totalSec / 86400);
  const hours = Math.floor((totalSec % 86400) / 3600);
  const minutes = Math.floor((totalSec % 3600) / 60);
  const seconds = totalSec % 60;

  if (days > 0) {
    return `${days}d ${hours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Truncate text to `maxLen` characters, appending an ellipsis if truncated.
 */
export function truncateSummary(text: string, maxLen: number = 80): string {
  if (text.length <= maxLen) {
    return text;
  }
  return text.slice(0, maxLen - 1) + '…';
}

/**
 * Build a breadcrumb string from an array of ancestor labels.
 * @example buildBreadcrumb([{ label: 'M2' }, { label: 'Team Alpha' }]) // "M2 > Team Alpha"
 */
export function buildBreadcrumb(ancestors: Array<{ label: string }>): string {
  return ancestors.map((a) => a.label).join(' > ');
}
