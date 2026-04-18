import { describe, it, expect, beforeEach } from 'vitest';
import { GraphViewState } from '../viewState.js';
import type { ViewStateChangeEvent, ViewStateSnapshot } from '../viewState.js';

describe('GraphViewState', () => {
  let vs: GraphViewState;

  beforeEach(() => {
    vs = new GraphViewState();
  });

  // ── Collapse / Expand ────────────────────────────────────────────────

  describe('collapse/expand', () => {
    it('should start with nodes expanded (not collapsed)', () => {
      expect(vs.isCollapsed('n1')).toBe(false);
    });

    it('should collapse a node', () => {
      vs.collapse('n1');
      expect(vs.isCollapsed('n1')).toBe(true);
    });

    it('should expand a collapsed node', () => {
      vs.collapse('n1');
      vs.expand('n1');
      expect(vs.isCollapsed('n1')).toBe(false);
    });

    it('should toggle collapse', () => {
      vs.toggleCollapse('n1');
      expect(vs.isCollapsed('n1')).toBe(true);
      vs.toggleCollapse('n1');
      expect(vs.isCollapsed('n1')).toBe(false);
    });

    it('should not emit when collapsing already collapsed node', () => {
      vs.collapse('n1');
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));
      vs.collapse('n1'); // already collapsed
      expect(events).toHaveLength(0);
    });

    it('should not emit when expanding already expanded node', () => {
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));
      vs.expand('n1'); // already expanded
      expect(events).toHaveLength(0);
    });
  });

  // ── Pin / Unpin ──────────────────────────────────────────────────────

  describe('pin/unpin', () => {
    it('should start unpinned', () => {
      expect(vs.isPinned('n1')).toBe(false);
    });

    it('should pin a node', () => {
      vs.pin('n1');
      expect(vs.isPinned('n1')).toBe(true);
    });

    it('should unpin a pinned node', () => {
      vs.pin('n1');
      vs.unpin('n1');
      expect(vs.isPinned('n1')).toBe(false);
    });

    it('should toggle pin', () => {
      vs.togglePin('n1');
      expect(vs.isPinned('n1')).toBe(true);
      vs.togglePin('n1');
      expect(vs.isPinned('n1')).toBe(false);
    });

    it('should not emit when pinning already pinned node', () => {
      vs.pin('n1');
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));
      vs.pin('n1');
      expect(events).toHaveLength(0);
    });
  });

  // ── Selection ────────────────────────────────────────────────────────

  describe('selection', () => {
    it('should start with no selection', () => {
      expect(vs.getSelectedId()).toBeNull();
    });

    it('should select a node', () => {
      vs.select('n1');
      expect(vs.getSelectedId()).toBe('n1');
      expect(vs.isSelected('n1')).toBe(true);
      expect(vs.isSelected('n2')).toBe(false);
    });

    it('should clear selection with null', () => {
      vs.select('n1');
      vs.select(null);
      expect(vs.getSelectedId()).toBeNull();
      expect(vs.isSelected('n1')).toBe(false);
    });

    it('should not emit when selecting same node', () => {
      vs.select('n1');
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));
      vs.select('n1');
      expect(events).toHaveLength(0);
    });
  });

  // ── Focus ────────────────────────────────────────────────────────────

  describe('focus', () => {
    it('should start with no focus', () => {
      expect(vs.getFocusedId()).toBeNull();
    });

    it('should set and get focus', () => {
      vs.focus('n1');
      expect(vs.getFocusedId()).toBe('n1');
    });

    it('should clear focus with null', () => {
      vs.focus('n1');
      vs.focus(null);
      expect(vs.getFocusedId()).toBeNull();
    });
  });

  // ── Filter ───────────────────────────────────────────────────────────

  describe('filter', () => {
    it('should start with empty filter text', () => {
      expect(vs.getFilterText()).toBe('');
    });

    it('should set filter text', () => {
      vs.setFilterText('search term');
      expect(vs.getFilterText()).toBe('search term');
    });

    it('should emit on filter change', () => {
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));

      vs.setFilterText('hello');
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('filter');
      expect(events[0].value).toBe('hello');
    });

    it('should not emit when setting same filter text', () => {
      vs.setFilterText('same');
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));
      vs.setFilterText('same');
      expect(events).toHaveLength(0);
    });
  });

  // ── removeNode ───────────────────────────────────────────────────────

  describe('removeNode', () => {
    it('should clear collapsed state', () => {
      vs.collapse('n1');
      vs.removeNode('n1');
      expect(vs.isCollapsed('n1')).toBe(false);
    });

    it('should clear pinned state', () => {
      vs.pin('n1');
      vs.removeNode('n1');
      expect(vs.isPinned('n1')).toBe(false);
    });

    it('should clear selection if node was selected', () => {
      vs.select('n1');
      vs.removeNode('n1');
      expect(vs.getSelectedId()).toBeNull();
    });

    it('should not clear selection if different node was selected', () => {
      vs.select('n2');
      vs.removeNode('n1');
      expect(vs.getSelectedId()).toBe('n2');
    });

    it('should clear focus if node was focused', () => {
      vs.focus('n1');
      vs.removeNode('n1');
      expect(vs.getFocusedId()).toBeNull();
    });

    it('should not clear focus if different node was focused', () => {
      vs.focus('n2');
      vs.removeNode('n1');
      expect(vs.getFocusedId()).toBe('n2');
    });
  });

  // ── Snapshot roundtrip ───────────────────────────────────────────────

  describe('snapshot', () => {
    it('should roundtrip getSnapshot/loadSnapshot', () => {
      vs.collapse('n1');
      vs.collapse('n2');
      vs.pin('n3');
      vs.select('n4');
      vs.focus('n5');
      vs.setFilterText('test filter');

      const snap = vs.getSnapshot();

      const vs2 = new GraphViewState();
      vs2.loadSnapshot(snap);

      expect(vs2.isCollapsed('n1')).toBe(true);
      expect(vs2.isCollapsed('n2')).toBe(true);
      expect(vs2.isCollapsed('n3')).toBe(false);
      expect(vs2.isPinned('n3')).toBe(true);
      expect(vs2.getSelectedId()).toBe('n4');
      expect(vs2.getFocusedId()).toBe('n5');
      expect(vs2.getFilterText()).toBe('test filter');
    });

    it('should produce correct snapshot shape', () => {
      vs.collapse('a');
      vs.pin('b');
      vs.select('c');
      vs.focus('d');
      vs.setFilterText('f');

      const snap = vs.getSnapshot();
      expect(snap.collapsedIds).toContain('a');
      expect(snap.pinnedIds).toContain('b');
      expect(snap.selectedId).toBe('c');
      expect(snap.focusedId).toBe('d');
      expect(snap.filterText).toBe('f');
      expect(typeof snap.expandedDepth).toBe('number');
    });

    it('should emit bulk event on loadSnapshot', () => {
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));

      const snap: ViewStateSnapshot = {
        collapsedIds: ['x'],
        pinnedIds: ['y'],
        selectedId: null,
        focusedId: null,
        filterText: '',
        expandedDepth: 2,
      };

      vs.loadSnapshot(snap);

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('bulk');
    });
  });

  // ── onChange listener ────────────────────────────────────────────────

  describe('onChange listener', () => {
    it('should fire correct events for collapse', () => {
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));

      vs.collapse('n1');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'collapsed', nodeId: 'n1', value: true });
    });

    it('should fire correct events for expand', () => {
      vs.collapse('n1');
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));

      vs.expand('n1');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'collapsed', nodeId: 'n1', value: false });
    });

    it('should fire correct events for pin', () => {
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));

      vs.pin('n1');
      expect(events[0]).toEqual({ type: 'pinned', nodeId: 'n1', value: true });
    });

    it('should fire correct events for unpin', () => {
      vs.pin('n1');
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));

      vs.unpin('n1');
      expect(events[0]).toEqual({ type: 'pinned', nodeId: 'n1', value: false });
    });

    it('should fire selected event', () => {
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));

      vs.select('n1');
      expect(events[0].type).toBe('selected');
      expect(events[0].nodeId).toBe('n1');
    });

    it('should dispose listener correctly', () => {
      const events: ViewStateChangeEvent[] = [];
      const sub = vs.onChange((e) => events.push(e));

      vs.collapse('n1');
      expect(events).toHaveLength(1);

      sub.dispose();
      vs.collapse('n2');
      expect(events).toHaveLength(1); // no new event
    });
  });

  // ── Dispose ──────────────────────────────────────────────────────────

  describe('dispose', () => {
    it('should clear all state', () => {
      vs.collapse('n1');
      vs.pin('n2');
      vs.select('n3');
      vs.focus('n4');
      vs.setFilterText('search');

      vs.dispose();

      expect(vs.isCollapsed('n1')).toBe(false);
      expect(vs.isPinned('n2')).toBe(false);
      expect(vs.getSelectedId()).toBeNull();
      expect(vs.getFocusedId()).toBeNull();
      expect(vs.getFilterText()).toBe('');
    });

    it('should remove all listeners', () => {
      const events: ViewStateChangeEvent[] = [];
      vs.onChange((e) => events.push(e));

      vs.dispose();
      vs.collapse('n1'); // manually set after dispose — listener should be gone
      // Since collapsed set was cleared by dispose, collapse will add and emit
      // But listener was removed, so events array should stay empty
      expect(events).toHaveLength(0);
    });
  });
});
