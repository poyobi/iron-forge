// The REST v3 surface under /api/v3. Every reply is a JSON object (or array)
// with a `message` on errors; the exact statuses and shapes follow the
// conformance contract (201 creates, 204 delete, 404 unknown/foreign,
// 405 merge conflict, 409 stale contents sha, 422 unknown label).

import { ZERO_OID, mergeBase, parseCommit } from './git.ts';
import { gid, type IssueRec, type PullRec, type RepoRec, type Store } from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const error = (status: number, message: string): RestResult => ({ status, body: { message } });
export const restError = error;

function repoJson(store: Store, repo: RepoRec): Record<string, unknown> {
  const login = store.viewerLogin ?? 'user';
  return {
    id: repo.dbId,
    node_id: gid('Repository', repo.dbId),
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    owner: { login, id: 1, type: 'User' },
  };
}

function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    node_id: gid('Issue', issue.dbId),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    comments: issue.comments.length,
  };
}

function pullJson(store: Store, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.mergeCommitSha ?? ZERO_OID;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? ZERO_OID;
  return {
    id: pull.dbId,
    node_id: gid('PullRequest', pull.dbId),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${store.viewerLogin ?? 'user'}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${store.viewerLogin ?? 'user'}:${pull.baseRef}` },
  };
}

function paginate<T>(items: T[], query: URLSearchParams): { page: T[]; perPage: number; pageNumber: number; totalPages: number } {
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? 30) || 30));
  const pageNumber = Math.max(1, Number(query.get('page') ?? 1) || 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  return { page: items.slice((pageNumber - 1) * perPage, pageNumber * perPage), perPage, pageNumber, totalPages };
}

function linkHeader(base: string, perPage: number, pageNumber: number, totalPages: number): string | undefined {
  const parts: string[] = [];
  const url = (page: number) => `${base}?per_page=${perPage}&page=${page}`;
  if (pageNumber < totalPages) {
    parts.push(`<${url(pageNumber + 1)}>; rel="next"`, `<${url(totalPages)}>; rel="last"`);
  }
  if (pageNumber > 1) {
    parts.push(`<${url(pageNumber - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  }
  return parts.length ? parts.join(', ') : undefined;
}

export function handleRest(
  store: Store,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
  host: string,
): RestResult {
  const [head, ...rest] = segments;

  if (segments.length === 0) {
    if (method !== 'GET') return error(404, 'Not Found');
    return {
      status: 200,
      body: { current_user_url: '/api/v3/user', repository_url: '/api/v3/repos/{owner}/{repo}' },
      headers: { 'x-oauth-scopes': 'repo, user' },
    };
  }
  if (head === 'meta' && segments.length === 1) {
    if (method !== 'GET') return error(404, 'Not Found');
    return { status: 200, body: { installed_version: '1.0.0', verifiable_password_authentication: false } };
  }
  if (head === 'user' && segments.length === 1) {
    if (method !== 'GET') return error(404, 'Not Found');
    return { status: 200, body: { login: store.viewerLogin ?? 'user', id: 1, type: 'User' } };
  }
  if (head === 'user' && rest[0] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const all = [...store.repos.values()].sort((a, b) => a.dbId - b.dbId).map((repo) => repoJson(store, repo));
      const { page, perPage, pageNumber, totalPages } = paginate(all, query);
      const link = linkHeader(`http://${host}/api/v3/user/repos`, perPage, pageNumber, totalPages);
      return { status: 200, body: page, headers: link ? { link } : undefined };
    }
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name) return error(422, 'Repository creation failed.');
      if (store.repos.has(name)) return error(422, 'name already exists on this account');
      const repo = store.createRepo(name, typeof body?.description === 'string' ? body.description : '', body?.private !== false);
      return { status: 201, body: repoJson(store, repo) };
    }
    return error(404, 'Not Found');
  }
  if (head !== 'repos' || rest.length < 2) return error(404, 'Not Found');

  const owner = rest[0]!;
  const repoName = rest[1]!;
  const tail = rest.slice(2);
  const repo = store.repos.get(repoName);
  if (!repo) return error(404, 'Not Found');
  if (!store.ownerMatches(owner)) return error(404, 'Not Found');
  store.adoptLogin(owner);

  if (tail.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(store, repo) };
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description;
      if (typeof body?.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body?.default_branch === 'string' && body.default_branch) repo.defaultBranch = body.default_branch;
      return { status: 200, body: repoJson(store, repo) };
    }
    if (method === 'DELETE') {
      store.repos.delete(repoName);
      return { status: 204 };
    }
    return error(404, 'Not Found');
  }

  const [area, ...sub] = tail;

  if (area === 'branches') {
    if (sub.length === 0 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }));
      return { status: 200, body: branches };
    }
    if (sub.length >= 1 && method === 'GET') {
      const name = sub.join('/');
      const sha = store.branchTip(repo, name);
      if (!sha) return error(404, 'Branch not found');
      return { status: 200, body: { name, commit: { sha }, protected: false } };
    }
    return error(404, 'Not Found');
  }

  if (area === 'git' && sub[0] === 'refs') {
    if (method === 'POST' && sub.length === 1) {
      const ref = typeof body?.ref === 'string' ? body.ref : '';
      const sha = typeof body?.sha === 'string' ? body.sha.toLowerCase() : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return error(422, 'Invalid ref or sha');
      repo.refs.set(ref, sha);
      return { status: 201, body: { ref, object: { sha, type: 'commit' } } };
    }
    if (method === 'GET' && sub.length >= 3 && sub[1] === 'heads') {
      const branch = sub.slice(2).join('/');
      const sha = store.branchTip(repo, branch);
      if (!sha) return error(404, 'Reference not found');
      return { status: 200, body: { ref: `refs/heads/${branch}`, object: { sha, type: 'commit' } } };
    }
    return error(404, 'Not Found');
  }

  if (area === 'commits' && sub.length === 0 && method === 'GET') {
    const ref = query.get('sha') ?? undefined;
    const tip = store.resolveRef(repo, ref);
    if (!tip) return { status: 200, body: [] };
    const commits = store.listCommits(repo, tip).map(({ oid }) => {
      const object = repo.objects.get(oid)!;
      const commit = parseCommit(object.data);
      return {
        sha: oid,
        commit: {
          message: commit.message.replace(/\n$/, ''),
          author: { name: commit.author, email: '' },
          committer: { name: commit.committer, email: '' },
          tree: { sha: commit.tree },
        },
        parents: commit.parents.map((parent) => ({ sha: parent })),
      };
    });
    const { page } = paginate(commits, query);
    return { status: 200, body: page };
  }

  if (area === 'contents') {
    const path = sub.map((segment) => decodeURIComponent(segment)).join('/');
    if (method === 'GET') {
      const found = store.contentsAt(repo, path, query.get('ref') ?? undefined);
      if (!found) return error(404, 'Not Found');
      if (found.kind === 'dir') {
        return {
          status: 200,
          body: found.entries.map((entry) => ({
            type: entry.type, name: entry.name, path: entry.path, sha: entry.oid, size: 0,
          })),
        };
      }
      const name = path.split('/').pop() ?? path;
      return {
        status: 200,
        body: {
          type: 'file', name, path, sha: found.oid, size: found.data.length,
          encoding: 'base64', content: found.data.toString('base64'),
        },
      };
    }
    if (method === 'PUT') {
      const message = typeof body?.message === 'string' ? body.message : 'Update file';
      const contentBase64 = typeof body?.content === 'string' ? body.content : '';
      const content = Buffer.from(contentBase64, 'base64');
      const branch = typeof body?.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
      const existing = store.contentsAt(repo, path, branch);
      if (existing && existing.kind === 'file') {
        const sha = typeof body?.sha === 'string' ? body.sha.toLowerCase() : '';
        if (sha !== existing.oid) return error(409, 'sha does not match the current file');
        const commitSha = store.commitFiles(repo, branch, new Map([[path, content]]), message);
        const after = store.contentsAt(repo, path, branch);
        return {
          status: 200,
          body: {
            content: { sha: after && after.kind === 'file' ? after.oid : '', encoding: 'base64', name: path.split('/').pop(), path },
            commit: { sha: commitSha },
          },
        };
      }
      const commitSha = store.commitFiles(repo, branch, new Map([[path, content]]), message);
      const after = store.contentsAt(repo, path, branch);
      return {
        status: 201,
        body: {
          content: { sha: after && after.kind === 'file' ? after.oid : '', encoding: 'base64', name: path.split('/').pop(), path },
          commit: { sha: commitSha },
        },
      };
    }
    if (method === 'DELETE') {
      const existing = store.contentsAt(repo, path, typeof body?.branch === 'string' ? body.branch : undefined);
      if (!existing || existing.kind !== 'file') return error(404, 'Not Found');
      const sha = typeof body?.sha === 'string' ? body.sha.toLowerCase() : '';
      if (sha && sha !== existing.oid) return error(409, 'sha does not match the current file');
      const branch = typeof body?.branch === 'string' && body.branch ? body.branch : repo.defaultBranch;
      const message = typeof body?.message === 'string' ? body.message : 'Delete file';
      const commitSha = store.commitFiles(repo, branch, new Map([[path, null]]), message);
      return { status: 200, body: { content: null, commit: { sha: commitSha } } };
    }
    return error(404, 'Not Found');
  }

  if (area === 'labels') {
    if (method === 'POST' && sub.length === 0) {
      const name = typeof body?.name === 'string' ? body.name : '';
      if (!name) return error(422, 'Validation Failed');
      if (repo.labels.has(name)) return error(422, 'Validation Failed: label already exists');
      const color = typeof body?.color === 'string' ? body.color : 'ededed';
      repo.labels.set(name, { name, color });
      return { status: 201, body: { name, color } };
    }
    if (method === 'GET' && sub.length === 0) {
      return { status: 200, body: [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })) };
    }
    return error(404, 'Not Found');
  }

  if (area === 'issues') {
    if (sub.length === 0) {
      if (method === 'POST') {
        const labels = Array.isArray(body?.labels) ? body.labels.filter((label): label is string => typeof label === 'string') : [];
        for (const label of labels) {
          if (!repo.labels.has(label)) return error(422, `Validation Failed: label '${label}' does not exist`);
        }
        const issue = store.createIssue(
          repo,
          typeof body?.title === 'string' ? body.title : '',
          typeof body?.body === 'string' ? body.body : '',
          labels,
        );
        return { status: 201, body: issueJson(repo, issue) };
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let issues = [...repo.issues.values()];
        if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
        const direction = query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
        const { page } = paginate(issues, query);
        return { status: 200, body: page.map((issue) => issueJson(repo, issue)) };
      }
      return error(404, 'Not Found');
    }
    const number = Number(sub[0]);
    const issue = Number.isInteger(number) ? repo.issues.get(number) : undefined;
    if (sub.length === 1) {
      if (!issue) return error(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
      if (method === 'PATCH') {
        if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
        if (typeof body?.title === 'string') issue.title = body.title;
        if (typeof body?.body === 'string') issue.body = body.body;
        return { status: 200, body: issueJson(repo, issue) };
      }
      return error(404, 'Not Found');
    }
    if (sub.length === 2 && sub[1] === 'comments') {
      if (!issue) return error(404, 'Not Found');
      if (method === 'POST') {
        const comment = store.addComment(issue, typeof body?.body === 'string' ? body.body : '');
        return { status: 201, body: { id: comment.id, body: comment.body } };
      }
      if (method === 'GET') {
        return { status: 200, body: issue.comments.map((comment) => ({ id: comment.id, body: comment.body })) };
      }
      return error(404, 'Not Found');
    }
    return error(404, 'Not Found');
  }

  if (area === 'pulls') {
    if (sub.length === 0) {
      if (method === 'POST') {
        const head = typeof body?.head === 'string' ? body.head : '';
        const base = typeof body?.base === 'string' ? body.base : '';
        if (!store.branchTip(repo, head) || !store.branchTip(repo, base)) {
          return error(422, 'Validation Failed: head or base branch does not exist');
        }
        const pull = store.createPull(
          repo,
          typeof body?.title === 'string' ? body.title : '',
          typeof body?.body === 'string' ? body.body : '',
          head, base,
        );
        return { status: 201, body: pullJson(store, repo, pull) };
      }
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let pulls = [...repo.pulls.values()];
        if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
        pulls.sort((a, b) => a.number - b.number);
        const { page } = paginate(pulls, query);
        return { status: 200, body: page.map((pull) => pullJson(store, repo, pull)) };
      }
      return error(404, 'Not Found');
    }
    const number = Number(sub[0]);
    const pull = Number.isInteger(number) ? repo.pulls.get(number) : undefined;
    if (sub.length === 1) {
      if (!pull) return error(404, 'Not Found');
      if (method === 'GET') return { status: 200, body: pullJson(store, repo, pull) };
      return error(404, 'Not Found');
    }
    if (sub.length === 2 && sub[1] === 'files' && method === 'GET') {
      if (!pull) return error(404, 'Not Found');
      const headTip = store.branchTip(repo, pull.headRef);
      const baseTip = store.branchTip(repo, pull.baseRef);
      const base = baseTip && headTip ? mergeBase(baseTip, headTip, store.lookup(repo)) : null;
      const files = store.diffFiles(repo, base, headTip);
      return {
        status: 200,
        body: files.map((file) => ({
          filename: file.filename, status: file.status,
          additions: file.additions, deletions: file.deletions, changes: file.changes,
          sha: '', patch: '',
        })),
      };
    }
    if (sub.length === 2 && sub[1] === 'merge' && method === 'PUT') {
      if (!pull) return error(404, 'Not Found');
      if (pull.state !== 'open') return error(405, 'Pull Request is not open');
      const sha = store.mergePull(repo, pull);
      if (!sha) return error(405, 'Pull Request is not mergeable');
      return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
    }
    return error(404, 'Not Found');
  }

  return error(404, 'Not Found');
}
