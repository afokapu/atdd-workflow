import { test } from "bun:test";

// The transfer command is deliberately narrow: it changes only task-level
// accountability/provenance and never creates, moves, or rewrites worktrees.
test.todo("RED: a task coordinator cannot transfer accountability before the governed transition exists");
test.todo("RED: accepted transfers retain immutable provenance and reject manual coordinator rewriting");
test.todo("RED: new governed bases appear only after accepted transfers; dirty, live, or evidence worktrees stay put");
test.todo("RED: duplicate, nested, and unauthorized coordinator transfers fail closed");
