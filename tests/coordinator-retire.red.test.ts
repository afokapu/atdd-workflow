import { afterEach, expect, test as bunTest } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * RED contract for retiring completed coordinator seats and for resolving the
 * ATDD Bun used by retirement: primary checkout copy, then a primary checkout
 * that is the ATDD Bun package source, then PATH — never the seat worktree copy.
 * Every fixture lives below mkdtemp; ATDD Bun calls go through logging wrappers
 * that delegate to the real locally installed ATDD Bun.
 */
const roots: string[] = [];
const cli = join(import.meta.dir, "..", "src", "cli.ts");
const realBun = join(import.meta.dir, "..", "node_modules", ".bin", "atdd-bun");
const test = (name: string, body: () => unknown | Promise<unknown>) => bunTest(name, body, 30_000);

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

type Environment = Record<string, string | undefined>;

async function spawnCli(cwd: string, environment: Environment, args: string[]) {
  const child = Bun.spawn([process.execPath, cli, ...args], { cwd, env: environment, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout: stdout.trim(), stderr: stderr.trim(), code };
}

async function run(cwd: string, environment: Environment, ...args: string[]) {
  const result = await spawnCli(cwd, environment, args);
  expect(result.code, result.stderr).toBe(0);
  return result.stdout;
}

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code, stderr).toBe(0);
  return stdout.trim();
}

/** Writes an `atdd-bun` wrapper that logs `<label> <cwd>` and delegates to the real ATDD Bun. */
async function wrapper(directory: string, label: string, log: string) {
  await mkdir(directory, { recursive: true });
  const file = join(directory, "atdd-bun");
  await writeFile(file, `#!/bin/sh\nprintf '%s %s\\n' '${label}' "$(pwd -P)" >> '${log}'\nexec '${process.execPath}' '${await realpath(realBun)}' "$@"\n`);
  await chmod(file, 0o755);
}

/** A repository with linked-worktree policy, main@demo on the primary checkout, and named coordinators/drivers. */
async function desk(options: { coordinators?: string[]; drivers?: string[]; packageSource?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "atdd-coordinator-retire-"));
  roots.push(root);
  const repository = join(root, "repository");
  const worktrees = join(root, "worktrees");
  const site = join(root, "site");
  const log = join(root, "atdd-bun.log");
  const environment: Environment = { ...process.env, ATDD_WORKFLOW_ROOT: undefined, ATDD_WORKFLOW_SEAT: undefined, HERDR_SESSION: undefined, HERDR_PANE_ID: undefined };
  await git(root, "init", "-b", "main", repository);
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, ".gitignore"), "node_modules/\n");
  await writeFile(join(repository, "atdd-bun.yaml"), "worktrees:\n  enabled: true\n  root: ../worktrees\n  primary_directory: repository\n  primary_branch: main\n  require_linked_worktree: true\n");
  const tracked = [".gitignore", "atdd-bun.yaml"];
  if (options.packageSource) {
    await writeFile(join(repository, "package.json"), JSON.stringify({ name: "@afokapu/atdd-bun", type: "module" }));
    await mkdir(join(repository, "src"));
    await writeFile(join(repository, "src", "cli.ts"), `import { appendFileSync, realpathSync } from "node:fs";
appendFileSync(${JSON.stringify(log)}, "source " + realpathSync(process.cwd()) + "\\n");
const child = Bun.spawnSync([process.execPath, ${JSON.stringify(await realpath(realBun))}, ...process.argv.slice(2)], { stdout: "inherit", stderr: "inherit" });
process.exit(child.exitCode ?? 1);
`);
    tracked.push("package.json", "src/cli.ts");
  }
  await git(repository, "add", ...tracked);
  await git(repository, "commit", "-m", "configure worktrees");
  await run(root, environment, "init", site);
  await run(site, environment, "project", "init", "demo");
  await writeFile(join(site, "work", "demo", "project.yaml"), `schema: atdd-workflow/project/v1
project: demo
repository: ${repository}
worktree_root: ${worktrees}
roles:
  main:
    address: main@{project}
    branch: main
    worktree: "{repository}"
  coordinator:
    address: coordinator.{name}@{project}
    branch: integration/{name}
    base: main
    worktree: "{worktree_root}/{name}"
  driver:
    address: driver.{name}@{project}
    branch: delivery/{name}
    base: main
    worktree: "{worktree_root}/{name}"
`);
  await run(site, environment, "spawn", "demo", "main", "primary");
  for (const name of options.coordinators ?? []) await run(site, environment, "spawn", "demo", "coordinator", name);
  for (const name of options.drivers ?? []) await run(site, environment, "spawn", "demo", "driver", name);
  return { root, site, repository, worktrees, log, environment };
}

type Fixture = Awaited<ReturnType<typeof desk>>;

async function finishTask(fixture: Fixture, coordinator: string, driver: string, id: string) {
  const { site, environment } = fixture;
  await run(site, environment, "task", "add", "demo", id, "--title", id, "--coordinator", coordinator, "--assignee", driver, "--done-when", "Delivery branch is merged.");
  await run(site, environment, "task", "start", "demo", id, "--by", driver);
  await run(site, environment, "task", "prove", "demo", id, "--by", driver, "--item", "1", "--proof", "main already contains the delivery branch");
  await run(site, environment, "task", "review", "demo", id, "--by", driver);
  await run(site, environment, "task", "done", "demo", id, "--by", coordinator);
}

async function refused(fixture: Fixture, address: string, by: string, message?: string) {
  const result = await spawnCli(fixture.site, fixture.environment, ["seat", "retire", address, "--by", by]);
  expect(result.code).not.toBe(0);
  if (message) expect(result.stderr).toContain(message);
  return result;
}

test("RED: main retires an all-DONE named coordinator whose worktree is absent and unregistered, keeping its branch", async () => {
  const fixture = await desk({ coordinators: ["payments"], drivers: ["checkout"] });
  await finishTask(fixture, "coordinator.payments@demo", "driver.checkout@demo", "W-checkout");
  const worktree = join(fixture.worktrees, "payments");
  await git(fixture.repository, "worktree", "remove", "--force", worktree);
  await run(fixture.site, fixture.environment, "seat", "retire", "coordinator.payments@demo", "--by", "main@demo");
  const record = await run(fixture.site, fixture.environment, "open", "coordinator.payments@demo");
  expect(record).toContain("retired:");
  expect(record).toContain("status: complete");
  expect(record).toContain("absent");
  expect(await git(fixture.repository, "branch", "--list", "integration/payments")).toContain("integration/payments");
  await expect(stat(worktree)).rejects.toThrow();
});

test("RED: main retires an all-DONE named coordinator with a clean merged worktree through worktree finish", async () => {
  const fixture = await desk({ coordinators: ["ledger"], drivers: ["posting"] });
  await finishTask(fixture, "coordinator.ledger@demo", "driver.posting@demo", "W-posting");
  await run(fixture.site, fixture.environment, "seat", "retire", "coordinator.ledger@demo", "--by", "main@demo");
  await expect(stat(join(fixture.worktrees, "ledger"))).rejects.toThrow();
  expect(await git(fixture.repository, "branch", "--list", "integration/ledger")).toBe("");
  expect(await run(fixture.site, fixture.environment, "open", "coordinator.ledger@demo")).toContain("retired:");
});

test("guard: a coordinator with an open coordinated task, a non-main actor, main, and operator stay refused", async () => {
  const fixture = await desk({ coordinators: ["busy", "idle"], drivers: ["open", "done"] });
  await run(fixture.site, fixture.environment, "task", "add", "demo", "W-open", "--title", "Open", "--coordinator", "coordinator.busy@demo", "--assignee", "driver.open@demo", "--done-when", "Delivered.");
  await run(fixture.site, fixture.environment, "task", "start", "demo", "W-open", "--by", "driver.open@demo");
  await refused(fixture, "coordinator.busy@demo", "main@demo", "unfinished tasks: W-open");
  expect((await stat(join(fixture.worktrees, "busy"))).isDirectory()).toBe(true);
  await finishTask(fixture, "coordinator.idle@demo", "driver.done@demo", "W-done");
  await refused(fixture, "coordinator.idle@demo", "coordinator.busy@demo", "main@demo");
  await refused(fixture, "main@demo", "main@demo");
  await refused(fixture, "operator@desk", "main@demo");
  for (const address of ["coordinator.busy@demo", "coordinator.idle@demo", "main@demo"]) {
    expect(await run(fixture.site, fixture.environment, "open", address)).not.toContain("retired:");
  }
  expect((await stat(join(fixture.worktrees, "idle"))).isDirectory()).toBe(true);
});

test("RED: retirement prefers the primary checkout ATDD Bun over the seat worktree copy, run in the seat worktree", async () => {
  const fixture = await desk({ drivers: ["alpha"] });
  const worktree = await realpath(join(fixture.worktrees, "alpha"));
  await wrapper(join(fixture.repository, "node_modules", ".bin"), "primary", fixture.log);
  await wrapper(join(worktree, "node_modules", ".bin"), "seat", fixture.log);
  await finishTask(fixture, "main@demo", "driver.alpha@demo", "W-alpha");
  await run(fixture.site, fixture.environment, "seat", "retire", "driver.alpha@demo", "--by", "main@demo");
  const log = await readFile(fixture.log, "utf8");
  expect(log).toContain(`primary ${worktree}`);
  expect(log).not.toContain("seat ");
});

test("RED: retirement runs the ATDD Bun package source when the primary checkout is that package", async () => {
  const fixture = await desk({ drivers: ["beta"], packageSource: true });
  const worktree = await realpath(join(fixture.worktrees, "beta"));
  await wrapper(join(worktree, "node_modules", ".bin"), "seat", fixture.log);
  await finishTask(fixture, "main@demo", "driver.beta@demo", "W-beta");
  await run(fixture.site, fixture.environment, "seat", "retire", "driver.beta@demo", "--by", "main@demo");
  const log = await readFile(fixture.log, "utf8");
  expect(log).toContain(`source ${worktree}`);
  expect(log).not.toContain("seat ");
});

test("RED: without a primary copy, retirement uses PATH ATDD Bun even when the seat worktree has its own", async () => {
  const fixture = await desk({ drivers: ["gamma"] });
  const worktree = await realpath(join(fixture.worktrees, "gamma"));
  const bin = join(fixture.root, "bin");
  await wrapper(bin, "path", fixture.log);
  await wrapper(join(worktree, "node_modules", ".bin"), "seat", fixture.log);
  const environment = { ...fixture.environment, PATH: `${bin}:${process.env.PATH ?? ""}` };
  await finishTask({ ...fixture, environment }, "main@demo", "driver.gamma@demo", "W-gamma");
  await run(fixture.site, environment, "seat", "retire", "driver.gamma@demo", "--by", "main@demo");
  const log = await readFile(fixture.log, "utf8");
  expect(log).toContain(`path ${worktree}`);
  expect(log).not.toContain("seat ");
});
