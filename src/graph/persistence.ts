/**
 * GraphPersistence — saves/restores graph and view state across VS Code reloads.
 *
 * Uses `vscode.ExtensionContext.globalState` for durable storage.
 * Debounces writes at 500ms to avoid IO storms during rapid changes.
 * On restore, clears ephemeral terminal bindings and marks active agents
 * as 'disconnected' since their terminals don't survive reload.
 */

import * as vscode from 'vscode';
import type { AgentGraphManager } from './graphManager.js';
import type { GraphViewState } from './viewState.js';
import type { GraphSnapshot } from './types.js';
import type { ViewStateSnapshot } from './viewState.js';
import { logger } from '../utils/logger.js';

const GRAPH_STATE_KEY = 'terminalAgent.graphSnapshot';
const SAVE_DEBOUNCE_MS = 500;

interface PersistedState {
  graph: GraphSnapshot;
  viewState: ViewStateSnapshot;
  savedAt: number; // epoch ms
}

export class GraphPersistence {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private disposables: { dispose(): void }[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly graph: AgentGraphManager,
    private readonly viewState: GraphViewState,
  ) {}

  /**
   * Load persisted state and hydrate graph + view state.
   * Call this once during activation, BEFORE setting up the patch listener.
   */
  restore(): boolean {
    const log = logger.withContext('GraphPersistence');
    try {
      const raw = this.context.globalState.get<PersistedState>(GRAPH_STATE_KEY);
      if (!raw?.graph) {
        log.info('No persisted graph state found');
        return false;
      }

      // Hydrate graph
      this.graph.loadSnapshot(raw.graph);
      log.info(`Restored graph: ${Object.keys(raw.graph.nodes).length} nodes, version ${raw.graph.version}`);

      // Hydrate view state
      if (raw.viewState) {
        this.viewState.loadSnapshot(raw.viewState);
        log.info('Restored view state');
      }

      // Clear ephemeral terminalId bindings — terminals don't survive reload
      const snapshot = this.graph.getSnapshot();
      for (const node of Object.values(snapshot.nodes)) {
        if (node.terminalId) {
          this.graph.updateNode(node.id, { terminalId: null });
        }
        // Reset running/starting agents to 'disconnected' since their terminals are gone
        if (['running', 'starting', 'stopping'].includes(node.status)) {
          this.graph.updateNode(node.id, { status: 'disconnected' });
        }
      }

      return true;
    } catch (err) {
      log.error('Failed to restore graph state', err);
      return false;
    }
  }

  /**
   * Start watching for changes and auto-saving.
   * Call this AFTER restore().
   */
  startAutoSave(): void {
    // Subscribe to graph patches
    const patchSub = this.graph.onPatch(() => {
      this.debouncedSave();
    });
    this.disposables.push(patchSub);

    // Subscribe to view state changes
    const viewSub = this.viewState.onChange(() => {
      this.debouncedSave();
    });
    this.disposables.push(viewSub);
  }

  private debouncedSave(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save();
    }, SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    const log = logger.withContext('GraphPersistence');
    try {
      const state: PersistedState = {
        graph: this.graph.getSnapshot(),
        viewState: this.viewState.getSnapshot(),
        savedAt: Date.now(),
      };
      await this.context.globalState.update(GRAPH_STATE_KEY, state);
      log.debug(`Saved graph state: ${Object.keys(state.graph.nodes).length} nodes`);
    } catch (err) {
      log.error('Failed to save graph state', err);
    }
  }

  dispose(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    // Final save before dispose
    const state: PersistedState = {
      graph: this.graph.getSnapshot(),
      viewState: this.viewState.getSnapshot(),
      savedAt: Date.now(),
    };
    void this.context.globalState.update(GRAPH_STATE_KEY, state);

    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
