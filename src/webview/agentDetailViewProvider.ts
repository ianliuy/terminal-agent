/**
 * @file agentDetailViewProvider.ts
 *
 * WebviewViewProvider for the Agent Detail panel.
 *
 * Shows full information about the currently selected agent node,
 * including status, metadata, rollup stats (for groups), and action buttons.
 * Reacts to selection changes from GraphViewState and graph patches
 * from the AgentOrchestrator.
 */

import * as vscode from 'vscode';
import type { AgentOrchestrator } from '../graph/orchestrator.js';
import type { GraphViewState } from '../graph/viewState.js';
import type { GraphPatch } from '../graph/types.js';
import { logger } from '../utils/logger.js';

const log = logger.withContext('AgentDetailView');

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AgentDetailViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private currentNodeId: string | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly orchestrator: AgentOrchestrator,
    private readonly viewState: GraphViewState,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [this.extensionUri] };
    webviewView.webview.html = this.getHtml(webviewView.webview);

    const disposables: vscode.Disposable[] = [];

    // Listen for selection changes from viewState
    disposables.push(this.viewState.onChange((event) => {
      if (event.type === 'selected') {
        this.currentNodeId = event.nodeId ?? null;
        this.sendNodeData();
      }
    }));

    // Listen for graph patches (selected node might have been updated)
    disposables.push(this.orchestrator.onPatch((_patch: GraphPatch) => {
      if (this.currentNodeId) {
        this.sendNodeData();
      }
    }));

    // Handle messages from webview
    disposables.push(webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleMessage(msg);
    }));

    // Re-send data when panel becomes visible
    disposables.push(webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && this.currentNodeId) {
        this.sendNodeData();
      }
    }));

    webviewView.onDidDispose(() => {
      this.view = undefined;
      for (const d of disposables) d.dispose();
    });

    // Send initial data if something is already selected
    this.currentNodeId = this.viewState.getSelectedId();
    if (this.currentNodeId) {
      this.sendNodeData();
    }
  }

  private sendNodeData(): void {
    if (!this.view || !this.currentNodeId) {
      this.postMessage({ type: 'clear' });
      return;
    }

    const node = this.orchestrator.getNode(this.currentNodeId);
    if (!node) {
      this.postMessage({ type: 'clear' });
      return;
    }

    const rollup = this.orchestrator.getRollup(this.currentNodeId);
    const ancestors = this.getAncestorLabels(this.currentNodeId);

    this.postMessage({
      type: 'node-data',
      data: { node, rollup, breadcrumb: ancestors },
    });
  }

  private getAncestorLabels(nodeId: string): string[] {
    const labels: string[] = [];
    const syncMsg = this.orchestrator.getInitialSyncMessage();
    if (syncMsg.type !== 'snapshot') return labels;

    let current = syncMsg.data.nodes[nodeId];
    while (current?.parentId) {
      const parent = syncMsg.data.nodes[current.parentId];
      if (parent) {
        labels.unshift(parent.label);
        current = parent;
      } else {
        break;
      }
    }
    return labels;
  }

  private handleMessage(msg: { type: string; nodeId?: string }): void {
    log.debug('Received message from webview', msg.type);
    switch (msg.type) {
      case 'stop':
        if (msg.nodeId) void this.orchestrator.stopSubtree(msg.nodeId);
        break;
      case 'retry':
        if (msg.nodeId) void this.orchestrator.retryNode(msg.nodeId);
        break;
      case 'focus-terminal':
        if (msg.nodeId) {
          const node = this.orchestrator.getNode(msg.nodeId);
          if (node?.terminalId) {
            this.orchestrator.focusTerminalById(node.terminalId);
          }
        }
        break;
      case 'remove':
        if (msg.nodeId) {
          this.orchestrator.removeNode(msg.nodeId);
          this.currentNodeId = null;
          this.postMessage({ type: 'clear' });
        }
        break;
    }
  }

  private postMessage(msg: unknown): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  private getHtml(_webview: vscode.Webview): string {
    const nonce = getNonce();
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Agent Detail</title>
  <style nonce="${nonce}">
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--vscode-font-family, system-ui);
      font-size: var(--vscode-font-size, 13px);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background, transparent);
      padding: 12px;
      overflow-y: auto;
    }
    #empty {
      display: flex; align-items: center; justify-content: center;
      height: 100%; opacity: 0.5; font-style: italic;
    }
    #detail { display: none; }
    .breadcrumb { font-size: 11px; opacity: 0.6; margin-bottom: 8px; }
    .header { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
    .header-label { font-size: 16px; font-weight: 600; }
    .header-badge {
      font-size: 10px; padding: 2px 6px; border-radius: 3px;
      background: var(--vscode-badge-background, #4d4d4d);
      color: var(--vscode-badge-foreground, #fff);
      text-transform: uppercase;
    }
    .status-line { display: flex; align-items: center; gap: 6px; margin-bottom: 12px; }
    .status-dot { width: 10px; height: 10px; border-radius: 50%; }
    .status-dot.running { background: var(--vscode-charts-green, #89d185); }
    .status-dot.error { background: var(--vscode-charts-red, #f14c4c); }
    .status-dot.blocked { background: var(--vscode-charts-orange, #cca700); }
    .status-dot.idle { background: #888; }
    .status-dot.done { background: var(--vscode-charts-green, #89d185); opacity: 0.5; }
    .status-dot.stopped { background: #666; }
    .status-dot.disconnected { background: #666; border: 1px dashed #aaa; }
    .section { margin-bottom: 14px; }
    .section-title { font-size: 11px; font-weight: 600; text-transform: uppercase; opacity: 0.5; margin-bottom: 4px; letter-spacing: 0.5px; }
    .field { display: flex; margin-bottom: 3px; }
    .field-key { min-width: 90px; opacity: 0.6; font-size: 12px; }
    .field-val { font-size: 12px; word-break: break-word; }
    .summary-text { font-size: 12px; line-height: 1.5; padding: 6px 8px; background: var(--vscode-textBlockQuote-background, rgba(255,255,255,0.05)); border-radius: 4px; }
    .rollup-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
    .rollup-card { padding: 6px 8px; border-radius: 4px; background: rgba(255,255,255,0.04); text-align: center; }
    .rollup-num { font-size: 18px; font-weight: 600; }
    .rollup-label { font-size: 10px; opacity: 0.6; text-transform: uppercase; }
    .rollup-num.running { color: var(--vscode-charts-green, #89d185); }
    .rollup-num.error { color: var(--vscode-charts-red, #f14c4c); }
    .rollup-num.blocked { color: var(--vscode-charts-orange, #cca700); }
    .actions { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
    .action-btn {
      padding: 4px 10px; border: 1px solid var(--vscode-button-border, #555);
      background: var(--vscode-button-secondaryBackground, #3a3d41);
      color: var(--vscode-button-secondaryForeground, #ccc);
      border-radius: 4px; cursor: pointer; font-size: 12px;
    }
    .action-btn:hover { background: var(--vscode-button-secondaryHoverBackground, #45494e); }
    .action-btn.danger { color: var(--vscode-charts-red, #f14c4c); }
  </style>
</head>
<body>
  <div id="empty">Select an agent to view details</div>
  <div id="detail"></div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'clear') { showEmpty(); }
      else if (msg.type === 'node-data') { showDetail(msg.data); }
    });

    function showEmpty() {
      document.getElementById('empty').style.display = 'flex';
      document.getElementById('detail').style.display = 'none';
    }

    function showDetail(data) {
      const { node, rollup, breadcrumb } = data;
      document.getElementById('empty').style.display = 'none';
      const el = document.getElementById('detail');
      el.style.display = 'block';

      const statusClass = ['running','starting'].includes(node.status) ? 'running'
        : node.status === 'error' ? 'error'
        : node.status === 'blocked' ? 'blocked'
        : node.status === 'done' ? 'done'
        : ['stopped','stopping'].includes(node.status) ? 'stopped'
        : node.status === 'disconnected' ? 'disconnected'
        : 'idle';

      const elapsed = formatElapsed(node.createdAt);
      const updated = formatElapsed(node.updatedAt);

      let html = '';

      if (breadcrumb.length > 0) {
        html += '<div class="breadcrumb">' + breadcrumb.map(esc).join(' \\u203A ') + '</div>';
      }

      html += '<div class="header">';
      html += '<span class="header-label">' + esc(node.label) + '</span>';
      if (node.role) html += '<span class="header-badge">' + esc(node.role) + '</span>';
      html += '<span class="header-badge">' + esc(node.nodeType) + '</span>';
      html += '</div>';

      html += '<div class="status-line">';
      html += '<span class="status-dot ' + statusClass + '"></span>';
      html += '<span>' + esc(node.status) + '</span>';
      html += '</div>';

      html += '<div class="section">';
      html += '<div class="section-title">Info</div>';
      html += field('ID', node.id);
      html += field('Created', elapsed + ' ago');
      html += field('Updated', updated + ' ago');
      if (node.terminalId) html += field('Terminal', node.terminalId);
      html += '</div>';

      if (node.summary || node.lastAction) {
        html += '<div class="section">';
        html += '<div class="section-title">Summary</div>';
        if (node.summary) html += '<div class="summary-text">' + esc(node.summary) + '</div>';
        if (node.lastAction) html += '<div style="margin-top:4px">' + field('Last Action', node.lastAction) + '</div>';
        html += '</div>';
      }

      if (node.nodeType === 'group' && rollup) {
        html += '<div class="section">';
        html += '<div class="section-title">Subtree</div>';
        html += '<div class="rollup-grid">';
        html += rollupCard(rollup.subtreeNodeCount, 'Total', '');
        html += rollupCard(rollup.subtreeRunningCount, 'Running', 'running');
        html += rollupCard(rollup.subtreeErrorCount, 'Errors', 'error');
        html += rollupCard(rollup.subtreeBlockedCount, 'Blocked', 'blocked');
        html += '</div></div>';
      }

      html += '<div class="actions">';
      if (node.terminalId) {
        html += '<button class="action-btn" onclick="send(\\'focus-terminal\\',\\'' + node.id + '\\')">\\uD83D\\uDC41 Focus Terminal</button>';
      }
      if (['running','starting','blocked','waiting-input'].includes(node.status)) {
        html += '<button class="action-btn" onclick="send(\\'stop\\',\\'' + node.id + '\\')">\\u23F9 Stop</button>';
      }
      if (['error','stopped','disconnected'].includes(node.status)) {
        html += '<button class="action-btn" onclick="send(\\'retry\\',\\'' + node.id + '\\')">\\uD83D\\uDD04 Retry</button>';
      }
      html += '<button class="action-btn danger" onclick="if(confirm(\\'Remove this node and all children?\\')) send(\\'remove\\',\\'' + node.id + '\\')">\\uD83D\\uDDD1 Remove</button>';
      html += '</div>';

      el.innerHTML = html;
    }

    function send(type, nodeId) {
      vscode.postMessage({ type, nodeId });
    }

    function field(key, val) {
      return '<div class="field"><span class="field-key">' + esc(key) + '</span><span class="field-val">' + esc(String(val)) + '</span></div>';
    }

    function rollupCard(num, label, cls) {
      return '<div class="rollup-card"><div class="rollup-num ' + cls + '">' + num + '</div><div class="rollup-label">' + label + '</div></div>';
    }

    function esc(s) {
      const d = document.createElement('div');
      d.textContent = s || '';
      return d.innerHTML;
    }

    function formatElapsed(ms) {
      const diff = Date.now() - ms;
      if (diff < 60000) return Math.floor(diff / 1000) + 's';
      if (diff < 3600000) return Math.floor(diff / 60000) + 'm';
      if (diff < 86400000) return Math.floor(diff / 3600000) + 'h';
      return Math.floor(diff / 86400000) + 'd';
    }
  </script>
</body>
</html>`;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i++) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}
