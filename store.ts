// store.ts: the forge's own store.
//
// One process, one store, all in memory: repositories with their git objects
// and refs, issues, pull requests, labels and comments. Nothing is read from
// disk and nothing leaves the process.
//
// Determinism: every timestamp the store stamps comes from MAKEFUN_TRIAL_NOW
// (the instance's opening time, the same on a live pass and its replay) or,
// when it is unset, from the scenario's fixed epoch. Every id is a counter.
// Nothing here reads a clock or a random source.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type GitObjectType,
  type TreeEntry,
} from './gitobj.ts';
import { IDENTITY } from './scenario.ts';

/** The scenario's day one, 2025-01-01T00:00:00Z: the fallback "now". */
export const FALLBACK_EPOCH_SEC = 1_735_689_600;

/** The trial's fixed "now" as epoch seconds. */
function trialNowEpoch(): number {
  const raw = (process.env.MAKEFUN_TRIAL_NOW ?? '').trim();
  if (raw === '') return FALLBACK_EPOCH_SEC;
  const numeric = Number(raw);
  if (Number.isFinite(numeric) && numeric > 0) {
    // A bare number is epoch seconds, unless it is clearly milliseconds.
    return numeric > 1e12 ? Math.floor(numeric / 1000) : Math.floor(numeric);
  }
  const parsed = Date.parse(raw);
  if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  return FALLBACK_EPOCH_SEC;
}

/** The one timestamp this process stamps on anything it creates. */
export const NOW_EPOCH_SEC: number = trialNowEpoch();
export const NOW_ISO: string = new Date(NOW_EPOCH_SEC * 1000).toISOString();

/** The identity server-created commits carry. */
export const SERVER_IDENTITY = `${IDENTITY.viewer.name} <${IDENTITY.viewer.email}>`;

/** The default branch every repository is born with. */
export const DEFAULT_BRANCH = 'main';
export const HEAD_REF = `refs/heads/${DEFAULT_BRANCH}`;

// ---------------------------------------------------------------------------------------------
// global (Relay) ids: opaque, deterministic, stable across reads
// ---------------------------------------------------------------------------------------------

function gid(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64url');
}

function ungid(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// the records
// ---------------------------------------------------------------------------------------------

export interface Label {
  readonly id: number;
  readonly name: string;
  readonly color: string;
}

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly userLogin: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  readonly comments: Comment[];
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  readonly headSha: string;
  readonly baseSha: string;
  readonly userLogin: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  privateFlag: boolean;
  description: string;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** All git objects, by id. */
  readonly objects: Map<string, GitObject>;
  /** Full ref names (refs/heads/..., refs/tags/...) to object ids. */
  readonly refs: Map<string, string>;
  /** Labels by name. */
  readonly labels: Map<string, Label>;
  /** Issues and pull requests share one per-repo number sequence, as GitHub's do. */
  nextNumber: number;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  /** Parsed-commit cache: oid -> {tree, parents}. Grows with the repo; bounded by it. */
  readonly commitCache: Map<string, { tree: string; parents: string[] }>;
}

export class ForgeError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ForgeError';
    this.status = status;
  }
}

// ---------------------------------------------------------------------------------------------
// the forge
// ---------------------------------------------------------------------------------------------

export class Forge {
  readonly viewerLogin: string = IDENTITY.viewer.login;
  readonly viewerId: number = IDENTITY.viewer.id;
  /** Repositories by `owner/name`. */
  private readonly repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private nextLabelId = 1;

  // -- repositories -------------------------------------------------------------

  createRepo(name: string, options: { private?: boolean; description?: string }): Repo {
    if (typeof name !== 'string' || name === '' || name.includes('/')) {
      throw new ForgeError(422, 'name is not a valid repository name');
    }
    const key = `${this.viewerLogin}/${name}`;
    if (this.repos.has(key)) throw new ForgeError(422, 'name already exists on this account');
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: this.viewerLogin,
      name,
      privateFlag: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: DEFAULT_BRANCH,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      nextNumber: 1,
      issues: new Map(),
      pulls: new Map(),
      commitCache: new Map(),
    };
    this.repos.set(key, repo);
    return repo;
  }

  /** A repository by owner and name; null when the owner is not the viewer or it is absent. */
  getRepo(owner: string, name: string): Repo | null {
    if (owner !== this.viewerLogin) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== this.viewerLogin) return false;
    return this.repos.delete(`${owner}/${name}`);
  }

  /** Every repository the viewer owns, in creation order. */
  listRepos(): Repo[] {
    return [...this.repos.values()];
  }

  repoGlobalId(repo: Repo): string {
    return gid('repo', `${repo.owner}/${repo.name}`);
  }

  issueGlobalId(repo: Repo, issue: Issue): string {
    return gid('issue', `${repo.owner}/${repo.name}#${issue.number}`);
  }

  pullGlobalId(repo: Repo, pull: PullRequest): string {
    return gid('pr', `${repo.owner}/${repo.name}#${pull.number}`);
  }

  commentGlobalId(repo: Repo, issue: Issue, comment: Comment): string {
    return gid('comment', `${repo.owner}/${repo.name}#${issue.number}:${comment.id}`);
  }

  /** Resolve a global id to what it names, or null. */
  resolveGlobalId(id: string): { kind: 'repo'; repo: Repo } | { kind: 'issue'; repo: Repo; issue: Issue } | { kind: 'pr'; repo: Repo; pull: PullRequest } | null {
    const parsed = ungid(id);
    if (parsed === null) return null;
    if (parsed.kind === 'repo') {
      const [owner, name] = parsed.key.split('/', 2);
      if (owner === undefined || name === undefined) return null;
      const repo = this.getRepo(owner, name);
      return repo === null ? null : { kind: 'repo', repo };
    }
    if (parsed.kind === 'issue' || parsed.kind === 'pr') {
      const hash = parsed.key.indexOf('#');
      if (hash < 0) return null;
      const fullName = parsed.key.slice(0, hash);
      const number = Number(parsed.key.slice(hash + 1));
      if (!Number.isInteger(number) || number < 1) return null;
      const [owner, name] = fullName.split('/', 2);
      if (owner === undefined || name === undefined) return null;
      const repo = this.getRepo(owner, name);
      if (repo === null) return null;
      if (parsed.kind === 'issue') {
        const issue = repo.issues.get(number);
        return issue === undefined ? null : { kind: 'issue', repo, issue };
      }
      const pull = repo.pulls.get(number);
      return pull === undefined ? null : { kind: 'pr', repo, pull };
    }
    return null;
  }

  // -- git objects --------------------------------------------------------------

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** A commit's tree and parents, cached. */
  commitOf(repo: Repo, oid: string): { tree: string; parents: string[] } | null {
    const cached = repo.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    let view;
    try {
      view = parseCommit(object.data);
    } catch {
      return null;
    }
    const entry = { tree: view.tree, parents: view.parents };
    repo.commitCache.set(oid, entry);
    return entry;
  }

  /** Whether `ancestor` is an ancestor of (or equal to) `descendant`. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    const seen = new Set<string>();
    const queue = [descendant];
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (parent === ancestor) return true;
        queue.push(parent);
      }
    }
    return false;
  }

  /** The merge-base of two commits: the first common ancestor found walking from `a`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    if (a === b) return a;
    const aAncestors = new Set<string>();
    const queueA = [a];
    while (queueA.length > 0) {
      const oid = queueA.pop() as string;
      if (aAncestors.has(oid)) continue;
      aAncestors.add(oid);
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) queueA.push(parent);
    }
    const seenB = new Set<string>();
    const queueB = [b];
    while (queueB.length > 0) {
      const oid = queueB.shift() as string;
      if (seenB.has(oid)) continue;
      seenB.add(oid);
      if (aAncestors.has(oid)) return oid;
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) queueB.push(parent);
    }
    return null;
  }

  /**
   * Every object reachable from `roots`. With `shallowCut`, a commit in the
   * set contributes itself and its tree but not its parents: the have-closure
   * of a shallow client, which holds the boundary commit but not its history.
   */
  collectReachable(
    repo: Repo,
    roots: Iterable<string>,
    options: { shallowCut?: ReadonlySet<string> } = {},
  ): Set<string> {
    const seen = new Set<string>();
    const queue: string[] = [];
    for (const root of roots) if (isObjectId(root)) queue.push(root);
    while (queue.length > 0) {
      const oid = queue.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = this.commitOf(repo, oid);
        if (commit === null) continue;
        queue.push(commit.tree);
        if (options.shallowCut?.has(oid) !== true) {
          for (const parent of commit.parents) queue.push(parent);
        }
      } else if (object.type === 'tag') {
        try {
          queue.push(parseTag(object.data).object);
        } catch {
          // A malformed tag names nothing reachable.
        }
      } else if (object.type === 'tree') {
        let entries: TreeEntry[];
        try {
          entries = parseTree(object.data);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.mode === '160000') continue; // a gitlink names a commit the repo does not hold
          queue.push(entry.oid);
        }
      }
    }
    return seen;
  }

  /**
   * The commits within `depth` generations of `wants` (want = depth 1), and
   * the boundary: the commits at exactly `depth`, which become shallow.
   * With no depth limit every ancestor is included and there is no boundary.
   */
  depthWalk(
    repo: Repo,
    wants: readonly string[],
    depth: number | null,
  ): { commits: Set<string>; boundary: Set<string> } {
    const commits = new Set<string>();
    const boundary = new Set<string>();
    const queue: Array<{ oid: string; at: number }> = wants.map((oid) => ({ oid, at: 1 }));
    const seenDepth = new Map<string, number>();
    while (queue.length > 0) {
      const { oid, at } = queue.shift() as { oid: string; at: number };
      const known = seenDepth.get(oid);
      if (known !== undefined && known <= at) continue;
      seenDepth.set(oid, at);
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      commits.add(oid);
      if (depth !== null && at >= depth) {
        boundary.add(oid);
        continue;
      }
      for (const parent of commit.parents) queue.push({ oid: parent, at: at + 1 });
    }
    return { commits, boundary };
  }

  /** A commit's history, newest first (depth-first from the tip). */
  commitHistory(repo: Repo, tip: string, limit = 10_000): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0 && out.length < limit) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const commit = this.commitOf(repo, oid);
      if (commit === null) continue;
      out.push(oid);
      for (let i = commit.parents.length - 1; i >= 0; i -= 1) stack.push(commit.parents[i] as string);
    }
    return out;
  }

  // -- trees and files ----------------------------------------------------------

  /** A tree flattened to path -> {oid, mode}, recursively. */
  flattenTree(repo: Repo, treeOid: string): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The blob (or tree) a tree holds at `path`, or null. */
  lookupPath(repo: Repo, treeOid: string, path: string): { oid: string; mode: string; type: 'file' | 'dir' } | null {
    const segments = path.split('/').filter((segment) => segment !== '');
    let current = treeOid;
    for (let i = 0; i < segments.length; i += 1) {
      const object = repo.objects.get(current);
      if (object === undefined || object.type !== 'tree') return null;
      let entries: TreeEntry[];
      try {
        entries = parseTree(object.data);
      } catch {
        return null;
      }
      const entry = entries.find((candidate) => candidate.name === segments[i]);
      if (entry === undefined) return null;
      if (i === segments.length - 1) {
        return entry.mode === '40000'
          ? { oid: entry.oid, mode: entry.mode, type: 'dir' }
          : { oid: entry.oid, mode: entry.mode, type: 'file' };
      }
      if (entry.mode !== '40000') return null;
      current = entry.oid;
    }
    return { oid: treeOid, mode: '40000', type: 'dir' };
  }

  /** The entries of a tree object, or null when it is not a tree. */
  treeEntries(repo: Repo, treeOid: string): TreeEntry[] | null {
    const object = repo.objects.get(treeOid);
    if (object === undefined || object.type !== 'tree') return null;
    try {
      return parseTree(object.data);
    } catch {
      return null;
    }
  }

  /** A tree with `segments` set to `blobOid` (or removed when null), other entries kept. */
  private treeWithPath(repo: Repo, entries: readonly TreeEntry[], segments: readonly string[], blobOid: string | null): string {
    const head = segments[0] as string;
    const rest = segments.slice(1);
    const kept = entries.filter((entry) => entry.name !== head);
    if (rest.length === 0) {
      if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
    } else {
      const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
      const childEntries = existing === undefined ? [] : (this.treeEntries(repo, existing.oid) ?? []);
      const childOid = this.treeWithPath(repo, childEntries, rest, blobOid);
      const childObject = repo.objects.get(childOid);
      // Keep the directory only when it still holds entries.
      const childList = childObject !== undefined && childObject.type === 'tree' ? parseTree(childObject.data) : [];
      if (childList.length > 0) kept.push({ mode: '40000', name: head, oid: childOid });
    }
    return this.putObject(repo, 'tree', buildTree(kept));
  }

  /** A tree built from a flat path -> blob map, storing every intermediate tree. */
  treeFromFiles(repo: Repo, files: ReadonlyMap<string, string>): string {
    interface Node {
      files: Map<string, string>;
      dirs: Map<string, Node>;
    }
    const make = (): Node => ({ files: new Map(), dirs: new Map() });
    const root = make();
    for (const [path, oid] of files) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i] as string;
        let child = node.dirs.get(name);
        if (child === undefined) {
          child = make();
          node.dirs.set(name, child);
        }
        node = child;
      }
      node.files.set(segments[segments.length - 1] as string, oid);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  // -- refs ---------------------------------------------------------------------

  /** A ref's tip, resolving HEAD to the default branch. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (ref === 'HEAD') return repo.refs.get(HEAD_REF) ?? null;
    if (ref.startsWith('refs/')) return repo.refs.get(ref) ?? null;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch !== undefined) return branch;
    const tag = repo.refs.get(`refs/tags/${ref}`);
    if (tag !== undefined) return tag;
    // A bare commit id is its own resolution.
    if (isObjectId(ref) && repo.objects.has(ref)) return ref;
    return null;
  }

  /** The default branch's tip, or null on an unborn repository. */
  defaultTip(repo: Repo): string | null {
    return repo.refs.get(HEAD_REF) ?? null;
  }

  // -- contents commits ---------------------------------------------------------

  /**
   * Write (or delete) a file through the contents API, creating a commit on
   * `branch`. A missing branch is created from the default branch's tip (or
   * from nothing on an unborn repository). Returns the commit and blob ids.
   */
  contentsCommit(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null,
    message: string,
  ): { commitSha: string; blobSha: string | null; created: boolean } {
    const refName = `refs/heads/${branch}`;
    let tip = repo.refs.get(refName);
    let branchExisted = tip !== undefined;
    if (!branchExisted) {
      tip = repo.refs.get(HEAD_REF);
      branchExisted = false;
    }
    const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.' && segment !== '..');
    if (segments.length === 0) throw new ForgeError(422, 'the file path is empty');
    const parentEntries = tip === undefined ? [] : this.treeEntries(repo, this.commitOf(repo, tip)?.tree ?? '') ?? [];
    const existed = tip !== undefined && this.lookupPath(repo, this.commitOf(repo, tip)?.tree ?? '', path) !== null;
    const blobSha = content === null ? null : this.putObject(repo, 'blob', content);
    const treeOid = this.treeWithPath(repo, parentEntries, segments, blobSha);
    const commitData = buildCommit({
      tree: treeOid,
      parents: tip === undefined ? [] : [tip],
      message: message.endsWith('\n') ? message : `${message}\n`,
      author: SERVER_IDENTITY,
      committer: SERVER_IDENTITY,
      timestamp: NOW_EPOCH_SEC,
    });
    const commitSha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitSha);
    return { commitSha, blobSha, created: !existed };
  }

  // -- labels -------------------------------------------------------------------

  createLabel(repo: Repo, name: string, color: string): Label {
    if (typeof name !== 'string' || name === '') throw new ForgeError(422, 'a label needs a name');
    const existing = repo.labels.get(name);
    if (existing !== undefined) throw new ForgeError(422, 'a label with that name already exists');
    const label: Label = { id: this.nextLabelId++, name, color: typeof color === 'string' && color !== '' ? color : 'ededed' };
    repo.labels.set(name, label);
    return label;
  }

  // -- issues -------------------------------------------------------------------

  createIssue(repo: Repo, title: string, body: string, labelNames: readonly string[]): Issue {
    if (typeof title !== 'string' || title === '') throw new ForgeError(422, 'an issue needs a title');
    const labels: Label[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label === undefined) throw new ForgeError(422, `unknown label "${name}"`);
      labels.push(label);
    }
    const issue: Issue = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      labels,
      comments: [],
      userLogin: this.viewerLogin,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    if (typeof body !== 'string' || body === '') throw new ForgeError(422, 'a comment needs a body');
    const comment: Comment = { id: this.nextCommentId++, body, userLogin: this.viewerLogin, createdAt: NOW_ISO };
    issue.comments.push(comment);
    return comment;
  }

  // -- pull requests ------------------------------------------------------------

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string): PullRequest {
    if (typeof title !== 'string' || title === '') throw new ForgeError(422, 'a pull request needs a title');
    const headSha = repo.refs.get(`refs/heads/${headRef}`);
    const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
    if (headSha === undefined) throw new ForgeError(422, `the head branch "${headRef}" does not exist`);
    if (baseSha === undefined) throw new ForgeError(422, `the base branch "${baseRef}" does not exist`);
    for (const existing of repo.pulls.values()) {
      if (existing.state === 'open' && existing.headRef === headRef && existing.baseRef === baseRef) {
        throw new ForgeError(422, 'a pull request is already open for this head and base');
      }
    }
    const pull: PullRequest = {
      id: this.nextIssueId++,
      number: repo.nextNumber++,
      title,
      body: body ?? '',
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      userLogin: this.viewerLogin,
      createdAt: NOW_ISO,
      updatedAt: NOW_ISO,
    };
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** The current tips of a pull request's head and base branches. */
  pullTips(repo: Repo, pull: PullRequest): { head: string | null; base: string | null } {
    return {
      head: repo.refs.get(`refs/heads/${pull.headRef}`) ?? null,
      base: repo.refs.get(`refs/heads/${pull.baseRef}`) ?? null,
    };
  }

  /** The merge-base of a pull request's head and base tips, or null. */
  pullMergeBase(repo: Repo, pull: PullRequest): string | null {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return null;
    return this.mergeBase(repo, head, base);
  }

  /**
   * The three-way merge of a pull request: the merged file map, or the
   * conflicting paths. base = merge-base, head = head tip, current = base tip.
   */
  threeWayMerge(
    repo: Repo,
    pull: PullRequest,
  ): { ok: true; files: Map<string, string> } | { ok: false; conflicts: string[] } {
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return { ok: false, conflicts: [] };
    const mergeBase = this.mergeBase(repo, head, base);
    const baseTree = mergeBase === null ? null : this.commitOf(repo, mergeBase)?.tree ?? null;
    const headTree = this.commitOf(repo, head)?.tree ?? null;
    const currentTree = this.commitOf(repo, base)?.tree ?? null;
    const m = baseTree === null ? new Map() : this.flattenTree(repo, baseTree);
    const h = headTree === null ? new Map() : this.flattenTree(repo, headTree);
    const b = currentTree === null ? new Map() : this.flattenTree(repo, currentTree);
    const paths = new Set([...m.keys(), ...h.keys(), ...b.keys()]);
    const conflicts: string[] = [];
    const result = new Map<string, string>();
    for (const path of paths) {
      const mOid = m.get(path)?.oid;
      const hOid = h.get(path)?.oid;
      const bOid = b.get(path)?.oid;
      if (hOid === mOid) {
        if (bOid !== undefined) result.set(path, bOid);
      } else if (bOid === mOid) {
        if (hOid !== undefined) result.set(path, hOid);
      } else if (hOid === bOid) {
        if (hOid !== undefined) result.set(path, hOid);
      } else {
        conflicts.push(path);
      }
    }
    if (conflicts.length > 0) return { ok: false, conflicts };
    return { ok: true, files: result };
  }

  /** Whether a pull request merges cleanly right now. */
  mergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pull.state !== 'open') return 'UNKNOWN';
    const { head, base } = this.pullTips(repo, pull);
    if (head === null || base === null) return 'UNKNOWN';
    return this.threeWayMerge(repo, pull).ok ? 'MERGEABLE' : 'CONFLICTING';
  }

  /** Squash-merge an open pull request onto its base branch. */
  mergePull(repo: Repo, pull: PullRequest): { sha: string } {
    if (pull.state !== 'open') throw new ForgeError(405, 'the pull request is already closed');
    const { base } = this.pullTips(repo, pull);
    if (base === null) throw new ForgeError(405, 'the base branch does not exist');
    const merged = this.threeWayMerge(repo, pull);
    if (!merged.ok) throw new ForgeError(405, 'the pull request has merge conflicts');
    const treeOid = this.treeFromFiles(repo, merged.files);
    const commitData = buildCommit({
      tree: treeOid,
      parents: [base],
      message: `${pull.title}\n`,
      author: SERVER_IDENTITY,
      committer: SERVER_IDENTITY,
      timestamp: NOW_EPOCH_SEC,
    });
    const sha = this.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = NOW_ISO;
    pull.mergeCommitSha = sha;
    pull.updatedAt = NOW_ISO;
    return { sha };
  }
}

// ---------------------------------------------------------------------------------------------
// diffs: base...head file lists with line counts
// ---------------------------------------------------------------------------------------------

export interface FileDiff {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function splitLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Added/removed line counts by multiset difference (exact enough for the suite's counts). */
export function lineCounts(oldContent: string | null, newContent: string | null): { additions: number; deletions: number } {
  if (oldContent === null && newContent === null) return { additions: 0, deletions: 0 };
  if (oldContent === null) return { additions: splitLines(newContent as string).length, deletions: 0 };
  if (newContent === null) return { additions: 0, deletions: splitLines(oldContent).length };
  const oldCounts = new Map<string, number>();
  for (const line of splitLines(oldContent)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  let additions = 0;
  for (const line of splitLines(newContent)) {
    const left = oldCounts.get(line) ?? 0;
    if (left > 0) oldCounts.set(line, left - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const left of oldCounts.values()) deletions += left;
  return { additions, deletions };
}

/** The files changed between two trees (merge-base...head for a pull request). */
export function diffTrees(
  forge: Forge,
  repo: Repo,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): FileDiff[] {
  const base = baseTreeOid === null ? new Map() : forge.flattenTree(repo, baseTreeOid);
  const head = headTreeOid === null ? new Map() : forge.flattenTree(repo, headTreeOid);
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const path of [...paths].sort()) {
    const b = base.get(path);
    const h = head.get(path);
    if (b !== undefined && h !== undefined && b.oid === h.oid) continue;
    const oldContent = b === undefined ? null : (repo.objects.get(b.oid)?.data.toString('utf8') ?? '');
    const newContent = h === undefined ? null : (repo.objects.get(h.oid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineCounts(oldContent, newContent);
    const status = b === undefined ? 'added' : h === undefined ? 'removed' : 'modified';
    out.push({ filename: path, status, additions, deletions, changes: additions + deletions });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------------------------

export function repoJson(forge: Forge, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: forge.repoGlobalId(repo),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: forge.viewerId, type: 'User' },
    private: repo.privateFlag,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function labelJson(label: Label): Record<string, unknown> {
  return { id: label.id, name: label.name, color: label.color };
}

export function issueJson(forge: Forge, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: forge.issueGlobalId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map(labelJson),
    user: { login: issue.userLogin, id: forge.viewerId, type: 'User' },
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

export function commentJson(forge: Forge, repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: forge.commentGlobalId(repo, issue, comment),
    body: comment.body,
    user: { login: comment.userLogin, id: forge.viewerId, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
  };
}

export function pullJson(forge: Forge, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const tips = forge.pullTips(repo, pull);
  return {
    id: pull.id,
    node_id: forge.pullGlobalId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: tips.head ?? pull.headSha },
    base: { ref: pull.baseRef, sha: tips.base ?? pull.baseSha },
    user: { login: pull.userLogin, id: forge.viewerId, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

/** A commit object as the REST /commits list renders it. */
export function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  let view;
  try {
    view = parseCommit(object.data);
  } catch {
    return null;
  }
  const message = view.message.endsWith('\n') ? view.message.slice(0, -1) : view.message;
  const who = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(line);
    if (match === null) return { name: line, email: '', date: NOW_ISO };
    return {
      name: match[1] as string,
      email: match[2] as string,
      date: new Date(Number(match[3]) * 1000).toISOString(),
    };
  };
  return {
    sha,
    commit: {
      message,
      author: who(view.author),
      committer: who(view.committer),
      tree: { sha: view.tree },
    },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

export { ZERO_OID };
