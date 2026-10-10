import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { paths, required, words, yaml } from "./core";
import { post, type Message } from "./threads";

export const authorizationSchema = "atdd-flow/exact-session-adoption-authorization/v1" as const;
export type ExactSessionAdoptionAuthorization = {
  schema: typeof authorizationSchema;
  seat: string;
  pi_session: string;
  pi_session_path: string;
  source: { herdr_session: string; pane: string };
  target: { herdr_session: string; pane: string; cwd: string };
};

const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const hashPath = (root: string, id: string) => join(root, ".atdd-flow", "exact-session-adoption-message-hashes", `${id}.sha256`);

function valid(record: unknown): record is ExactSessionAdoptionAuthorization {
  if (!record || typeof record !== "object") return false;
  const value = record as Record<string, unknown>;
  const source = value.source as Record<string, unknown> | undefined;
  const target = value.target as Record<string, unknown> | undefined;
  return value.schema === authorizationSchema && nonEmpty(value.seat) && nonEmpty(value.pi_session) && nonEmpty(value.pi_session_path)
    && nonEmpty(source?.herdr_session) && nonEmpty(source?.pane) && nonEmpty(target?.herdr_session) && nonEmpty(target?.pane) && nonEmpty(target?.cwd);
}

/** Operator-only command path: append one typed authorization message; no record is rewritten or inferred from prose. */
export async function createExactSessionAdoptionAuthorization(root: string, thread: string, args: string[]) {
  if (words(args, "--by") !== "operator@desk") throw new Error("Only operator@desk may issue an exact-session adoption authorization.");
  const authorization: ExactSessionAdoptionAuthorization = {
    schema: authorizationSchema,
    seat: required(words(args, "--seat"), "--seat"), pi_session: required(words(args, "--pi-session"), "--pi-session"),
    pi_session_path: resolve(required(words(args, "--pi-session-path"), "--pi-session-path")),
    source: { herdr_session: required(words(args, "--source-herdr-session"), "--source-herdr-session"), pane: required(words(args, "--source-pane"), "--source-pane") },
    target: { herdr_session: required(words(args, "--target-herdr-session"), "--target-herdr-session"), pane: required(words(args, "--target-pane"), "--target-pane"), cwd: resolve(required(words(args, "--target-cwd"), "--target-cwd")) },
  };
  const id = await post(root, thread, ["--from", "operator@desk", "--to", "operator@desk", "--body", "Typed exact-session adoption authorization."], {
    from: "operator@desk", to: ["operator@desk"], exact_session_adoption_authorization: authorization,
  });
  const raw = await readFile(paths(root).message(thread, id), "utf8");
  const file = hashPath(root, id);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${digest(raw)}\n`, { encoding: "utf8", flag: "wx" });
  return id;
}

function same(record: ExactSessionAdoptionAuthorization, expected: Omit<ExactSessionAdoptionAuthorization, "schema">) {
  return record.seat === expected.seat && record.pi_session === expected.pi_session && record.pi_session_path === expected.pi_session_path
    && record.source.herdr_session === expected.source.herdr_session && record.source.pane === expected.source.pane
    && record.target.herdr_session === expected.target.herdr_session && record.target.pane === expected.target.pane && record.target.cwd === expected.target.cwd;
}

async function authorizationMessage(root: string, id: string) {
  if (!/^M-[A-Za-z0-9_-]+$/.test(id)) throw new Error("Exact-session adoption requires an immutable operator authorization message id.");
  let folders: Awaited<ReturnType<typeof readdir>>;
  try { folders = await readdir(paths(root).threads, { withFileTypes: true }); }
  catch { throw new Error("Exact-session adoption requires an existing immutable operator authorization message."); }
  const matches = await Promise.all(folders.filter((entry) => entry.isDirectory() && entry.name.startsWith("T-")).map(async (entry) => {
    try {
      const file = paths(root).message(entry.name, id);
      return { raw: await readFile(file, "utf8"), message: await (async () => yaml.parse<Message>(await readFile(file, "utf8")))() };
    } catch { return undefined; }
  }));
  const found = matches.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (found.length !== 1) throw new Error("Exact-session adoption requires an existing immutable operator authorization message.");
  return found[0]!;
}

async function used(root: string, id: string) {
  const folder = `${root}/.atdd-flow/runtime-launch`;
  try {
    for (const file of (await readdir(folder)).filter((entry) => entry.endsWith(".yaml"))) {
      try {
        const receipt = yaml.parse<Record<string, unknown>>(await readFile(`${folder}/${file}`, "utf8"));
        const relocation = receipt.relocation as Record<string, unknown> | undefined;
        const authorization = relocation?.authorization_message;
        if (authorization === id || (authorization && typeof authorization === "object" && (authorization as Record<string, unknown>).id === id)) return true;
      } catch { /* Invalid receipts never authorize reuse. */ }
    }
  } catch { /* No receipts means unused. */ }
  return false;
}

/** Resolve only a typed operator message whose complete tuple matches before runtime projection. */
export async function resolveExactSessionAdoptionAuthorization(root: string, id: string, expected: Omit<ExactSessionAdoptionAuthorization, "schema">) {
  const found = await authorizationMessage(root, id);
  const record = found.message.exact_session_adoption_authorization;
  let storedHash: string;
  try { storedHash = (await readFile(hashPath(root, id), "utf8")).trim(); }
  catch { throw new Error("Exact-session adoption requires a create-only immutable operator authorization message."); }
  if (!/^[a-f0-9]{64}$/i.test(storedHash) || storedHash !== digest(found.raw)) throw new Error("Exact-session adoption requires an immutable operator authorization message.");
  if (found.message.from !== "operator@desk" || found.message.kind !== "message" || !valid(record) || !same(record, expected)) {
    throw new Error("Exact-session adoption requires an immutable operator authorization message bound to the exact adoption tuple.");
  }
  if (await used(root, id)) throw new Error("Exact-session adoption authorization message was already used.");
  return { id, hash: storedHash };
}
