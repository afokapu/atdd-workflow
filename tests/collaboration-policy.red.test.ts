import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalCollaborationPolicy, collaborationConventionPath, collaborationPolicyPointer, projectCollaborationPolicy, runtimeStartupInstruction } from "../src/collaboration-policy";
import { init, migrate } from "../src/seats";

const start = "<!-- atdd-flow:collaboration-policy:start -->";
const end = "<!-- atdd-flow:collaboration-policy:end -->";
const pointer = collaborationPolicyPointer;
const managed = `${start}\n${pointer}\n${end}\n`;

async function workspace() {
  return mkdtemp(join(tmpdir(), "atdd-flow-collaboration-policy-"));
}

test("projects one byte-identical managed collaboration-policy pointer into both instruction files", async () => {
  const root = await workspace();
  await projectCollaborationPolicy(root);

  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    expect(await readFile(join(root, name), "utf8")).toBe(managed);
  }
  expect(canonicalCollaborationPolicy()).toContain("Delegation flows operator → main → named coordinator → driver.");
});

test("projection preserves user content, repairs drift, replaces old blocks, and is idempotent", async () => {
  const root = await workspace();
  const path = join(root, "AGENTS.md");
  await writeFile(path, `# User instructions\n\n${start}\nwrong\n${end}\n\nUser content.\n\n${start}\nstale duplicate\n${end}\n`, "utf8");

  await projectCollaborationPolicy(root);
  const projected = await readFile(path, "utf8");
  expect(projected).toBe(`# User instructions\n\n${managed}\nUser content.\n\n`);
  expect((projected.match(new RegExp(start, "g")) ?? [])).toHaveLength(1);
  expect((projected.match(new RegExp(end, "g")) ?? [])).toHaveLength(1);

  await projectCollaborationPolicy(root);
  expect(await readFile(path, "utf8")).toBe(projected);
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(managed);
});

test("Desk init and migration projection create and repair the managed instruction files", async () => {
  const root = await workspace();
  await init(root, "demo", []);
  expect(await readFile(join(root, "AGENTS.md"), "utf8")).toBe(managed);
  await writeFile(join(root, "CLAUDE.md"), "user text\n", "utf8");
  await migrate(root);
  expect(await readFile(join(root, "CLAUDE.md"), "utf8")).toBe(`user text\n\n${managed}`);
});

test("Pi startup resolves the canonical collaboration policy rather than a duplicated runtime copy", () => {
  const instruction = runtimeStartupInstruction("driver.runtime@demo");
  expect(instruction).toContain("you are driver.runtime@demo");
  expect(instruction).toContain(canonicalCollaborationPolicy());
  expect(instruction).toContain(collaborationConventionPath);
});
