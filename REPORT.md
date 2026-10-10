# GhostGuard Plan — Build Report

Built Oct 10, 2026 at Ryan's direction ("Knock em out" — more-ideas
#6 Plan Approval + #7 Separation of Duties, as one prototype).
Standalone package at `~/workspace/ghostguard-plan/`; `private: true`,
zero runtime dependencies, nothing published, pushed, or deployed.
`~/workspace/ghostguard`, `~/workspace/ghostbus`, and
`~/workspace/ghost-hands` were not modified — the GhostGuard engine is
imported read-only from `~/workspace/ghostguard/dist/index.js`
(`compilePolicy`, `evaluatePolicy`, `gatewayRecordFromDecision`,
`createJsonlRecorder`, `readGatewayRecords`). No network calls.

## What was built

- `src/planner.mjs` — `createPlanner({ policyDoc | compiledPolicy,
  auditFile, approvalsFile, projectId?, spendQuorumThreshold?,
  planTtlMs?, now? })`:
  - `buildPlan(actions)` — evaluates + records every intended action
    with `dry_run:true` via the real engine/recorder; no executor
    exists in this phase. Produces the plan (ordered steps with
    verdicts + per-step payload hashes) and a content `plan_hash`.
    A deny step marks the plan `denied`.
  - `approvePlan(plan, approver)` — separation of duties: approver
    must differ from the plan's proposer; self-approval,
    denied-plan, expired-plan, and hash-mismatch approvals are
    rejected AND recorded as `approval_rejected` entries; duplicate
    approvals count once. Quorum: 2 distinct approvers when any
    SPEND step's `payload.amount` exceeds the threshold (default
    500), else 1.
  - `executePlan(plan, realActions, executor)` — checks hash,
    deny, expiry, quorum (in that order), then executes only exact
    in-order matches, recording each real run (`dry_run:false`,
    carried approval) before executing. First deviation (changed
    payload / extra action / reorder) stops the run: the deviating
    action is recorded fresh and returned as `verdict:"ask"`,
    unexecuted.
  - `examplePolicyDoc()` — locked denies (SPEND > 10000, DELETE),
    ask on SPEND/DEPLOY/COMMUNICATE/PUBLISH, allow the rest.
- `src/hash.mjs` — canonical JSON (recursive key sort) + SHA-256
  action and plan hashes.
- `src/approvals.mjs` — append-only JSONL approvals board shaped
  like a GhostBus approvals channel (thread = plan); local file
  only, no live bus.
- `policy.example.json` — the example policy as data.
- `examples/demo.mjs` — end-to-end demo (`npm run demo`).

## Verification

Command: `npm run verify` (= `node test/run-tests.mjs`) in
`~/workspace/ghostguard-plan` — **17 passed, 0 failed**:

- plan steps recorded `dry_run:true` with real verdicts (allow/ask)
- unapproved plan does not execute (`not_approved`)
- approved plan executes end-to-end, in order, record-first
  (real-run records present in the trail)
- tampered payload mid-run blocked as deviation (`step_mismatch`,
  verdict `ask`); the earlier matching step ran, the tampered one
  did not
- extra unplanned action blocked (`extra_action`), not executed
- reordered actions deviate at the first out-of-order step
- self-approval rejected, recorded on the board, plan unsatisfied
- big-spend (750 > 500) plan requires quorum 2; 1 approver blocked
  (`quorum_not_met`); same approver twice counts once
  (`duplicate_approver`); 2nd distinct approver releases it
- small spend (25) needs only 1 approver
- plan with a denied step (SPEND 25000 vs locked rule) is marked
  denied; approval rejected (`plan_contains_deny`); execution
  blocked; nothing runs
- expired plan (injected clock advanced past 60s TTL) cannot
  execute even though approved in time; approving after expiry
  rejected (`plan_expired`)
- plan object edited after approval fails hash recomputation
  (`plan_hash_mismatch`) and does not execute

`npm run demo` also ran green, showing the narrative flow:
self-approval rejected → 1 of 2 quorum → blocked → 2nd approver →
both steps executed.

## Left undone, on purpose

- Authenticated approver identity (approver is a claimed string —
  stated plainly in README's honest limits).
- Real GhostBus transport (board is GhostBus-shaped local JSONL,
  per the task's "implemented locally" instruction).
- hand_off routing at execution (a hand_off step blocks execution;
  routing belongs to a transport layer).
- Single-action (non-plan) ask approvals with quorum — the quorum
  logic is plan-scoped here; `requiredApprovalsForAction` is
  exported for reuse.
