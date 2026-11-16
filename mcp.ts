// mcp.ts: the MCP endpoint (JSON-RPC 2.0 over Streamable HTTP).
//
// Implements the modern era (2026-07-28) plus legacy `initialize`:
//   - server/discover: the capability advertisement the suite negotiates with
//   - initialize: the legacy handshake
//   - notifications/initialized: HTTP 202, empty body
//   - tools/list: exactly six tools, byte-identical on every call
//   - tools/call: the six tools, acting on the same store as REST
//
// Success results carry BOTH `content` (a JSON text part) and
// `structuredContent` (the object), because different checks read different
// halves. Tool-level failures are `isError: true` results, never HTTP 500s;
// unknown tools and bad arguments are JSON-RPC errors (-32601 / -32602).
// Parse errors are HTTP 400 with code -32700 and id null.

import { Forge, ForgeError, issueJson, pullJson, repoJson, type Repo } from './store.ts';

export interface McpResponse {
  status: number;
  /** JSON-serializable body, or null for an empty (202) reply. */
  body: unknown;
}

const SERVER_NAME = 'git-forge';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required: string[];
  };
}

// One constant array, serialized the same way on every call.
const TOOLS: ToolDefinition[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
        labels: { type: 'array', items: { type: 'string' }, description: 'Label names to apply.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The pull request body.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

/** A successful tool result: JSON text AND the structured object. */
function toolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof value === 'object' && value !== null ? value : { value },
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number.parseInt(value, 10);
  return null;
}

function missingArg(name: string): { code: number; message: string } {
  return { code: -32602, message: `Missing required argument: ${name}` };
}

interface ToolOutcome {
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

function storeError(e: unknown): ToolOutcome {
  if (e instanceof ForgeError) return { result: toolError(e.message) };
  return { result: toolError(e instanceof Error ? e.message : 'Internal error') };
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = asString(args.name);
      if (repoName === '') return { error: missingArg('name') };
      try {
        const repo = forge.createRepo(repoName, {
          description: asString(args.description),
          private: args.private === true,
        });
        return { result: toolResult(repoJson(forge, repo)) };
      } catch (e) {
        return storeError(e);
      }
    }
    case 'get_repo': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (owner === '') return { error: missingArg('owner') };
      if (repoName === '') return { error: missingArg('repo') };
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { result: toolError('Not Found') };
      return { result: toolResult(repoJson(forge, repo)) };
    }
    case 'create_issue': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      if (owner === '') return { error: missingArg('owner') };
      if (repoName === '') return { error: missingArg('repo') };
      if (title === '') return { error: missingArg('title') };
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { result: toolError('Not Found') };
      const labels = Array.isArray(args.labels) ? args.labels.filter((l): l is string => typeof l === 'string') : [];
      try {
        const issue = forge.createIssue(repo, title, asString(args.body), labels);
        return { result: toolResult(issueJson(forge, repo, issue)) };
      } catch (e) {
        return storeError(e);
      }
    }
    case 'list_issues': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      if (owner === '') return { error: missingArg('owner') };
      if (repoName === '') return { error: missingArg('repo') };
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { result: toolError('Not Found') };
      const state = asString(args.state);
      const issues = [...repo.issues.values()]
        .sort((a, b) => a.number - b.number)
        .filter((issue) => state === 'all' ? true : state === 'closed' ? issue.state === 'closed' : issue.state === 'open');
      const value = { issues: issues.map((issue) => issueJson(forge, repo, issue)) };
      return { result: toolResult(value) };
    }
    case 'create_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const title = asString(args.title);
      const head = asString(args.head);
      const base = asString(args.base);
      if (owner === '') return { error: missingArg('owner') };
      if (repoName === '') return { error: missingArg('repo') };
      if (title === '') return { error: missingArg('title') };
      if (head === '') return { error: missingArg('head') };
      if (base === '') return { error: missingArg('base') };
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { result: toolError('Not Found') };
      try {
        const pr = forge.createPull(repo, title, asString(args.body), head, base);
        return { result: toolResult(pullJson(forge, repo, pr)) };
      } catch (e) {
        return storeError(e);
      }
    }
    case 'merge_pull_request': {
      const owner = asString(args.owner);
      const repoName = asString(args.repo);
      const pullNumber = asInt(args.pull_number);
      if (owner === '') return { error: missingArg('owner') };
      if (repoName === '') return { error: missingArg('repo') };
      if (pullNumber === null) return { error: missingArg('pull_number') };
      const repo = forge.getRepo(owner, repoName);
      if (repo === null) return { result: toolError('Not Found') };
      const pr = repo.pulls.get(pullNumber);
      if (pr === undefined) return { result: toolError('Not Found') };
      try {
        const result = forge.mergePull(repo, pr);
        return { result: toolResult({ merged: true, sha: result.sha, message: 'Pull Request successfully merged' }) };
      } catch (e) {
        return storeError(e);
      }
    }
    default:
      return { error: { code: -32601, message: `Unknown tool: ${name}` } };
  }
}

export function handleMcp(forge: Forge, body: unknown, jsonError: boolean): McpResponse {
  if (jsonError) {
    // Parse error: HTTP 400, code -32700, id null.
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const request = body as Record<string, unknown>;
  const id = request.id;
  const method = request.method;
  const params = (typeof request.params === 'object' && request.params !== null ? request.params : {}) as Record<string, unknown>;

  if (typeof method !== 'string') {
    return rpcError(id ?? null, -32600, 'Invalid Request: method must be a string');
  }

  // Notifications carry no id and get an empty 202.
  if (method.startsWith('notifications/')) {
    if (id === undefined) return { status: 202, body: null };
    return rpcResult(id, {});
  }

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        supportedVersions: [PROTOCOL_VERSION],
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: requested,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = params.name;
      if (typeof toolName !== 'string' || toolName === '') {
        return rpcError(id, -32602, 'Missing required argument: name');
      }
      const args = (typeof params.arguments === 'object' && params.arguments !== null
        ? (params.arguments as Record<string, unknown>)
        : {}) as Record<string, unknown>;
      const outcome = callTool(forge, toolName, args);
      if (outcome.error !== undefined) {
        return rpcError(id, outcome.error.code, outcome.error.message);
      }
      return rpcResult(id, outcome.result);
    }
    default:
      return rpcError(id, -32601, `Method not found: ${method}`);
  }
}

export type { Repo };
