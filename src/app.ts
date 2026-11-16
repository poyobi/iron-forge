// HTTP wiring: one node:http server routing the four surfaces — git smart
// HTTP at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at
// /api/graphql and MCP at /mcp — over a single in-memory store. Every reply
// carries a non-empty X-GitHub-Request-Id; API errors are JSON with a
// `message`, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGitHttp } from './gitHttp.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  const sendJson = (res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void => {
    if (headers) for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
    if (status === 204 || body === undefined) {
      res.writeHead(status);
      res.end();
      return;
    }
    const payload = Buffer.from(JSON.stringify(body), 'utf8');
    res.setHeader('content-type', 'application/json');
    res.setHeader('content-length', payload.length);
    res.writeHead(status);
    res.end(payload);
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('x-github-request-id', randomUUID());
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const authed = token === '' || req.headers.authorization === `Bearer ${token}`;

    if (path === '/healthz') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (path === '/mcp') {
      const result = handleMcp(store, method, body, authed);
      sendJson(res, result.status, result.body);
      return;
    }

    // A malformed JSON body is a 400 before anything else looks at it.
    let jsonBody: unknown = null;
    let jsonParsed = false;
    if (body.length > 0 && (path.startsWith('/api/'))) {
      try {
        jsonBody = JSON.parse(body.toString('utf8'));
        jsonParsed = true;
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
    }

    if (!authed) {
      sendJson(res, 401, { message: 'Unauthorized' });
      return;
    }

    if (path === '/api/graphql') {
      if (method !== 'POST') { sendJson(res, 404, { message: 'Not Found' }); return; }
      const result = executeGraphQL(store, jsonParsed ? jsonBody : {});
      sendJson(res, 200, result);
      return;
    }

    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      const segments = path.slice('/api/v3'.length).split('/').filter((segment) => segment.length > 0);
      const record = jsonBody && typeof jsonBody === 'object' && !Array.isArray(jsonBody)
        ? jsonBody as Record<string, unknown>
        : null;
      // A JSON body that is present but unparseable was handled above; a
      // non-object body on a write is treated as malformed too.
      if (body.length > 0 && !jsonParsed && method !== 'GET') {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return;
      }
      const result = handleRest(store, method, segments, url.searchParams, record, req.headers.host ?? 'localhost');
      sendJson(res, result.status, result.body, result.headers);
      return;
    }

    if (path.startsWith('/api/')) {
      sendJson(res, 404, { message: 'Not Found' });
      return;
    }

    const gitMatch = /^\/([^/]+)\/([^/]+)\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      const result = handleGitHttp(
        store, method, gitMatch[1]!, gitMatch[2]!, [gitMatch[3]!], url.searchParams,
        req.headers as Record<string, string | undefined>, body,
      );
      res.setHeader('content-type', result.contentType);
      res.setHeader('content-length', result.body.length);
      res.writeHead(result.status);
      res.end(result.body);
      return;
    }

    sendJson(res, 404, { message: 'Not Found' });
  };

  const server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
      else res.end();
    });
  });
  return server;
}
