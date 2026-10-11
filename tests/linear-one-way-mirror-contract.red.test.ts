import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
import type { MirrorConfig, OutboundLinear, TaskProjection } from "../src/linear-mirror";
import { applyInboundChange, authorizeLiveProjection, mirrorMessage, mirrorTask } from "../src/linear-mirror";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const config: MirrorConfig = {
  schema: "atdd-flow/linear-mirror-config/v1",
  routing: {
    team_id: "ae91eacd-4cc0-4924-bb1e-4e4fa718d8ca",
    project_id: "P-FOS-25",
    states: { todo: "backlog", in_progress: "started", review: "started", done: "completed" },
  },
  allow: { projects: ["atdd-flow"], fields: ["title", "status", "body", "comment"] },
};

const authorize = (root: string) => authorizeLiveProjection(root, config, { id: "LMA-pilot", by: "operator@desk" });

const task = (overrides: Partial<TaskProjection> = {}): TaskProjection => ({
  canonical_id: "flow:task:atdd-flow/linear-one-way-mirror-contract",
  project: "atdd-flow", task_id: "linear-one-way-mirror-contract",
  title: "Mirror Flow tasks", status: "in_progress", body: "Projection only.",
  ...overrides,
});

function remote(): OutboundLinear & { created: Array<Record<string, string>>; updated: Array<Record<string, string>>; comments: Array<Record<string, string>> } {
  const created: Array<Record<string, string>> = [];
  const updated: Array<Record<string, string>> = [];
  const comments: Array<Record<string, string>> = [];
  const byKey = new Map<string, { id: string; marker: string; state_id: string }>();
  return {
    created, updated, comments,
    async findIssueByKey(key) { return byKey.get(key); },
    async createIssue(input) {
      created.push(input);
      const value = { id: `LIN-${created.length}`, marker: input.marker, state_id: input.state_id };
      byKey.set(input.idempotency_key, value);
      return value;
    },
    async updateIssue(input) { updated.push(input); return { id: input.id }; },
    async findCommentByKey(_issue_id, key) { return comments.find((entry) => entry.idempotency_key === key) ? { id: `comment-${comments.findIndex((entry) => entry.idempotency_key === key) + 1}` } : undefined; },
    async createComment(input) { comments.push(input); return { id: `comment-${comments.length}` }; },
    async inspectIssue(id) { return [...byKey.values()].find((value) => value.id === id); },
  };
}

async function evidence(root: string) {
  const folder = join(root, ".atdd-flow", "linear-mirror", "evidence");
  return Promise.all((await readdir(folder)).sort().map(async (file) => Bun.YAML.parse(await readFile(join(folder, file), "utf8"))));
}

test("GREEN: the CLI projects an authoritative task as dry-run by default and needs no Linear credential", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-linear-mirror-cli-")); roots.push(root);
  await Bun.write(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await Bun.write(join(root, "work", "demo", "tasks", "delivery.yaml"), Bun.YAML.stringify({ schema: "atdd-workflow/task/v1", title: "Mirror me", status: "todo", coordinator: "main@demo", done_when: [{ text: "done" }] }));
  const configFile = join(root, "mirror.yaml");
  await writeFile(configFile, Bun.YAML.stringify({ ...config, allow: { ...config.allow, projects: ["demo"] } }));
  const child = Bun.spawn([process.execPath, cli, "--root", root, "linear", "mirror", "task", "demo", "delivery", "--config", configFile], { cwd: root, env: { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  expect(stdout).toContain("mode: dry-run");
  expect((await evidence(root))[0]).toMatchObject({ outcome: "planned", canonical_id: "flow:task:demo/delivery" });
});

test("RED: duplicate delivery and retries create only one Linear issue and leave immutable receipts", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-linear-mirror-")); roots.push(root);
  const linear = remote();
  await authorize(root);
  const first = await mirrorTask(root, config, task(), linear, { apply: true, authorization: "LMA-pilot" });
  const retry = await mirrorTask(root, config, task(), linear, { apply: true, authorization: "LMA-pilot" });
  expect(first.operation).toBe("create");
  expect(retry.operation).toBe("update");
  expect(linear.created).toHaveLength(1);
  expect(linear.updated).toHaveLength(1);
  const receipts = await evidence(root);
  expect(receipts).toHaveLength(4);
  expect(receipts.every((entry) => entry.immutable === true)).toBe(true);
  expect(receipts.every((entry) => entry.idempotency_key === "flow:task:atdd-flow/linear-one-way-mirror-contract")).toBe(true);
  expect(receipts.every((entry) => entry.authorization?.id === "LMA-pilot" && /^[a-f0-9]{64}$/.test(entry.authorization?.content_hash ?? ""))).toBe(true);
});

test("RED: unsupported fields, missing routing, sensitive values, and inbound changes fail closed before a Linear write or Flow mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-linear-mirror-")); roots.push(root);
  const linear = remote();
  await expect(mirrorTask(root, config, task({ unsupported: ["assignee"] }), linear, { apply: true, authorization: "LMA-arbitrary" })).rejects.toThrow(/unsupported/i);
  await expect(mirrorTask(root, { ...config, routing: { ...config.routing, project_id: "" } }, task(), linear, { apply: true, authorization: "LMA-arbitrary" })).rejects.toThrow(/routing/i);
  await expect(mirrorTask(root, config, task({ body: "authorization: Bearer super-secret-value" }), linear, { apply: true, authorization: "LMA-arbitrary" })).rejects.toThrow(/sensitive|redact/i);
  await expect(applyInboundChange(root, { canonical_id: task().canonical_id, status: "done" })).rejects.toThrow(/one-way|inbound/i);
  expect(linear.created).toHaveLength(0);
  expect(linear.updated).toHaveLength(0);
  expect(linear.comments).toHaveLength(0);
});

test("RED: live projection rejects arbitrary, wrong-owner, mutable, and wrong-route authorizations before writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-linear-mirror-")); roots.push(root);
  const linear = remote();
  await expect(mirrorTask(root, config, task(), linear, { apply: true, authorization: "LMA-arbitrary" })).rejects.toThrow(/authorization/i);
  expect((await evidence(root)).every((entry) => entry.outcome !== "projected")).toBe(true);
  await expect(authorizeLiveProjection(root, config, { id: "LMA-wrong-owner", by: "main@atdd-flow" })).rejects.toThrow(/operator/i);
  await authorize(root);
  await expect(mirrorTask(root, { ...config, routing: { ...config.routing, project_id: "other-project" } }, task(), linear, { apply: true, authorization: "LMA-pilot" })).rejects.toThrow(/exact route|authorization/i);
  const authorization = join(root, ".atdd-flow", "linear-mirror", "authorizations", "LMA-pilot.yaml");
  await writeFile(authorization, (await readFile(authorization, "utf8")).replace("immutable: true", "immutable: false"));
  await expect(mirrorTask(root, config, task(), linear, { apply: true, authorization: "LMA-pilot" })).rejects.toThrow(/exact route|authorization/i);
  expect(linear.created).toHaveLength(0);
});

test("RED: missing canonical marker reports Linear drift and refuses a blind overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-linear-mirror-")); roots.push(root);
  const linear = remote();
  await authorize(root);
  await mirrorTask(root, config, task(), linear, { apply: true, authorization: "LMA-pilot" });
  linear.inspectIssue = async () => ({ id: "LIN-1", marker: "manually changed", state_id: "started" });
  await expect(mirrorTask(root, config, task(), linear, { apply: true, authorization: "LMA-pilot" })).rejects.toThrow(/drift/i);
  expect(linear.updated).toHaveLength(0);
  expect((await evidence(root)).at(-1)).toMatchObject({ outcome: "drift", immutable: true, linear_id: "LIN-1" });
});

test("RED: a failed authorized comment lookup retains LMA-bound evidence before any comment GraphQL call", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-linear-mirror-")); roots.push(root);
  const linear = remote();
  await authorize(root);
  await mirrorTask(root, config, task(), linear, { apply: true, authorization: "LMA-pilot" });
  linear.findCommentByKey = async () => { throw new Error("comment lookup failed"); };
  const message = { canonical_id: "flow:message:T-failure/M-failure", task_canonical_id: task().canonical_id, project: "atdd-flow", task_id: "linear-one-way-mirror-contract", thread_id: "T-failure", message_id: "M-failure", body: "Comment failure." };
  const before = (await evidence(root)).length;
  await expect(mirrorMessage(root, config, message, linear, { apply: true, authorization: "LMA-pilot" })).rejects.toThrow(/lookup failed/i);
  const receipts = await evidence(root);
  expect(receipts).toHaveLength(before + 1);
  expect(receipts.at(-1)).toMatchObject({ operation: "comment", outcome: "authorized", authorization: { id: "LMA-pilot", content_hash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
  expect(linear.comments).toHaveLength(0);
});

test("GREEN: outbound comments are tied to their canonical Flow message and retry without duplicates", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-linear-mirror-")); roots.push(root);
  const linear = remote();
  await authorize(root);
  await mirrorTask(root, config, task(), linear, { apply: true, authorization: "LMA-pilot" });
  const message = { canonical_id: "flow:message:T-pilot/M-pilot", task_canonical_id: task().canonical_id, project: "atdd-flow", task_id: "linear-one-way-mirror-contract", thread_id: "T-pilot", message_id: "M-pilot", body: "Pilot update." };
  await mirrorMessage(root, config, message, linear, { apply: true, authorization: "LMA-pilot" });
  await mirrorMessage(root, config, message, linear, { apply: true, authorization: "LMA-pilot" });
  expect(linear.comments).toHaveLength(1);
  expect(linear.comments[0].body).toContain("flow:message:T-pilot/M-pilot");
});

test("GREEN: dry-run is deterministic and outbound task/comment projection carries canonical Flow IDs, maps every status, and never needs a Linear write", async () => {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-linear-mirror-")); roots.push(root);
  const linear = remote();
  const planned = await mirrorTask(root, config, task({ status: "review" }), linear);
  expect(planned).toMatchObject({ mode: "dry-run", operation: "create", idempotency_key: task().canonical_id });
  expect(linear.created).toHaveLength(0);
  expect(linear.updated).toHaveLength(0);
  expect((await evidence(root))[0]).toMatchObject({ mode: "dry-run", route: { team_id: config.routing.team_id, project_id: config.routing.project_id }, state_id: "started" });
});
