import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { now, yaml } from "./core";
import type { TaskStatus } from "./tasks";

/** Deliberately outbound-only Linear projection. Flow records never accept Linear mutations. */
export type MirrorConfig = {
  schema: "atdd-flow/linear-mirror-config/v1";
  routing: { team_id: string; project_id: string; states: Record<TaskStatus, string> };
  allow: { projects: string[]; task_ids?: string[]; fields: Array<"title" | "status" | "body" | "comment"> };
};

type ProjectionTuple = { team_id: string; project_id: string; states: Record<TaskStatus, string>; projects: string[]; task_ids: string[]; fields: string[] };
type LiveAuthorization = { schema: "atdd-flow/linear-mirror-authorization/v1"; id: string; immutable: true; by: "operator@desk"; accepted_at: string; projection: ProjectionTuple };

export type TaskProjection = {
  canonical_id: string;
  project: string;
  task_id: string;
  title: string;
  status: TaskStatus;
  body?: string;
  /** Fields Flow does not project must be named explicitly and are refused. */
  unsupported?: string[];
};

export type MessageProjection = {
  canonical_id: string;
  task_canonical_id: string;
  project: string;
  task_id: string;
  thread_id: string;
  message_id: string;
  body: string;
  unsupported?: string[];
};

type RemoteIssue = { id: string; marker: string; state_id: string };
export type OutboundLinear = {
  /** Lookup by the canonical Flow key makes retry-after-partial-write safe. */
  findIssueByKey(key: string): Promise<RemoteIssue | undefined>;
  createIssue(input: { idempotency_key: string; team_id: string; project_id: string; title: string; description: string; state_id: string; marker: string }): Promise<RemoteIssue>;
  updateIssue(input: { id: string; title: string; description: string; state_id: string; marker: string }): Promise<{ id: string }>;
  /** Lookup prevents a retry after a completed remote comment from creating a duplicate. */
  findCommentByKey(issue_id: string, key: string): Promise<{ id: string } | undefined>;
  createComment(input: { issue_id: string; body: string; idempotency_key: string; marker: string }): Promise<{ id: string }>;
  /** Optional read-only inspection records remote drift but never changes Flow. */
  inspectIssue?(id: string): Promise<RemoteIssue | undefined>;
};

export type MirrorResult = { mode: "dry-run" | "live"; operation: "create" | "update" | "comment"; idempotency_key: string; receipt: string };
type Mapping = { schema: "atdd-flow/linear-mirror-mapping/v1"; canonical_id: string; idempotency_key: string; linear_id: string; created_at: string; immutable: true };
type Evidence = {
  schema: "atdd-flow/linear-mirror-evidence/v1"; immutable: true; at: string; mode: "dry-run" | "live";
  operation: MirrorResult["operation"]; outcome: "planned" | "authorized" | "projected" | "drift" | "refused";
  canonical_id: string; idempotency_key: string; route: { team_id: string; project_id: string }; state_id?: string; linear_id?: string; authorization?: { id: string; content_hash: string }; reason?: string;
};

const rootFor = (root: string) => join(root, ".atdd-flow", "linear-mirror");
const authorizationFile = (root: string, id: string) => join(rootFor(root), "authorizations", `${id}.yaml`);
const authorizationId = (id: string) => {
  if (!/^LMA-[A-Za-z0-9_-]+$/.test(id)) throw new Error("Linear authorization id must start with LMA- and contain only letters, numbers, underscores, or hyphens.");
  return id;
};
const projectionTuple = (config: MirrorConfig): ProjectionTuple => ({
  team_id: config.routing.team_id, project_id: config.routing.project_id, states: config.routing.states,
  projects: [...config.allow.projects].sort(), task_ids: [...(config.allow.task_ids ?? [])].sort(), fields: [...config.allow.fields].sort(),
});
const sameProjection = (left: ProjectionTuple, right: ProjectionTuple) => JSON.stringify(left) === JSON.stringify(right);
const safeName = (value: string) => createHash("sha256").update(value).digest("hex");
const mappingFile = (root: string, canonicalId: string) => join(rootFor(root), "mappings", `${safeName(canonicalId)}.yaml`);
const markerFor = (canonicalId: string) => `<!-- atdd-flow:canonical=${canonicalId} -->`;
const sensitive = /(?:api[_ -]?key|password|secret|token|authorization)\s*[:=]|bearer\s+[a-z0-9._-]+/i;

async function mapping(root: string, canonicalId: string) {
  try { return yaml.parse<Mapping>(await readFile(mappingFile(root, canonicalId), "utf8")); }
  catch { return undefined; }
}

/** Mapping records are append-only: a canonical Flow record can never be rebound to another Linear object. */
async function writeMapping(root: string, value: Mapping) {
  const file = mappingFile(root, value.canonical_id);
  await mkdir(join(rootFor(root), "mappings"), { recursive: true });
  try { await writeFile(file, yaml.print(value), { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = await mapping(root, value.canonical_id);
    if (!prior || prior.linear_id !== value.linear_id || prior.idempotency_key !== value.idempotency_key) {
      throw new Error(`Canonical Flow id ${value.canonical_id} is already mapped inconsistently.`);
    }
  }
}

/** Evidence has no source body, token, or mutable filename; it is safe to retain in the Desk. */
async function receipt(root: string, value: Evidence) {
  const folder = join(rootFor(root), "evidence");
  await mkdir(folder, { recursive: true });
  const file = join(folder, `${now().replace(/[^0-9]/g, "")}-${randomUUID()}.yaml`);
  await writeFile(file, yaml.print(value), { encoding: "utf8", flag: "wx" });
  return file;
}

function refuse(config: MirrorConfig, item: { project?: string; task_id?: string; canonical_id: string; unsupported?: string[]; title?: string; body?: string }, comments = false) {
  if (config.schema !== "atdd-flow/linear-mirror-config/v1") throw new Error("Unsupported Linear mirror configuration.");
  const route = config.routing;
  if (!route?.team_id?.trim() || !route.project_id?.trim() || !route.states) throw new Error("Linear mirror routing requires exact team_id, project_id, and status mapping.");
  for (const state of ["todo", "in_progress", "review", "done"] as const) if (!route.states[state]?.trim()) throw new Error(`Linear mirror routing has no mapping for ${state}.`);
  if (!Array.isArray(config.allow?.projects) || !config.allow.projects.includes(item.project ?? "")) throw new Error(`Flow project ${item.project ?? ""} is not allowlisted for Linear projection.`);
  if (item.task_id && config.allow.task_ids && !config.allow.task_ids.includes(item.task_id)) throw new Error(`Flow task ${item.task_id} is not allowlisted for Linear projection.`);
  if (item.unsupported?.length) throw new Error(`Unsupported Flow fields are not projectable: ${item.unsupported.join(", ")}.`);
  if (comments && !config.allow.fields.includes("comment")) throw new Error("Linear comment projection is not allowlisted.");
  if (!comments && (!config.allow.fields.includes("title") || !config.allow.fields.includes("status"))) throw new Error("Linear task projection requires title and status allowlist entries.");
  for (const value of [item.title, item.body]) if (value && sensitive.test(value)) throw new Error("Sensitive content was refused by the Linear redaction policy.");
}

function taskPayload(config: MirrorConfig, item: TaskProjection) {
  const marker = markerFor(item.canonical_id);
  const description = config.allow.fields.includes("body") && item.body ? `${item.body}\n\n${marker}` : marker;
  return { marker, description, state_id: config.routing.states[item.status] };
}

/** Only the human authority can create a write-once approval bound to this exact projection tuple. */
export async function authorizeLiveProjection(root: string, config: MirrorConfig, input: { id: string; by: string }) {
  if (input.by !== "operator@desk") throw new Error("Only operator@desk may authorize a live Linear projection.");
  refuse(config, { canonical_id: "authorization", project: config.allow.projects[0] ?? "" });
  const id = authorizationId(input.id);
  const record: LiveAuthorization = { schema: "atdd-flow/linear-mirror-authorization/v1", id, immutable: true, by: "operator@desk", accepted_at: now(), projection: projectionTuple(config) };
  await mkdir(join(rootFor(root), "authorizations"), { recursive: true });
  try { await writeFile(authorizationFile(root, id), yaml.print(record), { encoding: "utf8", flag: "wx" }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = yaml.parse<LiveAuthorization>(await readFile(authorizationFile(root, id), "utf8"));
    if (prior.schema !== record.schema || prior.id !== id || prior.immutable !== true || prior.by !== "operator@desk" || !sameProjection(prior.projection, record.projection)) throw new Error(`Live Linear authorization ${id} already exists with a different or mutable approval.`);
  }
  return authorizationFile(root, id);
}

type ResolvedMode = { mode: "dry-run" } | { mode: "live"; authorization: { id: string; content_hash: string } };

async function mode(root: string, config: MirrorConfig, options?: { apply?: boolean; authorization?: string }): Promise<ResolvedMode> {
  if (!options?.apply) return { mode: "dry-run" };
  const id = authorizationId(options.authorization ?? "");
  let source: string;
  let record: LiveAuthorization;
  try { source = await readFile(authorizationFile(root, id), "utf8"); record = yaml.parse<LiveAuthorization>(source); }
  catch { throw new Error(`Live Linear authorization ${id} is absent from the immutable Desk authorization store.`); }
  if (record.schema !== "atdd-flow/linear-mirror-authorization/v1" || record.id !== id || record.immutable !== true || record.by !== "operator@desk" || !sameProjection(record.projection, projectionTuple(config))) {
    throw new Error(`Live Linear authorization ${id} does not bind operator@desk to this exact route and projection allowlist.`);
  }
  return { mode: "live", authorization: { id, content_hash: createHash("sha256").update(source).digest("hex") } };
}

async function recordRefusal(root: string, config: MirrorConfig, canonical_id: string, key: string, reason: string) {
  return receipt(root, {
    schema: "atdd-flow/linear-mirror-evidence/v1", immutable: true, at: now(), mode: "live", operation: "create", outcome: "refused",
    canonical_id, idempotency_key: key, route: { team_id: config.routing?.team_id ?? "", project_id: config.routing?.project_id ?? "" }, reason,
  });
}

export async function mirrorTask(root: string, config: MirrorConfig, item: TaskProjection, linear: OutboundLinear, options?: { apply?: boolean; authorization?: string }): Promise<MirrorResult> {
  const key = item.canonical_id;
  try { refuse(config, item); }
  catch (error) { await recordRefusal(root, config, key, key, (error as Error).message); throw error; }
  let selected: ResolvedMode;
  try { selected = await mode(root, config, options); }
  catch (error) { await recordRefusal(root, config, key, key, (error as Error).message); throw error; }
  const selectedMode = selected.mode;
  const payload = taskPayload(config, item);
  let prior = await mapping(root, key);
  let operation: MirrorResult["operation"] = prior ? "update" : "create";
  if (!prior && selectedMode === "live") {
    const remote = await linear.findIssueByKey(key);
    if (remote) {
      await writeMapping(root, { schema: "atdd-flow/linear-mirror-mapping/v1", canonical_id: key, idempotency_key: key, linear_id: remote.id, created_at: now(), immutable: true });
      prior = await mapping(root, key);
      operation = "update";
    }
  }
  const evidence = (outcome: Evidence["outcome"], extra: Partial<Evidence> = {}) => receipt(root, {
    schema: "atdd-flow/linear-mirror-evidence/v1", immutable: true, at: now(), mode: selectedMode, operation, outcome,
    canonical_id: key, idempotency_key: key, route: { team_id: config.routing.team_id, project_id: config.routing.project_id }, state_id: payload.state_id,
    ...(selected.mode === "live" ? { authorization: selected.authorization } : {}), ...extra,
  });
  if (selectedMode === "dry-run") return { mode: selectedMode, operation, idempotency_key: key, receipt: await evidence("planned") };

  if (!prior) {
    await evidence("authorized");
    const remote = await linear.createIssue({ idempotency_key: key, team_id: config.routing.team_id, project_id: config.routing.project_id, title: item.title, description: payload.description, state_id: payload.state_id, marker: payload.marker });
    await writeMapping(root, { schema: "atdd-flow/linear-mirror-mapping/v1", canonical_id: key, idempotency_key: key, linear_id: remote.id, created_at: now(), immutable: true });
    return { mode: selectedMode, operation, idempotency_key: key, receipt: await evidence("projected", { linear_id: remote.id }) };
  }

  if (linear.inspectIssue) {
    const remote = await linear.inspectIssue(prior.linear_id);
    if (!remote || !remote.marker.includes(payload.marker)) {
      const file = await evidence("drift", { linear_id: prior.linear_id, reason: "Mapped Linear issue is missing its canonical Flow marker." });
      throw new Error(`Linear drift detected for ${key}; receipt: ${file}`);
    }
  }
  await evidence("authorized");
  await linear.updateIssue({ id: prior.linear_id, title: item.title, description: payload.description, state_id: payload.state_id, marker: payload.marker });
  return { mode: selectedMode, operation, idempotency_key: key, receipt: await evidence("projected", { linear_id: prior.linear_id }) };
}

/** Messages can only become outbound comments on an already mapped Flow task. */
export async function mirrorMessage(root: string, config: MirrorConfig, item: MessageProjection, linear: OutboundLinear, options?: { apply?: boolean; authorization?: string }): Promise<MirrorResult> {
  const key = item.canonical_id;
  try { refuse(config, { project: item.project, task_id: item.task_id, canonical_id: key, body: item.body, unsupported: item.unsupported }, true); }
  catch (error) { await recordRefusal(root, config, key, key, (error as Error).message); throw error; }
  let selected: ResolvedMode;
  try { selected = await mode(root, config, options); }
  catch (error) { await recordRefusal(root, config, key, key, (error as Error).message); throw error; }
  const selectedMode = selected.mode;
  const parent = await mapping(root, item.task_canonical_id);
  if (!parent) throw new Error(`Cannot project ${key}: its authoritative Flow task has no Linear mapping.`);
  const marker = markerFor(key);
  const folderReceipt = async (outcome: Evidence["outcome"], linear_id?: string) => receipt(root, {
    schema: "atdd-flow/linear-mirror-evidence/v1", immutable: true, at: now(), mode: selectedMode, operation: "comment", outcome,
    canonical_id: key, idempotency_key: key, route: { team_id: config.routing.team_id, project_id: config.routing.project_id }, linear_id,
    ...(selected.mode === "live" ? { authorization: selected.authorization } : {}),
  });
  if (selectedMode === "dry-run") return { mode: selectedMode, operation: "comment", idempotency_key: key, receipt: await folderReceipt("planned", parent.linear_id) };
  // This receipt precedes both remote lookup and creation, so a failed lookup
  // leaves immutable operator authorization evidence without an external write.
  await folderReceipt("authorized", parent.linear_id);
  let existing = await mapping(root, key);
  if (!existing) {
    const remote = await linear.findCommentByKey(parent.linear_id, key);
    if (remote) {
      await writeMapping(root, { schema: "atdd-flow/linear-mirror-mapping/v1", canonical_id: key, idempotency_key: key, linear_id: remote.id, created_at: now(), immutable: true });
      existing = await mapping(root, key);
    }
  }
  if (existing) return { mode: selectedMode, operation: "comment", idempotency_key: key, receipt: await folderReceipt("projected", existing.linear_id) };
  const remote = await linear.createComment({ issue_id: parent.linear_id, body: `${item.body}\n\n${marker}`, idempotency_key: key, marker });
  await writeMapping(root, { schema: "atdd-flow/linear-mirror-mapping/v1", canonical_id: key, idempotency_key: key, linear_id: remote.id, created_at: now(), immutable: true });
  return { mode: selectedMode, operation: "comment", idempotency_key: key, receipt: await folderReceipt("projected", remote.id) };
}

/** There is intentionally no parser or writer from Linear to Flow. */
export async function applyInboundChange(_root: string, _change: unknown): Promise<never> {
  throw new Error("Linear mirror is one-way: inbound Linear changes are refused and cannot mutate Flow.");
}

export async function readMirrorConfig(file: string) {
  return yaml.parse<MirrorConfig>(await readFile(file, "utf8"));
}

type GraphqlResponse<T> = { data?: T; errors?: Array<{ message?: string }> };

/**
 * Small typed GraphQL edge for the outbound seam. The token is read only at
 * invocation and is never stored in config, mappings, receipts, or output.
 */
export function linearGraphql(apiKey: string, endpoint = "https://api.linear.app/graphql"): OutboundLinear {
  if (!apiKey.trim()) throw new Error("LINEAR_API_KEY is required for a live Linear projection.");
  const execute = async <T>(query: string, variables: Record<string, unknown>) => {
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ query, variables }),
    });
    const value = await response.json() as GraphqlResponse<T>;
    if (!response.ok || value.errors?.length || !value.data) throw new Error(`Linear GraphQL refused outbound projection: ${value.errors?.map((entry) => entry.message).join("; ") || response.statusText}`);
    return value.data;
  };
  const queryIssues = `query MirrorIssue($marker: String!) { issues(filter: { description: { contains: $marker } }) { nodes { id description state { id } } } }`;
  const remote = (value: { id: string; description?: string; state?: { id?: string } }) => ({ id: value.id, marker: value.description ?? "", state_id: value.state?.id ?? "" });
  return {
    async findIssueByKey(key) {
      const marker = markerFor(key);
      const data = await execute<{ issues: { nodes: Array<{ id: string; description?: string; state?: { id?: string } }> } }>(queryIssues, { marker });
      const found = data.issues.nodes.find((entry) => entry.description?.includes(marker));
      return found ? remote(found) : undefined;
    },
    async createIssue(input) {
      const data = await execute<{ issueCreate: { success: boolean; issue?: { id: string; description?: string; state?: { id?: string } } } }>(
        `mutation CreateMirrorIssue($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id description state { id } } } }`,
        { input: { teamId: input.team_id, projectId: input.project_id, title: input.title, description: input.description, stateId: input.state_id } },
      );
      if (!data.issueCreate.success || !data.issueCreate.issue) throw new Error("Linear did not confirm issue creation.");
      return { ...remote(data.issueCreate.issue), marker: input.marker };
    },
    async updateIssue(input) {
      const data = await execute<{ issueUpdate: { success: boolean; issue?: { id: string } } }>(
        `mutation UpdateMirrorIssue($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id } } }`,
        { id: input.id, input: { title: input.title, description: input.description, stateId: input.state_id } },
      );
      if (!data.issueUpdate.success || !data.issueUpdate.issue) throw new Error("Linear did not confirm issue update.");
      return data.issueUpdate.issue;
    },
    async findCommentByKey(issue_id, key) {
      const marker = markerFor(key);
      const data = await execute<{ issue: { comments: { nodes: Array<{ id: string; body?: string }> } } | null }>(
        `query MirrorComment($id: String!) { issue(id: $id) { comments { nodes { id body } } } }`, { id: issue_id },
      );
      return data.issue?.comments.nodes.find((entry) => entry.body?.includes(marker));
    },
    async createComment(input) {
      const data = await execute<{ commentCreate: { success: boolean; comment?: { id: string } } }>(
        `mutation CreateMirrorComment($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id } } }`,
        { input: { issueId: input.issue_id, body: input.body } },
      );
      if (!data.commentCreate.success || !data.commentCreate.comment) throw new Error("Linear did not confirm comment creation.");
      return data.commentCreate.comment;
    },
    async inspectIssue(id) {
      const data = await execute<{ issue: { id: string; description?: string; state?: { id?: string } } | null }>(
        `query InspectMirrorIssue($id: String!) { issue(id: $id) { id description state { id } } }`, { id },
      );
      return data.issue ? remote(data.issue) : undefined;
    },
  };
}
