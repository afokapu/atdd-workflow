import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acknowledgeOwnerAlert, chooseOwnerAlertOption, deliverOwnerAlert, ownerAlertFile,
  resolveOwnerAlert, scanOwnerAlerts,
} from "../src/owner-escalations";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-owner-alert-"));
  roots.push(root);
  await mkdir(join(root, "work", "desk", "seats", "operator"), { recursive: true });
  await mkdir(join(root, "work", "demo", "seats", "coordinator"), { recursive: true });
  await mkdir(join(root, "work", "demo", "seats", "driver.delivery"), { recursive: true });
  await mkdir(join(root, "work", "demo", "tasks"), { recursive: true });
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await writeFile(join(root, "work", "desk", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: desk\n");
  await writeFile(join(root, "work", "demo", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: demo\n");
  await seat(root, "desk", "operator", "operator@desk", "operator");
  await seat(root, "demo", "coordinator", "coordinator@demo", "coordinator");
  await seat(root, "demo", "driver.delivery", "driver.delivery@demo", "driver");
  return root;
}

async function seat(root: string, project: string, local: string, address: string, role: string, checkpoint = "active") {
  await writeFile(join(root, "work", project, "seats", local, "seat.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/seat/v2", address, role, project, worktree: `/tmp/${local}`, branch: "main",
  }));
  await writeFile(join(root, "work", project, "seats", local, "checkpoint.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/checkpoint/v1", seat: address, status: checkpoint,
    updated_at: "2026-10-10T19:00:00.000Z", summary: "fixture", next_action: "fixture",
  }));
}

async function task(root: string, id: string, fields: Record<string, unknown> = {}) {
  await writeFile(join(root, "work", "demo", "tasks", `${id}.yaml`), Bun.YAML.stringify({
    schema: "atdd-workflow/task/v1", title: id, status: "in_progress", coordinator: "coordinator@demo",
    assignee: "driver.delivery@demo", done_when: [{ text: "fixture" }], ...fields,
  }));
}

async function alert(root: string, id: string) {
  return Bun.YAML.parse(await readFile(ownerAlertFile(root, id), "utf8"));
}

test("RED: an explicit material cross-project blocker with no visible fallback persists one redacted owner alert", async () => {
  const root = await fixture();
  await task(root, "blocked", { blocker: "[cross-project] Waiting for upstream decision; token=TOPSECRET" });

  const first = await scanOwnerAlerts(root, { by: "coordinator@demo", now: "2026-10-10T19:30:00.000Z" });
  expect(first.created).toHaveLength(1);
  expect(first.sent).toHaveLength(1);
  const record = await alert(root, first.created[0]);
  expect(record.affected_tasks).toEqual(["demo/blocked"]);
  expect(record.state).toBe("blocked");
  expect(record.evidence).toContain("[cross-project]");
  expect(record.evidence).not.toContain("TOPSECRET");
  expect(record.fallback).toMatchObject({ state: "absent", safe_automatic_action: "none" });
  expect(record.owner_options.map((option: { id: string }) => option.id)).toEqual([
    "authorize-safe-fallback", "provide-cross-project-decision", "hold-or-resolve",
  ]);
  expect(record.prohibited_actions).toContain("Do not infer authorization.");
  expect(record.delivery).toMatchObject({ state: "sent", persisted_at: expect.any(String), sent_at: expect.any(String) });
});

test("RED: waits, productive execution, duplicate observations, and unclassified blockers do not spam", async () => {
  const root = await fixture();
  await task(root, "ordinary-wait", { status: "todo", depends_on: ["blocked"] });
  await task(root, "blocked", { status: "todo" });
  await task(root, "unclassified", { blocker: "Waiting for routine reviewer feedback" });
  expect((await scanOwnerAlerts(root, { by: "coordinator@demo" })).created).toEqual([]);

  await task(root, "material", { blocker: "[toolkit] Required local tool is unavailable" });
  await task(root, "independent", { assignee: "driver.delivery@demo" });
  expect((await scanOwnerAlerts(root, { by: "coordinator@demo" })).created).toEqual([]);

  await writeFile(join(root, "work", "demo", "seats", "driver.delivery", "checkpoint.yaml"), Bun.YAML.stringify({
    schema: "atdd-workflow/checkpoint/v1", seat: "driver.delivery@demo", status: "blocked",
    updated_at: "2026-10-10T19:00:00.000Z", summary: "fixture", next_action: "fixture",
  }));
  const first = await scanOwnerAlerts(root, { by: "coordinator@demo", now: "2026-10-10T19:30:00.000Z" });
  expect(first.created).toHaveLength(1);
  const duplicate = await scanOwnerAlerts(root, { by: "coordinator@demo", now: "2026-10-10T19:31:00.000Z" });
  expect(duplicate.created).toEqual([]);
  expect(duplicate.sent).toEqual([]);
});

test("RED: re-notification is bounded, material change supersedes, and resolution ends an alert", async () => {
  const root = await fixture();
  await task(root, "blocked", { blocker: "[authorization] Awaiting explicit approval" });
  const first = await scanOwnerAlerts(root, { by: "coordinator@demo", now: "2026-10-10T19:30:00.000Z" });
  const id = first.created[0];
  expect((await scanOwnerAlerts(root, { by: "coordinator@demo", now: "2026-10-10T19:30:30.000Z", re_notify_after_ms: 60_000 })).sent).toEqual([]);
  expect((await scanOwnerAlerts(root, { by: "coordinator@demo", now: "2026-10-10T19:32:00.000Z", re_notify_after_ms: 60_000 })).renotified).toEqual([id]);

  await task(root, "blocked", { blocker: "[authorization] Awaiting named approval from operator" });
  const changed = await scanOwnerAlerts(root, { by: "coordinator@demo", now: "2026-10-10T19:33:00.000Z" });
  expect(changed.created).toHaveLength(1);
  expect((await alert(root, id)).state).toBe("superseded");
  await resolveOwnerAlert(root, changed.created[0], { by: "coordinator@demo", reason: "The named approval arrived." });
  expect((await alert(root, changed.created[0])).state).toBe("resolved");
});

test("RED: transport delivery, acknowledgement, and owner-selected execution remain distinct", async () => {
  const root = await fixture();
  await task(root, "blocked", { blocker: "[cross-project] Awaiting upstream response" });
  const id = (await scanOwnerAlerts(root, { by: "coordinator@demo" })).created[0];
  await deliverOwnerAlert(root, id, { by: "operator@desk" });
  expect((await alert(root, id)).delivery.state).toBe("delivered");
  await acknowledgeOwnerAlert(root, id, { by: "operator@desk", note: "I am reviewing the options." });
  expect((await alert(root, id)).delivery.state).toBe("acknowledged");
  await chooseOwnerAlertOption(root, id, { by: "operator@desk", option: "authorize-safe-fallback" });
  const record = await alert(root, id);
  expect(record.delivery.state).toBe("executing");
  expect(record.owner_decision).toMatchObject({ option: "authorize-safe-fallback", by: "operator@desk" });
});

test("RED: a missing owner path records durable unavailable evidence and never claims delivery", async () => {
  const root = await fixture();
  await rm(join(root, "work", "desk", "seats", "operator"), { recursive: true, force: true });
  await task(root, "blocked", { blocker: "[toolkit] Required toolkit is unavailable; password=TOPSECRET" });
  const result = await scanOwnerAlerts(root, { by: "coordinator@demo" });
  expect(result.unavailable).toHaveLength(1);
  const record = await alert(root, result.unavailable[0]);
  expect(record.delivery.state).toBe("owner_unavailable");
  expect(record.delivery).not.toHaveProperty("sent_at");
  expect(record.evidence).not.toContain("TOPSECRET");
});
