// The in-memory store and the domain operations shared by every surface
// (REST, GraphQL, MCP, git): one tenant (the bearer token's login), its
// repositories, git objects and refs, issues, pull requests, labels and
// comments. All state lives in Maps so the hot paths stay O(1).

import {
  ZERO_OID, buildCommit, buildTree, collectReachable, hashObject, isAncestor, mergeBase, parseCommit, parseTree,
  type GitObject, type GitObjectType, type ObjectLookup, type TreeEntry,
} from './git.ts';

export interface LabelRec { name: string; color: string }
export interface CommentRec { id: number; body: string }
export interface IssueRec {
  dbId: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; labels: string[]; comments: CommentRec[];
}
export interface PullRec {
  dbId: number; number: number; title: string; body: string;
  state: 'open' | 'closed'; merged: boolean; mergedAt: string | null; mergeCommitSha: string | null;
  headRef: string; baseRef: string;
}
export interface RepoRec {
  dbId: number; name: string; description: string; isPrivate: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  labels: Map<string, LabelRec>;
  nextNumber: number;
}

export function gid(type: string, dbId: number): string {
  return Buffer.from(`${type}:${dbId}`, 'utf8').toString('base64url');
}

export function parseGid(value: string): { type: string; dbId: number } | null {
  try {
    const text = Buffer.from(value, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    const dbId = Number(text.slice(colon + 1));
    if (!Number.isInteger(dbId) || dbId < 1) return null;
    return { type: text.slice(0, colon), dbId };
  } catch {
    return null;
  }
}

export class Store {
  viewerLogin: string | null = null;
  readonly repos = new Map<string, RepoRec>();
  private nextRepoId = 1;
  private nextIssueDbId = 1;
  private nextPullDbId = 1;
  private nextCommentId = 1;
  private clock = 1735689600;

  /** Learn the token owner's login from the first owner-named path that resolves to a real repo. */
  adoptLogin(login: string): void {
    if (!this.viewerLogin && login) this.viewerLogin = login;
  }

  ownerMatches(login: string): boolean {
    return this.viewerLogin === null || this.viewerLogin === login;
  }

  createRepo(name: string, description: string, isPrivate: boolean): RepoRec {
    const repo: RepoRec = {
      dbId: this.nextRepoId++,
      name, description, isPrivate,
      defaultBranch: 'main',
      objects: new Map(), refs: new Map(),
      issues: new Map(), pulls: new Map(), labels: new Map(),
      nextNumber: 1,
    };
    this.repos.set(name, repo);
    return repo;
  }

  repoByDbId(dbId: number): RepoRec | undefined {
    for (const repo of this.repos.values()) if (repo.dbId === dbId) return repo;
    return undefined;
  }

  lookup(repo: RepoRec): ObjectLookup {
    return (oid) => repo.objects.get(oid);
  }

  putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  private identity(): string {
    const login = this.viewerLogin ?? 'forge';
    return `${login} <${login}@example.invalid>`;
  }

  private nextTimestamp(): number {
    this.clock += 1;
    return this.clock;
  }

  /** Flatten a tree (recursively) into path -> entry. */
  treeToFlat(repo: RepoRec, treeOid: string | null): Map<string, { mode: string; oid: string }> {
    const flat = new Map<string, { mode: string; oid: string }>();
    if (!treeOid) return flat;
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.mode === '40000') walk(entry.oid, path);
        else flat.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return flat;
  }

  /** Store a flattened path map as nested trees; returns the root tree oid. */
  flatToTree(repo: RepoRec, flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface Node { files: Map<string, { mode: string; oid: string }>; dirs: Map<string, Node> }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i += 1) {
        const part = parts[i]!;
        if (!node.dirs.has(part)) node.dirs.set(part, { files: new Map(), dirs: new Map() });
        node = node.dirs.get(part)!;
      }
      node.files.set(parts[parts.length - 1]!, entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, sub] of node.dirs) entries.push({ mode: '40000', name, oid: build(sub) });
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  commitTreeOf(repo: RepoRec, commitOid: string): string | null {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data).tree;
  }

  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** Create a commit on a branch applying path changes (Buffer = write, null = delete). Returns the commit oid. */
  commitFiles(repo: RepoRec, branch: string, changes: ReadonlyMap<string, Buffer | null>, message: string): string {
    const tip = this.branchTip(repo, branch);
    const flat = this.treeToFlat(repo, tip ? this.commitTreeOf(repo, tip) : null);
    for (const [path, content] of changes) {
      if (content === null) flat.delete(path);
      else flat.set(path, { mode: '100644', oid: this.putObject(repo, 'blob', content) });
    }
    const tree = this.flatToTree(repo, flat);
    const commit = buildCommit({
      tree,
      parents: tip ? [tip] : [],
      message,
      author: this.identity(),
      timestamp: this.nextTimestamp(),
    });
    const oid = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${branch}`, oid);
    return oid;
  }

  resolveRef(repo: RepoRec, ref: string | undefined): string | null {
    if (!ref) return this.branchTip(repo, repo.defaultBranch);
    if (/^[0-9a-f]{40}$/i.test(ref) && repo.objects.has(ref.toLowerCase())) return ref.toLowerCase();
    return this.branchTip(repo, ref) ?? repo.refs.get(ref) ?? null;
  }

  /** Read a path at a ref: a file, a directory listing, or null. */
  contentsAt(repo: RepoRec, path: string, ref?: string): (
    | { kind: 'file'; oid: string; data: Buffer }
    | { kind: 'dir'; entries: { name: string; path: string; type: 'file' | 'dir'; oid: string }[] }
    | null
  ) {
    const commitOid = this.resolveRef(repo, ref);
    if (!commitOid) return null;
    let treeOid = this.commitTreeOf(repo, commitOid);
    if (!treeOid) return null;
    const parts = path.split('/').filter((part) => part.length > 0);
    for (let i = 0; i < parts.length; i += 1) {
      const object = repo.objects.get(treeOid);
      if (!object || object.type !== 'tree') return null;
      const entry = parseTree(object.data).find((candidate) => candidate.name === parts[i]);
      if (!entry) return null;
      if (i === parts.length - 1) {
        if (entry.mode === '40000') {
          const dirObject = repo.objects.get(entry.oid);
          if (!dirObject || dirObject.type !== 'tree') return null;
          return {
            kind: 'dir',
            entries: parseTree(dirObject.data).map((child) => ({
              name: child.name,
              path: path ? `${path}/${child.name}` : child.name,
              type: (child.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
              oid: child.oid,
            })),
          };
        }
        const blob = repo.objects.get(entry.oid);
        if (!blob || blob.type !== 'blob') return null;
        return { kind: 'file', oid: entry.oid, data: blob.data };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    // path was '' or '/': the root directory
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return null;
    return {
      kind: 'dir',
      entries: parseTree(object.data).map((child) => ({
        name: child.name,
        path: child.name,
        type: (child.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
        oid: child.oid,
      })),
    };
  }

  /** Commits reachable from a tip, newest first (BFS by generation). */
  listCommits(repo: RepoRec, tip: string): { oid: string; message: string }[] {
    const reachable = collectReachable([tip], this.lookup(repo), true);
    const order: { oid: string; message: string }[] = [];
    const seen = new Set<string>();
    const queue = [tip];
    while (queue.length) {
      const oid = queue.shift()!;
      if (seen.has(oid) || !reachable.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      order.push({ oid, message: commit.message.replace(/\n$/, '') });
      queue.push(...commit.parents);
    }
    return order;
  }

  /** File-level diff between two commits. */
  diffFiles(repo: RepoRec, baseCommit: string | null, headCommit: string | null): {
    filename: string; status: 'added' | 'removed' | 'modified'; additions: number; deletions: number; changes: number;
  }[] {
    const baseFlat = this.treeToFlat(repo, baseCommit ? this.commitTreeOf(repo, baseCommit) : null);
    const headFlat = this.treeToFlat(repo, headCommit ? this.commitTreeOf(repo, headCommit) : null);
    const lineCount = (oid: string): number => {
      const blob = repo.objects.get(oid);
      if (!blob) return 0;
      const text = blob.data.toString('utf8');
      if (!text) return 0;
      return text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    };
    const files: ReturnType<Store['diffFiles']> = [];
    const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of [...paths].sort()) {
      const before = baseFlat.get(path);
      const after = headFlat.get(path);
      if (before && !after) {
        const deletions = lineCount(before.oid);
        files.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
      } else if (!before && after) {
        const additions = lineCount(after.oid);
        files.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
      } else if (before && after && before.oid !== after.oid) {
        const additions = lineCount(after.oid);
        const deletions = lineCount(before.oid);
        files.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
      }
    }
    return files;
  }

  /** Three-way tree merge for a pull request; returns the merged flat map, or null on conflict. */
  mergedFlat(repo: RepoRec, pull: PullRec): Map<string, { mode: string; oid: string }> | null {
    const baseTip = this.branchTip(repo, pull.baseRef);
    const headTip = this.branchTip(repo, pull.headRef);
    if (!baseTip || !headTip) return null;
    const base = mergeBase(baseTip, headTip, this.lookup(repo));
    const baseFlat = this.treeToFlat(repo, baseTip ? this.commitTreeOf(repo, baseTip) : null);
    const headFlat = this.treeToFlat(repo, headTip ? this.commitTreeOf(repo, headTip) : null);
    const ancestorFlat = this.treeToFlat(repo, base ? this.commitTreeOf(repo, base) : null);
    const result = new Map<string, { mode: string; oid: string }>();
    const paths = new Set([...ancestorFlat.keys(), ...baseFlat.keys(), ...headFlat.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFlat.get(path)?.oid;
      const baseValue = baseFlat.get(path)?.oid;
      const headValue = headFlat.get(path)?.oid;
      let chosen: string | undefined;
      if (headValue === ancestor) chosen = baseValue;
      else if (baseValue === ancestor) chosen = headValue;
      else if (headValue === baseValue) chosen = headValue;
      else return null;
      if (chosen !== undefined) {
        const mode = (headFlat.get(path) ?? baseFlat.get(path))!.mode;
        result.set(path, { mode, oid: chosen });
      }
    }
    return result;
  }

  pullMergeable(repo: RepoRec, pull: PullRec): boolean {
    if (pull.state !== 'open') return false;
    return this.mergedFlat(repo, pull) !== null;
  }

  /** Squash-merge a pull request onto its base branch. Returns the merge commit oid, or null on conflict. */
  mergePull(repo: RepoRec, pull: PullRec): string | null {
    const merged = this.mergedFlat(repo, pull);
    if (!merged) return null;
    const baseTip = this.branchTip(repo, pull.baseRef)!;
    const tree = this.flatToTree(repo, merged);
    const commit = buildCommit({
      tree,
      parents: [baseTip],
      message: `${pull.title}\n\n${pull.body}`.trimEnd() + '\n',
      author: this.identity(),
      timestamp: this.nextTimestamp(),
    });
    const oid = this.putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${pull.baseRef}`, oid);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = new Date().toISOString();
    pull.mergeCommitSha = oid;
    return oid;
  }

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    const issue: IssueRec = {
      dbId: this.nextIssueDbId++,
      number: repo.nextNumber++,
      title, body, state: 'open', labels: [...labels], comments: [],
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  issueByDbId(dbId: number): { repo: RepoRec; issue: IssueRec } | null {
    for (const repo of this.repos.values()) {
      for (const issue of repo.issues.values()) if (issue.dbId === dbId) return { repo, issue };
    }
    return null;
  }

  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec {
    const pull: PullRec = {
      dbId: this.nextPullDbId++,
      number: repo.nextNumber++,
      title, body, state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
      headRef, baseRef,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  pullByDbId(dbId: number): { repo: RepoRec; pull: PullRec } | null {
    for (const repo of this.repos.values()) {
      for (const pull of repo.pulls.values()) if (pull.dbId === dbId) return { repo, pull };
    }
    return null;
  }

  addComment(issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId++, body };
    issue.comments.push(comment);
    return comment;
  }
}
