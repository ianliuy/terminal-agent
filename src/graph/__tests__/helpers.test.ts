import { describe, it, expect } from 'vitest';
import {
  generateNodeId,
  isTerminalStatus,
  isActiveStatus,
  isBlockedStatus,
  statusPriority,
  formatElapsed,
  truncateSummary,
  buildBreadcrumb,
} from '../helpers.js';
import type { AgentStatus } from '../types.js';

// ---------------------------------------------------------------------------
// generateNodeId
// ---------------------------------------------------------------------------

describe('generateNodeId', () => {
  it('should match format node-{base36}-{4chars}', () => {
    const id = generateNodeId();
    expect(id).toMatch(/^node-[a-z0-9]+-[a-z0-9]{4}$/);
  });

  it('should produce unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateNodeId());
    }
    // Expect at least 95 unique out of 100 (random collisions extremely unlikely)
    expect(ids.size).toBeGreaterThanOrEqual(95);
  });

  it('should always start with "node-"', () => {
    for (let i = 0; i < 10; i++) {
      expect(generateNodeId().startsWith('node-')).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// isTerminalStatus
// ---------------------------------------------------------------------------

describe('isTerminalStatus', () => {
  it('should return true for done, stopped, error', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('stopped')).toBe(true);
    expect(isTerminalStatus('error')).toBe(true);
  });

  it('should return false for non-terminal statuses', () => {
    const nonTerminal: AgentStatus[] = [
      'idle',
      'queued',
      'starting',
      'running',
      'blocked',
      'waiting-input',
      'stopping',
      'disconnected',
    ];
    for (const s of nonTerminal) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isActiveStatus
// ---------------------------------------------------------------------------

describe('isActiveStatus', () => {
  it('should return true for running, starting, stopping, waiting-input', () => {
    expect(isActiveStatus('running')).toBe(true);
    expect(isActiveStatus('starting')).toBe(true);
    expect(isActiveStatus('stopping')).toBe(true);
    expect(isActiveStatus('waiting-input')).toBe(true);
  });

  it('should return false for non-active statuses', () => {
    const nonActive: AgentStatus[] = [
      'idle',
      'queued',
      'blocked',
      'stopped',
      'error',
      'done',
      'disconnected',
    ];
    for (const s of nonActive) {
      expect(isActiveStatus(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// isBlockedStatus
// ---------------------------------------------------------------------------

describe('isBlockedStatus', () => {
  it('should return true for blocked and disconnected', () => {
    expect(isBlockedStatus('blocked')).toBe(true);
    expect(isBlockedStatus('disconnected')).toBe(true);
  });

  it('should return false for non-blocked statuses', () => {
    const nonBlocked: AgentStatus[] = [
      'idle',
      'queued',
      'starting',
      'running',
      'waiting-input',
      'stopping',
      'stopped',
      'error',
      'done',
    ];
    for (const s of nonBlocked) {
      expect(isBlockedStatus(s)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// statusPriority
// ---------------------------------------------------------------------------

describe('statusPriority', () => {
  it('should rank error highest', () => {
    const allStatuses: AgentStatus[] = [
      'idle',
      'queued',
      'starting',
      'running',
      'blocked',
      'waiting-input',
      'stopping',
      'stopped',
      'error',
      'done',
      'disconnected',
    ];

    for (const s of allStatuses) {
      if (s !== 'error') {
        expect(statusPriority('error')).toBeGreaterThan(statusPriority(s));
      }
    }
  });

  it('should rank blocked > running', () => {
    expect(statusPriority('blocked')).toBeGreaterThan(statusPriority('running'));
  });

  it('should rank running > idle', () => {
    expect(statusPriority('running')).toBeGreaterThan(statusPriority('idle'));
  });

  it('should rank idle > stopped', () => {
    expect(statusPriority('idle')).toBeGreaterThan(statusPriority('stopped'));
  });

  it('should rank disconnected > running', () => {
    expect(statusPriority('disconnected')).toBeGreaterThan(
      statusPriority('running'),
    );
  });

  it('should return 0 for stopped (lowest)', () => {
    expect(statusPriority('stopped')).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe('formatElapsed', () => {
  it('should show seconds for <1 minute', () => {
    expect(formatElapsed(0, 30_000)).toBe('30s');
    expect(formatElapsed(0, 0)).toBe('0s');
    expect(formatElapsed(0, 59_000)).toBe('59s');
  });

  it('should show minutes and seconds', () => {
    expect(formatElapsed(0, 90_000)).toBe('1m 30s');
    expect(formatElapsed(0, 3599_000)).toBe('59m 59s');
  });

  it('should show hours and minutes', () => {
    expect(formatElapsed(0, 3600_000)).toBe('1h 0m');
    expect(formatElapsed(0, 7200_000 + 1800_000)).toBe('2h 30m');
  });

  it('should show days and hours', () => {
    expect(formatElapsed(0, 86400_000)).toBe('1d 0h');
    expect(formatElapsed(0, 86400_000 * 2 + 3600_000 * 5)).toBe('2d 5h');
  });

  it('should handle negative elapsed as 0s', () => {
    expect(formatElapsed(1000, 0)).toBe('0s');
  });
});

// ---------------------------------------------------------------------------
// truncateSummary
// ---------------------------------------------------------------------------

describe('truncateSummary', () => {
  it('should leave short text unchanged', () => {
    expect(truncateSummary('hello')).toBe('hello');
    expect(truncateSummary('a'.repeat(80))).toBe('a'.repeat(80));
  });

  it('should truncate long text with ellipsis', () => {
    const long = 'x'.repeat(100);
    const result = truncateSummary(long, 80);
    expect(result).toHaveLength(80);
    expect(result.endsWith('…')).toBe(true);
  });

  it('should respect custom maxLen', () => {
    const result = truncateSummary('abcdefghij', 5);
    expect(result).toBe('abcd…');
    expect(result).toHaveLength(5);
  });

  it('should handle empty string', () => {
    expect(truncateSummary('')).toBe('');
  });

  it('should handle text exactly at maxLen', () => {
    const text = 'a'.repeat(10);
    expect(truncateSummary(text, 10)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// buildBreadcrumb
// ---------------------------------------------------------------------------

describe('buildBreadcrumb', () => {
  it('should return empty string for empty array', () => {
    expect(buildBreadcrumb([])).toBe('');
  });

  it('should return label for single node', () => {
    expect(buildBreadcrumb([{ label: 'Root' }])).toBe('Root');
  });

  it('should join multiple with " > "', () => {
    expect(
      buildBreadcrumb([{ label: 'A' }, { label: 'B' }, { label: 'C' }]),
    ).toBe('A > B > C');
  });

  it('should handle labels with special characters', () => {
    expect(
      buildBreadcrumb([{ label: 'Team > Alpha' }, { label: 'Sub "Group"' }]),
    ).toBe('Team > Alpha > Sub "Group"');
  });
});
