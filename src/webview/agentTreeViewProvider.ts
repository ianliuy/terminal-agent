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
import type { GraphPatch } from '../graph/types.js';
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

      case 'filter':
        this.viewState.setFilterText(msg.text ?? '');
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

  private getHtmlForWebview(_webview: vscode.Webview): string {
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

    /* ── Rollup badges (collapsed groups) ────────────── */
    .rollup-badges {
      display: inline-flex;
      gap: 3px;
      margin-left: 4px;
      flex-shrink: 0;
    }
    .rollup-badge {
      font-size: 9px;
      padding: 0 4px;
      border-radius: 7px;
      line-height: 14px;
      font-weight: 600;
    }
    .rollup-badge.rb-running {
      background: rgba(137, 209, 133, 0.2);
      color: var(--vscode-charts-green, #89d185);
    }
    .rollup-badge.rb-error {
      background: rgba(241, 76, 76, 0.2);
      color: var(--vscode-charts-red, #f14c4c);
    }
    .rollup-badge.rb-blocked {
      background: rgba(204, 167, 0, 0.2);
      color: var(--vscode-charts-orange, #cca700);
    }
    .rollup-badge.rb-total {
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      opacity: 0.6;
    }

    /* ── Pin indicator ───────────────────────────────── */
    .pin-icon {
      font-size: 10px;
      margin-right: 2px;
      flex-shrink: 0;
    }

    /* ── Tooltip ──────────────────────────────────────── */
    .node-tooltip {
      display: none;
      position: absolute;
      z-index: 1000;
      left: 20px;
      top: 100%;
      min-width: 220px;
      max-width: 320px;
      padding: 8px 10px;
      background: var(--vscode-editorHoverWidget-background, #2d2d2d);
      border: 1px solid var(--vscode-editorHoverWidget-border, #454545);
      border-radius: 4px;
      font-size: 11px;
      line-height: 1.4;
      color: var(--vscode-editorHoverWidget-foreground, #ccc);
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      pointer-events: none;
      white-space: pre-line;
    }
    .node-row { position: relative; }
    .node-row:hover > .node-tooltip { display: block; }
    .tooltip-label { font-weight: 600; margin-bottom: 4px; }
    .tooltip-row { opacity: 0.8; }
    .tooltip-row .tt-key { display: inline-block; min-width: 70px; opacity: 0.6; }

    /* ── Search/filter bar ────────────────────────────── */
    #search-bar {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      border-bottom: 1px solid var(--vscode-panel-border, #333);
    }
    #search-input {
      flex: 1;
      background: var(--vscode-input-background, #3c3c3c);
      color: var(--vscode-input-foreground, #ccc);
      border: 1px solid var(--vscode-input-border, #555);
      border-radius: 3px;
      padding: 3px 6px;
      font-size: 12px;
      outline: none;
      font-family: inherit;
    }
    #search-input:focus {
      border-color: var(--vscode-focusBorder, #007acc);
    }
    #search-input::placeholder {
      color: var(--vscode-input-placeholderForeground, #888);
    }

    /* ── Status bar ───────────────────────────────────── */
    #status-bar {
      display: flex;
      align-items: center;
      padding: 4px 8px;
      border-top: 1px solid var(--vscode-panel-border, #333);
      font-size: 11px;
      opacity: 0.8;
      gap: 8px;
      flex-wrap: wrap;
      position: sticky;
      bottom: 0;
      background: var(--vscode-sideBar-background, transparent);
    }
    .status-count {
      display: inline-flex;
      align-items: center;
      gap: 3px;
    }
    .status-count .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      display: inline-block;
    }
    .dot-total   { background: var(--vscode-foreground, #ccc); opacity: 0.4; }
    .dot-running { background: var(--vscode-charts-green, #89d185); }
    .dot-error   { background: var(--vscode-charts-red, #f14c4c); }

    .filter-buttons {
      display: inline-flex;
      gap: 2px;
      margin-left: auto;
    }
    .filter-btn {
      background: none;
      border: 1px solid transparent;
      color: var(--vscode-foreground);
      cursor: pointer;
      padding: 1px 6px;
      font-size: 10px;
      border-radius: 3px;
      opacity: 0.6;
    }
    .filter-btn:hover { opacity: 1; }
    .filter-btn.active {
      opacity: 1;
      border-color: var(--vscode-focusBorder, #007acc);
      background: var(--vscode-list-activeSelectionBackground, rgba(0,120,212,0.2));
    }

    /* ── Filtered-out nodes ──────────────────────────── */
    .node-hidden { display: none !important; }
  </style>
</head>
<body>
  <div id="search-bar"><input id="search-input" type="text" placeholder="Filter nodes…" /></div>
  <div id="root"></div>
  <div id="status-bar"></div>
  <script nonce="${nonce}">
  (function() {
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('root');

    // ── State ──────────────────────────────────────────
    let snapshot = null;     // GraphSnapshot
    let viewState = null;    // ViewStateSnapshot
    let selectedId = null;
    let filterText = '';
    let statusFilter = 'all'; // 'all' | 'errors' | 'running'

    // ── Status icon map───────────────────────────────
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
          filterText = viewState?.filterText ?? '';
          { const si = document.getElementById('search-input'); if (si) si.value = filterText; }
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
        case 'filter':
          filterText = (event.value || '');
          { const si2 = document.getElementById('search-input'); if (si2) si2.value = filterText; }
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
        updateStatusBar(0, 0, 0);
        return;
      }

      const rootChildren = snapshot.childOrder['__root__'] || [];
      if (rootChildren.length === 0) {
        root.innerHTML = '<div id="empty">No agents yet</div>';
        updateStatusBar(0, 0, 0);
        return;
      }

      // Global counts for status bar
      const allNodes = Object.values(snapshot.nodes);
      const totalCount = allNodes.length;
      const runningCount = allNodes.filter(n => n.status === 'running' || n.status === 'starting').length;
      const errorCount = allNodes.filter(n => n.status === 'error').length;

      const fragment = document.createDocumentFragment();
      const sorted = sortWithPins(rootChildren);
      for (const childId of sorted) {
        renderNode(fragment, childId, 0);
      }
      root.innerHTML = '';
      root.appendChild(fragment);
      updateStatusBar(totalCount, runningCount, errorCount);
    }

    function renderNode(container, nodeId, depth) {
      const node = snapshot.nodes[nodeId];
      if (!node) return;

      const children = snapshot.childOrder[nodeId] || [];
      const hasChildren = children.length > 0;
      const collapsed = isCollapsed(nodeId);
      const pinned = isPinned(nodeId);
      const selected = selectedId === nodeId;

      // Filter visibility
      const visible = isNodeVisible(nodeId);
      const statusVisible = isStatusVisible(nodeId);

      // Row
      const row = document.createElement('div');
      row.className = 'node-row'
        + (selected ? ' selected' : '')
        + (pinned ? ' pinned' : '')
        + (!visible || !statusVisible ? ' node-hidden' : '');
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

      // Pin indicator
      if (pinned) {
        const pinEl = document.createElement('span');
        pinEl.className = 'pin-icon';
        pinEl.textContent = '\uD83D\uDCCC'; // 📌
        row.appendChild(pinEl);
      }

      // Status icon
      const statusEl = document.createElement('span');
      statusEl.className = 'status-icon ' + (STATUS_CLASS[node.status] || '');
      statusEl.textContent = STATUS_ICON[node.status] || '?';
      row.appendChild(statusEl);

      // Label
      const label = document.createElement('span');
      label.className = 'node-label';
      label.textContent = node.label;
      row.appendChild(label);

      // Role badge
      if (node.role) {
        const badge = document.createElement('span');
        badge.className = 'role-badge';
        badge.textContent = node.role;
        row.appendChild(badge);
      }

      // Summary (hide when collapsed to make room for rollup badges)
      if (node.summary && !(hasChildren && collapsed)) {
        const summary = document.createElement('span');
        summary.className = 'node-summary';
        summary.textContent = node.summary;
        row.appendChild(summary);
      }

      // Rollup badges for collapsed groups
      if (hasChildren && collapsed) {
        const rollup = computeRollup(nodeId);
        const badges = document.createElement('span');
        badges.className = 'rollup-badges';

        if (rollup.running > 0) {
          const b = document.createElement('span');
          b.className = 'rollup-badge rb-running';
          b.textContent = rollup.running + ' running';
          badges.appendChild(b);
        }
        if (rollup.error > 0) {
          const b = document.createElement('span');
          b.className = 'rollup-badge rb-error';
          b.textContent = rollup.error + ' error';
          badges.appendChild(b);
        }
        if (rollup.blocked > 0) {
          const b = document.createElement('span');
          b.className = 'rollup-badge rb-blocked';
          b.textContent = rollup.blocked + ' blocked';
          badges.appendChild(b);
        }

        const totalBadge = document.createElement('span');
        totalBadge.className = 'rollup-badge rb-total';
        totalBadge.textContent = rollup.total + ' total';
        badges.appendChild(totalBadge);

        row.appendChild(badges);
      }

      // Action buttons (visible on hover)
      const actions = document.createElement('span');
      actions.className = 'node-actions';

      if (node.terminalId) {
        actions.appendChild(createActionBtn('\uD83D\uDC41', 'Focus terminal', () =>
          vscode.postMessage({ type: 'focus-terminal', nodeId })));
      }

      const isRunnable = node.status === 'running' || node.status === 'starting';
      const subtreeHasRunning = hasChildren && computeRollup(nodeId).running > 0;
      if (isRunnable || subtreeHasRunning) {
        actions.appendChild(createActionBtn('\u23F9', 'Stop subtree', () =>
          vscode.postMessage({ type: 'stop', nodeId })));
      }

      if (node.status === 'error' || node.status === 'stopped') {
        actions.appendChild(createActionBtn('\uD83D\uDD04', 'Retry', () =>
          vscode.postMessage({ type: 'retry', nodeId })));
      }

      row.appendChild(actions);

      // Tooltip (rich info on hover)
      const tooltip = document.createElement('div');
      tooltip.className = 'node-tooltip';
      tooltip.innerHTML = buildTooltipHtml(node, nodeId, hasChildren);
      row.appendChild(tooltip);

      // Click to select
      row.addEventListener('click', () => {
        selectedId = nodeId;
        vscode.postMessage({ type: 'select', nodeId });
        render();
      });

      container.appendChild(row);

      // Children (pinned first)
      if (hasChildren && !collapsed) {
        const sorted = sortWithPins(children);
        for (const childId of sorted) {
          renderNode(container, childId, depth + 1);
        }
      }
    }

    // ── Rollup computation ──────────────────────────
    function computeRollup(nodeId) {
      let total = 0, running = 0, error = 0, blocked = 0;
      function walk(id) {
        const n = snapshot.nodes[id];
        if (!n) return;
        total++;
        if (n.status === 'running' || n.status === 'starting') running++;
        if (n.status === 'error') error++;
        if (n.status === 'blocked') blocked++;
        const kids = snapshot.childOrder[id] || [];
        for (const kid of kids) walk(kid);
      }
      const children = snapshot.childOrder[nodeId] || [];
      for (const childId of children) walk(childId);
      return { total, running, error, blocked };
    }

    // ── Pin sorting ──────────────────────────────────
    function sortWithPins(childIds) {
      const p = [], u = [];
      for (const id of childIds) {
        if (isPinned(id)) p.push(id); else u.push(id);
      }
      return p.concat(u);
    }

    // ── Filter helpers ───────────────────────────────
    function isNodeVisible(nodeId) {
      if (!filterText) return true;
      if (nodeMatchesFilter(nodeId)) return true;
      if (hasMatchingDescendant(nodeId)) return true;
      return hasMatchingAncestor(nodeId);
    }

    function nodeMatchesFilter(nodeId) {
      const node = snapshot.nodes[nodeId];
      if (!node) return false;
      const q = filterText.toLowerCase();
      return (
        (node.label && node.label.toLowerCase().includes(q)) ||
        (node.role && node.role.toLowerCase().includes(q)) ||
        (node.summary && node.summary.toLowerCase().includes(q))
      );
    }

    function hasMatchingDescendant(nodeId) {
      const children = snapshot.childOrder[nodeId] || [];
      for (const childId of children) {
        if (nodeMatchesFilter(childId)) return true;
        if (hasMatchingDescendant(childId)) return true;
      }
      return false;
    }

    function hasMatchingAncestor(nodeId) {
      const node = snapshot.nodes[nodeId];
      if (!node || !node.parentId) return false;
      if (nodeMatchesFilter(node.parentId)) return true;
      return hasMatchingAncestor(node.parentId);
    }

    function isStatusVisible(nodeId) {
      if (statusFilter === 'all') return true;
      const node = snapshot.nodes[nodeId];
      if (!node) return false;
      // Groups visible if they have matching descendants
      const children = snapshot.childOrder[nodeId] || [];
      if (children.length > 0) {
        for (const childId of children) {
          if (isStatusVisible(childId)) return true;
        }
      }
      if (statusFilter === 'errors') return node.status === 'error';
      if (statusFilter === 'running') return node.status === 'running' || node.status === 'starting';
      return true;
    }

    // ── Tooltip builder ──────────────────────────────
    function buildTooltipHtml(node, nodeId, hasChildren) {
      let h = '<div class="tooltip-label">' + escHtml(node.label) + '</div>';
      h += '<div class="tooltip-row"><span class="tt-key">Role:</span> ' + escHtml(node.role || '\u2014') + '</div>';
      h += '<div class="tooltip-row"><span class="tt-key">Status:</span> ' + escHtml(node.status) + '</div>';
      h += '<div class="tooltip-row"><span class="tt-key">Elapsed:</span> ' + formatElapsed(node.createdAt) + '</div>';
      if (node.summary) {
        h += '<div class="tooltip-row"><span class="tt-key">Summary:</span> ' + escHtml(node.summary) + '</div>';
      }
      if (hasChildren) {
        const r = computeRollup(nodeId);
        let sub = r.total + ' nodes';
        if (r.running) sub += ', ' + r.running + ' running';
        if (r.error) sub += ', ' + r.error + ' errors';
        if (r.blocked) sub += ', ' + r.blocked + ' blocked';
        h += '<div class="tooltip-row"><span class="tt-key">Subtree:</span> ' + sub + '</div>';
      }
      if (node.terminalId) {
        h += '<div class="tooltip-row"><span class="tt-key">Terminal:</span> ' + escHtml(node.terminalId) + '</div>';
      }
      return h;
    }

    function escHtml(str) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function formatElapsed(createdAt) {
      if (!createdAt) return '\u2014';
      const ms = Date.now() - createdAt;
      if (ms < 1000) return '<1s';
      if (ms < 60000) return Math.floor(ms / 1000) + 's';
      if (ms < 3600000) return Math.floor(ms / 60000) + 'm ' + Math.floor((ms % 60000) / 1000) + 's';
      return Math.floor(ms / 3600000) + 'h ' + Math.floor((ms % 3600000) / 60000) + 'm';
    }

    // ── Status bar ───────────────────────────────────
    function updateStatusBar(total, running, errorCt) {
      const bar = document.getElementById('status-bar');
      if (!bar) return;
      bar.innerHTML =
        '<span class="status-count"><span class="dot dot-total"></span>' + total + ' nodes</span>' +
        '<span class="status-count"><span class="dot dot-running"></span>' + running + ' running</span>' +
        '<span class="status-count"><span class="dot dot-error"></span>' + errorCt + ' errors</span>' +
        '<span class="filter-buttons">' +
          '<button class="filter-btn' + (statusFilter === 'all' ? ' active' : '') + '" data-filter="all">All</button>' +
          '<button class="filter-btn' + (statusFilter === 'errors' ? ' active' : '') + '" data-filter="errors">Errors</button>' +
          '<button class="filter-btn' + (statusFilter === 'running' ? ' active' : '') + '" data-filter="running">Running</button>' +
        '</span>';
      bar.querySelectorAll('.filter-btn').forEach(function(btn) {
        btn.addEventListener('click', function() {
          statusFilter = btn.dataset.filter;
          render();
        });
      });
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

    // ── Search input handling ───────────────────────
    document.getElementById('search-input').addEventListener('input', function(e) {
      filterText = e.target.value;
      vscode.postMessage({ type: 'filter', text: filterText });
      render();
    });

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
    | 'filter'
    | 'request-sync';
  nodeId?: string;
  text?: string;
}
