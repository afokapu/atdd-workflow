import { readFile } from "node:fs/promises";
import { atomicYaml, canonicalAddress, exists, has, now, paths, readYaml, required, seat, words } from "./core";

export type Handover = {
  schema: "atdd-workflow/handover/v1";
  seat: string;
  handover_id: string;
  supersedes: string;
  recorded_at: string;
  text: string;
};

export const maxHandoverLines = 150;
export const handoverSections = [
  "SEAT, AUTHORITY, TOOLKIT AND HAZARDS",
  "OPEN WORK AND IN-FLIGHT OPERATIONS",
  "DEPENDENCIES",
  "RESUME PROCEDURE AND NEXT ACTIONS",
] as const;

const header = /^HANDOVER (\S+) \| (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z) \| handover-id ([^\s|]+) \| supersedes ([^\s|]+)$/;
const headerForm = "`HANDOVER <seat-address> | <UTC ts> | handover-id <id> | supersedes <id|none>`";
/** Words that name a moving target instead of an exact record. */
const vagueWords = /\b(latest|newest|most recent)\b/gi;
/** A demonstrative reference to a record kind, vague unless an exact identifier (one containing a digit, `@`, or `/`) follows. */
const vagueDemonstrative = /\b(?:that|this|those|these|same|previous|earlier|above|last|aforementioned)\s+(PRs?|pull requests?|tasks?|threads?|messages?|commits?|branch(?:es)?|handovers?|sessions?|issues?|releases?)\b(?!\s+\S*[\d@/])/gi;

/** Every reason a handover text is not acceptable for `seat`, given the currently recorded handover id. */
export function handoverProblems(text: string, seatAddress: string, recorded?: string) {
  const problems: string[] = [];
  const lines = text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  if (lines.length > maxHandoverLines) problems.push(`handover has ${lines.length} lines; the maximum is ${maxHandoverLines}.`);
  const match = header.exec(lines[0] ?? "");
  if (!match) problems.push(`line 1: missing or malformed header; expected ${headerForm}.`);
  else {
    const [, writer, , id, supersedes] = match as unknown as [string, string, string, string, string];
    if (writer !== seatAddress) problems.push(`line 1: header seat ${writer} does not match ${seatAddress}.`);
    if (id === "none") problems.push("line 1: handover-id must be an exact identifier, not none.");
    if (recorded === undefined && supersedes !== "none") problems.push(`line 1: supersedes ${supersedes}, but ${seatAddress} has no recorded handover; use supersedes none.`);
    if (recorded !== undefined && supersedes !== recorded) problems.push(`line 1: supersedes ${supersedes} must name the recorded handover ${recorded}.`);
    if (recorded !== undefined && id === recorded) problems.push(`line 1: handover-id ${id} is already recorded; use a new id.`);
  }
  if (!/^Runtime:\s*\S/.test(lines[1] ?? "")) problems.push("line 2: missing Runtime line; expected `Runtime: <runtime> | <session> | model <provider/model> | context <NN>%`.");
  const found: number[] = [];
  handoverSections.forEach((title, index) => {
    const heading = `${index + 1}. ${title}`;
    const at = lines.flatMap((line, position) => line.trim().startsWith(heading) ? [position] : []);
    if (!at.length) problems.push(`missing section ${index + 1} (\`${heading}\`).`);
    else if (at.length > 1) problems.push(`line ${at[1]! + 1}: duplicate section ${index + 1}.`);
    found[index + 1] = at[0] ?? -1;
  });
  for (let section = 2; section <= handoverSections.length; section++) {
    const earlier = found[section - 1]!, later = found[section]!;
    if (earlier >= 0 && later >= 0 && later < earlier) problems.push(`line ${later + 1}: section ${section} appears before section ${section - 1}; sections are out of order (expected 1, 2, 3, 4).`);
  }
  lines.forEach((line, index) => {
    for (const vague of [...line.matchAll(vagueWords), ...line.matchAll(vagueDemonstrative)]) {
      problems.push(`line ${index + 1}: vague reference "${vague[0]}"; name the exact ID (task, message, PR number, commit sha, or address).`);
    }
  });
  return problems;
}

async function recorded(root: string, address: string) {
  const file = paths(root).handoverFile(address);
  return await exists(file) ? await readYaml<Handover>(file) : undefined;
}

/** Validate a handover file and, unless `--check`, record it as the seat's durable handover. Checkpoints are never touched. */
export async function recordHandover(root: string, address: string, args: string[]) {
  const resolved = await canonicalAddress(root, address);
  await seat(root, resolved);
  const text = await readFile(required(words(args, "--file"), "--file"), "utf8");
  const prior = await recorded(root, resolved);
  const problems = handoverProblems(text, resolved, prior?.handover_id);
  if (problems.length) throw new Error(`Handover rejected for ${resolved}; nothing was recorded:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
  const [, , , id, supersedes] = header.exec(text.split(/\r?\n/, 1)[0]!)! as unknown as [string, string, string, string, string];
  if (has(args, "--check")) return console.log(`Handover valid: ${id} for ${resolved} (checked only; not recorded).`);
  const record: Handover = { schema: "atdd-workflow/handover/v1", seat: resolved, handover_id: id, supersedes, recorded_at: now(), text };
  await atomicYaml(paths(root).handoverFile(resolved), record);
  console.log(`Recorded handover ${id} for ${resolved}.`);
}

export async function showHandover(root: string, address: string) {
  const resolved = await canonicalAddress(root, address);
  await seat(root, resolved);
  const record = await recorded(root, resolved);
  if (!record) throw new Error(`No handover is recorded for ${resolved}.`);
  process.stdout.write(record.text.endsWith("\n") ? record.text : `${record.text}\n`);
}
