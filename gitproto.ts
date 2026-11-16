// gitproto.ts: git smart HTTP.
//
// upload-pack speaks protocol v2 (when the client asks with
// `Git-Protocol: version=2`) and v0 otherwise; receive-pack is v0 only.
//   - info/refs: the v2 capability advertisement, or the v0 ref advertisement
//     with the `# service=...` preamble
//   - ls-refs: refs, HEAD symref, peeled annotated tags, ref-prefix filtering
//   - fetch: want/have negotiation, shallow/deepen, sideband-framed packs
//   - receive-pack: command list + pack, per-ref report-status, fast-forward
//     enforcement, sideband-framed report
//
// Packs are always complete (no deltas, no thin packs): a complete pack is a
// valid answer to a thin-pack request, and the suite only verifies resolved
// objects.

import {
  PKT_LINE_MAX,
  ZERO_OID,
  decodePktLines,
  isObjectId,
  parseTag,
  pktLine,
  pktLines,
  readPack,
  writePack,
  type GitObject,
  type GitPacket,
} from './gitobj.ts';
import { Forge, HEAD_REF, type Repo } from './store.ts';

export type GitService = 'git-upload-pack' | 'git-receive-pack';

const UPLOAD_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow multi_ack_detailed agent=git-forge/1.0 object-format=sha1';
const RECEIVE_V0_CAPS = 'symref=HEAD:refs/heads/main report-status side-band-64k delete-refs agent=git-forge/1.0';

export interface GitResponse {
  status: number;
  contentType: string;
  body: Buffer;
}

function ok(contentType: string, body: Buffer): GitResponse {
  return { status: 200, contentType, body };
}

function notFound(): GitResponse {
  return { status: 404, contentType: 'application/json', body: Buffer.from('{"message":"Not Found"}\n', 'utf8') };
}

function badRequest(message: string): GitResponse {
  return { status: 400, contentType: 'application/json', body: Buffer.from(`${JSON.stringify({ message })}\n`, 'utf8') };
}

// ---------------------------------------------------------------------------------------------
// ref listings
// ---------------------------------------------------------------------------------------------

interface ListedRef {
  oid: string;
  name: string;
  peeled?: string;
}

/** All refs, sorted: HEAD first, then heads, then tags. Peeled targets resolved. */
function listRefs(forge: Forge, repo: Repo): ListedRef[] {
  const out: ListedRef[] = [];
  const headTip = repo.refs.get(HEAD_REF);
  if (headTip !== undefined) out.push({ oid: headTip, name: 'HEAD' });
  const heads = [...repo.refs.keys()].filter((name) => name.startsWith('refs/heads/')).sort();
  for (const name of heads) out.push({ oid: repo.refs.get(name) as string, name });
  const tags = [...repo.refs.keys()].filter((name) => name.startsWith('refs/tags/')).sort();
  for (const name of tags) {
    const oid = repo.refs.get(name) as string;
    const entry: ListedRef = { oid, name };
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      try {
        entry.peeled = parseTag(object.data).object;
      } catch {
        // A malformed tag peels to nothing.
      }
    }
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// info/refs
// ---------------------------------------------------------------------------------------------

/** The v2 capability advertisement. */
function v2Advertisement(): Buffer {
  return pktLines([
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The v0 ref advertisement, with the service preamble. */
function v0Advertisement(forge: Forge, repo: Repo, service: GitService): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
  const refs = listRefs(forge, repo);
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), Buffer.from('0000', 'ascii')];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      const first = index === 0 ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${first}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function handleInfoRefs(
  forge: Forge,
  repo: Repo | null,
  service: GitService,
  wantsV2: boolean,
): GitResponse {
  if (repo === null) return notFound();
  const contentType = `application/x-${service}-advertisement`;
  if (service === 'git-upload-pack' && wantsV2) return ok(contentType, v2Advertisement());
  return ok(contentType, v0Advertisement(forge, repo, service));
}

// ---------------------------------------------------------------------------------------------
// sideband
// ---------------------------------------------------------------------------------------------

/** Wrap bytes in sideband band-1 pkt-lines (payload <= 65515 data bytes each). */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const CHUNK = PKT_LINE_MAX - 4 - 1; // header + band byte
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + CHUNK));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

/** Wrap a report-status stream in one band-1 sideband frame (chunked when long). */
function sidebandReport(report: Buffer): Buffer {
  return sidebandPack(report);
}

// ---------------------------------------------------------------------------------------------
// fetch planning (shared by v2 and v0)
// ---------------------------------------------------------------------------------------------

interface FetchPlan {
  /** The objects to send, in pack order (commits, then trees, then blobs). */
  objects: GitObject[];
  /** ACK lines for haves that are ancestors of the wants (empty means NAK). */
  acks: string[];
  /** The new shallow boundary commits. */
  shallow: string[];
  /** Client shallow boundaries that are now fully included. */
  unshallow: string[];
}

function planFetch(
  forge: Forge,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | null,
): FetchPlan {
  // Resolve tag wants to their target commits; the tag objects themselves ship too.
  const tagObjects: Array<[string, GitObject]> = [];
  const walkRoots: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.push([want, object]);
      try {
        const target = parseTag(object.data).object;
        const targetObject = repo.objects.get(target);
        if (targetObject !== undefined && targetObject.type === 'commit') walkRoots.push(target);
        else if (targetObject !== undefined) tagObjects.push([target, targetObject]);
      } catch {
        // A malformed tag contributes nothing more.
      }
    } else if (object.type === 'commit') {
      walkRoots.push(want);
    } else {
      tagObjects.push([want, object]);
    }
  }

  const { commits, boundary } = forge.depthWalk(repo, walkRoots, depth);
  // The wanted closure: included commits plus their trees/blobs, never the
  // parents of a boundary commit.
  const wanted = forge.collectReachable(repo, commits, { shallowCut: boundary });
  for (const [oid] of tagObjects) wanted.add(oid);
  // What the client already holds: the haves' closure, cut at the client's
  // own shallow boundaries (a shallow commit's parents are NOT held).
  const held = forge.collectReachable(repo, haves, { shallowCut: new Set(clientShallow) });
  const send = [...wanted].filter((oid) => !held.has(oid));
  // Deterministic pack order: commits, then trees, then blobs, each by oid.
  const byType = (oid: string): number => {
    const type = repo.objects.get(oid)?.type;
    return type === 'commit' ? 0 : type === 'tree' ? 1 : type === 'tag' ? 2 : 3;
  };
  send.sort((a, b) => byType(a) - byType(b) || (a < b ? -1 : a > b ? 1 : 0));
  const objects: GitObject[] = [];
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object !== undefined) objects.push(object);
  }

  // ACKs: a have is acknowledged when it is an ancestor of (or equal to) a want.
  const acks: string[] = [];
  for (const have of haves) {
    let acked = false;
    for (const root of walkRoots) {
      if (forge.isAncestor(repo, have, root)) {
        acked = true;
        break;
      }
    }
    if (acked) acks.push(have);
  }

  const shallow = [...boundary].sort();
  const unshallow = clientShallow.filter((oid) => commits.has(oid) && !boundary.has(oid)).sort();
  return { objects, acks, shallow, unshallow };
}

// ---------------------------------------------------------------------------------------------
// upload-pack v2
// ---------------------------------------------------------------------------------------------

interface V2Request {
  command: string;
  args: string[];
}

/** Split a v2 request body into its command and its argument lines. */
function parseV2Request(body: Buffer): V2Request {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  let sawDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      sawDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8'));
  }
  if (!sawDelim && lines.length > 0) throw new Error('v2 request has no delim');
  const first = lines[0] ?? '';
  const match = /^command=([a-z-]+)\n?$/.exec(first.trim());
  if (match === null) throw new Error(`v2 request has no command line: ${JSON.stringify(first.slice(0, 40))}`);
  // Argument lines are those after the delim; the header lines (agent,
  // object-format) sit between the command and the delim and are ignored.
  const args: string[] = [];
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !pastDelim) continue;
    args.push(packet.payload.toString('utf8'));
  }
  return { command: match[1] as string, args };
}

function handleLsRefs(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const refs = listRefs(forge, repo);
  const headTip = repo.refs.get(HEAD_REF);
  if (headTip === undefined) {
    // An unborn repository: HEAD alone, only when the client asked for it.
    if (unborn && keep('HEAD')) parts.push(pktLine(`unborn HEAD symref-target:${HEAD_REF}\n`));
  } else {
    if (keep('HEAD')) {
      const target = symrefs ? ` symref-target:${HEAD_REF}` : '';
      parts.push(pktLine(`${headTip} HEAD${target}\n`));
    }
    for (const ref of refs) {
      if (ref.name === 'HEAD') continue;
      if (!keep(ref.name)) continue;
      const peeled = peel && ref.peeled !== undefined ? ` peeled:${ref.peeled}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${peeled}\n`));
    }
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

function handleFetchV2(forge: Forge, repo: Repo, args: readonly string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const raw of args) {
    const line = raw.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) wants.push(oid);
    } else if (line.startsWith('have ')) {
      const oid = line.slice(5).trim();
      if (isObjectId(oid)) haves.push(oid);
    } else if (line.startsWith('shallow ')) {
      const oid = line.slice(8).trim();
      if (isObjectId(oid)) shallow.push(oid);
    } else if (line.startsWith('deepen ')) {
      const value = Number(line.slice(7).trim());
      if (Number.isInteger(value) && value > 0) depth = value;
    }
    // thin-pack, no-progress, ofs-delta, filter, done: acknowledged by shape,
    // needing no action (packs are always complete; no progress is ever sent).
  }
  if (wants.length === 0) return Buffer.from('0000', 'ascii');
  const plan = planFetch(forge, repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  parts.push(Buffer.from('0000', 'ascii'));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  if (plan.objects.length > 0) {
    const pack = writePack(plan.objects);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(Buffer.from('0000', 'ascii'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------------------------
// upload-pack v0
// ---------------------------------------------------------------------------------------------

function handleFetchV0(forge: Forge, repo: Repo, body: Buffer): Buffer {
  const { packets } = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let secondSection = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      secondSection = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!secondSection) {
      if (line.startsWith('want ')) {
        const oid = line.slice(5).split(' ')[0] as string;
        if (isObjectId(oid)) wants.push(oid);
      } else if (line.startsWith('shallow ')) {
        const oid = line.slice(8).trim();
        if (isObjectId(oid)) shallow.push(oid);
      } else if (line.startsWith('deepen ')) {
        const value = Number(line.slice(7).trim());
        if (Number.isInteger(value) && value > 0) depth = value;
      }
    } else {
      if (line.startsWith('have ')) {
        const oid = line.slice(5).trim();
        if (isObjectId(oid)) haves.push(oid);
      }
    }
  }
  if (wants.length === 0) return Buffer.from('0000', 'ascii');
  const plan = planFetch(forge, repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.length > 0) {
    parts.push(sidebandPack(writePack(plan.objects)));
  }
  parts.push(Buffer.from('0000', 'ascii'));
  return Buffer.concat(parts);
}

export function handleUploadPack(
  forge: Forge,
  repo: Repo | null,
  body: Buffer,
  wantsV2: boolean,
): GitResponse {
  if (repo === null) return notFound();
  const contentType = 'application/x-git-upload-pack-result';
  try {
    if (wantsV2) {
      const request = parseV2Request(body);
      if (request.command === 'ls-refs') return ok(contentType, handleLsRefs(forge, repo, request.args));
      if (request.command === 'fetch') return ok(contentType, handleFetchV2(forge, repo, request.args));
      return badRequest(`unknown v2 command ${JSON.stringify(request.command)}`);
    }
    return ok(contentType, handleFetchV0(forge, repo, body));
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
}

// ---------------------------------------------------------------------------------------------
// receive-pack v0
// ---------------------------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(forge: Forge, repo: Repo | null, body: Buffer): GitResponse {
  if (repo === null) return notFound();
  const contentType = 'application/x-git-receive-pack-result';
  let commands: PushCommand[];
  let packBytes: Buffer;
  try {
    const { packets, consumed } = decodePktLines(body, { allowTrailing: true });
    commands = [];
    for (const packet of packets) {
      if (packet.kind !== 'data') continue;
      let line = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = line.indexOf('\0');
      if (nul >= 0) line = line.slice(0, nul);
      const match = /^([0-9a-f]{40}) ([0-9a-f]{40}) (\S+)$/.exec(line);
      if (match === null) throw new Error(`bad receive-pack command ${JSON.stringify(line.slice(0, 60))}`);
      commands.push({ oldOid: match[1] as string, newOid: match[2] as string, ref: match[3] as string });
    }
    packBytes = body.subarray(consumed);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : String(err));
  }
  if (commands.length === 0) return badRequest('receive-pack sent no commands');

  // Unpack first: a refused update still unpacks, and its objects stay.
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const reportLines: string[] = [`unpack ${unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpacker error`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      reportLines.push(`ng ${command.ref} bad object`);
      continue;
    }
    if (current === undefined) {
      // Create.
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    // Update.
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (command.newOid === current) {
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    if (command.ref.startsWith('refs/tags/')) {
      // Tags do not move without force.
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (target.type !== 'commit' || !forge.isAncestor(repo, current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }

  const report = pktLines([...reportLines.map((line) => `${line}\n`), 'flush' as const]);
  const bodyOut = Buffer.concat([sidebandReport(report), Buffer.from('0000', 'ascii')]);
  return ok(contentType, bodyOut);
}

export type { GitPacket };
