import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

export const collaborationConventionPath = "conventions/atdd-flow.collaboration/atdd-flow.collaboration.convention.yaml";
const startMarker = "<!-- atdd-flow:collaboration-policy:start -->";
const endMarker = "<!-- atdd-flow:collaboration-policy:end -->";
export const collaborationPolicyPointer = `ATDD Flow collaboration policy: node_modules/@afokapu/atdd-flow/${collaborationConventionPath} (source checkout: ${collaborationConventionPath})`;

type Convention = { content?: { canonical_policy?: unknown } };

function conventionFile() {
  return join(import.meta.dir, "..", collaborationConventionPath);
}

/** The convention is the sole policy text; projections and runtimes resolve it from here. */
export function canonicalCollaborationPolicy() {
  const convention = parse(readFileSync(conventionFile(), "utf8")) as Convention;
  const policy = convention.content?.canonical_policy;
  if (typeof policy !== "string" || !policy.trim()) throw new Error("Collaboration convention requires content.canonical_policy.");
  return policy.trim();
}

function block() {
  return `${startMarker}\n${collaborationPolicyPointer}\n${endMarker}\n`;
}

function escaped(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const existingBlock = new RegExp(`${escaped(startMarker)}\\r?\\n[\\s\\S]*?${escaped(endMarker)}(?:\\r?\\n)?`, "g");

/** Replaces every prior managed block with one canonical pointer while retaining all other bytes. */
export function projectCollaborationPolicyText(source: string) {
  const matches = [...source.matchAll(existingBlock)];
  if (matches.length) {
    const first = matches[0]!;
    const before = source.slice(0, first.index);
    const after = source.slice((first.index ?? 0) + first[0].length).replace(existingBlock, "");
    return `${before}${block()}${after}`;
  }
  if (!source) return block();
  return `${source}${source.endsWith("\n") ? "\n" : "\n\n"}${block()}`;
}

/** Idempotently projects the canonical pointer into the two conventional agent instruction files. */
export async function projectCollaborationPolicy(root: string) {
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    const file = join(root, name);
    let source = "";
    try { source = await readFile(file, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const next = projectCollaborationPolicyText(source);
    if (next !== source) await writeFile(file, next, "utf8");
  }
}

/** The one startup handoff for supported Flow-managed runtimes, resolved from the canonical convention. */
export function runtimeStartupInstruction(seat: string) {
  return `SYSTEM: you are ${seat}. Collaboration policy: ${canonicalCollaborationPolicy()} Canonical convention: ${collaborationConventionPath}. Read your durable seat and assigned work with: atdd-flow open ${seat}. Continue assigned in_progress work until it is review-ready or explicitly blocked.`;
}
