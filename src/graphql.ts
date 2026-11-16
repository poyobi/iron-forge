// A compact GraphQL implementation covering exactly the v4 surface the
// forge exposes: queries, mutations, variables, aliases, inline fragments,
// batched operations, cursor connections, global ids, and the slice of
// introspection the clients read (__type fields / enumValues).

import { gid, parseGid, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';

// ---------------------------------------------------------------------------
// lexer / parser
// ---------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Map<string, ValueNode> };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: Map<string, ValueNode>;
  selectionSet?: SelectionNode[];
}
type SelectionNode =
  | FieldNode
  | { kind: 'inline'; typeCondition: string; selectionSet: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  selectionSet: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, SelectionNode[]>;
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (/\s|,/.test(ch)) { i += 1; continue; }
    if (source.startsWith('...', i)) { tokens.push('...'); i += 3; continue; }
    if ('!$():=@[]{}|'.includes(ch)) { tokens.push(ch); i += 1; continue; }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push(`"${source.slice(i + 3, end < 0 ? source.length : end)}"`);
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) { value += source[j + 1]; j += 2; }
        else { value += source[j]; j += 1; }
      }
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    const rest = source.slice(i);
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest);
    if (name) { tokens.push(name[0]); i += name[0].length; continue; }
    const number = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(rest);
    if (number) { tokens.push(number[0]); i += number[0].length; continue; }
    throw new Error(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private readonly tokens: string[];
  constructor(tokens: string[]) { this.tokens = tokens; }
  peek(): string | undefined { return this.tokens[this.pos]; }
  next(): string { const token = this.tokens[this.pos]; this.pos += 1; return token ?? ''; }
  expect(token: string): void { const got = this.next(); if (got !== token) throw new Error(`expected ${token}, got ${got}`); }
  skip(token: string): boolean { if (this.peek() === token) { this.pos += 1; return true; } return false; }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const head = this.peek()!;
      if (head === '{') {
        operations.push({ operation: 'query', selectionSet: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const operation = this.next() as 'query' | 'mutation';
        let name: string | undefined;
        if (this.peek() && /^[A-Za-z_]/.test(this.peek()!)) name = this.next();
        if (this.peek() === '(') this.parseVariableDefinitions();
        operations.push({ operation, name, selectionSet: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const fragmentName = this.next();
        this.expect('on');
        this.next(); // type condition
        fragments.set(fragmentName, this.parseSelectionSet());
      } else {
        throw new Error(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      this.next(); // variable name
      this.expect(':');
      this.parseType();
      if (this.skip('=')) this.parseValue();
    }
    this.expect(')');
  }

  private parseType(): void {
    if (this.skip('[')) { this.parseType(); this.expect(']'); }
    else this.next();
    this.skip('!');
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: this.next() });
        }
        continue;
      }
      let name = this.next();
      let alias: string | undefined;
      if (this.skip(':')) { alias = name; name = this.next(); }
      const args = new Map<string, ValueNode>();
      if (this.peek() === '(') {
        this.next();
        while (this.peek() !== ')') {
          const argName = this.next();
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.expect(')');
      }
      let selectionSet: SelectionNode[] | undefined;
      if (this.peek() === '{') selectionSet = this.parseSelectionSet();
      selections.push({ kind: 'field', alias, name, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }

  parseValue(): ValueNode {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const items: ValueNode[] = [];
      while (this.peek() !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token === '{') {
      const fields = new Map<string, ValueNode>();
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*\.\d/.test(token) || /^-?\d+(\.\d+)?[eE]/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'string': case 'enum': return node.value;
    case 'int': case 'float': case 'boolean': return node.value;
    case 'null': return null;
    case 'list': return node.items.map((item) => resolveValue(item, variables));
    case 'object': {
      const object: Record<string, unknown> = {};
      for (const [key, value] of node.fields) object[key] = resolveValue(value, variables);
      return object;
    }
  }
}

// ---------------------------------------------------------------------------
// schema / execution
// ---------------------------------------------------------------------------

type Obj = { __type: string; [key: string]: unknown };

const TYPE_FIELDS: Readonly<Record<string, string[]>> = {
  Query: ['viewer', 'repository', 'node', 'search', 'user', 'organization', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'reopenIssue'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'description', 'isPrivate', 'isArchived', 'createdAt', 'updatedAt', 'url', 'labels', 'stargazerCount', 'forkCount'],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'closed', 'createdAt', 'updatedAt', 'url', 'repository', 'author', 'labels', 'comments', 'assignees', 'milestone'],
  PullRequest: ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'mergeCommit', 'files', 'createdAt', 'updatedAt', 'url', 'repository', 'author', 'commits', 'additions', 'deletions', 'changedFiles'],
  User: ['id', 'login', 'name', 'email', 'url', 'avatarUrl', 'createdAt', 'repositories', 'issues', 'pullRequests'],
  Ref: ['id', 'name', 'prefix', 'target', 'repository'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueComment: ['id', 'databaseId', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'issue'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'possibleTypes', 'interfaces', 'inputFields', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const ENUM_VALUES: Readonly<Record<string, string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
  FileStatus: ['ADDED', 'DELETED', 'MODIFIED', 'RENAMED', 'COPIED', 'CHANGED', 'UNCHANGED'],
};

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

const cursorOf = (number: number): string => Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function repoObj(repo: RepoRec): Obj { return { __type: 'Repository', repo }; }
function issueObj(repo: RepoRec, issue: IssueRec): Obj { return { __type: 'Issue', repo, issue }; }
function pullObj(repo: RepoRec, pull: PullRec): Obj { return { __type: 'PullRequest', repo, pull }; }

function issueConnection(ctx: Ctx, repo: RepoRec, args: Map<string, ValueNode>): Obj {
  let issues = [...repo.issues.values()];
  const states = args.has('states') ? resolveValue(args.get('states')!, ctx.variables) : undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  let direction = 'ASC';
  if (args.has('orderBy')) {
    const orderBy = resolveValue(args.get('orderBy')!, ctx.variables) as { direction?: string } | null;
    if (orderBy && typeof orderBy.direction === 'string') direction = orderBy.direction;
  }
  issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
  const first = args.has('first') ? Number(resolveValue(args.get('first')!, ctx.variables)) : issues.length;
  const after = args.has('after') ? decodeCursor(resolveValue(args.get('after')!, ctx.variables)) : null;
  let start = 0;
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    if (index >= 0) start = index + 1;
  }
  const page = issues.slice(start, start + Math.max(0, first));
  return {
    __type: 'IssueConnection',
    nodes: page.map((issue) => issueObj(repo, issue)),
    pageInfo: {
      __type: 'PageInfo',
      hasNextPage: start + page.length < issues.length,
      hasPreviousPage: start > 0,
      startCursor: page.length ? cursorOf(page[0]!.number) : null,
      endCursor: page.length ? cursorOf(page[page.length - 1]!.number) : null,
    },
    totalCount: issues.length,
  };
}

function pullConnection(ctx: Ctx, repo: RepoRec, args: Map<string, ValueNode>): Obj {
  let pulls = [...repo.pulls.values()];
  const states = args.has('states') ? resolveValue(args.get('states')!, ctx.variables) : undefined;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((state) => String(state)));
    pulls = pulls.filter((pull) => wanted.has(pull.merged ? 'MERGED' : pull.state.toUpperCase()));
  }
  pulls.sort((a, b) => a.number - b.number);
  const first = args.has('first') ? Number(resolveValue(args.get('first')!, ctx.variables)) : pulls.length;
  return {
    __type: 'PullRequestConnection',
    nodes: pulls.slice(0, Math.max(0, first)).map((pull) => pullObj(repo, pull)),
    pageInfo: { __type: 'PageInfo', hasNextPage: pulls.length > first, hasPreviousPage: false, startCursor: null, endCursor: null },
    totalCount: pulls.length,
  };
}

function resolveField(ctx: Ctx, source: Obj, field: string, args: Map<string, ValueNode>): unknown {
  const store = ctx.store;
  const arg = (name: string): unknown => (args.has(name) ? resolveValue(args.get(name)!, ctx.variables) : undefined);
  switch (source.__type) {
    case 'Query': {
      if (field === 'viewer') return { __type: 'User' };
      if (field === 'repository') {
        const owner = String(arg('owner') ?? '');
        const name = String(arg('name') ?? '');
        const repo = store.repos.get(name);
        if (!repo || !store.ownerMatches(owner)) return null;
        store.adoptLogin(owner);
        return repoObj(repo);
      }
      if (field === 'node') {
        const parsed = parseGid(String(arg('id') ?? ''));
        if (!parsed) return null;
        if (parsed.type === 'Repository') {
          const repo = store.repoByDbId(parsed.dbId);
          return repo ? repoObj(repo) : null;
        }
        if (parsed.type === 'Issue') {
          const found = store.issueByDbId(parsed.dbId);
          return found ? issueObj(found.repo, found.issue) : null;
        }
        if (parsed.type === 'PullRequest') {
          const found = store.pullByDbId(parsed.dbId);
          return found ? pullObj(found.repo, found.pull) : null;
        }
        return null;
      }
      if (field === '__type') {
        const name = String(arg('name') ?? '');
        if (TYPE_FIELDS[name] || ENUM_VALUES[name]) return { __type: '__Type', name };
        return null;
      }
      if (field === '__schema') return { __type: '__Schema' };
      break;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = (arg('input') ?? {}) as { repositoryId?: string; title?: string; body?: string };
        const parsed = parseGid(String(input.repositoryId ?? ''));
        const repo = parsed && parsed.type === 'Repository' ? store.repoByDbId(parsed.dbId) : undefined;
        if (!repo) throw new Error('repository not found for createIssue');
        const issue = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { __type: 'CreateIssuePayload', issue: issueObj(repo, issue), clientMutationId: null };
      }
      if (field === 'closeIssue') {
        const input = (arg('input') ?? {}) as { issueId?: string };
        const parsed = parseGid(String(input.issueId ?? ''));
        const found = parsed && parsed.type === 'Issue' ? store.issueByDbId(parsed.dbId) : null;
        if (!found) throw new Error('issue not found for closeIssue');
        found.issue.state = 'closed';
        return { __type: 'CloseIssuePayload', issue: issueObj(found.repo, found.issue), clientMutationId: null };
      }
      if (field === 'createPullRequest') {
        const input = (arg('input') ?? {}) as { repositoryId?: string; baseRefName?: string; headRefName?: string; title?: string; body?: string };
        const parsed = parseGid(String(input.repositoryId ?? ''));
        const repo = parsed && parsed.type === 'Repository' ? store.repoByDbId(parsed.dbId) : undefined;
        if (!repo) throw new Error('repository not found for createPullRequest');
        const pull = store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), String(input.headRefName ?? ''), String(input.baseRefName ?? ''));
        return { __type: 'CreatePullRequestPayload', pullRequest: pullObj(repo, pull), clientMutationId: null };
      }
      if (field === 'mergePullRequest') {
        const input = (arg('input') ?? {}) as { pullRequestId?: string };
        const parsed = parseGid(String(input.pullRequestId ?? ''));
        const found = parsed && parsed.type === 'PullRequest' ? store.pullByDbId(parsed.dbId) : null;
        if (!found) throw new Error('pull request not found for mergePullRequest');
        if (found.pull.state === 'open') {
          const sha = store.mergePull(found.repo, found.pull);
          if (!sha) throw new Error('pull request is not mergeable');
        }
        return { __type: 'MergePullRequestPayload', pullRequest: pullObj(found.repo, found.pull), clientMutationId: null };
      }
      if (field === 'addComment') {
        const input = (arg('input') ?? {}) as { subjectId?: string; body?: string };
        const parsed = parseGid(String(input.subjectId ?? ''));
        const found = parsed && parsed.type === 'Issue' ? store.issueByDbId(parsed.dbId) : null;
        if (!found) throw new Error('subject not found for addComment');
        const comment = store.addComment(found.issue, String(input.body ?? ''));
        const node: Obj = { __type: 'IssueComment', id: gid('IssueComment', comment.id), body: comment.body };
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node, cursor: '' }, clientMutationId: null };
      }
      break;
    }
    case 'User': {
      if (field === 'login') return store.viewerLogin ?? 'user';
      if (field === 'id') return gid('User', 1);
      if (field === 'name') return store.viewerLogin ?? 'user';
      break;
    }
    case 'Repository': {
      const repo = source.repo as RepoRec;
      switch (field) {
        case 'id': return gid('Repository', repo.dbId);
        case 'databaseId': return repo.dbId;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${store.viewerLogin ?? 'user'}/${repo.name}`;
        case 'owner': return { __type: 'User' };
        case 'defaultBranchRef': return { __type: 'Ref', name: repo.defaultBranch };
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'issue': {
          const number = Number(arg('number'));
          const issue = repo.issues.get(number);
          return issue ? issueObj(repo, issue) : null;
        }
        case 'issues': return issueConnection(ctx, repo, args);
        case 'pullRequest': {
          const number = Number(arg('number'));
          const pull = repo.pulls.get(number);
          return pull ? pullObj(repo, pull) : null;
        }
        case 'pullRequests': return pullConnection(ctx, repo, args);
      }
      break;
    }
    case 'Issue': {
      const issue = source.issue as IssueRec;
      const repo = source.repo as RepoRec;
      switch (field) {
        case 'id': return gid('Issue', issue.dbId);
        case 'databaseId': return issue.dbId;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'closed': return issue.state === 'closed';
        case 'repository': return repoObj(repo);
      }
      break;
    }
    case 'PullRequest': {
      const pull = source.pull as PullRec;
      const repo = source.repo as RepoRec;
      switch (field) {
        case 'id': return gid('PullRequest', pull.dbId);
        case 'databaseId': return pull.dbId;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedAt;
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'mergeable': return store.pullMergeable(repo, pull) ? 'MERGEABLE' : (pull.state === 'open' ? 'CONFLICTING' : 'UNKNOWN');
        case 'mergeCommit': return pull.mergeCommitSha ? { __type: 'Commit', oid: pull.mergeCommitSha } : null;
        case 'files': {
          const headTip = store.branchTip(repo, pull.headRef);
          const baseTip = store.branchTip(repo, pull.baseRef);
          const { mergeBase } = { mergeBase: baseTip && headTip ? computeMergeBase(store, repo, baseTip, headTip) : null };
          const files = store.diffFiles(repo, mergeBase, headTip);
          const first = args.has('first') ? Number(resolveValue(args.get('first')!, ctx.variables)) : files.length;
          return {
            __type: 'PullRequestChangedFileConnection',
            nodes: files.slice(0, Math.max(0, first)).map((file) => ({
              __type: 'PullRequestChangedFile', path: file.filename, additions: file.additions, deletions: file.deletions,
            })),
            pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
            totalCount: files.length,
          };
        }
        case 'repository': return repoObj(repo);
      }
      break;
    }
    case 'Ref': {
      if (field === 'name') return source.name;
      if (field === 'prefix') return 'refs/heads/';
      break;
    }
    case 'PageInfo': {
      if (field in source) return source[field];
      break;
    }
    case 'IssueConnection': case 'PullRequestConnection': case 'PullRequestChangedFileConnection': {
      if (field === 'nodes' || field === 'pageInfo' || field === 'totalCount') return source[field];
      if (field === 'edges') {
        const nodes = (source.nodes as Obj[]) ?? [];
        return nodes.map((node) => ({ __type: source.__type === 'IssueConnection' ? 'IssueEdge' : 'PullRequestEdge', node, cursor: '' }));
      }
      break;
    }
    case 'PullRequestChangedFile': {
      if (field === 'path' || field === 'additions' || field === 'deletions') return source[field];
      if (field === 'changeType') return 'ADDED';
      break;
    }
    case 'IssueComment': {
      if (field === 'id' || field === 'body') return source[field];
      break;
    }
    case 'CreateIssuePayload': case 'CloseIssuePayload': {
      if (field === 'issue') return source.issue;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'CreatePullRequestPayload': case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return source.pullRequest;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return source.commentEdge;
      if (field === 'clientMutationId') return null;
      break;
    }
    case 'IssueCommentEdge': case 'IssueEdge': case 'PullRequestEdge': {
      if (field === 'node') return source.node;
      if (field === 'cursor') return source.cursor ?? '';
      break;
    }
    case 'Commit': {
      if (field === 'oid' || field === 'id') return source.oid;
      break;
    }
    case '__Type': {
      const name = source.name as string;
      if (field === 'name') return name;
      if (field === 'kind') return ENUM_VALUES[name] ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        return (TYPE_FIELDS[name] ?? []).map((fieldName) => ({ __type: '__Field', name: fieldName }));
      }
      if (field === 'enumValues') {
        return (ENUM_VALUES[name] ?? []).map((value) => ({ __type: '__EnumValue', name: value }));
      }
      if (field === 'possibleTypes') return [];
      if (field === 'interfaces') return [];
      if (field === 'inputFields') return [];
      if (field === 'description') return null;
      if (field === 'ofType') return null;
      break;
    }
    case '__Field': {
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      break;
    }
    case '__EnumValue': {
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      break;
    }
  }
  if (field === '__typename') return source.__type;
  throw new Error(`Field '${field}' doesn't exist on type '${source.__type}'`);
}

import { mergeBase as mergeBaseImpl } from './git.ts';
function computeMergeBase(store: Store, repo: RepoRec, baseTip: string, headTip: string): string | null {
  return mergeBaseImpl(baseTip, headTip, store.lookup(repo));
}

function executeSelectionSet(ctx: Ctx, source: Obj, selections: SelectionNode[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === source.__type || selection.typeCondition === 'Node') {
        Object.assign(out, executeSelectionSet(ctx, source, selection.selectionSet));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment) Object.assign(out, executeSelectionSet(ctx, source, fragment));
      continue;
    }
    const key = selection.alias ?? selection.name;
    let value: unknown;
    try {
      value = resolveField(ctx, source, selection.name, selection.args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[key] = null;
      continue;
    }
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && selection.selectionSet) {
      out[key] = executeSelectionSet(ctx, value as Obj, selection.selectionSet);
    } else if (Array.isArray(value) && selection.selectionSet) {
      out[key] = value.map((item) => (
        item !== null && typeof item === 'object' ? executeSelectionSet(ctx, item as Obj, selection.selectionSet!) : item
      ));
    } else {
      out[key] = value ?? null;
    }
  }
  return out;
}

export function executeGraphQL(store: Store, body: unknown): unknown {
  const runOne = (entry: { query?: unknown; variables?: unknown; operationName?: unknown }): Record<string, unknown> => {
    const query = typeof entry.query === 'string' ? entry.query : '';
    const variables = (entry.variables && typeof entry.variables === 'object' ? entry.variables : {}) as Record<string, unknown>;
    let document: DocumentNode;
    try {
      document = new Parser(tokenize(query)).parseDocument();
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
    }
    const operationName = typeof entry.operationName === 'string' ? entry.operationName : undefined;
    const operation = document.operations.find((candidate) => !operationName || candidate.name === operationName) ?? document.operations[0];
    if (!operation) return { errors: [{ message: 'no operation in document' }] };
    const ctx: Ctx = { store, variables, fragments: document.fragments, errors: [] };
    const root: Obj = { __type: operation.operation === 'mutation' ? 'Mutation' : 'Query' };
    const data = executeSelectionSet(ctx, root, operation.selectionSet);
    const envelope: Record<string, unknown> = { data };
    if (ctx.errors.length) envelope.errors = ctx.errors;
    return envelope;
  };
  if (Array.isArray(body)) return body.map((entry) => runOne((entry ?? {}) as { query?: unknown }));
  return runOne((body ?? {}) as { query?: unknown });
}
