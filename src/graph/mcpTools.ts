import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AgentOrchestrator } from './orchestrator.js';
import type { AgentNode, AgentStatus, RollupCounts } from './types.js';

/** All valid AgentStatus values, kept in sync with the union type. */
const AGENT_STATUSES = [
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
] as const satisfies readonly AgentStatus[];

const statusEnum = z.enum(AGENT_STATUSES);

/** Recursive tree node returned by `graph_list`. */
interface TreeNode {
  id: string;
  label: string;
  role: string;
  nodeType: string;
  status: string;
  summary: string;
  terminalId: string | null;
  rollup: RollupCounts;
  children: TreeNode[];
}

// ── Response helpers ────────────────────────────────────────────────

function jsonResult(data: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
  };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `Error: ${message}` }],
    isError: true as const,
  };
}

// ── Tree builder ────────────────────────────────────────────────────

function buildSubtree(
  orchestrator: AgentOrchestrator,
  node: AgentNode,
  depth: number,
  maxDepth: number,
): TreeNode {
  const rollup = orchestrator.getRollup(node.id);
  const children: TreeNode[] =
    depth < maxDepth
      ? orchestrator
          .getChildren(node.id)
          .map((child) => buildSubtree(orchestrator, child, depth + 1, maxDepth))
      : [];

  return {
    id: node.id,
    label: node.label,
    role: node.role,
    nodeType: node.nodeType,
    status: node.status,
    summary: node.summary,
    terminalId: node.terminalId,
    rollup,
    children,
  };
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Register MCP tools for managing the agent hierarchy graph.
 *
 * Adds 8 tools (`graph_*`) that let AI agents create, query, update,
 * and control nodes in the orchestrator's agent tree.
 */
export function registerGraphTools(
  server: McpServer,
  orchestrator: AgentOrchestrator,
): void {
  // ── graph_create_group ──────────────────────────────────────────

  server.tool(
    'graph_create_group',
    'Create an organizational group in the agent hierarchy.',
    {
      label: z.string().describe('Display name for the group'),
      parentId: z.string().optional().describe('Parent node ID (omit for root)'),
      role: z.string().optional().describe('Role tag, e.g. "M2", "team"'),
    },
    async ({ label, parentId, role }) => {
      try {
        const node = orchestrator.createAgentGroup(
          label,
          parentId ?? null,
          role,
        );
        return jsonResult(node);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── graph_create_agent ──────────────────────────────────────────

  server.tool(
    'graph_create_agent',
    'Create an agent node, optionally bound to an existing terminal.',
    {
      label: z.string().describe('Display name for the agent'),
      parentId: z.string().optional().describe('Parent node ID (omit for root)'),
      role: z.string().optional().describe('Role tag, e.g. "SDE", "intern"'),
      terminalId: z
        .string()
        .optional()
        .describe('Existing terminal ID to bind to this agent'),
    },
    async ({ label, parentId, role, terminalId }) => {
      try {
        const node = orchestrator.createAgent(
          label,
          parentId ?? null,
          role,
          terminalId ?? null,
        );
        return jsonResult(node);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── graph_remove ────────────────────────────────────────────────

  server.tool(
    'graph_remove',
    'Remove a node and all its descendants from the hierarchy.',
    {
      nodeId: z.string().describe('ID of the node to remove'),
    },
    async ({ nodeId }) => {
      try {
        const subtreeIds = orchestrator.getSubtreeIds(nodeId);
        orchestrator.removeNode(nodeId);
        return jsonResult({
          removed: nodeId,
          descendantsRemoved: subtreeIds.length,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── graph_update ────────────────────────────────────────────────

  server.tool(
    'graph_update',
    'Update properties of an existing node (label, role, status, summary, lastAction).',
    {
      nodeId: z.string().describe('ID of the node to update'),
      label: z.string().optional().describe('New display name'),
      role: z.string().optional().describe('New role tag'),
      status: statusEnum.optional().describe('New lifecycle status'),
      summary: z.string().optional().describe('One-line summary'),
      lastAction: z
        .string()
        .optional()
        .describe('Brief description of the most recent activity'),
    },
    async ({ nodeId, label, role, status, summary, lastAction }) => {
      try {
        const changes: Partial<
          Pick<AgentNode, 'label' | 'role' | 'status' | 'summary' | 'lastAction'>
        > = {};
        if (label !== undefined) changes.label = label;
        if (role !== undefined) changes.role = role;
        if (status !== undefined) changes.status = status;
        if (summary !== undefined) changes.summary = summary;
        if (lastAction !== undefined) changes.lastAction = lastAction;

        orchestrator.updateNode(nodeId, changes);

        const updated = orchestrator.getNode(nodeId);
        return jsonResult(updated);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── graph_move ──────────────────────────────────────────────────

  server.tool(
    'graph_move',
    'Move a node to a new parent (or to root if newParentId is omitted).',
    {
      nodeId: z.string().describe('ID of the node to move'),
      newParentId: z
        .string()
        .optional()
        .describe('Target parent node ID (omit to move to root)'),
      newIndex: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe('Position among siblings (0-based)'),
    },
    async ({ nodeId, newParentId, newIndex }) => {
      try {
        orchestrator.moveNode(nodeId, newParentId ?? null, newIndex);
        const moved = orchestrator.getNode(nodeId);
        return jsonResult(moved);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── graph_list ──────────────────────────────────────────────────

  server.tool(
    'graph_list',
    'List the agent hierarchy as a nested tree. Returns the full tree or a subtree.',
    {
      rootId: z
        .string()
        .optional()
        .describe('Start from this node (omit for entire tree)'),
      maxDepth: z
        .number()
        .int()
        .min(0)
        .default(3)
        .describe('Maximum depth of the tree to return'),
    },
    async ({ rootId, maxDepth }) => {
      try {
        let roots: AgentNode[];

        if (rootId !== undefined) {
          const node = orchestrator.getNode(rootId);
          if (!node) {
            return errorResult(new Error(`Node not found: ${rootId}`));
          }
          roots = [node];
        } else {
          roots = orchestrator.getRoots();
        }

        const tree: TreeNode[] = roots.map((root) =>
          buildSubtree(orchestrator, root, 0, maxDepth),
        );

        return jsonResult(tree);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── graph_stop_subtree ──────────────────────────────────────────

  server.tool(
    'graph_stop_subtree',
    'Stop all agents in a subtree by closing their terminals.',
    {
      nodeId: z.string().describe('Root of the subtree to stop'),
    },
    async ({ nodeId }) => {
      try {
        const result = await orchestrator.stopSubtree(nodeId);
        return jsonResult(result);
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  // ── graph_retry ─────────────────────────────────────────────────

  server.tool(
    'graph_retry',
    'Retry a failed or stopped agent by creating a new terminal.',
    {
      nodeId: z.string().describe('ID of the agent node to retry'),
    },
    async ({ nodeId }) => {
      try {
        const node = await orchestrator.retryNode(nodeId);
        return jsonResult(node);
      } catch (err) {
        return errorResult(err);
      }
    },
  );
}
