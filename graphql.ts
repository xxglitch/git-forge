// graphql.ts: a small GraphQL executor for the fixed documents the suite sends
// (the shapes `gh` and github-mcp-server use).
//
// A real lexer/parser/validator/executor, not document matching: the suite
// sends 18 documents plus batched arrays and one deliberately invalid field,
// so the executor validates against a schema map and reports unknown fields
// the way GraphQL.js does (`Cannot query field "x" on type "Y".`).
//
// Supported subset: queries and mutations, variables (with defaults),
// aliases, arguments (scalars, enums, lists, inline input objects),
// inline fragments, named fragments, batched arrays, and the `__type` /
// `__schema` introspection surface the suite exercises.

import {
  Forge,
  ForgeError,
  diffTrees,
  type Comment,
  type Issue,
  type PullRequest,
  type Repo,
} from './store.ts';

// ---------------------------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'spread';
  value: string;
}

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '\uFEFF') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      // Block strings (""") are not in the suite's documents; a triple quote
      // would lex as an empty string followed by a string, which the parser
      // rejects — acceptable for this subset.
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += input[j] as string;
          j += 1;
        }
      }
      if (j >= input.length) throw new Error('Unterminated string');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(input[i + 1] ?? ''))) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface ArgumentNode {
  name: string;
  value: ValueNode;
}

type SelectionNode =
  | { kind: 'field'; name: string; alias: string | null; args: ArgumentNode[]; selections: SelectionNode[] | null }
  | { kind: 'spread'; name: string }
  | { kind: 'inline'; typeCondition: string | null; selections: SelectionNode[] };

interface VariableDefNode {
  name: string;
  defaultValue: ValueNode | null;
}

interface OperationNode {
  kind: 'operation';
  operation: 'query' | 'mutation';
  name: string | null;
  variables: VariableDefNode[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  name: string;
  typeCondition: string;
  selections: SelectionNode[];
}

type DefinitionNode = OperationNode | FragmentNode;

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) {
      throw new Error(`Expected "${value}" but got ${JSON.stringify(token.value)}`);
    }
  }

  private expectName(value?: string): string {
    const token = this.next();
    if (token.kind !== 'name' || (value !== undefined && token.value !== value)) {
      throw new Error(`Expected name ${value ?? ''} but got ${JSON.stringify(token.value)}`);
    }
    return token.value;
  }

  private skipDirectives(): void {
    while (this.peek()?.kind === 'punct' && this.peek()?.value === '@') {
      this.next();
      this.expectName();
      if (this.peek()?.value === '(') this.parseArguments();
    }
  }

  parseDocument(): DefinitionNode[] {
    const definitions: DefinitionNode[] = [];
    while (this.pos < this.tokens.length) {
      definitions.push(this.parseDefinition());
    }
    if (definitions.length === 0) throw new Error('Document is empty');
    return definitions;
  }

  private parseDefinition(): DefinitionNode {
    const token = this.peek();
    if (token === undefined) throw new Error('Unexpected end of document');
    if (token.kind === 'punct' && token.value === '{') {
      return { kind: 'operation', operation: 'query', name: null, variables: [], selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      this.next();
      const operation = token.value as 'query' | 'mutation';
      let name: string | null = null;
      if (this.peek()?.kind === 'name') name = this.next().value;
      const variables = this.parseVariableDefinitions();
      this.skipDirectives();
      return { kind: 'operation', operation, name, variables, selections: this.parseSelectionSet() };
    }
    if (token.kind === 'name' && token.value === 'fragment') {
      this.next();
      const name = this.expectName();
      this.expectName('on');
      const typeCondition = this.expectName();
      this.skipDirectives();
      return { kind: 'fragment', name, typeCondition, selections: this.parseSelectionSet() };
    }
    throw new Error(`Unexpected token ${JSON.stringify(token.value)}`);
  }

  private parseVariableDefinitions(): VariableDefNode[] {
    const variables: VariableDefNode[] = [];
    if (this.peek()?.value !== '(') return variables;
    this.expectPunct('(');
    while (this.peek()?.value !== ')') {
      this.expectPunct('$');
      const name = this.expectName();
      this.expectPunct(':');
      this.parseType();
      let defaultValue: ValueNode | null = null;
      if (this.peek()?.value === '=') {
        this.next();
        defaultValue = this.parseValue(true);
      }
      variables.push({ name, defaultValue });
    }
    this.expectPunct(')');
    return variables;
  }

  private parseType(): void {
    if (this.peek()?.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.value === '!') this.next();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (this.peek()?.value !== '}') {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  private parseSelection(): SelectionNode {
    const token = this.peek();
    if (token === undefined) throw new Error('Unexpected end of selection set');
    if (token.kind === 'spread') {
      this.next();
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        const typeCondition = this.expectName();
        this.skipDirectives();
        return { kind: 'inline', typeCondition, selections: this.parseSelectionSet() };
      }
      if (next?.kind === 'name') {
        const name = this.next().value;
        this.skipDirectives();
        return { kind: 'spread', name };
      }
      this.skipDirectives();
      return { kind: 'inline', typeCondition: null, selections: this.parseSelectionSet() };
    }
    const first = this.expectName();
    let alias: string | null = null;
    let name = first;
    if (this.peek()?.value === ':') {
      this.next();
      alias = first;
      name = this.expectName();
    }
    const args = this.parseArguments();
    this.skipDirectives();
    const selections = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return { kind: 'field', name, alias, args, selections };
  }

  private parseArguments(): ArgumentNode[] {
    const args: ArgumentNode[] = [];
    if (this.peek()?.value !== '(') return args;
    this.expectPunct('(');
    while (this.peek()?.value !== ')') {
      const name = this.expectName();
      this.expectPunct(':');
      args.push({ name, value: this.parseValue(false) });
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(isConst: boolean): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('Variable in constant value');
      return { kind: 'variable', name: this.expectName() };
    }
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (this.peek()?.value !== ']') items.push(this.parseValue(isConst));
      this.expectPunct(']');
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek()?.value !== '}') {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue(isConst) });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    throw new Error(`Unexpected value token ${JSON.stringify(token.value)}`);
  }
}

// ---------------------------------------------------------------------------------------------
// schema map (validation + introspection)
// ---------------------------------------------------------------------------------------------

/** type name -> field name -> return type name (list types written `[X]`). */
const SCHEMA: Record<string, Record<string, string>> = {
  Query: {
    viewer: 'User',
    repository: 'Repository',
    node: 'Node',
    __type: '__Type',
    __schema: '__Schema',
  },
  User: { login: 'String', id: 'ID' },
  Node: { id: 'ID' },
  Repository: {
    id: 'ID',
    databaseId: 'Int',
    name: 'String',
    nameWithOwner: 'String',
    owner: 'User',
    defaultBranchRef: 'Ref',
    viewerPermission: 'RepositoryPermission',
    hasIssuesEnabled: 'Boolean',
    issue: 'Issue',
    issues: 'IssueConnection',
    pullRequests: 'PullRequestConnection',
    pullRequest: 'PullRequest',
  },
  Ref: { name: 'String' },
  Issue: { id: 'ID', number: 'Int', title: 'String', state: 'IssueState', body: 'String' },
  IssueConnection: { nodes: '[Issue]', edges: '[IssueEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  IssueEdge: { node: 'Issue', cursor: 'String' },
  PageInfo: { hasNextPage: 'Boolean', hasPreviousPage: 'Boolean', startCursor: 'String', endCursor: 'String' },
  PullRequest: {
    id: 'ID',
    number: 'Int',
    state: 'PullRequestState',
    merged: 'Boolean',
    headRefName: 'String',
    baseRefName: 'String',
    mergeable: 'MergeableState',
    title: 'String',
    body: 'String',
    files: 'PullRequestChangedFileConnection',
  },
  PullRequestConnection: { nodes: '[PullRequest]', edges: '[PullRequestEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestEdge: { node: 'PullRequest', cursor: 'String' },
  PullRequestChangedFileConnection: { nodes: '[PullRequestChangedFile]', edges: '[PullRequestChangedFileEdge]', pageInfo: 'PageInfo', totalCount: 'Int' },
  PullRequestChangedFileEdge: { node: 'PullRequestChangedFile', cursor: 'String' },
  PullRequestChangedFile: { path: 'String', additions: 'Int', deletions: 'Int', changeType: 'PullRequestChangeType' },
  Mutation: {
    createIssue: 'CreateIssuePayload',
    closeIssue: 'CloseIssuePayload',
    createPullRequest: 'CreatePullRequestPayload',
    mergePullRequest: 'MergePullRequestPayload',
    addComment: 'AddCommentPayload',
  },
  CreateIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CloseIssuePayload: { issue: 'Issue', clientMutationId: 'String' },
  CreatePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  MergePullRequestPayload: { pullRequest: 'PullRequest', clientMutationId: 'String' },
  AddCommentPayload: { commentEdge: 'IssueCommentEdge', clientMutationId: 'String' },
  IssueCommentEdge: { node: 'IssueComment', cursor: 'String' },
  IssueComment: { id: 'ID', body: 'String' },
  __Type: {
    name: 'String',
    kind: 'String',
    description: 'String',
    fields: '[__Field]',
    enumValues: '[__EnumValue]',
    ofType: '__Type',
    inputFields: '[__InputValue]',
    interfaces: '[__Type]',
    possibleTypes: '[__Type]',
  },
  __Field: { name: 'String', description: 'String', args: '[__InputValue]', type: '__Type', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __EnumValue: { name: 'String', description: 'String', isDeprecated: 'Boolean', deprecationReason: 'String' },
  __InputValue: { name: 'String', description: 'String', type: '__Type', defaultValue: 'String' },
  __Schema: { types: '[__Type]', queryType: '__Type', mutationType: '__Type', directives: '[__Directive]' },
  __Directive: { name: 'String', description: 'String', locations: '[String]', args: '[__InputValue]' },
};

const ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'READ', 'TRIAGE', 'WRITE'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
  PullRequestChangeType: ['ADDED', 'CHANGED', 'COPIED', 'DELETED', 'MODIFIED', 'RENAMED'],
};

const SCALARS = new Set(['String', 'Int', 'Float', 'Boolean', 'ID']);

function unwrapList(typeName: string): string {
  return typeName.startsWith('[') && typeName.endsWith(']') ? typeName.slice(1, -1) : typeName;
}

function isLeafType(typeName: string): boolean {
  const base = unwrapList(typeName);
  return SCALARS.has(base) || ENUMS[base] !== undefined;
}

// ---------------------------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------------------------

function validate(
  definitions: DefinitionNode[],
  fragments: Map<string, FragmentNode>,
): string[] {
  const errors: string[] = [];
  const validateSelections = (selections: SelectionNode[], typeName: string, seenFragments: Set<string>): void => {
    const fields = SCHEMA[typeName];
    for (const selection of selections) {
      if (selection.kind === 'field') {
        if (selection.name === '__typename') continue;
        const returnType = fields?.[selection.name];
        if (returnType === undefined) {
          errors.push(`Cannot query field "${selection.name}" on type "${typeName}".`);
          continue;
        }
        const base = unwrapList(returnType);
        if (isLeafType(returnType)) {
          if (selection.selections !== null) {
            errors.push(`Field "${selection.name}" must not have a selection since type "${base}" has no subfields.`);
          }
        } else if (selection.selections === null) {
          errors.push(`Field "${selection.name}" of type "${base}" must have a selection of subfields.`);
        } else {
          validateSelections(selection.selections, base, seenFragments);
        }
      } else if (selection.kind === 'spread') {
        const fragment = fragments.get(selection.name);
        if (fragment === undefined) {
          errors.push(`Unknown fragment "${selection.name}".`);
        } else if (!seenFragments.has(selection.name)) {
          seenFragments.add(selection.name);
          validateSelections(fragment.selections, fragment.typeCondition, seenFragments);
        }
      } else {
        const condition = selection.typeCondition ?? typeName;
        if (SCHEMA[condition] === undefined && ENUMS[condition] === undefined) {
          errors.push(`Unknown type "${condition}".`);
        } else {
          validateSelections(selection.selections, condition, seenFragments);
        }
      }
    }
  };
  for (const definition of definitions) {
    if (definition.kind === 'operation') {
      validateSelections(definition.selections, definition.operation === 'mutation' ? 'Mutation' : 'Query', new Set());
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------------------------
// values
// ---------------------------------------------------------------------------------------------

type GqlValue =
  | { kind: 'user'; login: string }
  | { kind: 'repo'; repo: Repo }
  | { kind: 'issue'; repo: Repo; issue: Issue }
  | { kind: 'pr'; repo: Repo; pr: PullRequest }
  | { kind: 'ref'; name: string }
  | { kind: 'issueConn'; repo: Repo; items: Issue[]; total: number; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'issueEdge'; repo: Repo; issue: Issue }
  | { kind: 'prConn'; repo: Repo; items: PullRequest[]; total: number; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'prEdge'; repo: Repo; pr: PullRequest }
  | { kind: 'fileConn'; files: Array<{ path: string; additions: number; deletions: number; status: string }>; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'fileEdge'; file: { path: string; additions: number; deletions: number; status: string } }
  | { kind: 'file'; file: { path: string; additions: number; deletions: number; status: string } }
  | { kind: 'comment'; repo: Repo; issue: Issue; comment: Comment }
  | { kind: 'commentEdge'; repo: Repo; issue: Issue; comment: Comment }
  | { kind: 'payload'; typeName: string; issue?: { repo: Repo; issue: Issue }; pr?: { repo: Repo; pr: PullRequest }; comment?: { repo: Repo; issue: Issue; comment: Comment } }
  | { kind: 'type'; name: string }
  | { kind: 'field'; name: string }
  | { kind: 'enumValue'; name: string }
  | { kind: 'pageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { kind: 'schema' }
  | string
  | number
  | boolean
  | null;

function typeNameOf(value: Exclude<GqlValue, string | number | boolean | null>): string {
  switch (value.kind) {
    case 'user': return 'User';
    case 'repo': return 'Repository';
    case 'issue': return 'Issue';
    case 'pr': return 'PullRequest';
    case 'ref': return 'Ref';
    case 'issueConn': return 'IssueConnection';
    case 'issueEdge': return 'IssueEdge';
    case 'prConn': return 'PullRequestConnection';
    case 'prEdge': return 'PullRequestEdge';
    case 'fileConn': return 'PullRequestChangedFileConnection';
    case 'fileEdge': return 'PullRequestChangedFileEdge';
    case 'file': return 'PullRequestChangedFile';
    case 'comment': return 'IssueComment';
    case 'commentEdge': return 'IssueCommentEdge';
    case 'payload': return value.typeName;
    case 'type': return '__Type';
    case 'field': return '__Field';
    case 'enumValue': return '__EnumValue';
    case 'pageInfo': return 'PageInfo';
    case 'schema': return '__Schema';
  }
}

function isObjectValue(value: GqlValue): value is Exclude<GqlValue, string | number | boolean | null> {
  return typeof value === 'object' && value !== null;
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------------------------

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function evaluateValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable': return variables[node.name];
    case 'int': case 'float': case 'string': case 'boolean': return node.value;
    case 'null': return null;
    case 'enum': return node.value;
    case 'list': return node.items.map((item) => evaluateValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evaluateValue(field.value, variables);
      return out;
    }
  }
}

function evaluateArgs(args: ArgumentNode[], variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) out[arg.name] = evaluateValue(arg.value, variables);
  return out;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

class GraphQLError extends Error {}

/** Resolve one field of one object value. Returns a value, a list, or null. */
function resolveField(
  ctx: ExecContext,
  parentType: string,
  parent: GqlValue,
  fieldName: string,
  args: Record<string, unknown>,
): GqlValue | GqlValue[] {
  const forge = ctx.forge;

  // --- Query root (parent is null) ---
  if (parentType === 'Query') {
    switch (fieldName) {
      case 'viewer':
        return { kind: 'user', login: forge.viewerLogin };
      case 'repository': {
        const repo = forge.getRepo(asString(args.owner), asString(args.name));
        return repo === null ? null : { kind: 'repo', repo };
      }
      case 'node': {
        const resolved = forge.resolveGlobalId(asString(args.id));
        if (resolved === null) return null;
        if (resolved.kind === 'repo') return { kind: 'repo', repo: resolved.repo };
        if (resolved.kind === 'issue') return { kind: 'issue', repo: resolved.repo, issue: resolved.issue };
        return { kind: 'pr', repo: resolved.repo, pr: resolved.pull };
      }
      case '__type': {
        const name = asString(args.name);
        if (SCHEMA[name] === undefined && ENUMS[name] === undefined) return null;
        return { kind: 'type', name };
      }
      case '__schema':
        return { kind: 'schema' };
      default:
        throw new GraphQLError(`Cannot query field "${fieldName}" on type "Query".`);
    }
  }

  // --- Mutation root ---
  if (parentType === 'Mutation') {
    switch (fieldName) {
      case 'createIssue': {
        const input = asRecord(args.input);
        const resolved = forge.resolveGlobalId(asString(input.repositoryId));
        if (resolved === null || resolved.kind !== 'repo') throw new GraphQLError('Repository not found');
        const repo = resolved.repo;
        let issue: Issue;
        try {
          issue = forge.createIssue(repo, asString(input.title), asString(input.body), []);
        } catch (e) {
          throw new GraphQLError(e instanceof Error ? e.message : 'Could not create issue');
        }
        return { kind: 'payload', typeName: 'CreateIssuePayload', issue: { repo, issue } };
      }
      case 'closeIssue': {
        const input = asRecord(args.input);
        const resolved = forge.resolveGlobalId(asString(input.issueId));
        if (resolved === null || resolved.kind !== 'issue') throw new GraphQLError('Issue not found');
        resolved.issue.state = 'closed';
        return { kind: 'payload', typeName: 'CloseIssuePayload', issue: { repo: resolved.repo, issue: resolved.issue } };
      }
      case 'createPullRequest': {
        const input = asRecord(args.input);
        const resolved = forge.resolveGlobalId(asString(input.repositoryId));
        if (resolved === null || resolved.kind !== 'repo') throw new GraphQLError('Repository not found');
        const repo = resolved.repo;
        let pr: PullRequest;
        try {
          pr = forge.createPull(repo, asString(input.title), asString(input.body), asString(input.headRefName), asString(input.baseRefName));
        } catch (e) {
          throw new GraphQLError(e instanceof Error ? e.message : 'Could not create pull request');
        }
        return { kind: 'payload', typeName: 'CreatePullRequestPayload', pr: { repo, pr } };
      }
      case 'mergePullRequest': {
        const input = asRecord(args.input);
        const resolved = forge.resolveGlobalId(asString(input.pullRequestId));
        if (resolved === null || resolved.kind !== 'pr') throw new GraphQLError('Pull request not found');
        try {
          forge.mergePull(resolved.repo, resolved.pull);
        } catch (e) {
          throw new GraphQLError(e instanceof Error ? e.message : 'Could not merge pull request');
        }
        return { kind: 'payload', typeName: 'MergePullRequestPayload', pr: { repo: resolved.repo, pr: resolved.pull } };
      }
      case 'addComment': {
        const input = asRecord(args.input);
        const resolved = forge.resolveGlobalId(asString(input.subjectId));
        if (resolved === null || resolved.kind !== 'issue') {
          throw new GraphQLError('Subject not found');
        }
        let comment: Comment;
        try {
          comment = forge.addComment(resolved.repo, resolved.issue, asString(input.body));
        } catch (e) {
          throw new GraphQLError(e instanceof Error ? e.message : 'Could not add comment');
        }
        return { kind: 'payload', typeName: 'AddCommentPayload', comment: { repo: resolved.repo, issue: resolved.issue, comment } };
      }
      default:
        throw new GraphQLError(`Cannot query field "${fieldName}" on type "Mutation".`);
    }
  }

  if (!isObjectValue(parent)) throw new GraphQLError(`Cannot query field "${fieldName}" on scalar.`);

  switch (parent.kind) {
    case 'user':
      if (fieldName === 'login') return parent.login;
      if (fieldName === 'id') return Buffer.from(`user:${parent.login}`, 'utf8').toString('base64url');
      break;

    case 'repo': {
      const repo = parent.repo;
      switch (fieldName) {
        case 'id': return forge.repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return { kind: 'user', login: repo.owner };
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : { kind: 'ref', name: repo.defaultBranch };
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const issue = repo.issues.get(asInt(args.number) ?? -1);
          return issue === undefined ? null : { kind: 'issue', repo, issue };
        }
        case 'issues': {
          let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null) {
            const wanted = new Set(states.map((state) => state.toLowerCase()));
            issues = issues.filter((issue) => wanted.has(issue.state));
          }
          const orderBy = asRecord(args.orderBy);
          const direction = orderBy.direction === 'DESC' ? 'desc' : 'asc';
          if (direction === 'desc') issues = [...issues].reverse();
          const total = issues.length;
          let start = 0;
          if (typeof args.after === 'string') {
            const cursorNumber = decodeCursor(args.after);
            if (cursorNumber !== null) {
              const index = issues.findIndex((issue) => issue.number === cursorNumber);
              start = index >= 0 ? index + 1 : 0;
            }
          }
          const first = asInt(args.first) ?? 100;
          const page = issues.slice(start, start + first);
          const hasNextPage = start + page.length < issues.length;
          const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as Issue).number) : null;
          return { kind: 'issueConn', repo, items: page, total, hasNextPage, endCursor };
        }
        case 'pullRequests': {
          const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
          const first = asInt(args.first) ?? 100;
          let start = 0;
          if (typeof args.after === 'string') {
            const cursorNumber = decodeCursor(args.after);
            if (cursorNumber !== null) {
              const index = pulls.findIndex((pr) => pr.number === cursorNumber);
              start = index >= 0 ? index + 1 : 0;
            }
          }
          const page = pulls.slice(start, start + first);
          const hasNextPage = start + page.length < pulls.length;
          const endCursor = page.length > 0 ? encodeCursor((page[page.length - 1] as PullRequest).number) : null;
          return { kind: 'prConn', repo, items: page, total: pulls.length, hasNextPage, endCursor };
        }
        case 'pullRequest': {
          const pr = repo.pulls.get(asInt(args.number) ?? -1);
          return pr === undefined ? null : { kind: 'pr', repo, pr };
        }
      }
      break;
    }

    case 'ref':
      if (fieldName === 'name') return parent.name;
      break;

    case 'issue': {
      const issue = parent.issue;
      switch (fieldName) {
        case 'id': return forge.issueGlobalId(parent.repo, issue);
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body': return issue.body;
      }
      break;
    }

    case 'pr': {
      const pr = parent.pr;
      switch (fieldName) {
        case 'id': return forge.pullGlobalId(parent.repo, pr);
        case 'number': return pr.number;
        case 'state': return pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged': return pr.merged;
        case 'headRefName': return pr.headRef;
        case 'baseRefName': return pr.baseRef;
        case 'mergeable': return forge.mergeable(parent.repo, pr);
        case 'title': return pr.title;
        case 'body': return pr.body;
        case 'files': {
          const mergeBase = forge.pullMergeBase(parent.repo, pr);
          const tips = forge.pullTips(parent.repo, pr);
          const baseTree = mergeBase === null ? null : forge.commitOf(parent.repo, mergeBase)?.tree ?? null;
          const headTree = tips.head === null ? null : forge.commitOf(parent.repo, tips.head)?.tree ?? null;
          const files = diffTrees(forge, parent.repo, baseTree, headTree).map((file) => ({
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            status: file.status,
          }));
          const first = asInt(args.first) ?? 100;
          const page = files.slice(0, first);
          return { kind: 'fileConn', files: page, hasNextPage: files.length > page.length, endCursor: null };
        }
      }
      break;
    }

    case 'issueConn':
      switch (fieldName) {
        case 'nodes': return parent.items.map((issue): GqlValue => ({ kind: 'issue', repo: parent.repo, issue }));
        case 'edges': return parent.items.map((issue): GqlValue => ({ kind: 'issueEdge', repo: parent.repo, issue }));
        case 'pageInfo': return { kind: 'pageInfo', hasNextPage: parent.hasNextPage, hasPreviousPage: false, startCursor: parent.items.length > 0 ? encodeCursor((parent.items[0] as Issue).number) : null, endCursor: parent.endCursor };
        case 'totalCount': return parent.total;
      }
      break;

    case 'issueEdge':
      switch (fieldName) {
        case 'node': return { kind: 'issue', repo: parent.repo, issue: parent.issue };
        case 'cursor': return encodeCursor(parent.issue.number);
      }
      break;

    case 'prConn':
      switch (fieldName) {
        case 'nodes': return parent.items.map((pr): GqlValue => ({ kind: 'pr', repo: parent.repo, pr }));
        case 'edges': return parent.items.map((pr): GqlValue => ({ kind: 'prEdge', repo: parent.repo, pr }));
        case 'pageInfo': return { kind: 'pageInfo', hasNextPage: parent.hasNextPage, hasPreviousPage: false, startCursor: parent.items.length > 0 ? encodeCursor((parent.items[0] as PullRequest).number) : null, endCursor: parent.endCursor };
        case 'totalCount': return parent.total;
      }
      break;

    case 'prEdge':
      switch (fieldName) {
        case 'node': return { kind: 'pr', repo: parent.repo, pr: parent.pr };
        case 'cursor': return encodeCursor(parent.pr.number);
      }
      break;

    case 'fileConn':
      switch (fieldName) {
        case 'nodes': return parent.files.map((file): GqlValue => ({ kind: 'file', file }));
        case 'edges': return parent.files.map((file): GqlValue => ({ kind: 'fileEdge', file }));
        case 'pageInfo': return { kind: 'pageInfo', hasNextPage: parent.hasNextPage, hasPreviousPage: false, startCursor: null, endCursor: parent.endCursor };
        case 'totalCount': return parent.files.length;
      }
      break;

    case 'fileEdge':
      switch (fieldName) {
        case 'node': return { kind: 'file', file: parent.file };
        case 'cursor': return Buffer.from(parent.file.path, 'utf8').toString('base64url');
      }
      break;

    case 'file':
      switch (fieldName) {
        case 'path': return parent.file.path;
        case 'additions': return parent.file.additions;
        case 'deletions': return parent.file.deletions;
        case 'changeType': return parent.file.status === 'added' ? 'ADDED' : parent.file.status === 'removed' ? 'DELETED' : parent.file.status === 'renamed' ? 'RENAMED' : 'MODIFIED';
      }
      break;

    case 'comment':
      switch (fieldName) {
        case 'id': return forge.commentGlobalId(parent.repo, parent.issue, parent.comment);
        case 'body': return parent.comment.body;
      }
      break;

    case 'commentEdge':
      switch (fieldName) {
        case 'node': return { kind: 'comment', repo: parent.repo, issue: parent.issue, comment: parent.comment };
        case 'cursor': return forge.commentGlobalId(parent.repo, parent.issue, parent.comment);
      }
      break;

    case 'payload':
      switch (fieldName) {
        case 'issue': return parent.issue === undefined ? null : { kind: 'issue', repo: parent.issue.repo, issue: parent.issue.issue };
        case 'pullRequest': return parent.pr === undefined ? null : { kind: 'pr', repo: parent.pr.repo, pr: parent.pr.pr };
        case 'commentEdge': return parent.comment === undefined ? null : { kind: 'commentEdge', repo: parent.comment.repo, issue: parent.comment.issue, comment: parent.comment.comment };
        case 'clientMutationId': return null;
      }
      break;

    case 'type': {
      const fields = SCHEMA[parent.name];
      const enumValues = ENUMS[parent.name];
      switch (fieldName) {
        case 'name': return parent.name;
        case 'kind': return enumValues !== undefined ? 'ENUM' : 'OBJECT';
        case 'description': return null;
        case 'fields': {
          if (fields === undefined) return null;
          return Object.keys(fields).map((name): GqlValue => ({ kind: 'field', name }));
        }
        case 'enumValues': {
          if (enumValues === undefined) return null;
          return enumValues.map((name): GqlValue => ({ kind: 'enumValue', name }));
        }
        case 'ofType': return null;
        case 'inputFields': return null;
        case 'interfaces': return [];
        case 'possibleTypes': return [];
      }
      break;
    }

    case 'field':
      switch (fieldName) {
        case 'name': return parent.name;
        case 'description': return null;
        case 'args': return [];
        case 'type': return null;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
      }
      break;

    case 'enumValue':
      switch (fieldName) {
        case 'name': return parent.name;
        case 'description': return null;
        case 'isDeprecated': return false;
        case 'deprecationReason': return null;
      }
      break;

    case 'pageInfo':
      switch (fieldName) {
        case 'hasNextPage': return parent.hasNextPage;
        case 'hasPreviousPage': return parent.hasPreviousPage;
        case 'startCursor': return parent.startCursor;
        case 'endCursor': return parent.endCursor;
      }
      break;

    case 'schema':
      switch (fieldName) {
        case 'types': return Object.keys(SCHEMA).map((name): GqlValue => ({ kind: 'type', name }));
        case 'queryType': return { kind: 'type', name: 'Query' };
        case 'mutationType': return { kind: 'type', name: 'Mutation' };
        case 'directives': return [];
      }
      break;
  }
  throw new GraphQLError(`Cannot query field "${fieldName}" on type "${parentType}".`);
}

function executeSelections(
  ctx: ExecContext,
  parent: GqlValue,
  parentType: string,
  selections: SelectionNode[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) continue;
      if (fragment.typeCondition !== parentType) continue;
      Object.assign(result, executeSelections(ctx, parent, parentType, fragment.selections));
      continue;
    }
    if (selection.kind === 'inline') {
      if (selection.typeCondition !== null && selection.typeCondition !== parentType) continue;
      Object.assign(result, executeSelections(ctx, parent, parentType, selection.selections));
      continue;
    }
    const responseKey = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      result[responseKey] = parentType;
      continue;
    }
    const args = evaluateArgs(selection.args, ctx.variables);
    let value: GqlValue | GqlValue[];
    try {
      value = resolveField(ctx, parentType, parent, selection.name, args);
    } catch (e) {
      ctx.errors.push({ message: e instanceof Error ? e.message : String(e) });
      result[responseKey] = null;
      continue;
    }
    if (selection.selections === null || value === null) {
      result[responseKey] = value;
      continue;
    }
    if (Array.isArray(value)) {
      result[responseKey] = value.map((item) => {
        if (item === null) return null;
        if (!isObjectValue(item)) return item;
        return executeSelections(ctx, item, typeNameOf(item), selection.selections as SelectionNode[]);
      });
      continue;
    }
    if (!isObjectValue(value)) {
      result[responseKey] = value;
      continue;
    }
    result[responseKey] = executeSelections(ctx, value, typeNameOf(value), selection.selections);
  }
  return result;
}

// ---------------------------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------------------------

export interface GraphQLResponse {
  status: number;
  body: unknown;
}

function executeOne(
  forge: Forge,
  request: unknown,
): Record<string, unknown> {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return { errors: [{ message: 'Request body must be a JSON object with a query string.' }] };
  }
  const query = (request as Record<string, unknown>).query;
  const operationName = (request as Record<string, unknown>).operationName;
  const rawVariables = (request as Record<string, unknown>).variables;
  if (typeof query !== 'string' || query.trim() === '') {
    return { errors: [{ message: 'Must provide query string.' }] };
  }
  let definitions: DefinitionNode[];
  try {
    definitions = new Parser(lex(query)).parseDocument();
  } catch (e) {
    return { errors: [{ message: e instanceof Error ? e.message : String(e) }] };
  }
  const fragments = new Map<string, FragmentNode>();
  const operations: OperationNode[] = [];
  for (const definition of definitions) {
    if (definition.kind === 'fragment') fragments.set(definition.name, definition);
    else operations.push(definition);
  }
  const validationErrors = validate(definitions, fragments);
  if (validationErrors.length > 0) {
    return { data: null, errors: validationErrors.map((message) => ({ message })) };
  }
  let operation = operations[0];
  if (typeof operationName === 'string') {
    operation = operations.find((op) => op.name === operationName) ?? operation;
  }
  if (operation === undefined) {
    return { errors: [{ message: 'Document contains no operation.' }] };
  }
  const variables: Record<string, unknown> = {};
  for (const def of operation.variables) {
    variables[def.name] = def.defaultValue !== null ? evaluateValue(def.defaultValue, {}) : undefined;
  }
  if (typeof rawVariables === 'object' && rawVariables !== null) {
    for (const [key, value] of Object.entries(rawVariables as Record<string, unknown>)) {
      variables[key] = value;
    }
  }
  const ctx: ExecContext = {
    forge,
    variables,
    fragments,
    errors: [],
  };
  const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(ctx, null, rootType, operation.selections);
  if (ctx.errors.length > 0) return { data, errors: ctx.errors };
  return { data };
}

export function handleGraphQL(forge: Forge, body: unknown, jsonError: boolean): GraphQLResponse {
  if (jsonError) {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  if (Array.isArray(body)) {
    // Batched requests: one envelope per item, in order.
    return { status: 200, body: body.map((item) => executeOne(forge, item)) };
  }
  return { status: 200, body: executeOne(forge, body) };
}
