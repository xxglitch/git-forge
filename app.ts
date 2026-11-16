// app.ts: the HTTP server: routing, auth, and the four surfaces.
//
//   GET  /healthz                          -> {"ok":true} (no auth, the boot probe)
//   /api/v3/*                              -> REST v3 (auth, except GET /api/v3/ and /api/v3/meta)
//   POST /api/graphql                      -> GraphQL (auth)
//   POST /mcp                              -> MCP (auth)
//   /<owner>/<repo>.git/info/refs          -> git smart-HTTP advertisement (auth)
//   /<owner>/<repo>.git/git-upload-pack    -> git fetch / ls-refs (auth)
//   /<owner>/<repo>.git/git-receive-pack   -> git push (auth)
//   anything else                          -> JSON 404
//
// Auth: the token is MAKEFUN_SHOP_TOKEN. When it is set, the Bearer token
// must match exactly; when it is unset (local runs), any non-empty Bearer
// token is accepted. A missing or wrong token is a JSON 401.
//
// Every reply carries a deterministic X-GitHub-Request-Id (`req-<n>`).
// The handler never throws: an unexpected failure is a JSON 500 and the
// server keeps serving.

import http from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  handleInfoRefs,
  handleReceivePack,
  handleUploadPack,
  type GitService,
} from './gitproto.ts';

const MAX_JSON_BODY_BYTES = 16 * 1024 * 1024;
const MAX_GIT_BODY_BYTES = 128 * 1024 * 1024;

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

export function createApp(): http.Server {
  const forge = new Forge();
  const expectedToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  function isAuthorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return false;
    const token = header.slice('Bearer '.length);
    if (token === '') return false;
    if (expectedToken === '') return true;
    return token === expectedToken;
  }

  function send(
    res: http.ServerResponse,
    status: number,
    contentType: string | null,
    body: Buffer | null,
    extraHeaders: Record<string, string> = {},
  ): void {
    requestCounter += 1;
    const headers: Record<string, string> = {
      'X-GitHub-Request-Id': `req-${requestCounter}`,
      ...extraHeaders,
    };
    if (contentType !== null) headers['Content-Type'] = contentType;
    if (body !== null) headers['Content-Length'] = String(body.length);
    res.writeHead(status, headers);
    res.end(body ?? undefined);
  }

  function sendJson(res: http.ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
    send(res, status, 'application/json', Buffer.from(JSON.stringify(value), 'utf8'), extraHeaders);
  }

  function readBody(req: http.IncomingMessage, maxBytes: number): Promise<{ body: Buffer; tooLarge: boolean }> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let total = 0;
      let tooLarge = false;
      req.on('data', (chunk: Buffer) => {
        if (tooLarge) return;
        total += chunk.length;
        if (total > maxBytes) {
          tooLarge = true;
          chunks.length = 0;
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => resolve({ body: Buffer.concat(chunks), tooLarge }));
      req.on('error', reject);
    });
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      let path: string;
      try {
        path = decodeURIComponent(url.pathname);
      } catch {
        sendJson(res, 400, { message: 'Bad Request: malformed path' });
        return;
      }
      const method = req.method ?? 'GET';
      const host = req.headers.host ?? 'localhost';

      // The boot probe: no auth, always 200.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      // --- REST v3 ---
      if (path === '/api/v3/' || path === '/api/v3' || path.startsWith('/api/v3/')) {
        const open = method === 'GET' && (path === '/api/v3/' || path === '/api/v3' || path === '/api/v3/meta');
        if (!open && !isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
        let json: unknown;
        let jsonError = false;
        if (needsBody) {
          const { body, tooLarge } = await readBody(req, MAX_JSON_BODY_BYTES);
          if (tooLarge) {
            sendJson(res, 413, { message: 'Request body too large' });
            return;
          }
          if (body.length > 0) {
            try {
              json = JSON.parse(body.toString('utf8')) as unknown;
            } catch {
              jsonError = true;
            }
          }
        }
        const response = handleRest(forge, { method, path, query: url.searchParams, json, jsonError, host });
        if (response.empty === true) {
          send(res, response.status, null, null, response.headers ?? {});
        } else {
          sendJson(res, response.status, response.body ?? null, response.headers ?? {});
        }
        return;
      }

      // --- GraphQL ---
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const { body, tooLarge } = await readBody(req, MAX_JSON_BODY_BYTES);
        if (tooLarge) {
          sendJson(res, 413, { message: 'Request body too large' });
          return;
        }
        let json: unknown;
        let jsonError = false;
        if (body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            jsonError = true;
          }
        }
        const response = handleGraphQL(forge, json, jsonError);
        sendJson(res, response.status, response.body);
        return;
      }

      // --- MCP ---
      if (path === '/mcp') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const { body, tooLarge } = await readBody(req, MAX_JSON_BODY_BYTES);
        if (tooLarge) {
          sendJson(res, 413, { message: 'Request body too large' });
          return;
        }
        let json: unknown;
        let jsonError = false;
        if (body.length > 0) {
          try {
            json = JSON.parse(body.toString('utf8')) as unknown;
          } catch {
            jsonError = true;
          }
        }
        const response = handleMcp(forge, json, jsonError);
        if (response.body === null) {
          send(res, response.status, null, null);
        } else {
          sendJson(res, response.status, response.body);
        }
        return;
      }

      // --- git smart HTTP ---
      const gitMatch = GIT_ROUTE.exec(path);
      if (gitMatch !== null) {
        if (!isAuthorized(req)) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const owner = gitMatch[1] as string;
        const repoName = gitMatch[2] as string;
        const endpoint = gitMatch[3] as string;
        const repo = forge.getRepo(owner, repoName);
        const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
        if (method === 'GET' && endpoint === 'info/refs') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(res, 400, { message: 'Bad Request: unknown service' });
            return;
          }
          const response = handleInfoRefs(forge, repo, service as GitService, wantsV2);
          send(res, response.status, response.contentType, response.body);
          return;
        }
        if (method === 'POST' && endpoint === 'git-upload-pack') {
          const { body, tooLarge } = await readBody(req, MAX_GIT_BODY_BYTES);
          if (tooLarge) {
            sendJson(res, 413, { message: 'Request body too large' });
            return;
          }
          const response = handleUploadPack(forge, repo, body, wantsV2);
          send(res, response.status, response.contentType, response.body);
          return;
        }
        if (method === 'POST' && endpoint === 'git-receive-pack') {
          const { body, tooLarge } = await readBody(req, MAX_GIT_BODY_BYTES);
          if (tooLarge) {
            sendJson(res, 413, { message: 'Request body too large' });
            return;
          }
          const response = handleReceivePack(forge, repo, body);
          send(res, response.status, response.contentType, response.body);
          return;
        }
        sendJson(res, 404, { message: 'Not Found' });
        return;
      }

      sendJson(res, 404, { message: 'Not Found' });
    } catch (err) {
      process.stderr.write(`[forge] request failed: ${err instanceof Error ? err.message : String(err)}\n`);
      if (!res.headersSent) {
        try {
          sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          res.destroy();
        }
      } else {
        res.destroy();
      }
    }
  }

  const server = http.createServer((req, res) => {
    void handle(req, res);
  });
  server.on('clientError', (err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\n\r\n{"message":"Bad Request"}\n');
  });
  return server;
}
