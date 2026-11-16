// The MCP endpoint (/mcp): JSON-RPC 2.0 over Streamable HTTP. Stateless —
// no session header is issued, which the client fully supports. Speaks the
// modern server/discover handshake (2026-07-28) and the legacy initialize
// handshake, and exposes the six canonical GitHub tools backed by the same
// store as REST and GraphQL.

import { gid, type RepoRec, type Store } from './store.ts';

export interface McpResult {
  status: number;
  body?: unknown;
}

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body text of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        body: { type: 'string', description: 'The body text of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner login of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function repoObject(store: Store, repo: RepoRec): Record<string, unknown> {
  const login = store.viewerLogin ?? 'user';
  return {
    id: repo.dbId,
    node_id: gid('Repository', repo.dbId),
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login },
  };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function handleMcp(store: Store, method: string, rawBody: Buffer, authed: boolean): McpResult {
  if (method === 'DELETE') return { status: 200, body: {} };
  if (method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  const request = (parsed ?? {}) as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const isNotification = request.id === undefined;
  if (isNotification) return { status: 202 };
  if (!authed) return { status: 401, body: { message: 'Unauthorized' } };

  const id = request.id ?? null;
  const rpcError = (code: number, message: string): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });
  const rpcResult = (result: unknown): McpResult => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result },
  });
  const params = request.params ?? {};

  switch (request.method) {
    case 'server/discover':
      return rpcResult({
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion)
        ? params.protocolVersion
        : '2025-11-25';
      return rpcResult({ protocolVersion: requested, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult({});
    case 'tools/list':
      return rpcResult({ tools: TOOLS });
    case 'tools/call': {
      const name = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return rpcError(-32601, `Tool not found: ${name}`);
      const args = (params.arguments && typeof params.arguments === 'object' ? params.arguments : {}) as Record<string, unknown>;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null || args[required] === '') {
          return rpcError(-32602, `Missing required argument: ${required}`);
        }
      }
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const repoName = typeof args.repo === 'string' ? args.repo : (typeof args.name === 'string' && name !== 'create_repo' ? args.name : '');
      const findRepo = (): RepoRec | undefined => {
        const repo = repoName ? store.repos.get(repoName) : undefined;
        if (repo && owner) {
          if (!store.ownerMatches(owner)) return undefined;
          store.adoptLogin(owner);
        }
        return repo;
      };
      try {
        switch (name) {
          case 'create_repo': {
            const repoNameToCreate = String(args.name ?? '');
            const existing = store.repos.get(repoNameToCreate);
            if (existing) return rpcResult(toolSuccess(repoObject(store, existing)));
            const repo = store.createRepo(
              repoNameToCreate,
              typeof args.description === 'string' ? args.description : '',
              args.private !== false,
            );
            return rpcResult(toolSuccess(repoObject(store, repo)));
          }
          case 'get_repo': {
            const repo = findRepo();
            if (!repo) return rpcResult(toolFailure(`repository not found: ${owner}/${repoName}`));
            return rpcResult(toolSuccess(repoObject(store, repo)));
          }
          case 'create_issue': {
            const repo = findRepo();
            if (!repo) return rpcResult(toolFailure(`repository not found: ${owner}/${repoName}`));
            const issue = store.createIssue(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', []);
            return rpcResult(toolSuccess({
              id: issue.dbId, number: issue.number, title: issue.title, body: issue.body, state: issue.state, labels: [],
            }));
          }
          case 'list_issues': {
            const repo = findRepo();
            if (!repo) return rpcResult(toolFailure(`repository not found: ${owner}/${repoName}`));
            const state = typeof args.state === 'string' ? args.state : 'open';
            const issues = [...repo.issues.values()]
              .filter((issue) => state === 'all' || issue.state === state)
              .map((issue) => ({ id: issue.dbId, number: issue.number, title: issue.title, body: issue.body, state: issue.state }));
            return rpcResult(toolSuccess({ issues }));
          }
          case 'create_pull_request': {
            const repo = findRepo();
            if (!repo) return rpcResult(toolFailure(`repository not found: ${owner}/${repoName}`));
            const head = String(args.head ?? '');
            const base = String(args.base ?? '');
            if (!store.branchTip(repo, head) || !store.branchTip(repo, base)) {
              return rpcResult(toolFailure('head or base branch does not exist'));
            }
            const pull = store.createPull(repo, String(args.title ?? ''), typeof args.body === 'string' ? args.body : '', head, base);
            return rpcResult(toolSuccess({
              id: pull.dbId, number: pull.number, title: pull.title, body: pull.body, state: pull.state,
              head: { ref: head, sha: store.branchTip(repo, head) }, base: { ref: base, sha: store.branchTip(repo, base) },
            }));
          }
          case 'merge_pull_request': {
            const repo = findRepo();
            if (!repo) return rpcResult(toolFailure(`repository not found: ${owner}/${repoName}`));
            const pull = repo.pulls.get(Number(args.pull_number));
            if (!pull) return rpcResult(toolFailure(`pull request not found: ${String(args.pull_number)}`));
            if (pull.state === 'open') {
              const sha = store.mergePull(repo, pull);
              if (!sha) return rpcResult(toolFailure('pull request is not mergeable'));
            }
            return rpcResult(toolSuccess({
              id: pull.dbId, number: pull.number, title: pull.title, state: pull.state,
              merged: pull.merged, merge_commit_sha: pull.mergeCommitSha,
            }));
          }
        }
      } catch (err) {
        return rpcResult(toolFailure(err instanceof Error ? err.message : 'tool error'));
      }
      return rpcError(-32601, `Tool not found: ${name}`);
    }
    default:
      return rpcError(-32601, `Method not found: ${String(request.method)}`);
  }
}
