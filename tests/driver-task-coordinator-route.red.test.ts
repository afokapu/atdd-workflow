import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const roots: string[] = [];
const timeout = 20_000;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type Fixture = { project: string; local: string; role: string };
type TaskFixture = { id: string; project?: string; status: string; coordinator: string; assignee: string };

const seats: Fixture[] = [
  { project: "desk", local: "operator", role: "operator" },
  { project: "demo", local: "main", role: "main" },
  { project: "demo", local: "coordinator", role: "coordinator" },
  { project: "demo", local: "driver.one", role: "driver" },
  { project: "demo", local: "driver.two", role: "driver" },
  { project: "other", local: "main", role: "main" },
];

async function fixture(tasks: TaskFixture[]) {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-driver-route-"));
  roots.push(root);
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  for (const name of ["desk", "demo", "other"]) {
    await mkdir(join(root, "work", name, "tasks"), { recursive: true });
    await writeFile(join(root, "work", name, "project.yaml"), `schema: atdd-workflow/project/v1\nproject: ${name}\n`);
  }
  for (const entry of seats) {
    const folder = join(root, "work", entry.project, "seats", entry.local);
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, "seat.yaml"), Bun.YAML.stringify({
      schema: "atdd-workflow/seat/v2", address: `${entry.local}@${entry.project}`, role: entry.role,
      project: entry.project, worktree: `/tmp/${entry.project}-${entry.local}`, branch: entry.role === "driver" ? `delivery/${entry.local}` : "main",
    }));
  }
  for (const entry of tasks) {
    await writeFile(join(root, "work", entry.project ?? "demo", "tasks", `${entry.id}.yaml`), Bun.YAML.stringify({
      schema: "atdd-workflow/task/v1", title: `Task ${entry.id}`, status: entry.status,
      coordinator: entry.coordinator, assignee: entry.assignee, done_when: [{ text: "Works" }],
    }));
  }
  return root;
}

async function invoke(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output: `${stdout}${stderr}`.trim(), stdout: stdout.trim(), exitCode };
}

async function ok(root: string, ...args: string[]) {
  const outcome = await invoke(root, ...args);
  expect(outcome.exitCode, outcome.output).toBe(0);
  return outcome.stdout;
}

async function rejected(root: string, ...args: string[]) {
  const outcome = await invoke(root, ...args);
  expect(outcome.exitCode, outcome.output).not.toBe(0);
  return outcome.output;
}

const everyone = "operator@desk,main@demo,coordinator@demo,driver.one@demo,driver.two@demo,main@other";

test("RED: a driver may message, receipt and result to main when main coordinates its own active task", async () => {
  const root = await fixture([{ id: "active", status: "in_progress", coordinator: "main@demo", assignee: "driver.one@demo" }]);
  const thread = await ok(root, "thread", "start", "--with", everyone, "--subject", "Main route");

  const request = await ok(root, "post", thread, "--from", "main@demo", "--to", "driver.one@demo", "--expects-result", "--body", "Return RED evidence.");
  // Each route is attempted independently so RED shows message, receipt and result all rejected on base.
  const outcomes = {
    message: await invoke(root, "post", thread, "--from", "driver.one@demo", "--to", "main@demo", "--body", "PLAN handoff ready."),
    receipt: await invoke(root, "receipt", thread, request, "--from", "driver.one@demo"),
    result: await invoke(root, "result", thread, request, "--from", "driver.one@demo", "--body", "RED committed."),
  };
  expect(Object.fromEntries(Object.entries(outcomes).map(([kind, outcome]) => [kind, outcome.exitCode === 0 ? "ok" : outcome.output])))
    .toEqual({ message: "ok", receipt: "ok", result: "ok" });

  // The existing driver -> coordinator route keeps working.
  await ok(root, "post", thread, "--from", "driver.one@demo", "--to", "coordinator@demo", "--body", "Still reachable.");
}, timeout);

test("RED: a driver may reply to main for todo and review tasks main coordinates", async () => {
  for (const status of ["todo", "review"]) {
    const root = await fixture([{ id: "open", status, coordinator: "main@demo", assignee: "driver.one@demo" }]);
    const thread = await ok(root, "thread", "start", "--with", everyone, "--subject", `Main route ${status}`);
    await ok(root, "post", thread, "--from", "driver.one@demo", "--to", "main@demo", "--body", `Status ${status}.`);
  }
}, timeout);

test("GUARD: a driver with an active main-coordinated task still cannot reach operator, other drivers or other projects", async () => {
  const root = await fixture([{ id: "active", status: "in_progress", coordinator: "main@demo", assignee: "driver.one@demo" }]);
  const thread = await ok(root, "thread", "start", "--with", everyone, "--subject", "Guards");

  expect(await rejected(root, "post", thread, "--from", "driver.one@demo", "--to", "operator@desk", "--body", "Escalate."))
    .toContain("may not directly address operator@desk");
  expect(await rejected(root, "post", thread, "--from", "driver.one@demo", "--to", "driver.two@demo", "--body", "Hi."))
    .toContain("may message only a coordinator");
  expect(await rejected(root, "post", thread, "--from", "driver.one@demo", "--to", "main@other", "--body", "Hi."))
    .toContain("may message only a coordinator");
  expect(await rejected(root, "post", thread, "--from", "driver.one@demo", "--to", "main@demo,driver.two@demo", "--body", "Mixed."))
    .toContain("may message only a coordinator");
}, timeout);

test("GUARD: a driver cannot reach main when its main-coordinated task is done, absent, or belongs to another driver", async () => {
  const cases: TaskFixture[][] = [
    [{ id: "finished", status: "done", coordinator: "main@demo", assignee: "driver.one@demo" }],
    [],
    [{ id: "theirs", status: "in_progress", coordinator: "main@demo", assignee: "driver.two@demo" }],
    [{ id: "elsewhere", project: "other", status: "in_progress", coordinator: "main@other", assignee: "driver.one@demo" }],
  ];
  for (const tasks of cases) {
    const root = await fixture(tasks);
    const thread = await ok(root, "thread", "start", "--with", everyone, "--subject", "No active task");
    expect(await rejected(root, "post", thread, "--from", "driver.one@demo", "--to", "main@demo", "--body", "Hi."))
      .toContain("may message only a coordinator");
  }
}, timeout);

test("GUARD: a driver's active task in its own project does not open a route to another project's main", async () => {
  const root = await fixture([
    { id: "active", status: "in_progress", coordinator: "main@demo", assignee: "driver.one@demo" },
    { id: "foreign", project: "other", status: "in_progress", coordinator: "main@other", assignee: "driver.one@demo" },
  ]);
  const thread = await ok(root, "thread", "start", "--with", everyone, "--subject", "Cross project");
  expect(await rejected(root, "post", thread, "--from", "driver.one@demo", "--to", "main@other", "--body", "Hi."))
    .toContain("may message only a coordinator");
}, timeout);
