import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");
const conventionFile = join(import.meta.dir, "..", "conventions", "atdd-workflow.workflow", "atdd-workflow.workflow.lifecycle.convention.yaml");
const seatAddress = "driver.delivery@demo";
const checkpointText = "schema: atdd-workflow/checkpoint/v1\nseat: driver.delivery@demo\nstatus: active\nupdated_at: 2026-10-11T00:00:00.000Z\nsummary: existing checkpoint\nnext_action: keep me byte-for-byte\n";
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "atdd-flow-handover-"));
  roots.push(root);
  const seatDir = join(root, "work", "demo", "seats", "driver.delivery");
  await mkdir(seatDir, { recursive: true });
  await writeFile(join(root, "desk.yaml"), "schema: atdd-workflow/desk/v1\ndesk: test\napplication: herdr\n");
  await writeFile(join(root, "work", "demo", "project.yaml"), "schema: atdd-workflow/project/v1\nproject: demo\n");
  await writeFile(join(seatDir, "seat.yaml"), "schema: atdd-workflow/seat/v2\naddress: driver.delivery@demo\nrole: driver\nproject: demo\nworktree: /tmp/delivery\nbranch: delivery/test\n");
  await writeFile(join(seatDir, "checkpoint.yaml"), checkpointText);
  return { root, seatDir, handoverFile: join(seatDir, "handover.yaml"), checkpointFile: join(seatDir, "checkpoint.yaml") };
}

async function invoke(root: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, cli, "--root", root, ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output: `${stdout}${stderr}`, exitCode };
}

type Sections = { one?: string[]; two?: string[]; three?: string[]; four?: string[] };

/** A complete handover following the owner template; each section can be replaced or omitted. */
function handover(options: { seat?: string; id?: string; supersedes?: string; omit?: number; sections?: Sections; order?: number[] } = {}) {
  const headings: Record<number, string[]> = {
    1: ["1. SEAT, AUTHORITY, TOOLKIT AND HAZARDS", ...(options.sections?.one ?? [
      "- Seat: driver.delivery@demo (driver), project demo; reports to coordinator@demo; directs none",
      "- Worktree: /tmp/delivery @ delivery/test d60116f (clean)",
      "- Hazards / known bugs / workarounds: none",
    ])],
    2: ["2. OPEN WORK AND IN-FLIGHT OPERATIONS", ...(options.sections?.two ?? [
      "- demo/delivery | in_progress/red | assignee driver.delivery@demo | [verified]",
      "  ref: PR #42 at commit d60116f; last evidence M-20261011T010000Z-plan_0000aaaa; state: RED committed",
    ])],
    3: ["3. DEPENDENCIES (both directions)", ...(options.sections?.three ?? ["- WAITING ON: none", "- OWED BY ME: none"])],
    4: ["4. RESUME PROCEDURE AND NEXT ACTIONS", ...(options.sections?.four ?? [
      "Verify first:",
      "- atdd-flow status seat driver.delivery@demo",
      "- atdd-flow task open demo delivery",
      "Then, in order:",
      "1. Read inbox; receipt pending messages lacking my receipt.",
      "2. Implement GREEN for demo/delivery after the coordinator accepts RED.",
    ])],
  };
  const order = options.order ?? [1, 2, 3, 4];
  const lines = [
    `HANDOVER ${options.seat ?? seatAddress} | 2026-10-11T01:00:00Z | handover-id ${options.id ?? "H-20261011-1"} | supersedes ${options.supersedes ?? "none"}`,
    "Runtime: herdr session-a:pane-1 | pi session S-example-1 | model provider/model | context 80%",
    "",
  ];
  for (const number of order) {
    if (number === options.omit) continue;
    lines.push(...headings[number]!, "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function source(root: string, name: string, text: string) {
  const file = join(root, name);
  await writeFile(file, text);
  return file;
}

test("RED: the installed CLI advertises a supported handover record command", async () => {
  const { root } = await fixture();
  const help = await invoke(root, "--help");
  expect(help.output).toContain("atdd-flow handover <address> --file <path>");
  expect(help.output).toContain("atdd-flow handover show <address>");
});

test("RED: a complete handover is recorded durably beside, not instead of, the existing checkpoint", async () => {
  const { root, handoverFile, checkpointFile } = await fixture();
  const text = handover();
  const result = await invoke(root, "handover", seatAddress, "--file", await source(root, "handover.txt", text));
  expect(result.output).toContain("H-20261011-1");
  expect(result.exitCode).toBe(0);
  expect(Bun.YAML.parse(await readFile(handoverFile, "utf8"))).toMatchObject({
    schema: "atdd-workflow/handover/v1", seat: seatAddress, handover_id: "H-20261011-1", supersedes: "none",
    recorded_at: expect.any(String), text,
  });
  expect(await readFile(checkpointFile, "utf8")).toBe(checkpointText);
  const shown = await invoke(root, "handover", "show", seatAddress);
  expect(shown.exitCode).toBe(0);
  expect(shown.output).toContain("HANDOVER driver.delivery@demo");
  expect(shown.output).toContain("4. RESUME PROCEDURE AND NEXT ACTIONS");
});

test("RED: --check validates a handover without writing any record", async () => {
  const { root, handoverFile, checkpointFile } = await fixture();
  const valid = await invoke(root, "handover", seatAddress, "--check", "--file", await source(root, "valid.txt", handover()));
  expect(valid.output).toMatch(/handover valid/i);
  expect(valid.exitCode).toBe(0);
  const invalid = await invoke(root, "handover", seatAddress, "--check", "--file", await source(root, "invalid.txt", handover({ omit: 3 })));
  expect(invalid.output).toMatch(/missing section 3/i);
  expect(invalid.exitCode).not.toBe(0);
  expect(existsSync(handoverFile)).toBe(false);
  expect(await readFile(checkpointFile, "utf8")).toBe(checkpointText);
});

test("RED: a handover missing any of the four sections, or with sections out of order, is rejected", async () => {
  const { root, handoverFile } = await fixture();
  for (const omit of [1, 2, 3, 4]) {
    const result = await invoke(root, "handover", seatAddress, "--file", await source(root, `missing-${omit}.txt`, handover({ omit })));
    expect(result.output).toMatch(new RegExp(`missing section ${omit}`, "i"));
    expect(result.exitCode).not.toBe(0);
  }
  const reordered = await invoke(root, "handover", seatAddress, "--file", await source(root, "order.txt", handover({ order: [1, 3, 2, 4] })));
  expect(reordered.output).toMatch(/section 3 .*out of order|out of order.*section 3/i);
  expect(reordered.exitCode).not.toBe(0);
  const noRuntime = await invoke(root, "handover", seatAddress, "--file", await source(root, "runtime.txt", handover().replace(/^Runtime:.*\n/m, "")));
  expect(noRuntime.output).toMatch(/missing runtime line/i);
  expect(noRuntime.exitCode).not.toBe(0);
  expect(existsSync(handoverFile)).toBe(false);
});

test("RED: a handover with a malformed header or another seat's header is rejected", async () => {
  const { root, handoverFile } = await fixture();
  const malformed = await invoke(root, "handover", seatAddress, "--file", await source(root, "header.txt", handover().replace(/^HANDOVER .*\n/, "Handover for me\n")));
  expect(malformed.output).toMatch(/line 1: .*header/i);
  expect(malformed.exitCode).not.toBe(0);
  const otherSeat = await invoke(root, "handover", seatAddress, "--file", await source(root, "other.txt", handover({ seat: "driver.other@demo" })));
  expect(otherSeat.output).toMatch(/line 1: .*driver\.other@demo.*driver\.delivery@demo/i);
  expect(otherSeat.exitCode).not.toBe(0);
  expect(existsSync(handoverFile)).toBe(false);
});

test("RED: a handover over 150 lines is rejected, while exactly 150 lines is accepted", async () => {
  const { root, handoverFile } = await fixture();
  const base = handover().trimEnd().split("\n");
  const padTo = (total: number) => `${[...base, ...Array.from({ length: total - base.length }, (_, index) => `- step ${index}: atdd-flow task open demo delivery`)].join("\n")}\n`;
  const over = await invoke(root, "handover", seatAddress, "--file", await source(root, "over.txt", padTo(151)));
  expect(over.output).toMatch(/151 lines.*150|150.*151 lines/i);
  expect(over.exitCode).not.toBe(0);
  expect(existsSync(handoverFile)).toBe(false);
  const ceiling = await invoke(root, "handover", seatAddress, "--file", await source(root, "ceiling.txt", padTo(150)));
  expect(ceiling.exitCode).toBe(0);
  expect(existsSync(handoverFile)).toBe(true);
});

test("RED: vague references are rejected with their line numbers", async () => {
  const { root, handoverFile } = await fixture();
  const text = handover({ sections: { two: [
    "- demo/delivery | in_progress/red | assignee driver.delivery@demo | [assumed]",
    "  ref: the latest commit; state: waiting for that PR to merge",
  ] } });
  const lines = text.split("\n");
  const line = lines.findIndex((entry) => entry.includes("latest")) + 1;
  const result = await invoke(root, "handover", seatAddress, "--file", await source(root, "vague.txt", text));
  expect(result.output).toContain(`line ${line}`);
  expect(result.output).toMatch(/vague reference.*latest/i);
  expect(result.output).toMatch(/vague reference.*that PR/i);
  expect(result.exitCode).not.toBe(0);
  expect(existsSync(handoverFile)).toBe(false);
});

test("RED: exact identifiers and plain prose without vague tokens are accepted", async () => {
  const { root, handoverFile } = await fixture();
  const text = handover({ sections: { two: [
    "- demo/delivery | in_progress/red | assignee driver.delivery@demo | [verified]",
    "  ref: that PR #42 at commit d60116f, thread T-20261011T010000Z-delivery_0000bbbb; state: RED committed",
    "  Session-only knowledge: the fixture helper builds an isolated Desk and must stay test-only.",
  ] } });
  const result = await invoke(root, "handover", seatAddress, "--file", await source(root, "exact.txt", text));
  expect(result.output).not.toMatch(/vague/i);
  expect(result.exitCode).toBe(0);
  expect(existsSync(handoverFile)).toBe(true);
});

test("RED: a replacement handover must supersede the recorded handover id exactly", async () => {
  const { root, handoverFile } = await fixture();
  expect((await invoke(root, "handover", seatAddress, "--file", await source(root, "first.txt", handover()))).exitCode).toBe(0);
  const stale = await invoke(root, "handover", seatAddress, "--file", await source(root, "stale.txt", handover({ id: "H-20261011-2" })));
  expect(stale.output).toMatch(/supersedes.*H-20261011-1/i);
  expect(stale.exitCode).not.toBe(0);
  expect(Bun.YAML.parse(await readFile(handoverFile, "utf8"))).toMatchObject({ handover_id: "H-20261011-1" });
  const next = await invoke(root, "handover", seatAddress, "--file", await source(root, "next.txt", handover({ id: "H-20261011-2", supersedes: "H-20261011-1" })));
  expect(next.exitCode).toBe(0);
  expect(Bun.YAML.parse(await readFile(handoverFile, "utf8"))).toMatchObject({ handover_id: "H-20261011-2", supersedes: "H-20261011-1" });
});

test("RED: the lifecycle convention carries the 80% handover process and points to the record command", async () => {
  const convention = Bun.YAML.parse(await readFile(conventionFile, "utf8")) as { content: { normative_text: string } };
  const text = convention.content.normative_text;
  expect(text).toMatch(/80%/);
  expect(text).toContain("atdd-flow handover");
  expect(text).toMatch(/150\s+lines/);
  for (const heading of ["SEAT, AUTHORITY, TOOLKIT AND HAZARDS", "OPEN WORK AND IN-FLIGHT OPERATIONS", "DEPENDENCIES", "RESUME PROCEDURE AND NEXT ACTIONS"]) {
    expect(text).toContain(heading);
  }
});
