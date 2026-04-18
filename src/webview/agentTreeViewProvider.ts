/**
 * @file agentTreeViewProvider.ts
 *
 * WebviewViewProvider for the Terminal Agent sidebar panel.
 *
 * Renders the agent hierarchy as vertical tabs with indentation,
 * collapse/expand, status badges, and basic interactions.
 * Communicates with the extension host via postMessage for graph
 * sync (snapshot + patches) and user actions (select, stop, retry…).
 */

import * as vscode from 'vscode';
import type { AgentOrchestrator } from '../graph/orchestrator.js';
import type { GraphViewState } from '../graph/viewState.js';
import type { GraphPatch, GraphSyncMessage } from '../graph/types.js';
import { logger } from '../utils/logger.js';

const log = logger.withContext('AgentTreeView');

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AgentTreeViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orchestrator: AgentOrchestrator,
    private readonly viewState: GraphViewState,
  ) {}

  // ── WebviewViewProvider ─────────────────────────────────────────

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // ── Send initial snapshot once the webview is ready ─────────
    // The webview JS posts 'request-sync' when it has initialised.
    // We also send eagerly so fast startups don't miss data.
    this.postSnapshot();

    // ── Graph patches → webview ────────────────────────────────
    const patchSub = this.orchestrator.onPatch((patch: GraphPatch) => {
      this.postMessage({ type: 'patch', data: patch });
    });

    // ── View-state changes → webview ───────────────────────────
    const viewStateSub = this.viewState.onChange((event) => {
      this.postMessage({ type: 'view-state', data: event });
    });

    // ── Messages FROM the webview ──────────────────────────────
    const messageSub = webviewView.webview.onDidReceiveMessage(
      (msg: WebviewIncomingMessage) => {
        this.handleWebviewMessage(msg);
      },
    );

    // ── Visibility ─────────────────────────────────────────────
    const visibilitySub = webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        log.info('Webview became visible — sending snapshot');
        this.postSnapshot();
      }
    });

    // ── Disposables ────────────────────────────────────────────
    webviewView.onDidDispose(() => {
      this.view = undefined;
    });

    webviewView.webview.onDidReceiveMessage(() => {}, undefined, [
      patchSub,
      viewStateSub,
      messageSub,
      visibilitySub,
    ]);
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private postSnapshot(): void {
    const syncMsg = this.orchestrator.getInitialSyncMessage();
    this.postMessage(syncMsg);

    // Also send current view-state snapshot
    this.postMessage({
      type: 'view-state-snapshot',
      data: this.viewState.getSnapshot(),
    });
  }

  private postMessage(msg: unknown): void {
    if (this.view?.visible) {
      void this.view.webview.postMessage(msg);
    }
  }

  // ── Incoming messages from webview ──────────────────────────────

  private handleWebviewMessage(msg: WebviewIncomingMessage): void {
    switch (msg.type) {
      case 'select':
        this.viewState.select(msg.nodeId ?? null);
        break;

      case 'toggle-collapse':
        if (msg.nodeId) this.viewState.toggleCollapse(msg.nodeId);
        break;

      case 'toggle-pin':
        if (msg.nodeId) this.viewState.togglePin(msg.nodeId);
        break;

      case 'stop':
        if (msg.nodeId) {
          void this.orchestrator.stopSubtree(msg.nodeId).then((r) =>
            log.info(`Stopped subtree ${msg.nodeId}: ${r.stopped} nodes`),
          );
        }
        break;

      case 'retry':
        if (msg.nodeId) {
          void this.orchestrator.retryNode(msg.nodeId).then((node) =>
            log.info(`Retried ${msg.nodeId}: ${node ? 'ok' : 'not retryable'}`),
          );
        }
        break;

      case 'focus-terminal':
        if (msg.nodeId) this.focusTerminal(msg.nodeId);
        break;

      case 'request-sync':
        log.info('Webview requested sync');
        this.postSnapshot();
        break;

      default:
        log.warn(`Unknown webview message type: ${(msg as { type: string }).type}`);
    }
  }

  /** Focus the VS Code terminal bound to the given graph node. */
  private focusTerminal(nodeId: string): void {
    const syncMsg = this.orchestrator.getInitialSyncMessage();
    if (syncMsg.type !== 'snapshot') return;

    const node = syncMsg.data.nodes[nodeId];
    if (!node?.terminalId) {
      log.warn(`focusTerminal: no terminal bound to node ${nodeId}`);
      return;
    }

    // Walk VS Code terminals to find a matching one by name
    const terminals = vscode.window.terminals;
    const match = terminals.find((t) => t.name === node.label);
    if (match) {
      match.show();
      log.info(`Focused terminal "${node.label}"`);
    } else {
      log.warn(`focusTerminal: no VS Code terminal found for "${node.label}"`);
    }
  }

  // ── HTML ────────────────────────────────────────────────────────

  private getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';"
  />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Tree</title>
  <style nonce="${nonce}">
    /* ── Reset ───────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { height: 100%; }
    body {
      font-family: var(--vscode-font-family, system-ui, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, transparent);
      overflow-y: auto;
    }

    /* ── Empty state ─────────────────────────────────── */
    #empty {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      opacity: 0.5;
      font-style: italic;
    }

    /* ── Node row ─────────────────────────────────────── */
    .node-row {
      display: flex;
      align-items: center;
      padding: 3px 8px 3px 0;
      cursor: pointer;
      border-left: 3px solid transparent;
      user-select: none;
      min-height: 26px;
    }
    .node-row:hover {
      background: var(--vscode-list-hoverBackground, rgba(255,255,255,0.05));
    }
    .node-row.selected {
      background: var(--vscode-list-activeSelectionBackground, rgba(0,120,212,0.3));
      border-left-color: var(--vscode-focusBorder, #007acc);
    }
    .node-row.pinned {
      border-left-color: var(--vscode-charts-yellow, #cca700);
    }

    /* ── Chevron ──────────────────────────────────────── */
    .chevron {
      width: 16px;
      flex-shrink: 0;
      text-align: center;
      font-size: 10px;
      opacity: 0.6;
      cursor: pointer;
    }
    .chevron:hover { opacity: 1; }
    .chevron.empty { visibility: hidden; }

    /* ── Status icon ─────────────────────────────────── */
    .status-icon {
      width: 16px;
      flex-shrink: 0;
      text-align: center;
      font-size: 11px;
    }
    .status-running  { color: var(--vscode-charts-green, #89d185); }
    .status-error    { color: var(--vscode-charts-red, #f14c4c); }
    .status-blocked  { color: var(--vscode-charts-orange, #cca700); }
    .status-done     { color: var(--vscode-charts-green, #89d185); opacity: 0.6; }
    .status-stopped  { color: var(--vscode-descriptionForeground, #888); }
    .status-idle     { opacity: 0.4; }
    .status-starting { color: var(--vscode-charts-blue, #3794ff); }
    .status-queued   { opacity: 0.5; }
    .status-waiting  { color: var(--vscode-charts-yellow, #cca700); }
    .status-stopping { color: var(--vscode-charts-orange, #cca700); opacity: 0.7; }

    /* ── Label ────────────────────────────────────────── */
    .node-label {
      flex: 1;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding: 0 4px;
    }

    /* ── Role badge ───────────────────────────────────── */
    .role-badge {
      flex-shrink: 0;
      font-size: 10px;
      padding: 1px 5px;
      border-radius: 3px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      margin-right: 4px;
      text-transform: uppercase;
    }

    /* ── Summary ──────────────────────────────────────── */
    .node-summary {
      font-size: 11px;
      opacity: 0.6;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 120px;
    }

    /* ── Action buttons (visible on hover) ────────────── */
    .node-actions {
      display: none;
      flex-shrink: 0;
      gap: 2px;
    }
    .node-row:hover .node-actions { display: flex; }
    .action-btn {
      background: none;
      border: none;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 2px 4px;
      font-size: 12px;
      border-radius: 3px;
      opacity: 0.7;
    }
    .action-btn:hover {
      opacity: 1;
      background: var(--vscode-toolbar-hoverBackground, rgba(255,255,255,0.1));
    }

    /* ── Rollup counts ────────────────────────────────── */
    .rollup {
      font-size: 10px;
      opacity: 0.5;
      margin-left: 4px;
      flex-shrink: 0;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');

    // ── State ──────────────────────────────────────────
    let snapshot = null;     // GraphSnapshot
    let viewState = null;    // ViewStateSnapshot
    let selectedId = null;

    // ── Status icon map ───────────────────────────────
    const STATUS_ICON = {
      'idle':          '◯',
      'queued':        '◦',
      'starting':      '◐',
      'running':       '●',
      'blocked':       '⏸',
      'waiting-input': '⏳',
      'stopping':      '◑',
      'stopped':       '⏹',
      'error':         '⬤',
      'done':          '✓',
      'disconnected':  '⊘',
    };

    const STATUS_CLASS = {
      'idle':          'status-idle',
      'queued':        'status-queued',
      'starting':      'status-starting',
      'running':       'status-running',
      'blocked':       'status-blocked',
      'waiting-input': 'status-waiting',
      'stopping':      'status-stopping',
      'stopped':       'status-stopped',
      'error':         'status-error',
      'done':          'status-done',
      'disconnected':  'status-stopped',
    };

    // ── Message handling ──────────────────────────────
    window.addEventListener('message', (event) => {
      const msg = event.data;
      switch (msg.type) {
        case 'snapshot':
          snapshot = msg.data;
          render();
          break;
        case 'patch':
          if (snapshot) applyPatch(msg.data);
          render();
          break;
        case 'view-state-snapshot':
          viewState = msg.data;
          selectedId = viewState?.selectedId ?? null;
          render();
          break;
        case 'view-state':
          applyViewStateEvent(msg.data);
          render();
          break;
      }
    });

    // ── Patch application ─────────────────────────────
    function applyPatch(patch) {
      if (!snapshot) return;
      if (patch.previousVersion !== snapshot.version) {
        // Version mismatch — request full resync
        vscode.postMessage({ type: 'request-sync' });
        return;
      }
      for (const event of patch.events) {
        switch (event.type) {
          case 'node-added':
            if (event.changes) {
              snapshot.nodes[event.nodeId] = event.changes;
              const parentKey = event.changes.parentId || '__root__';
              if (!snapshot.childOrder[parentKey]) snapshot.childOrder[parentKey] = [];
              snapshot.childOrder[parentKey].push(event.nodeId);
            }
            break;
          case 'node-removed':
            if (snapshot.nodes[event.nodeId]) {
              const node = snapshot.nodes[event.nodeId];
              const parentKey = node.parentId || '__root__';
              if (snapshot.childOrder[parentKey]) {
                snapshot.childOrder[parentKey] = snapshot.childOrder[parentKey].filter(id => id !== event.nodeId);
              }
              delete snapshot.childOrder[event.nodeId];
              delete snapshot.nodes[event.nodeId];
            }
            break;
          case 'node-updated':
            if (snapshot.nodes[event.nodeId] && event.changes) {
              Object.assign(snapshot.nodes[event.nodeId], event.changes);
            }
            break;
          case 'node-moved':
            if (snapshot.nodes[event.nodeId]) {
              const oldKey = event.oldParentId || '__root__';
              const newKey = event.newParentId || '__root__';
              if (snapshot.childOrder[oldKey]) {
                snapshot.childOrder[oldKey] = snapshot.childOrder[oldKey].filter(id => id !== event.nodeId);
              }
              if (!snapshot.childOrder[newKey]) snapshot.childOrder[newKey] = [];
              const idx = event.newIndex ?? snapshot.childOrder[newKey].length;
              snapshot.childOrder[newKey].splice(idx, 0, event.nodeId);
              snapshot.nodes[event.nodeId].parentId = event.newParentId ?? null;
            }
            break;
        }
      }
      snapshot.version = patch.version;
    }

    // ── View-state helpers ────────────────────────────
    function applyViewStateEvent(event) {
      if (!viewState) viewState = { collapsedIds: [], pinnedIds: [], selectedId: null, focusedId: null, filterText: '', expandedDepth: 2 };
      switch (event.type) {
        case 'collapsed':
          if (event.value) {
            if (!viewState.collapsedIds.includes(event.nodeId)) viewState.collapsedIds.push(event.nodeId);
          } else {
            viewState.collapsedIds = viewState.collapsedIds.filter(id => id !== event.nodeId);
          }
          break;
        case 'pinned':
          if (event.value) {
            if (!viewState.pinnedIds.includes(event.nodeId)) viewState.pinnedIds.push(event.nodeId);
          } else {
            viewState.pinnedIds = viewState.pinnedIds.filter(id => id !== event.nodeId);
          }
          break;
        case 'selected':
          selectedId = event.nodeId ?? null;
          break;
        case 'bulk':
          // Full refresh needed — request snapshot
          vscode.postMessage({ type: 'request-sync' });
          break;
      }
    }

    function isCollapsed(nodeId) {
      return viewState?.collapsedIds?.includes(nodeId) ?? false;
    }

    function isPinned(nodeId) {
      return viewState?.pinnedIds?.includes(nodeId) ?? false;
    }

    // ── Render ─────────────────────────────────────────
    function render() {
      if (!snapshot) {
        root.innerHTML = '<div id="empty">No agents yet</div>';
        return;
      }

      const rootChildren = snapshot.childOrder['__root__'] || [];
      if (rootChildren.length === 0) {
        root.innerHTML = '<div id="empty">No agents yet</div>';
        return;
      }

      const fragment = document.createDocumentFragment();
      for (const childId of rootChildren) {
        renderNode(fragment, childId, 0);
      }
      root.innerHTML = '';
      root.appendChild(fragment);
    }

    function renderNode(container, nodeId, depth) {
      const node = snapshot.nodes[nodeId];
      if (!node) return;

      const children = snapshot.childOrder[nodeId] || [];
      const hasChildren = children.length > 0;
      const collapsed = isCollapsed(nodeId);
      const pinned = isPinned(nodeId);
      const selected = selectedId === nodeId;

      // ── Row ────────────────
      const row = document.createElement('div');
      row.className = 'node-row' + (selected ? ' selected' : '') + (pinned ? ' pinned' : '');
      row.style.paddingLeft = (8 + depth * 16) + 'px';
      row.dataset.nodeId = nodeId;

      // Chevron
      const chevron = document.createElement('span');
      chevron.className = 'chevron' + (hasChildren ? '' : ' empty');
      chevron.textContent = hasChildren ? (collapsed ? '▶' : '▼') : '';
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'toggle-collapse', nodeId });
      });
      row.appendChild(chevron);

      // Status icon
      const statusEl = document.createElement('span');
      statusEl.className = 'status-icon ' + (STATUS_CLASS[node.status] || '');
      statusEl.textContent = STATUS_ICON[node.status] || '?';
      statusEl.title = node.status;
      row.appendChild(statusEl);

      // Label
      const label = document.createElement('span');
      label.className = 'node-label';
      label.textContent = node.label;
      label.title = node.label;
      row.appendChild(label);

      // Role badge
      if (node.role) {
        const badge = document.createElement('span');
        badge.className = 'role-badge';
        badge.textContent = node.role;
        row.appendChild(badge);
      }

      // Summary
      if (node.summary) {
        const summary = document.createElement('span');
        summary.className = 'node-summary';
        summary.textContent = node.summary;
        summary.title = node.summary;
        row.appendChild(summary);
      }

      // Rollup for groups with collapsed children
      if (hasChildren && collapsed) {
        const count = countSubtree(nodeId);
        const rollup = document.createElement('span');
        rollup.className = 'rollup';
        rollup.textContent = '(' + count + ')';
        row.appendChild(rollup);
      }

      // Action buttons
      const actions = document.createElement('span');
      actions.className = 'node-actions';

      if (node.terminalId) {
        const focusBtn = createActionBtn('⬡', 'Focus terminal', () =>
          vscode.postMessage({ type: 'focus-terminal', nodeId }),
        );
        actions.appendChild(focusBtn);
      }

      if (node.status === 'running' || node.status === 'starting') {
        const stopBtn = createActionBtn('■', 'Stop', () =>
          vscode.postMessage({ type: 'stop', nodeId }),
        );
        actions.appendChild(stopBtn);
      }

      if (node.status === 'error' || node.status === 'stopped') {
        const retryBtn = createActionBtn('↻', 'Retry', () =>
          vscode.postMessage({ type: 'retry', nodeId }),
        );
        actions.appendChild(retryBtn);
      }

      row.appendChild(actions);

      // Click to select
      row.addEventListener('click', () => {
        selectedId = nodeId;
        vscode.postMessage({ type: 'select', nodeId });
        render();
      });

      container.appendChild(row);

      // ── Children ───────────
      if (hasChildren && !collapsed) {
        for (const childId of children) {
          renderNode(container, childId, depth + 1);
        }
      }
    }

    function countSubtree(nodeId) {
      const children = snapshot.childOrder[nodeId] || [];
      let count = children.length;
      for (const childId of children) {
        count += countSubtree(childId);
      }
      return count;
    }

    function createActionBtn(icon, title, handler) {
      const btn = document.createElement('button');
      btn.className = 'action-btn';
      btn.textContent = icon;
      btn.title = title;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        handler();
      });
      return btn;
    }

    // ── Initial sync request ──────────────────────────
    vscode.postMessage({ type: 'request-sync' });
  })();
  </script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}

// ---------------------------------------------------------------------------
// Message types from webview → extension host
// ---------------------------------------------------------------------------

interface WebviewIncomingMessage {
  type:
    | 'select'
    | 'toggle-collapse'
    | 'toggle-pin'
    | 'stop'
    | 'retry'
    | 'focus-terminal'
    | 'request-sync';
  nodeId?: string;
}
