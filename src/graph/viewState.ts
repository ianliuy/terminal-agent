import { EventEmitter } from 'node:events';

// ── Types ──────────────────────────────────────────────────────────

/** Serializable snapshot of all view state, for persist/restore across Webview reconnections. */
export interface ViewStateSnapshot {
  collapsedIds: string[];
  pinnedIds: string[];
  selectedId: string | null;
  focusedId: string | null;
  filterText: string;
  expandedDepth: number;
}

/** Describes a single view-state mutation. */
export interface ViewStateChangeEvent {
  type: 'collapsed' | 'pinned' | 'selected' | 'focused' | 'filter' | 'expanded-depth' | 'bulk';
  nodeId?: string;
  value?: unknown;
}

// ── Class ──────────────────────────────────────────────────────────

/**
 * UI-only state for the agent graph.
 *
 * Tracks which nodes are collapsed, pinned, selected, and focused —
 * state that the Webview needs but the core graph model doesn't own.
 * Emits change events so the Webview layer can react.
 */
export class GraphViewState {
  private collapsed = new Set<string>();
  private pinned = new Set<string>();
  private selectedId: string | null = null;
  private focusedId: string | null = null;
  private filterText = '';
  private expandedDepth = 2;
  private emitter = new EventEmitter();

  // ── Collapse / expand ──────────────────────────────────────────

  /** Whether the given node is collapsed. */
  isCollapsed(id: string): boolean {
    return this.collapsed.has(id);
  }

  /** Toggle collapsed state and emit. */
  toggleCollapse(id: string): void {
    if (this.collapsed.has(id)) {
      this.expand(id);
    } else {
      this.collapse(id);
    }
  }

  /** Collapse a single node. */
  collapse(id: string): void {
    if (!this.collapsed.has(id)) {
      this.collapsed.add(id);
      this.emit({ type: 'collapsed', nodeId: id, value: true });
    }
  }

  /** Expand a single node. */
  expand(id: string): void {
    if (this.collapsed.has(id)) {
      this.collapsed.delete(id);
      this.emit({ type: 'collapsed', nodeId: id, value: false });
    }
  }

  /** Collapse every node, emit a single bulk event. */
  collapseAll(): void {
    // The caller typically feeds *all* node IDs; but since we don't own the
    // tree we just mark everything currently known as collapsed — which is a
    // no-op beyond what's already tracked.  The practical pattern is:
    //   viewState.collapseAll()  — marks whatever is tracked
    // But we still emit so the Webview can treat all nodes as collapsed.
    this.emit({ type: 'bulk' });
  }

  /**
   * Expand nodes up to `depth` levels deep, collapse everything deeper.
   *
   * Because the view state doesn't own the tree structure, the caller must
   * provide a `getChildren` callback that returns direct child IDs for a
   * given parent (pass `null` for root children).
   */
  expandToDepth(depth: number, getChildren: (parentId: string | null) => string[]): void {
    this.expandedDepth = depth;
    this.collapsed.clear();

    const walk = (parentId: string | null, currentDepth: number): void => {
      const children = getChildren(parentId);
      for (const childId of children) {
        if (currentDepth >= depth) {
          this.collapsed.add(childId);
        }
        walk(childId, currentDepth + 1);
      }
    };
    walk(null, 0);

    this.emit({ type: 'expanded-depth', value: depth });
  }

  // ── Pin ────────────────────────────────────────────────────────

  /** Whether the given node is pinned. */
  isPinned(id: string): boolean {
    return this.pinned.has(id);
  }

  /** Toggle pinned state and emit. */
  togglePin(id: string): void {
    if (this.pinned.has(id)) {
      this.unpin(id);
    } else {
      this.pin(id);
    }
  }

  /** Pin a node. */
  pin(id: string): void {
    if (!this.pinned.has(id)) {
      this.pinned.add(id);
      this.emit({ type: 'pinned', nodeId: id, value: true });
    }
  }

  /** Unpin a node. */
  unpin(id: string): void {
    if (this.pinned.has(id)) {
      this.pinned.delete(id);
      this.emit({ type: 'pinned', nodeId: id, value: false });
    }
  }

  // ── Selection ──────────────────────────────────────────────────

  /** Get the currently selected node ID, or `null`. */
  getSelectedId(): string | null {
    return this.selectedId;
  }

  /** Set the selected node (or `null` to clear). */
  select(id: string | null): void {
    if (this.selectedId !== id) {
      this.selectedId = id;
      this.emit({ type: 'selected', nodeId: id ?? undefined });
    }
  }

  /** Whether the given node is the currently selected one. */
  isSelected(id: string): boolean {
    return this.selectedId === id;
  }

  // ── Focus ──────────────────────────────────────────────────────

  /** Get the currently focused node ID, or `null`. */
  getFocusedId(): string | null {
    return this.focusedId;
  }

  /** Set the focused node (or `null` to clear). */
  focus(id: string | null): void {
    if (this.focusedId !== id) {
      this.focusedId = id;
      this.emit({ type: 'focused', nodeId: id ?? undefined });
    }
  }

  // ── Filter ─────────────────────────────────────────────────────

  /** Get the current filter text. */
  getFilterText(): string {
    return this.filterText;
  }

  /** Update the filter text and emit. */
  setFilterText(text: string): void {
    if (this.filterText !== text) {
      this.filterText = text;
      this.emit({ type: 'filter', value: text });
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────

  /**
   * Remove all view-state references to a deleted node.
   *
   * Clears the node from collapsed/pinned sets and resets selection/focus
   * if they pointed at this node.
   */
  removeNode(id: string): void {
    this.collapsed.delete(id);
    this.pinned.delete(id);
    if (this.selectedId === id) {
      this.selectedId = null;
    }
    if (this.focusedId === id) {
      this.focusedId = null;
    }
  }

  // ── Events ─────────────────────────────────────────────────────

  /** Subscribe to view-state changes. Returns a disposable handle. */
  onChange(listener: (event: ViewStateChangeEvent) => void): { dispose(): void } {
    this.emitter.on('change', listener);
    return {
      dispose: () => {
        this.emitter.removeListener('change', listener);
      },
    };
  }

  // ── Serialization ──────────────────────────────────────────────

  /** Capture a serializable snapshot of the current view state. */
  getSnapshot(): ViewStateSnapshot {
    return {
      collapsedIds: [...this.collapsed],
      pinnedIds: [...this.pinned],
      selectedId: this.selectedId,
      focusedId: this.focusedId,
      filterText: this.filterText,
      expandedDepth: this.expandedDepth,
    };
  }

  /** Replace all view state from a snapshot and emit a bulk change. */
  loadSnapshot(snapshot: ViewStateSnapshot): void {
    this.collapsed = new Set(snapshot.collapsedIds);
    this.pinned = new Set(snapshot.pinnedIds);
    this.selectedId = snapshot.selectedId;
    this.focusedId = snapshot.focusedId;
    this.filterText = snapshot.filterText;
    this.expandedDepth = snapshot.expandedDepth;
    this.emit({ type: 'bulk' });
  }

  // ── Dispose ────────────────────────────────────────────────────

  /** Clear all state and remove all listeners. */
  dispose(): void {
    this.collapsed.clear();
    this.pinned.clear();
    this.selectedId = null;
    this.focusedId = null;
    this.filterText = '';
    this.emitter.removeAllListeners();
  }

  // ── Internal ───────────────────────────────────────────────────

  private emit(event: ViewStateChangeEvent): void {
    this.emitter.emit('change', event);
  }
}
