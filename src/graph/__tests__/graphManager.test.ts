import { describe, it, expect, beforeEach } from 'vitest';
import { AgentGraphManager } from '../graphManager.js';
import type { AgentNode, GraphPatch } from '../types.js';

// ---------------------------------------------------------------------------
// Helper: build node input (without createdAt/updatedAt which are auto-set)
// ---------------------------------------------------------------------------

function makeNode(
  overrides: Partial<AgentNode> = {},
): Omit<AgentNode, 'createdAt' | 'updatedAt'> {
  return {
    id: overrides.id ?? 'test-1',
    parentId: overrides.parentId ?? null,
    label: overrides.label ?? 'Test Node',
    role: overrides.role ?? 'agent',
    nodeType: overrides.nodeType ?? 'agent',
    status: overrides.status ?? 'idle',
    terminalId: overrides.terminalId ?? null,
    lastAction: overrides.lastAction ?? '',
    summary: overrides.summary ?? '',
    sortOrder: overrides.sortOrder ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentGraphManager', () => {
  let mgr: AgentGraphManager;

  beforeEach(() => {
    mgr = new AgentGraphManager();
  });

  // ── addNode ──────────────────────────────────────────────────────────

  describe('addNode', () => {
    it('should add a root node', () => {
      const node = mgr.addNode(makeNode({ id: 'r1' }));
      expect(node.id).toBe('r1');
      expect(node.parentId).toBeNull();
      expect(mgr.getNode('r1')).toBeDefined();
      expect(mgr.getRoots()).toHaveLength(1);
    });

    it('should add a child node', () => {
      mgr.addNode(makeNode({ id: 'parent', nodeType: 'group' }));
      const child = mgr.addNode(makeNode({ id: 'child', parentId: 'parent' }));
      expect(child.parentId).toBe('parent');
      expect(mgr.getChildren('parent')).toHaveLength(1);
      expect(mgr.getChildren('parent')[0].id).toBe('child');
    });

    it('should throw if parent does not exist', () => {
      expect(() =>
        mgr.addNode(makeNode({ id: 'orphan', parentId: 'nonexistent' })),
      ).toThrow(/not found/i);
    });

    it('should throw if id already exists', () => {
      mgr.addNode(makeNode({ id: 'dup' }));
      expect(() => mgr.addNode(makeNode({ id: 'dup' }))).toThrow(/already exists/i);
    });

    it('should auto-set createdAt and updatedAt', () => {
      const before = Date.now();
      const node = mgr.addNode(makeNode({ id: 'ts' }));
      const after = Date.now();
      expect(node.createdAt).toBeGreaterThanOrEqual(before);
      expect(node.createdAt).toBeLessThanOrEqual(after);
      expect(node.updatedAt).toBeGreaterThanOrEqual(before);
      expect(node.updatedAt).toBeLessThanOrEqual(after);
    });
  });

  // ── removeNode ───────────────────────────────────────────────────────

  describe('removeNode', () => {
    it('should remove a leaf node', () => {
      mgr.addNode(makeNode({ id: 'leaf' }));
      mgr.removeNode('leaf');
      expect(mgr.getNode('leaf')).toBeUndefined();
      expect(mgr.getRoots()).toHaveLength(0);
    });

    it('should cascade remove children', () => {
      mgr.addNode(makeNode({ id: 'p', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'c1', parentId: 'p' }));
      mgr.addNode(makeNode({ id: 'c2', parentId: 'p' }));
      mgr.addNode(makeNode({ id: 'gc1', parentId: 'c1' }));

      mgr.removeNode('p');

      expect(mgr.getNode('p')).toBeUndefined();
      expect(mgr.getNode('c1')).toBeUndefined();
      expect(mgr.getNode('c2')).toBeUndefined();
      expect(mgr.getNode('gc1')).toBeUndefined();
      expect(mgr.getRoots()).toHaveLength(0);
    });

    it('should throw if node does not exist', () => {
      expect(() => mgr.removeNode('ghost')).toThrow(/not found/i);
    });
  });

  // ── updateNode ───────────────────────────────────────────────────────

  describe('updateNode', () => {
    it('should partially update a node', () => {
      mgr.addNode(makeNode({ id: 'u1', label: 'Original' }));
      mgr.updateNode('u1', { label: 'Updated' });
      expect(mgr.getNode('u1')!.label).toBe('Updated');
      // role should be unchanged
      expect(mgr.getNode('u1')!.role).toBe('agent');
    });

    it('should update updatedAt timestamp', () => {
      const node = mgr.addNode(makeNode({ id: 'u2' }));
      const oldUpdated = node.updatedAt;

      mgr.updateNode('u2', { summary: 'new summary' });
      expect(mgr.getNode('u2')!.updatedAt).toBeGreaterThanOrEqual(oldUpdated);
    });

    it('should throw if node does not exist', () => {
      expect(() => mgr.updateNode('nope', { label: 'x' })).toThrow(/not found/i);
    });

    it('should recompute rollups on status change', () => {
      mgr.addNode(makeNode({ id: 'group', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'a1', parentId: 'group', status: 'idle' }));

      expect(mgr.getRollup('group').subtreeRunningCount).toBe(0);

      mgr.updateNode('a1', { status: 'running' });
      expect(mgr.getRollup('group').subtreeRunningCount).toBe(1);

      mgr.updateNode('a1', { status: 'error' });
      expect(mgr.getRollup('group').subtreeRunningCount).toBe(0);
      expect(mgr.getRollup('group').subtreeErrorCount).toBe(1);
    });
  });

  // ── moveNode ─────────────────────────────────────────────────────────

  describe('moveNode', () => {
    it('should move node to new parent', () => {
      mgr.addNode(makeNode({ id: 'g1', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'g2', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'agent', parentId: 'g1' }));

      expect(mgr.getChildren('g1')).toHaveLength(1);
      expect(mgr.getChildren('g2')).toHaveLength(0);

      mgr.moveNode('agent', 'g2');

      expect(mgr.getChildren('g1')).toHaveLength(0);
      expect(mgr.getChildren('g2')).toHaveLength(1);
      expect(mgr.getNode('agent')!.parentId).toBe('g2');
    });

    it('should detect cycles', () => {
      mgr.addNode(makeNode({ id: 'a', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'b', parentId: 'a', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'c', parentId: 'b', nodeType: 'group' }));

      // Trying to move 'a' under its descendant 'c' should throw
      expect(() => mgr.moveNode('a', 'c')).toThrow(/descendant/i);
    });

    it('should move to root (parentId=null)', () => {
      mgr.addNode(makeNode({ id: 'p', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'child', parentId: 'p' }));

      mgr.moveNode('child', null);

      expect(mgr.getNode('child')!.parentId).toBeNull();
      expect(mgr.getRoots()).toHaveLength(2);
      expect(mgr.getChildren('p')).toHaveLength(0);
    });

    it('should throw for nonexistent node', () => {
      expect(() => mgr.moveNode('missing', null)).toThrow(/not found/i);
    });

    it('should throw for nonexistent parent', () => {
      mgr.addNode(makeNode({ id: 'n' }));
      expect(() => mgr.moveNode('n', 'nowhere')).toThrow(/not found/i);
    });
  });

  // ── getChildren ──────────────────────────────────────────────────────

  describe('getChildren', () => {
    it('should return ordered children', () => {
      mgr.addNode(makeNode({ id: 'p', nodeType: 'group' }));
      // sortOrder beyond siblings.length → appends in insertion order
      mgr.addNode(makeNode({ id: 'c1', parentId: 'p', label: 'First', sortOrder: 100 }));
      mgr.addNode(makeNode({ id: 'c2', parentId: 'p', label: 'Second', sortOrder: 101 }));
      mgr.addNode(makeNode({ id: 'c3', parentId: 'p', label: 'Third', sortOrder: 102 }));

      const children = mgr.getChildren('p');
      expect(children.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    });

    it('should return roots when parentId is null', () => {
      // sortOrder beyond length → appends in insertion order
      mgr.addNode(makeNode({ id: 'r1', sortOrder: 100 }));
      mgr.addNode(makeNode({ id: 'r2', sortOrder: 101 }));

      const roots = mgr.getChildren(null);
      expect(roots).toHaveLength(2);
      expect(roots.map((r) => r.id)).toEqual(['r1', 'r2']);
    });

    it('should return empty array for leaf nodes', () => {
      mgr.addNode(makeNode({ id: 'leaf' }));
      expect(mgr.getChildren('leaf')).toEqual([]);
    });
  });

  // ── Rollups ──────────────────────────────────────────────────────────

  describe('rollups', () => {
    it('should count running nodes in subtree', () => {
      mgr.addNode(makeNode({ id: 'g', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'a1', parentId: 'g', status: 'running' }));
      mgr.addNode(makeNode({ id: 'a2', parentId: 'g', status: 'idle' }));

      const rollup = mgr.getRollup('g');
      expect(rollup.subtreeRunningCount).toBe(1);
      expect(rollup.subtreeNodeCount).toBe(2);
      expect(rollup.directChildCount).toBe(2);
    });

    it('should count error nodes in subtree', () => {
      mgr.addNode(makeNode({ id: 'g', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'a1', parentId: 'g', status: 'error' }));
      mgr.addNode(makeNode({ id: 'a2', parentId: 'g', status: 'error' }));

      expect(mgr.getRollup('g').subtreeErrorCount).toBe(2);
    });

    it('should count blocked nodes in subtree', () => {
      mgr.addNode(makeNode({ id: 'g', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'a1', parentId: 'g', status: 'blocked' }));

      expect(mgr.getRollup('g').subtreeBlockedCount).toBe(1);
    });

    it('should aggregate across nested levels', () => {
      // root-group
      //   ├── mid-group
      //   │   ├── running-agent
      //   │   └── error-agent
      //   └── blocked-agent
      mgr.addNode(makeNode({ id: 'root-g', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'mid-g', parentId: 'root-g', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'run', parentId: 'mid-g', status: 'running' }));
      mgr.addNode(makeNode({ id: 'err', parentId: 'mid-g', status: 'error' }));
      mgr.addNode(makeNode({ id: 'blk', parentId: 'root-g', status: 'blocked' }));

      const rootRollup = mgr.getRollup('root-g');
      expect(rootRollup.subtreeNodeCount).toBe(4); // mid-g + run + err + blk
      expect(rootRollup.subtreeRunningCount).toBe(1);
      expect(rootRollup.subtreeErrorCount).toBe(1);
      expect(rootRollup.subtreeBlockedCount).toBe(1);
      expect(rootRollup.directChildCount).toBe(2); // mid-g + blk

      const midRollup = mgr.getRollup('mid-g');
      expect(midRollup.subtreeNodeCount).toBe(2);
      expect(midRollup.subtreeRunningCount).toBe(1);
      expect(midRollup.subtreeErrorCount).toBe(1);
      expect(midRollup.subtreeBlockedCount).toBe(0);
    });
  });

  // ── Batching ─────────────────────────────────────────────────────────

  describe('batching', () => {
    it('should batch multiple events into one patch', () => {
      const patches: GraphPatch[] = [];
      mgr.onPatch((p) => patches.push(p));

      mgr.beginBatch();
      mgr.addNode(makeNode({ id: 'b1' }));
      mgr.addNode(makeNode({ id: 'b2' }));
      mgr.addNode(makeNode({ id: 'b3' }));
      expect(patches).toHaveLength(0); // nothing emitted yet

      mgr.endBatch();
      expect(patches).toHaveLength(1); // single patch
      expect(patches[0].events).toHaveLength(3);
    });

    it('should support nested batching', () => {
      const patches: GraphPatch[] = [];
      mgr.onPatch((p) => patches.push(p));

      mgr.beginBatch();
      mgr.addNode(makeNode({ id: 'n1' }));

      mgr.beginBatch(); // nested
      mgr.addNode(makeNode({ id: 'n2' }));
      mgr.endBatch(); // inner close — no emit yet
      expect(patches).toHaveLength(0);

      mgr.endBatch(); // outer close — now emit
      expect(patches).toHaveLength(1);
      expect(patches[0].events).toHaveLength(2);
    });

    it('should throw on unbalanced endBatch', () => {
      expect(() => mgr.endBatch()).toThrow(/without matching/i);
    });
  });

  // ── Snapshot ─────────────────────────────────────────────────────────

  describe('snapshot', () => {
    it('should roundtrip snapshot', () => {
      mgr.addNode(makeNode({ id: 'g', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'c1', parentId: 'g', status: 'running' }));
      mgr.addNode(makeNode({ id: 'c2', parentId: 'g', status: 'error' }));

      const snap = mgr.getSnapshot();

      const mgr2 = new AgentGraphManager();
      mgr2.loadSnapshot(snap);

      expect(mgr2.getNode('g')).toBeDefined();
      expect(mgr2.getNode('c1')?.status).toBe('running');
      expect(mgr2.getNode('c2')?.status).toBe('error');
      expect(mgr2.getChildren('g')).toHaveLength(2);
      expect(mgr2.getRoots()).toHaveLength(1);
    });

    it('should restore rollups after loadSnapshot', () => {
      mgr.addNode(makeNode({ id: 'g', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'r', parentId: 'g', status: 'running' }));
      mgr.addNode(makeNode({ id: 'e', parentId: 'g', status: 'error' }));

      const snap = mgr.getSnapshot();

      const mgr2 = new AgentGraphManager();
      mgr2.loadSnapshot(snap);

      const rollup = mgr2.getRollup('g');
      expect(rollup.subtreeRunningCount).toBe(1);
      expect(rollup.subtreeErrorCount).toBe(1);
      expect(rollup.subtreeNodeCount).toBe(2);
    });
  });

  // ── Events ───────────────────────────────────────────────────────────

  describe('events', () => {
    it('should emit patch with correct version', () => {
      const patches: GraphPatch[] = [];
      mgr.onPatch((p) => patches.push(p));

      mgr.addNode(makeNode({ id: 'v1' }));
      expect(patches).toHaveLength(1);
      expect(patches[0].version).toBe(1);
      expect(patches[0].previousVersion).toBe(0);

      mgr.addNode(makeNode({ id: 'v2' }));
      expect(patches).toHaveLength(2);
      expect(patches[1].version).toBe(2);
      expect(patches[1].previousVersion).toBe(1);
    });

    it('should include full node in node-added changes', () => {
      const patches: GraphPatch[] = [];
      mgr.onPatch((p) => patches.push(p));

      mgr.addNode(makeNode({ id: 'added-node', label: 'Fresh' }));

      expect(patches).toHaveLength(1);
      const event = patches[0].events[0];
      expect(event.type).toBe('node-added');
      expect(event.nodeId).toBe('added-node');
    });

    it('should emit node-removed events bottom-up', () => {
      mgr.addNode(makeNode({ id: 'p', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'c', parentId: 'p' }));

      const patches: GraphPatch[] = [];
      mgr.onPatch((p) => patches.push(p));

      mgr.removeNode('p');
      const lastPatch = patches[patches.length - 1];
      const removedIds = lastPatch.events
        .filter((e) => e.type === 'node-removed')
        .map((e) => e.nodeId);
      // child should appear before parent (bottom-up)
      expect(removedIds.indexOf('c')).toBeLessThan(removedIds.indexOf('p'));
    });

    it('should emit node-moved with old and new parent', () => {
      mgr.addNode(makeNode({ id: 'g1', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'g2', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'm', parentId: 'g1' }));

      const patches: GraphPatch[] = [];
      mgr.onPatch((p) => patches.push(p));

      mgr.moveNode('m', 'g2');

      const moveEvent = patches[patches.length - 1].events.find(
        (e) => e.type === 'node-moved',
      );
      expect(moveEvent).toBeDefined();
      expect(moveEvent!.oldParentId).toBe('g1');
      expect(moveEvent!.newParentId).toBe('g2');
    });

    it('should dispose listener', () => {
      const patches: GraphPatch[] = [];
      const sub = mgr.onPatch((p) => patches.push(p));

      mgr.addNode(makeNode({ id: 'd1' }));
      expect(patches).toHaveLength(1);

      sub.dispose();
      mgr.addNode(makeNode({ id: 'd2' }));
      expect(patches).toHaveLength(1); // no new patches after dispose
    });
  });

  // ── Query helpers ────────────────────────────────────────────────────

  describe('query helpers', () => {
    it('findByTerminalId should find the matching node', () => {
      mgr.addNode(makeNode({ id: 't1', terminalId: 'term-abc' }));
      mgr.addNode(makeNode({ id: 't2', terminalId: 'term-def' }));

      expect(mgr.findByTerminalId('term-abc')?.id).toBe('t1');
      expect(mgr.findByTerminalId('term-def')?.id).toBe('t2');
      expect(mgr.findByTerminalId('term-none')).toBeUndefined();
    });

    it('findByRole should return all matching nodes', () => {
      mgr.addNode(makeNode({ id: 'a', role: 'SDE' }));
      mgr.addNode(makeNode({ id: 'b', role: 'SDE' }));
      mgr.addNode(makeNode({ id: 'c', role: 'M1' }));

      expect(mgr.findByRole('SDE')).toHaveLength(2);
      expect(mgr.findByRole('M1')).toHaveLength(1);
      expect(mgr.findByRole('PM')).toHaveLength(0);
    });

    it('getAncestors should walk up the chain', () => {
      mgr.addNode(makeNode({ id: 'root', nodeType: 'group', label: 'Root' }));
      mgr.addNode(makeNode({ id: 'mid', parentId: 'root', nodeType: 'group', label: 'Mid' }));
      mgr.addNode(makeNode({ id: 'leaf', parentId: 'mid', label: 'Leaf' }));

      const ancestors = mgr.getAncestors('leaf');
      expect(ancestors.map((a) => a.id)).toEqual(['mid', 'root']);
    });

    it('getSubtreeIds should return all descendants', () => {
      mgr.addNode(makeNode({ id: 'r', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'a', parentId: 'r', nodeType: 'group' }));
      mgr.addNode(makeNode({ id: 'b', parentId: 'r' }));
      mgr.addNode(makeNode({ id: 'aa', parentId: 'a' }));

      const ids = mgr.getSubtreeIds('r');
      expect(ids).toContain('a');
      expect(ids).toContain('b');
      expect(ids).toContain('aa');
      expect(ids).not.toContain('r'); // excludes self
    });
  });

  // ── Dispose ──────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('should clear all state', () => {
      mgr.addNode(makeNode({ id: 'x' }));
      mgr.dispose();
      expect(mgr.getNode('x')).toBeUndefined();
      expect(mgr.getRoots()).toHaveLength(0);
    });
  });
});
