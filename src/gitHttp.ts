// The git smart-HTTP transport: ref advertisement, protocol v2 ls-refs and
// fetch, the v0 fetch fallback, and v0 receive-pack with report-status.
// Objects move byte-exactly; packs we send are plain (no deltas), packs we
// receive may use any delta form the reader supports.

import {
  PKT_DELIM, PKT_FLUSH, ZERO_OID, collectReachable, collectShallow, decodePktLines, isAncestor,
  parseCommit, parseTag, pktLine, readPack, writePack, type GitObject,
} from './git.ts';
import type { RepoRec, Store } from './store.ts';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const AGENT = 'makefun-forge/1.0';
const text = (status: number, message: string): GitHttpResult => ({
  status, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message }), 'utf8'),
});

function sortedRefs(repo: RepoRec): [string, string][] {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function peelToCommit(repo: RepoRec, oid: string): string {
  let current = oid;
  for (let depth = 0; depth < 16; depth += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current;
    current = parseTag(object.data).object;
  }
  return current;
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack'
    ? `multi_ack_detailed side-band-64k ofs-delta symref=HEAD:refs/heads/${repo.defaultBranch} agent=${AGENT}`
    : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${headTip} HEAD\0${caps}\n`));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') {
        parts.push(pktLine(`${peelToCommit(repo, oid)} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

function sidebandPackets(data: Buffer, band: number): Buffer[] {
  const packets: Buffer[] = [];
  const maxPayload = 65515;
  for (let offset = 0; offset < data.length; offset += maxPayload) {
    const chunk = data.subarray(offset, offset + maxPayload);
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), chunk])));
  }
  return packets;
}

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen?: number;
}

function computeFetch(repo: RepoRec, request: FetchRequest): { pack: Buffer | null; shallowLines: string[] } {
  const lookup = (oid: string) => repo.objects.get(oid);
  // What the client already holds: the closure of its haves, truncated at
  // the shallow boundary commits it named (their ancestors are not held).
  const held = new Set<string>();
  {
    const stopAt = new Set(request.shallow);
    const queue = [...request.haves];
    const seen = new Set<string>();
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid) || oid === ZERO_OID) continue;
      seen.add(oid);
      const object = lookup(oid);
      if (!object) continue;
      held.add(oid);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        for (const sub of collectReachable([commit.tree], lookup, true)) held.add(sub);
        if (!stopAt.has(oid)) queue.push(...commit.parents);
      } else if (object.type === 'tag') {
        for (const sub of collectReachable([oid], lookup, true)) held.add(sub);
      } else if (object.type === 'tree') {
        for (const sub of collectReachable([oid], lookup, true)) held.add(sub);
      }
    }
  }
  let included: Set<string>;
  let boundary = new Set<string>();
  if (request.deepen !== undefined && request.deepen > 0) {
    const shallow = collectShallow(request.wants, request.deepen, lookup);
    included = shallow.objects;
    boundary = shallow.boundary;
  } else {
    included = collectReachable(request.wants, lookup, true);
  }
  const send: GitObject[] = [];
  for (const oid of included) {
    if (held.has(oid)) continue;
    const object = lookup(oid);
    if (object) send.push(object);
  }
  const shallowLines: string[] = [];
  for (const oid of boundary) {
    if (!request.shallow.includes(oid)) shallowLines.push(`shallow ${oid}`);
  }
  for (const oid of request.shallow) {
    // A former boundary commit whose ancestry is now included is unshallowed.
    if (included.has(oid) && !boundary.has(oid)) shallowLines.push(`unshallow ${oid}`);
  }
  return { pack: send.length ? writePack(send) : null, shallowLines };
}

function lsRefs(repo: RepoRec, args: string[]): Buffer {
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headTip = repo.refs.get(headRef);
  if (matches('HEAD')) {
    if (headTip) lines.push(`${headTip} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    else if (args.includes('unborn')) lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    else lines.push(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'tag') line += ` peeled:${peelToCommit(repo, oid)}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
}

function v2Fetch(repo: RepoRec, request: FetchRequest): Buffer {
  const { pack, shallowLines } = computeFetch(repo, request);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), PKT_DELIM];
  if (shallowLines.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
    parts.push(PKT_DELIM);
  }
  if (pack) {
    parts.push(pktLine('packfile\n'));
    parts.push(...sidebandPackets(pack, 1));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function v0Fetch(repo: RepoRec, request: FetchRequest): Buffer {
  const { pack, shallowLines } = computeFetch(repo, request);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const line of shallowLines) parts.push(pktLine(`${line}\n`));
  if (pack) parts.push(...sidebandPackets(pack, 1));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function receivePack(repo: RepoRec, body: Buffer): Buffer {
  const { packets, rest } = decodePktLines(body);
  const commands: { oldOid: string; newOid: string; ref: string }[] = [];
  let sideband = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      const caps = line.slice(nul + 1);
      if (caps.includes('side-band-64k')) sideband = true;
      line = line.slice(0, nul);
    }
    const [oldOid, newOid, ref] = line.split(' ');
    if (oldOid && newOid && ref) commands.push({ oldOid: oldOid.toLowerCase(), newOid: newOid.toLowerCase(), ref });
  }
  let unpackLine = 'unpack ok';
  if (rest.length > 0) {
    try {
      const objects = readPack(rest);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackLine = `unpack ${err instanceof Error ? err.message : 'pack error'}`;
    }
  }
  const lookup = (oid: string) => repo.objects.get(oid);
  const report: string[] = [unpackLine];
  for (const command of commands) {
    if (unpackLine !== 'unpack ok') {
      report.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      report.push(`ok ${command.ref}`);
    } else if (!repo.objects.has(command.newOid)) {
      report.push(`ng ${command.ref} not found`);
    } else if (command.oldOid === ZERO_OID || isAncestor(command.oldOid, command.newOid, lookup)) {
      repo.refs.set(command.ref, command.newOid);
      report.push(`ok ${command.ref}`);
    } else {
      report.push(`ng ${command.ref} non-fast-forward`);
    }
  }
  const stream = Buffer.concat([...report.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]);
  if (!sideband) return stream;
  return Buffer.concat([...sidebandPackets(stream, 1), PKT_FLUSH]);
}

export function handleGitHttp(
  store: Store,
  method: string,
  owner: string,
  repoSegment: string,
  tail: string[],
  query: URLSearchParams,
  headers: Record<string, string | undefined>,
  body: Buffer,
): GitHttpResult {
  const repoName = repoSegment.endsWith('.git') ? repoSegment.slice(0, -'.git'.length) : repoSegment;
  const repo = store.repos.get(repoName);
  if (!repo) return text(404, 'Not Found');
  if (!store.ownerMatches(owner)) return text(404, 'Not Found');
  store.adoptLogin(owner);

  const endpoint = tail.join('/');
  if (method === 'GET' && endpoint === 'info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack') {
      const wantsV2 = (headers['git-protocol'] ?? '').includes('version=2');
      return {
        status: 200,
        contentType: 'application/x-git-upload-pack-advertisement',
        body: wantsV2 ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack'),
      };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: v0Advertisement(repo, 'git-receive-pack') };
    }
    return text(400, 'Unknown service');
  }

  if (method === 'POST' && endpoint === 'git-upload-pack') {
    try {
      const isV2 = (headers['git-protocol'] ?? '').includes('version=2');
      const { packets } = decodePktLines(body);
      if (isV2) {
        let command = '';
        const args: string[] = [];
        let phase: 'command' | 'args' = 'command';
        for (const packet of packets) {
          if (packet.kind === 'delim') { phase = 'args'; continue; }
          if (packet.kind === 'flush') break;
          if (packet.kind !== 'data') continue;
          const line = packet.payload.toString('utf8').replace(/\n$/, '');
          if (phase === 'command') {
            if (line.startsWith('command=')) command = line.slice('command='.length);
            continue;
          }
          args.push(line);
        }
        if (command === 'ls-refs') {
          return { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefs(repo, args) };
        }
        if (command === 'fetch') {
          const request: FetchRequest = { wants: [], haves: [], shallow: [] };
          for (const line of args) {
            if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().toLowerCase());
            else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim().toLowerCase());
            else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim().toLowerCase());
            else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
          }
          return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v2Fetch(repo, request) };
        }
        return text(400, 'Unknown command');
      }
      const request: FetchRequest = { wants: [], haves: [], shallow: [] };
      for (const packet of packets) {
        if (packet.kind !== 'data') continue;
        const line = packet.payload.toString('utf8').replace(/\n$/, '');
        if (line.startsWith('want ')) request.wants.push(line.slice(5).trim().split(' ')[0]!.toLowerCase());
        else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim().toLowerCase());
        else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8).trim().toLowerCase());
        else if (line.startsWith('deepen ')) request.deepen = Number(line.slice(7).trim());
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: v0Fetch(repo, request) };
    } catch {
      return text(400, 'Malformed git request');
    }
  }

  if (method === 'POST' && endpoint === 'git-receive-pack') {
    try {
      return { status: 200, contentType: 'application/x-git-receive-pack-result', body: receivePack(repo, body) };
    } catch {
      return text(400, 'Malformed git request');
    }
  }

  return text(404, 'Not Found');
}
