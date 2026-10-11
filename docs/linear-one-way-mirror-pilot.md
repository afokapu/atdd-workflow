# Linear one-way mirror: discovery and pilot plan

## Read-only discovery — 2026-10-10

No Linear write was made. The workspace was inspected through read-only team, project, and issue listing calls; no token, credential, issue body, or comment body is retained here.

The only active non-deprecated candidate discovered for an owner-approved pilot is:

- **Team:** `Forge` / key `FOS` / ID `ae91eacd-4cc0-4924-bb1e-4e4fa718d8ca`
- **Project:** `Play and Run v0.1.0` / ID `P-FOS-25` / status `In Progress`

This is a proposed routing target, not authorization to write. The former `FRG` team is explicitly marked `(Deprecated)` and is excluded.

## Projection contract

Flow is authoritative. A task has the canonical key `flow:task:<project>/<task-id>`; a message has `flow:message:<thread-id>/<message-id>`. The mirror adds that canonical key as an HTML marker on its Linear object and stores an append-only local mapping to the Linear ID. It does not read a Linear mutation into Flow, parse inbound webhooks, expose an inbound command, or write any Flow task/thread/message from Linear data.

Only explicitly allowlisted Flow projects, task IDs (when supplied), and fields can leave Flow. `title` and `status` are required for a task. `body` and `comment` are opt-in. Values resembling credentials (`secret`, `token`, `password`, API keys, authorization headers, or Bearer values) are refused before a Linear call. Unsupported fields are refused rather than silently broadened.

Every attempt writes a body-free immutable receipt below the Desk's `.atdd-flow/linear-mirror/evidence/`. The receipt records canonical ID, idempotency key, route, operation, state mapping, and outcome, but never a Linear token or projected content. Canonical mappings are write-once. Replays first look up the marker and then update the existing object; a retry cannot bind the Flow object to another Linear object. A missing marker on a mapped issue is recorded as drift and fails closed.

## Exact planned status mapping

The pilot config must use the Forge team's actual Linear workflow-state IDs (not guessed display labels) and preserve this deterministic mapping:

| Flow task state | Linear Forge workflow state |
| --- | --- |
| `todo` | `Backlog` |
| `in_progress` | `In Progress` |
| `review` | `In Progress` (Flow remains the review authority) |
| `done` | `Completed` |

The current read-only discovery did not retrieve workflow-state UUIDs. An approved pilot operator must insert the exact existing IDs into the config before an `--apply`; an empty mapping is rejected before any write.

## Owner-reviewable pilot

1. The owner explicitly accepts this pilot's exact `FOS` / `P-FOS-25` route by creating a write-once `operator@desk` authorization record from the local config (`atdd-flow linear mirror authorize --config ... --id LMA-... --by operator@desk`). The immutable record binds the complete route, task subset, fields, and status map; a config string cannot authorize a write.
2. Scope is exactly the Flow project `atdd-flow`, initially **only** task `linear-one-way-mirror-contract`; no historical bulk sync and no inbound handling.
3. Run `atdd-flow linear mirror task ... --config <local-config>` without `--apply`. Inspect the durable dry-run receipt and destination payload plan.
4. With a separate Linear credential in `LINEAR_API_KEY`, run the same command with `--apply --authorization <the-exact-accepted-reference>`. The CLI rejects a missing or mismatched reference. The secret stays only in process environment.
5. Verify the Linear issue has its canonical marker, repeat the command to verify idempotency, and project at most one safe Flow message as a comment. Verify all receipts and mapping IDs.
6. If a marker is missing, a route changes, a sensitive value is encountered, or any operation fails, disable by omitting `--apply`/removing the credential. There is no compensating Flow mutation and no remote-delete action. Rollback is therefore **disable the mirror**, preserve receipts, and investigate drift.

Example local config (do not commit a credential):

```yaml
schema: atdd-flow/linear-mirror-config/v1
routing:
  team_id: ae91eacd-4cc0-4924-bb1e-4e4fa718d8ca
  project_id: P-FOS-25
  states:
    todo: <Forge Backlog workflow-state UUID>
    in_progress: <Forge In Progress workflow-state UUID>
    review: <Forge In Progress workflow-state UUID>
    done: <Forge Completed workflow-state UUID>
allow:
  projects: [atdd-flow]
  task_ids: [linear-one-way-mirror-contract]
  fields: [title, status, body, comment]
```

No live write happens merely by adding this file. `--apply`, a matching immutable `LMA-...` authorization from the Desk, and `LINEAR_API_KEY` are all required.
