import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type Checkpoint, atomicYaml, canonicalAddress, now, paths, project, readYaml, required, runOutput, seat, taskId, values, words,
} from "./core";

export type TaskStatus = "todo" | "in_progress" | "review" | "done";
/** An optional, descriptive implementation phase; task status remains the lifecycle authority. */
export type TaskPhase = "plan" | "red" | "green" | "refactor";
export type HandoffState = "executing" | "awaiting_coordinator" | "awaiting_assignee";
/** A mutable projection of an immutable evidence message/reference, not a second task lifecycle. */
export type TaskHandoff = { state: HandoffState; evidence: string; updated_at: string };
export type DoneWhen = { text: string; proof?: string };
export type GovernedBase = { coordinator: string; branch: string; commit: string };
/** An append-only accountability decision; prior coordinator evidence remains untouched. */
export type CoordinatorTransfer = {
  from: string;
  to: string;
  reason: string;
  /** Required when main executes the transfer; references an operator@desk message. */
  authorization?: string;
  exact_head: { branch: string; commit: string };
  effective_at: string;
};
export type Task = {
  schema: "atdd-workflow/task/v1";
  title: string;
  status: TaskStatus;
  coordinator: string;
  assignee?: string;
  body?: string;
  source?: string;
  depends_on?: string[];
  blocker?: string;
  /** Absent on legacy tasks. */
  phase?: TaskPhase;
  /** Absent on legacy tasks; evidence remains an opaque immutable message/reference. */
  handoff?: TaskHandoff;
  /** Exact named-coordinator or main head from which an assigned driver is governed. */
  governed_base?: GovernedBase;
  /** Absent on legacy tasks; later entries never rewrite earlier coordinator evidence. */
  coordinator_transfers?: CoordinatorTransfer[];
  done_when: DoneWhen[];
};

export type ListedTask = { id: string; task: Task };

const transitions: Record<TaskStatus, TaskStatus[]> = {
  todo: ["in_progress"],
  in_progress: ["review"],
  review: ["in_progress", "done"],
  done: [],
};

function assertCoordinatorIntegrity(task: Task, id: string) {
  const transfers = task.coordinator_transfers;
  if (transfers && !Array.isArray(transfers)) throw new Error(`Task ${id} has invalid immutable transfer provenance.`);
  const latest = transfers?.at(-1);
  if (latest) {
    if (!latest.from || !latest.to || !latest.reason || !latest.effective_at || !latest.exact_head?.branch || !latest.exact_head.commit) {
      throw new Error(`Task ${id} has invalid immutable transfer provenance.`);
    }
    if (task.coordinator !== latest.to || !task.governed_base
      || task.governed_base.coordinator !== latest.to
      || task.governed_base.branch !== latest.exact_head.branch
      || task.governed_base.commit !== latest.exact_head.commit) {
      throw new Error(`Task ${id} coordinator is not backed by immutable transfer provenance.`);
    }
  } else if (task.governed_base && task.governed_base.coordinator !== task.coordinator) {
    throw new Error(`Task ${id} coordinator is not backed by immutable transfer provenance.`);
  }
}

async function readTask(root: string, projectName: string, id: string) {
  const record = await readYaml<Task>(paths(root).taskFile(projectName, id));
  if (record.schema !== "atdd-workflow/task/v1") throw new Error(`Unsupported task schema: ${id}`);
  assertCoordinatorIntegrity(record, id);
  return record;
}

async function allTasks(root: string, projectName: string): Promise<ListedTask[]> {
  const folder = paths(root).tasks(projectName);
  let files: string[];
  try { files = await readdir(folder); }
  catch { return []; }
  return Promise.all(files.filter((file) => file.endsWith(".yaml") && !file.endsWith(".reviews.yaml")).sort().map(async (file) => ({ id: file.slice(0, -5), task: await readTask(root, projectName, file.slice(0, -5)) })));
}

export async function seatTasks(root: string, projectName: string, address: string): Promise<ListedTask[]> {
  return (await allTasks(root, projectName)).filter((entry) =>
    entry.task.assignee === address || entry.task.coordinator === address
  );
}

async function ready(root: string, projectName: string, task: Task) {
  const dependencies = await Promise.all((task.depends_on ?? []).map(async (id) => ({ id, task: await readTask(root, projectName, id) })));
  return dependencies.filter((entry) => entry.task.status !== "done").map((entry) => entry.id);
}

function allProofs(task: Task) {
  return task.done_when.every((entry) => Boolean(entry.proof));
}

async function writeTask(root: string, projectName: string, id: string, task: Task) {
  await atomicYaml(paths(root).taskFile(projectName, id), task);
}

/** Records the exact parent head for new bounded topology without rewriting legacy tasks. */
async function governedBase(root: string, projectName: string, coordinatorAddress: string, assignee?: string): Promise<GovernedBase | undefined> {
  if (!assignee) return undefined;
  const config = await project(root, projectName);
  if (!config.repository) return undefined;
  const coordinator = await seat(root, coordinatorAddress);
  const driver = await seat(root, assignee);
  if (driver.role !== "driver") throw new Error(`${assignee} is not a driver seat.`);
  const primary = resolve(config.repository);
  let branch: string;
  if (coordinator.role === "main") {
    if (coordinator.address !== `main@${config.project}` || coordinator.branch !== "main" || resolve(coordinator.worktree) !== primary) {
      throw new Error(`Main coordinator ${coordinator.address} has mismatched primary lineage.`);
    }
    branch = "main";
  } else if (coordinator.role === "coordinator") {
    const configured = config.roles.coordinator;
    // Existing coordinator role templates and coordinator@project records
    // predate bounded integration lineage and remain readable unchanged.
    if (configured?.address !== "coordinator.{name}@{project}" || configured.branch !== "integration/{name}" || coordinator.address === `coordinator@${config.project}`) return undefined;
    const suffix = `@${config.project}`;
    const local = coordinator.address.endsWith(suffix) ? coordinator.address.slice(0, -suffix.length) : "";
    const match = local.match(/^coordinator\.([a-z0-9_-]+)$/);
    if (!match || coordinator.branch !== `integration/${match[1]}` || resolve(coordinator.worktree) === primary) {
      throw new Error(`Coordinator ${coordinator.address} has mismatched or nested integration lineage.`);
    }
    branch = coordinator.branch;
  } else {
    throw new Error(`Task coordinator ${coordinator.address} must be main or a named coordinator.`);
  }
  const commit = await runOutput(["git", "-C", coordinator.worktree, "rev-parse", branch]);
  const common = await runOutput(["git", "-C", driver.worktree, "merge-base", commit, driver.branch]);
  if (common !== commit) throw new Error(`Driver ${driver.address} is not based on the exact coordinator head ${commit}.`);
  return { coordinator: coordinator.address, branch, commit };
}

async function retireAssignee(root: string, projectName: string, id: string, task: Task) {
  const assignee = required(task.assignee, `an assignee for task ${id}`);
  const unfinished = (await allTasks(root, projectName))
    .filter((entry) => entry.id !== id && entry.task.assignee === assignee && entry.task.status !== "done")
    .map((entry) => entry.id);
  if (unfinished.length) throw new Error(`Cannot retire ${assignee}; it still owns unfinished tasks: ${unfinished.join(", ")}.`);

  const owner = await seat(root, assignee);
  try {
    const summary = await runOutput(["atdd-bun", "worktree", "finish", "--delete-branch"], owner.worktree);
    owner.retired = { task: `${projectName}/${id}`, completed_at: now(), summary };
    await atomicYaml(paths(root).seatFile(assignee), owner);
    const checkpoint: Checkpoint = {
      schema: "atdd-workflow/checkpoint/v1", seat: assignee, status: "complete", updated_at: now(),
      summary: `Retired after ${projectName}/${id}: ${summary}`,
      next_action: "No active worktree remains; spawn a new seat before assigning new work.",
      references: [`task:${projectName}/${id}`],
    };
    await atomicYaml(paths(root).checkpointFile(assignee), checkpoint);
  } catch (error) {
    const checkpoint: Checkpoint = {
      schema: "atdd-workflow/checkpoint/v1", seat: assignee, status: "blocked", updated_at: now(),
      summary: `Housekeeping after ${projectName}/${id} failed: ${(error as Error).message}`,
      next_action: "Inspect the worktree and rerun task completion only after resolving the cleanup failure.",
      references: [`task:${projectName}/${id}`],
    };
    await atomicYaml(paths(root).checkpointFile(assignee), checkpoint);
    throw error;
  }
}

export async function add(root: string, projectName: string, id: string, args: string[]) {
  await project(root, projectName);
  const coordinator = await canonicalAddress(root, required(words(args, "--coordinator"), "--coordinator"));
  const assigneeValue = words(args, "--assignee");
  const assignee = assigneeValue ? await canonicalAddress(root, assigneeValue) : undefined;
  await seat(root, coordinator);
  if (assignee) await seat(root, assignee);
  const base = await governedBase(root, projectName, coordinator, assignee);
  const doneWhen = values(args, "--done-when").map((text) => ({ text }));
  if (!doneWhen.length) throw new Error("A task needs at least one --done-when criterion.");
  const dependsOn = words(args, "--depends-on")?.split(",").filter(Boolean).map(taskId);
  const task: Task = {
    schema: "atdd-workflow/task/v1",
    title: required(words(args, "--title"), "--title"),
    status: "todo",
    coordinator,
    ...(assignee ? { assignee } : {}),
    ...(base ? { governed_base: base } : {}),
    ...(words(args, "--body") ? { body: words(args, "--body") } : {}),
    ...(words(args, "--source") ? { source: words(args, "--source") } : {}),
    ...(dependsOn?.length ? { depends_on: dependsOn } : {}),
    done_when: doneWhen,
  };
  await writeTask(root, projectName, taskId(id), task);
  console.log(id);
}

export async function assign(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may assign task ${id}.`);
  if (task.status !== "todo") throw new Error(`Task ${id} can only be assigned while todo.`);
  if (task.assignee) throw new Error(`Task ${id} is already assigned to ${task.assignee}.`);
  const assignee = await canonicalAddress(root, required(words(args, "--assignee"), "--assignee"));
  await seat(root, assignee);
  const base = await governedBase(root, projectName, task.coordinator, assignee);
  task.assignee = assignee;
  if (base) task.governed_base = base;
  await writeTask(root, projectName, id, task);
  console.log(`${id}  assigned  ${assignee}`);
}

type TransferAuthorization = {
  schema: "atdd-workflow/task-transfer-authorization/v1";
  project: string;
  task: string;
  from: string;
  to: string;
  reason: string;
  exact_head: { branch: string; commit: string };
};

async function operatorAuthorization(root: string, reference: string, main: string, expected: TransferAuthorization) {
  type AuthorizationMessage = { schema?: string; id?: string; from?: string; to?: "all" | string[]; authorization?: TransferAuthorization };
  type AuthorizationThread = { schema?: string; participants?: string[] };
  const folders = await readdir(paths(root).threads, { withFileTypes: true });
  const matches = (await Promise.all(folders.filter((entry) => entry.isDirectory() && entry.name.startsWith("T-"))
    .map(async (entry) => {
      try {
        const [thread, message] = await Promise.all([
          readYaml<AuthorizationThread>(paths(root).threadFile(entry.name)),
          readYaml<AuthorizationMessage>(paths(root).message(entry.name, reference)),
        ]);
        return { thread, message };
      } catch { return undefined; }
    }))).filter((entry): entry is NonNullable<typeof entry> =>
      entry?.thread.schema === "atdd-workflow/thread/v1" && entry.thread.participants?.includes(main) === true
      && entry.message.schema === "atdd-workflow/message/v1" && entry.message.id === reference);
  if (matches.length !== 1 || matches[0]?.message.from !== "operator@desk") {
    throw new Error(`Authorization ${reference} is not an owner-authorized topology plan.`);
  }
  if (matches[0].message.to !== "all" && !matches[0].message.to?.includes(main)) {
    throw new Error(`Authorization ${reference} is not applicable to ${main}.`);
  }
  const authorization = matches[0].message.authorization;
  if (!authorization || authorization.schema !== expected.schema
    || authorization.project !== expected.project || authorization.task !== expected.task
    || authorization.from !== expected.from || authorization.to !== expected.to
    || authorization.reason !== expected.reason
    || authorization.exact_head?.branch !== expected.exact_head.branch
    || authorization.exact_head.commit !== expected.exact_head.commit) {
    throw new Error(`Authorization ${reference} is not an exact transfer authorization.`);
  }
}

/**
 * Changes only the current task accountability projection. The record is
 * append-only and validates the target's existing topology; it never creates,
 * moves, cleans, or binds a seat/worktree.
 */
export async function transfer(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const config = await project(root, projectName);
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  const target = await canonicalAddress(root, required(words(args, "--to"), "--to"));
  const main = `main@${config.project}`;
  if (target === task.coordinator) throw new Error(`Task ${id} is already accountable to ${target}.`);
  if (actor !== main && actor !== task.coordinator) throw new Error(`Only ${main} or the current coordinator may transfer task ${id}.`);

  // governedBase confirms main/named-coordinator identity, exact branch head,
  // and the driver's descendant relationship before accountability changes.
  const base = await governedBase(root, projectName, target, task.assignee);
  if (!base) throw new Error(`Task ${id} needs an assigned driver and governed repository before transfer.`);
  const authorization = actor === main ? required(words(args, "--authorization"), "an owner-authorized topology plan") : undefined;
  if (authorization) await operatorAuthorization(root, authorization, main, {
    schema: "atdd-workflow/task-transfer-authorization/v1",
    project: config.project,
    task: id,
    from: task.coordinator,
    to: target,
    reason: required(words(args, "--reason"), "--reason"),
    exact_head: { branch: base.branch, commit: base.commit },
  });
  const transfer: CoordinatorTransfer = {
    from: task.coordinator,
    to: target,
    reason: required(words(args, "--reason"), "--reason"),
    ...(authorization ? { authorization } : {}),
    exact_head: { branch: base.branch, commit: base.commit },
    effective_at: now(),
  };
  task.coordinator = target;
  task.governed_base = base;
  task.coordinator_transfers = [...(task.coordinator_transfers ?? []), transfer];
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  coordinator transferred  ${transfer.from} -> ${transfer.to}`);
}

export async function amend(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const title = words(args, "--title");
  const body = words(args, "--body");
  const source = words(args, "--source");
  const dependencies = words(args, "--depends-on");
  if (!title && !body && !source && !dependencies) {
    throw new Error("Provide --title, --body, --source, or --depends-on.");
  }
  if (title) task.title = title;
  if (body) task.body = body;
  if (source) task.source = source;
  if (dependencies) task.depends_on = dependencies.split(",").filter(Boolean).map(taskId);
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  amended`);
}

/**
 * Records an already-completed task during a migration. Unlike `done`, this
 * does not invent an assignee or a live lifecycle transition: the supplied
 * evidence is the sole basis for the historical completion record.
 */
export async function importCompleted(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const proofs = values(args, "--proof");
  if (!proofs.length) throw new Error("An imported completion needs at least one --proof reference.");

  const criteria = values(args, "--done-when");
  const texts = criteria.length ? criteria : task.done_when.map((entry) => entry.text);
  if (texts.length !== proofs.length) {
    throw new Error("Provide one --proof for every existing or supplied --done-when criterion.");
  }
  const doneWhen = texts.map((text, index) => ({ text, proof: proofs[index] }));

  const source = words(args, "--source");
  if (source) task.source = source;
  task.status = "done";
  task.done_when = doneWhen;
  delete task.blocker;
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  imported done`);
}

async function transition(root: string, projectName: string, id: string, next: TaskStatus, by: string, retire = false) {
  const task = await readTask(root, projectName, id);
  const actor = await canonicalAddress(root, by);
  if (!transitions[task.status].includes(next)) throw new Error(`Task ${id} cannot move from ${task.status} to ${next}.`);
  if (next === "in_progress" && task.status === "todo") {
    if (!task.assignee) throw new Error(`Task ${id} has no assignee.`);
    if (actor !== task.assignee) throw new Error(`Only ${task.assignee} may start task ${id}.`);
    const waiting = await ready(root, projectName, task);
    if (waiting.length) throw new Error(`Task ${id} is waiting on: ${waiting.join(", ")}.`);
  }
  if (next === "in_progress" && task.status === "review" && actor !== task.coordinator) {
    throw new Error(`Only ${task.coordinator} may return task ${id} to work.`);
  }
  if (next === "review") {
    if (!task.assignee || actor !== task.assignee) throw new Error(`Only ${task.assignee ?? "the assignee"} may submit task ${id} for review.`);
    if (!allProofs(task)) throw new Error(`Task ${id} is missing proof for: ${task.done_when.filter((entry) => !entry.proof).map((entry) => entry.text).join("; ")}`);
  }
  if (next === "done") {
    if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may complete task ${id}.`);
    if (!allProofs(task)) throw new Error(`Task ${id} is missing completion proof.`);
    const { assertParentMayComplete } = await import("./ephemeral-resources");
    await assertParentMayComplete(root, { project: projectName, task: id });
    const { assertAcceptedBehavioralReview } = await import("./reviews");
    await assertAcceptedBehavioralReview(root, projectName, id, task);
    if (retire) await retireAssignee(root, projectName, id, task);
  }
  task.status = next;
  if (next !== "in_progress") delete task.blocker;
  await writeTask(root, projectName, id, task);
  console.log(`${id}  ${next}`);
}

export async function start(root: string, projectName: string, id: string, args: string[]) {
  return transition(root, projectName, taskId(id), "in_progress", required(words(args, "--by"), "--by"));
}

export async function review(root: string, projectName: string, id: string, args: string[]) {
  return transition(root, projectName, taskId(id), "review", required(words(args, "--by"), "--by"));
}

export async function done(root: string, projectName: string, id: string, args: string[]) {
  return transition(root, projectName, taskId(id), "done", required(words(args, "--by"), "--by"), args.includes("--retire-assignee"));
}

export async function returnToWork(root: string, projectName: string, id: string, args: string[]) {
  return transition(root, projectName, taskId(id), "in_progress", required(words(args, "--by"), "--by"));
}

const phases: TaskPhase[] = ["plan", "red", "green", "refactor"];
const handoffOutcomes = ["accept", "return"] as const;

type HandoffOutcome = typeof handoffOutcomes[number];

function phase(value: string | undefined): TaskPhase {
  const selected = required(value, "--phase");
  if (!phases.includes(selected as TaskPhase)) throw new Error(`--phase must be one of: ${phases.join(", ")}.`);
  return selected as TaskPhase;
}

function handoffOutcome(value: string | undefined): HandoffOutcome {
  const selected = required(value, "--outcome");
  if (!(handoffOutcomes as readonly string[]).includes(selected)) throw new Error("--outcome must be accept or return.");
  return selected as HandoffOutcome;
}

/**
 * The assignee records work as ready for a coordinator decision. The evidence
 * value is deliberately opaque: it links an immutable message/reference but
 * never parses message prose or changes the task lifecycle.
 */
export async function submitHandoff(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (!task.assignee || actor !== task.assignee) throw new Error(`Only ${task.assignee ?? "the assignee"} may submit a handoff for task ${id}.`);
  if (task.status !== "in_progress") throw new Error(`Task ${id} must be in_progress before a handoff is submitted.`);
  if (task.handoff?.state === "awaiting_coordinator") throw new Error(`Task ${id} is already awaiting coordinator handoff response.`);
  const evidence = required(words(args, "--evidence"), "--evidence");
  task.phase = phase(words(args, "--phase"));
  task.handoff = { state: "awaiting_coordinator", evidence, updated_at: now() };
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  handoff awaiting_coordinator`);
}

/**
 * The coordinator accepts a handoff for the assignee's next phase or returns
 * it to active execution. This only updates the optional projection.
 */
export async function respondToHandoff(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may respond to task ${id} handoff.`);
  if (task.status !== "in_progress") throw new Error(`Task ${id} must be in_progress before a handoff is answered.`);
  if (task.handoff?.state !== "awaiting_coordinator") throw new Error(`Task ${id} is not awaiting coordinator handoff response.`);
  const outcome = handoffOutcome(words(args, "--outcome"));
  task.phase = phase(words(args, "--phase"));
  task.handoff = {
    ...task.handoff,
    state: outcome === "accept" ? "awaiting_assignee" : "executing",
    updated_at: now(),
  };
  await writeTask(root, projectName, taskId(id), task);
  console.log(`${id}  handoff ${task.handoff.state}`);
}

export async function prove(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (!task.assignee || actor !== task.assignee) throw new Error(`Only ${task.assignee ?? "the assignee"} may add proof to task ${id}.`);
  if (task.status !== "in_progress") throw new Error(`Task ${id} must be in_progress before proof is added.`);
  const item = Number(required(words(args, "--item"), "--item"));
  if (!Number.isInteger(item) || item < 1 || item > task.done_when.length) throw new Error(`--item must be between 1 and ${task.done_when.length}.`);
  task.done_when[item - 1].proof = required(words(args, "--proof"), "--proof");
  await writeTask(root, projectName, id, task);
  console.log(`${id}  proof ${item}`);
}

export async function block(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.assignee && actor !== task.coordinator) throw new Error(`Only the assignee or coordinator may block task ${id}.`);
  if (task.status === "done") throw new Error(`Completed task ${id} cannot be blocked.`);
  task.blocker = required(words(args, "--reason"), "--reason");
  await writeTask(root, projectName, id, task);
  console.log(`${id}  blocked`);
}

export async function unblock(root: string, projectName: string, id: string, args: string[]) {
  const task = await readTask(root, projectName, taskId(id));
  const actor = await canonicalAddress(root, required(words(args, "--by"), "--by"));
  if (actor !== task.coordinator) throw new Error(`Only ${task.coordinator} may unblock task ${id}.`);
  if (task.status !== "todo" && task.status !== "in_progress") throw new Error(`Task ${id} can only be unblocked while todo or in_progress.`);
  if (!task.blocker) throw new Error(`Task ${id} has no blocker to clear.`);
  const waiting = await ready(root, projectName, task);
  if (waiting.length) throw new Error(`Task ${id} is waiting on: ${waiting.join(", ")}.`);
  const { assertDependentsMayUnblock } = await import("./ephemeral-resources");
  await assertDependentsMayUnblock(root, { project: projectName, task: id });
  delete task.blocker;
  await writeTask(root, projectName, id, task);
  console.log(`${id}  unblocked`);
}

export async function list(root: string, projectName: string, args: string[]) {
  const coordinator = words(args, "--coordinator") ? await canonicalAddress(root, required(words(args, "--coordinator"), "--coordinator")) : undefined;
  const assignee = words(args, "--assignee") ? await canonicalAddress(root, required(words(args, "--assignee"), "--assignee")) : undefined;
  for (const entry of await allTasks(root, projectName)) {
    if (coordinator && entry.task.coordinator !== coordinator || assignee && entry.task.assignee !== assignee) continue;
    const waiting = entry.task.status === "todo" ? await ready(root, projectName, entry.task) : [];
    const proof = `${entry.task.done_when.filter((item) => item.proof).length}/${entry.task.done_when.length}`;
    console.log(`${entry.id}  ${entry.task.status}  proof:${proof}  ${entry.task.title}${waiting.length ? `  waiting:${waiting.join(",")}` : ""}${entry.task.blocker ? `  blocked:${entry.task.blocker}` : ""}`);
  }
}

export async function open(root: string, projectName: string, id: string) {
  console.log(Bun.YAML.stringify(await readTask(root, projectName, taskId(id))));
}
