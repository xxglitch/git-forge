// rest.ts: the REST v3 API.
//
// Every reply is JSON and carries `X-GitHub-Request-Id` (added by app.ts).
// Errors carry a string `message`. Unknown routes are JSON 404s, malformed
// JSON bodies are 400s, duplicate names are 422s with a message containing
// "already exists", stale content shas are 409s, and unmergeable pull
// requests are 405s — matching what the suite's client expects.
//
// Auth is enforced by app.ts before routing; /api/v3/ and /api/v3/meta are
// the only open endpoints.

import {
  Forge,
  ForgeError,
  HEAD_REF,
  commitJson,
  commentJson,
  diffTrees,
  issueJson,
  labelJson,
  pullJson,
  repoJson,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';
import { IDENTITY } from './scenario.ts';

export interface RestContext {
  method: string;
  /** Decoded path, no query string. */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, or undefined when the request had no body. */
  json: unknown;
  /** True when a body was present but was not valid JSON. */
  jsonError: boolean;
  /** The request Host header, for absolute pagination URLs. */
  host: string;
}

export interface RestResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** True for 204-style replies with no body at all. */
  empty?: boolean;
}

const json = (status: number, body: unknown, headers?: Record<string, string>): RestResponse => ({
  status,
  body,
  headers,
});
const err = (status: number, message: string): RestResponse => json(status, { message });
const notFound = (): RestResponse => err(404, 'Not Found');
const unprocessable = (message: string): RestResponse => err(422, message);
const conflict = (message: string): RestResponse => err(409, message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyOf(ctx: RestContext): Record<string, unknown> | null {
  if (ctx.jsonError) return null;
  return isRecord(ctx.json) ? ctx.json : {};
}

function parseIntParam(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** A store error turned into the REST reply it asks for, or null. */
function asRestError(e: unknown): RestResponse | null {
  if (e instanceof ForgeError) return err(e.status, e.message);
  return null;
}

/** Slice a list into one page and build the Link header for the next page. */
function paginate<T>(
  items: readonly T[],
  ctx: RestContext,
  path: string,
): { page: T[]; headers: Record<string, string> } {
  const perPage = Math.min(parseIntParam(ctx.query.get('per_page'), 30), 100);
  const page = parseIntParam(ctx.query.get('page'), 1);
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const base = `http://${ctx.host}${path}`;
  const links: string[] = [];
  if (page < totalPages) links.push(`<${base}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (totalPages > 1) links.push(`<${base}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  return { page: slice, headers: links.length > 0 ? { Link: links.join(', ') } : {} };
}

function viewerJson(forge: Forge): Record<string, unknown> {
  return {
    login: forge.viewerLogin,
    id: forge.viewerId,
    type: 'User',
    name: IDENTITY.viewer.name,
    email: IDENTITY.viewer.email,
  };
}

function issuesOf(repo: Repo, state: string): Issue[] {
  const issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
  if (state === 'all') return issues;
  return issues.filter((issue) => issue.state === state);
}

function pullsOf(repo: Repo, state: string): PullRequest[] {
  const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
  if (state === 'all') return pulls;
  return pulls.filter((pull) => pull.state === state);
}

// ---------------------------------------------------------------------------------------------
// repos
// ---------------------------------------------------------------------------------------------

function createRepo(forge: Forge, ctx: RestContext): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  const name = typeof body.name === 'string' ? body.name : '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return unprocessable('Validation Failed: name is invalid');
  try {
    const repo = forge.createRepo(name, {
      description: typeof body.description === 'string' ? body.description : '',
      private: body.private === true,
    });
    return json(201, repoJson(forge, repo));
  } catch (e) {
    return asRestError(e) ?? err(500, 'Internal Server Error');
  }
}

function listOwnRepos(forge: Forge, ctx: RestContext): RestResponse {
  const repos = forge.listRepos();
  const { page, headers } = paginate(repos, ctx, '/api/v3/user/repos');
  return json(200, page.map((repo) => repoJson(forge, repo)), headers);
}

function getRepo(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  return json(200, repoJson(forge, repo));
}

function patchRepo(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  if (typeof body.description === 'string') repo.description = body.description;
  if (typeof body.private === 'boolean') repo.privateFlag = body.private;
  return json(200, repoJson(forge, repo));
}

function deleteRepo(forge: Forge, ctx: RestContext, owner: string, name: string): RestResponse {
  if (!forge.deleteRepo(owner, name)) return notFound();
  return { status: 204, empty: true };
}

// ---------------------------------------------------------------------------------------------
// refs and branches
// ---------------------------------------------------------------------------------------------

function createRef(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  const ref = typeof body.ref === 'string' ? body.ref : '';
  const sha = typeof body.sha === 'string' ? body.sha : '';
  if (!ref.startsWith('refs/') || ref.length < 6) return unprocessable('Validation Failed: ref is invalid');
  if (!/^[0-9a-f]{40}$/.test(sha)) return unprocessable('Validation Failed: sha is invalid');
  if (!repo.objects.has(sha)) return unprocessable('Object does not exist');
  if (repo.refs.has(ref)) return unprocessable('Reference already exists');
  repo.refs.set(ref, sha);
  return json(201, { ref, object: { sha } });
}

function getRef(forge: Forge, ctx: RestContext, repo: Repo, ref: string): RestResponse {
  const sha = repo.refs.get(ref);
  if (sha === undefined) return notFound();
  return json(200, { ref, object: { sha } });
}

function listBranches(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  const branches = [...repo.refs.keys()]
    .filter((name) => name.startsWith('refs/heads/'))
    .sort()
    .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) as string } }));
  return json(200, branches);
}

function getBranch(forge: Forge, ctx: RestContext, repo: Repo, branch: string): RestResponse {
  const sha = repo.refs.get(`refs/heads/${branch}`);
  if (sha === undefined) return notFound();
  return json(200, { name: branch, commit: { sha } });
}

// ---------------------------------------------------------------------------------------------
// commits
// ---------------------------------------------------------------------------------------------

function listCommits(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  const ref = ctx.query.get('sha');
  const tip = ref === null ? forge.defaultTip(repo) : forge.resolveRef(repo, ref);
  if (tip === null) return notFound();
  const commits = forge.commitHistory(repo, tip);
  const out: Array<Record<string, unknown>> = [];
  for (const sha of commits) {
    const rendered = commitJson(repo, sha);
    if (rendered !== null) out.push(rendered);
  }
  return json(200, out);
}

// ---------------------------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------------------------

function resolveRef(forge: Forge, repo: Repo, ref: string | null): string | null {
  if (ref === null || ref === '') return forge.defaultTip(repo);
  return forge.resolveRef(repo, ref);
}

function getContents(forge: Forge, ctx: RestContext, repo: Repo, path: string): RestResponse {
  const commitOid = resolveRef(forge, repo, ctx.query.get('ref'));
  if (commitOid === null) return notFound();
  const treeOid = forge.commitOf(repo, commitOid)?.tree;
  if (treeOid === undefined) return notFound();
  if (path === '') {
    const entries = forge.treeEntries(repo, treeOid) ?? [];
    return json(200, entries.map((entry) => ({
      type: entry.mode === '40000' ? 'dir' : 'file',
      name: entry.name,
      path: entry.name,
      sha: entry.oid,
    })));
  }
  const entry = forge.lookupPath(repo, treeOid, path);
  if (entry === null) return notFound();
  if (entry.type === 'dir') {
    const entries = forge.treeEntries(repo, entry.oid) ?? [];
    return json(200, entries.map((child) => ({
      type: child.mode === '40000' ? 'dir' : 'file',
      name: child.name,
      path: `${path}/${child.name}`,
      sha: child.oid,
    })));
  }
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined || blob.type !== 'blob') return notFound();
  return json(200, {
    type: 'file',
    encoding: 'base64',
    content: blob.data.toString('base64'),
    sha: entry.oid,
    size: blob.data.length,
    name: path.split('/').pop() as string,
    path,
  });
}

function putContents(forge: Forge, ctx: RestContext, repo: Repo, path: string): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  if (typeof body.content !== 'string') return unprocessable('Validation Failed: content is required');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : '';
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const bytes = Buffer.from(body.content, 'base64');
  // The store does not check shas: validate the update against the branch tip first.
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(HEAD_REF);
  const treeOid = tip === undefined ? undefined : forge.commitOf(repo, tip)?.tree;
  const existing = treeOid === undefined ? null : forge.lookupPath(repo, treeOid, path);
  if (existing !== null && existing.type === 'file') {
    if (sha === undefined) return unprocessable('sha is required when updating an existing file');
    if (sha !== existing.oid) return conflict('sha does not match the current blob');
  }
  let result;
  try {
    result = forge.contentsCommit(repo, branch, path, bytes, message);
  } catch (e) {
    return asRestError(e) ?? err(500, 'Internal Server Error');
  }
  return json(result.created ? 201 : 200, {
    content: { sha: result.blobSha, encoding: 'base64', name: path.split('/').pop() as string, path, size: bytes.length },
    commit: { sha: result.commitSha, message },
  });
}

function deleteContents(forge: Forge, ctx: RestContext, repo: Repo, path: string): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
  const message = typeof body.message === 'string' ? body.message : '';
  const sha = typeof body.sha === 'string' ? body.sha : undefined;
  const branchTip = repo.refs.get(`refs/heads/${branch}`);
  if (branchTip === undefined) return notFound();
  const treeOid = forge.commitOf(repo, branchTip)?.tree;
  const existing = treeOid === undefined ? null : forge.lookupPath(repo, treeOid, path);
  if (existing === null || existing.type !== 'file') return notFound();
  if (sha === undefined) return unprocessable('sha is required when deleting a file');
  if (sha !== existing.oid) return conflict('sha does not match the current blob');
  let result;
  try {
    result = forge.contentsCommit(repo, branch, path, null, message);
  } catch (e) {
    return asRestError(e) ?? err(500, 'Internal Server Error');
  }
  return json(200, { commit: { sha: result.commitSha, message } });
}

// ---------------------------------------------------------------------------------------------
// labels, issues, comments
// ---------------------------------------------------------------------------------------------

function createLabel(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  const name = typeof body.name === 'string' ? body.name : '';
  const color = typeof body.color === 'string' ? body.color : '000000';
  if (name === '') return unprocessable('Validation Failed: name is required');
  try {
    const label = forge.createLabel(repo, name, color);
    return json(201, labelJson(label));
  } catch (e) {
    return asRestError(e) ?? err(500, 'Internal Server Error');
  }
}

function listLabels(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  return json(200, [...repo.labels.values()].map(labelJson));
}

function createIssue(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  const title = typeof body.title === 'string' ? body.title : '';
  if (title === '') return unprocessable('Validation Failed: title is required');
  const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  try {
    const issue = forge.createIssue(repo, title, typeof body.body === 'string' ? body.body : '', labels);
    return json(201, issueJson(forge, repo, issue));
  } catch (e) {
    return asRestError(e) ?? err(500, 'Internal Server Error');
  }
}

function listIssues(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  const state = ctx.query.get('state') ?? 'open';
  let issues = issuesOf(repo, state === 'all' ? 'all' : state === 'closed' ? 'closed' : 'open');
  // issuesOf returns number-ascending (creation order); GitHub's default is
  // newest first, so reverse unless asc was asked for.
  const direction = ctx.query.get('direction') ?? 'desc';
  if (direction !== 'asc') issues = [...issues].reverse();
  const { page, headers } = paginate(issues, ctx, ctx.path);
  return json(200, page.map((issue) => issueJson(forge, repo, issue)), headers);
}

function getIssue(forge: Forge, ctx: RestContext, repo: Repo, number: number): RestResponse {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  return json(200, issueJson(forge, repo, issue));
}

function patchIssue(forge: Forge, ctx: RestContext, repo: Repo, number: number): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  if (typeof body.title === 'string') issue.title = body.title;
  if (typeof body.body === 'string') issue.body = body.body;
  if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
  return json(200, issueJson(forge, repo, issue));
}

function createComment(forge: Forge, ctx: RestContext, repo: Repo, number: number): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  const commentBody = typeof body.body === 'string' ? body.body : '';
  try {
    const comment = forge.addComment(repo, issue, commentBody);
    return json(201, commentJson(forge, repo, issue, comment));
  } catch (e) {
    return asRestError(e) ?? err(500, 'Internal Server Error');
  }
}

function listComments(forge: Forge, ctx: RestContext, repo: Repo, number: number): RestResponse {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  return json(200, issue.comments.map((comment) => commentJson(forge, repo, issue, comment)));
}

// ---------------------------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------------------------

function createPull(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  const title = typeof body.title === 'string' ? body.title : '';
  const head = typeof body.head === 'string' ? body.head : '';
  const base = typeof body.base === 'string' ? body.base : '';
  if (title === '' || head === '' || base === '') {
    return unprocessable('Validation Failed: title, head and base are required');
  }
  try {
    const pr = forge.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
    return json(201, pullJson(forge, repo, pr));
  } catch (e) {
    return asRestError(e) ?? err(500, 'Internal Server Error');
  }
}

function listPulls(forge: Forge, ctx: RestContext, repo: Repo): RestResponse {
  const state = ctx.query.get('state') ?? 'open';
  const pulls = pullsOf(repo, state === 'all' ? 'all' : state === 'closed' ? 'closed' : 'open');
  const { page, headers } = paginate([...pulls].reverse(), ctx, ctx.path);
  return json(200, page.map((pr) => pullJson(forge, repo, pr)), headers);
}

function getPull(forge: Forge, ctx: RestContext, repo: Repo, number: number): RestResponse {
  const pr = repo.pulls.get(number);
  if (pr === undefined) return notFound();
  return json(200, pullJson(forge, repo, pr));
}

function listPullFiles(forge: Forge, ctx: RestContext, repo: Repo, number: number): RestResponse {
  const pr = repo.pulls.get(number);
  if (pr === undefined) return notFound();
  const mergeBase = forge.pullMergeBase(repo, pr);
  const tips = forge.pullTips(repo, pr);
  const baseTree = mergeBase === null ? null : forge.commitOf(repo, mergeBase)?.tree ?? null;
  const headTree = tips.head === null ? null : forge.commitOf(repo, tips.head)?.tree ?? null;
  return json(200, diffTrees(forge, repo, baseTree, headTree));
}

function mergePull(forge: Forge, ctx: RestContext, repo: Repo, number: number): RestResponse {
  const body = bodyOf(ctx);
  if (body === null) return err(400, 'Problems parsing JSON');
  const pr = repo.pulls.get(number);
  if (pr === undefined) return notFound();
  try {
    const result = forge.mergePull(repo, pr);
    return json(200, { merged: true, sha: result.sha, message: 'Pull Request successfully merged' });
  } catch (e) {
    return asRestError(e) ?? err(500, 'Internal Server Error');
  }
}

// ---------------------------------------------------------------------------------------------
// router
// ---------------------------------------------------------------------------------------------

export function handleRest(forge: Forge, ctx: RestContext): RestResponse {
  let path = ctx.path;
  if (path !== '/api/v3/' && path.endsWith('/')) path = path.slice(0, -1);
  const { method } = ctx;

  if (path === '/api/v3/' || path === '/api/v3') {
    if (method !== 'GET') return notFound();
    return json(200, {
      current_user_url: `http://${ctx.host}/api/v3/user`,
      repository_url: `http://${ctx.host}/api/v3/repos/{owner}/{repo}`,
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') return notFound();
    return json(200, { installed_version: '1.0.0' });
  }
  if (path === '/api/v3/user') {
    if (method !== 'GET') return notFound();
    return json(200, viewerJson(forge));
  }
  if (path === '/api/v3/user/repos') {
    if (method === 'POST') return createRepo(forge, ctx);
    if (method === 'GET') return listOwnRepos(forge, ctx);
    return notFound();
  }

  const repoMatch = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (repoMatch === null) return notFound();
  const owner = decodeURIComponent(repoMatch[1] as string);
  const repoName = decodeURIComponent(repoMatch[2] as string);
  const rest = repoMatch[3] ?? '';
  const repo = forge.getRepo(owner, repoName);
  if (repo === null) return notFound();

  const segments = rest === '' ? [] : rest.split('/').map((segment) => decodeURIComponent(segment));

  // /repos/{owner}/{repo}
  if (segments.length === 0) {
    if (method === 'GET') return getRepo(forge, ctx, repo);
    if (method === 'PATCH') return patchRepo(forge, ctx, repo);
    if (method === 'DELETE') return deleteRepo(forge, ctx, owner, repoName);
    return notFound();
  }

  const head = segments[0] as string;
  if (head === 'git' && segments[1] === 'refs') {
    if (method === 'POST' && segments.length === 2) return createRef(forge, ctx, repo);
    if (method === 'GET' && segments.length > 2) {
      return getRef(forge, ctx, repo, `refs/${segments.slice(2).join('/')}`);
    }
    return notFound();
  }
  if (head === 'branches') {
    if (method === 'GET' && segments.length === 1) return listBranches(forge, ctx, repo);
    if (method === 'GET' && segments.length > 1) return getBranch(forge, ctx, repo, segments.slice(1).join('/'));
    return notFound();
  }
  if (head === 'commits') {
    if (method === 'GET' && segments.length === 1) return listCommits(forge, ctx, repo);
    return notFound();
  }
  if (head === 'contents') {
    const filePath = segments.slice(1).join('/');
    if (method === 'GET') return getContents(forge, ctx, repo, filePath);
    if (method === 'PUT') return putContents(forge, ctx, repo, filePath);
    if (method === 'DELETE') return deleteContents(forge, ctx, repo, filePath);
    return notFound();
  }
  if (head === 'labels') {
    if (method === 'POST' && segments.length === 1) return createLabel(forge, ctx, repo);
    if (method === 'GET' && segments.length === 1) return listLabels(forge, ctx, repo);
    return notFound();
  }
  if (head === 'issues') {
    if (segments.length === 1) {
      if (method === 'POST') return createIssue(forge, ctx, repo);
      if (method === 'GET') return listIssues(forge, ctx, repo);
      return notFound();
    }
    const number = Number(segments[1]);
    if (!Number.isInteger(number) || number < 1) return notFound();
    if (segments.length === 2) {
      if (method === 'GET') return getIssue(forge, ctx, repo, number);
      if (method === 'PATCH') return patchIssue(forge, ctx, repo, number);
      return notFound();
    }
    if (segments.length === 3 && segments[2] === 'comments') {
      if (method === 'POST') return createComment(forge, ctx, repo, number);
      if (method === 'GET') return listComments(forge, ctx, repo, number);
    }
    return notFound();
  }
  if (head === 'pulls') {
    if (segments.length === 1) {
      if (method === 'POST') return createPull(forge, ctx, repo);
      if (method === 'GET') return listPulls(forge, ctx, repo);
      return notFound();
    }
    const number = Number(segments[1]);
    if (!Number.isInteger(number) || number < 1) return notFound();
    if (segments.length === 2) {
      if (method === 'GET') return getPull(forge, ctx, repo, number);
      return notFound();
    }
    if (segments.length === 3 && segments[2] === 'files') {
      if (method === 'GET') return listPullFiles(forge, ctx, repo, number);
      return notFound();
    }
    if (segments.length === 3 && segments[2] === 'merge') {
      if (method === 'PUT') return mergePull(forge, ctx, repo, number);
      return notFound();
    }
    return notFound();
  }
  return notFound();
}

export type { Issue, PullRequest };
