# Owner stall escalation plan

## Boundary

Flow will add a bounded, coordinator/main-only `owner-alert scan` command. It is an
explicit observation pass, not a daemon or scheduler. It reads Desk task,
checkpoint, and thread records and writes only Flow-owned escalation records and
threads. It never changes task state, executes a fallback, infers authorization,
or sends an alert from a driver.

## Material signal

An alert candidate must have all of the following:

1. a non-done task with an explicit blocker;
2. an explicit material class in that blocker (`cross-project`, `toolkit`, or
   `authorization`), rather than a general wait; and
3. no other active, checkpoint-active task in that project as visibly executing
   independent work.

Dependency-only waits, active productive work, and unclassified blockers are
ignored. The persisted alert carries `blocked` for a blocker and `waiting` only
when a classified dependency observation is eventually supported; this slice
emits only the former, avoiding a guessed state.

## Durable record and delivery boundary

The alert key is a deterministic digest of the material class, canonical affected
task IDs, redacted evidence, and fallback observation. A record captures canonical
IDs, redacted exact evidence, fallback visibility, safe automatic action (always
`none` in this slice), owner options, prohibited actions, and a distinct delivery
state. The initial sequence is `persisted` then `sent`; `delivered` requires an
explicit owner receipt, `acknowledged` requires an owner acknowledgement, and
`executing` requires an explicit owner-selected option. No host notification is
claimed as delivery.

Missing or unreadable `operator@desk` fails closed: Flow persists the observation
with `owner_unavailable`, creates no synthetic delivery claim, and returns a
non-successful scan result. Repeated unchanged observations reuse the record;
re-notification is permitted only after a supplied bounded timeout or a material
state/evidence change. Resolution and supersession are recorded durably.

## RED matrix

Fixtures will prove that a material cross-project blocker with no active fallback
creates one redacted owner alert; ordinary dependency waits, active productive
fallbacks, duplicate scans, and unclassified blockers do not. Additional fixtures
will prove the record payload, persisted/sent/delivered/acknowledged/executing
separation, bounded re-notification, resolution/supersession, unavailable-owner
failure, and no secret preservation.
