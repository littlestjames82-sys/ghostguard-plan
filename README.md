# GhostGuard Plan Approval + Separation of Duties

**Ideas #6 (Plan Approval / dry-run twin) and #7 (Separation of Duties /
quorum approvals) from the GhostGuard more-ideas list, as one standalone
prototype.** By Ghost Developer Studio. Public prototype — v0.1.0 —
Node ESM, built on the real GhostGuard engine
(imported from the published `ghostguard` package — this package's only
runtime dependency — which it never modifies).

## The problem it solves

Per-action approval is safe but exhausting: a 12-step agent run interrupts
a human 12 times. Plan approval flips it — approve the *plan* once, then
let the run execute exactly what was approved, nothing else. Separation
of duties answers the follow-up question: who is allowed to approve, and
when is one approver not enough?

## Flow

```
1. PLAN      buildPlan(actions)
             Each intended action is evaluated by the GhostGuard policy
             engine and written to the gateway trail (JSONL, via the
             real createJsonlRecorder) with dry_run:true. There is NO
             executor in this phase — planning cannot cause an effect,
             by construction. The plan is the ordered list of records
             plus a plan_hash over its exact contents.

2. APPROVE   approvePlan(plan, approver)
             Appends an entry to the approvals board (append-only
             JSONL), bound to plan_hash. Valid only if:
               - approver != the plan's proposer (separation of duties)
               - the plan contains no deny verdict
               - the plan is not expired (TTL from creation)
               - the approver has not already approved (duplicates
                 count once toward quorum)
             Rejections are recorded too — a self-approval attempt
             lands on the board as approval_rejected / self_approval.

3. EXECUTE   executePlan(plan, realActions, executor)
             Preconditions, in order: plan hash intact, no deny steps,
             not expired, approval quorum satisfied. Then each real
             action must match the next plan step exactly (kind +
             permission_class + canonical payload hash, in order).
             A matching step is recorded again (dry_run:false, plan
             approval carried as approved:true) BEFORE the executor
             runs it. The first mismatch stops the run.
```

## Deviation = back to ask

A changed payload, a new action, an extra step past the plan's end, or
a reordering is a **deviation**: it is not executed, it is evaluated
and recorded as a fresh action, and `executePlan` returns
`status:"deviation", verdict:"ask"` — it needs new approval like any
other unplanned action. Steps before the deviation that matched the
plan have already executed (their real-run records are in the trail);
nothing at or after the deviation executes.

## Hash binding

- **Action hash** — SHA-256 over canonical JSON (object keys sorted
  recursively) of `{kind, permission_class, payload}`. Same logical
  payload hashes identically regardless of key order; any value change
  produces a different hash.
- **Plan hash** — SHA-256 over canonical JSON of the proposer, the
  project, and the ordered per-step action hashes. Approvals store
  the plan_hash; execution recomputes it. Editing the plan object
  after approval (tested) fails with `plan_hash_mismatch` and nothing
  executes.

## Quorum (separation of duties, part 2)

Default quorum is **1** distinct approver. A plan containing a `SPEND`
step whose `payload.amount` is a number greater than
`spendQuorumThreshold` (default 500, configurable) raises the plan's
quorum to **2 distinct approvers**. One approval on a big-spend plan
leaves execution blocked with `quorum_not_met`; a second approval from
the same person is a duplicate and changes nothing; only a second
*distinct, non-proposer* approver releases it.

## Deny kills the plan

Plan approval never overrides a `deny`. A step the engine denies
(e.g. the example policy's locked `no-huge-spend-ever`) marks the plan
`status:"denied"` at build time: approving it is rejected
(`plan_contains_deny`, recorded), executing it is blocked, and no
number of approvers changes that.

## Expiry

Plans carry `expires_at = created_at + planTtlMs` (default 15 min).
Approving or executing after expiry is blocked (`plan_expired`). The
clock is injectable (`now` in config) — the test suite uses it to
prove expiry deterministically.

## GhostBus shape, local transport

The approvals board is modelled on GhostBus concepts — an `approvals`
channel, one thread per plan, approval/rejection entries as messages —
but implemented as a local append-only JSONL file. This prototype does
**not** depend on or contact a live bus; replacing the file with real
GhostBus posts later changes the transport only.

## API

```js
import { createPlanner, examplePolicyDoc } from "./src/planner.mjs";

const planner = createPlanner({
  policyDoc,                 // or compiledPolicy
  auditFile,                 // gateway trail JSONL (real recorder)
  approvalsFile,             // approvals board JSONL
  projectId,                 // optional
  spendQuorumThreshold,      // optional, default 500
  planTtlMs,                 // optional, default 15 min
  now,                       // optional clock, default Date.now
});

const plan = planner.buildPlan(actions, { actor, project_id, initiator });
planner.approvePlan(plan, "ryan");            // -> { ok, reason, status }
planner.approvalStatus(plan);                 // -> { approvers, count, required, satisfied }
const run = planner.executePlan(plan, realActions, (action) => { /* effect */ });
```

Actions are `{ kind, permission_class, actor, payload, initiator? }` —
GhostGuard's vocabulary. `policy.example.json` mirrors
`examplePolicyDoc()` in `src/planner.mjs`.

## Honest limits

- **Identity is a claimed string.** `approver` and `actor` are plain
  names in this local prototype — there is no authentication, no
  signature, no session. Anyone who can append to the approvals file
  can approve as anyone. Separation of duties here proves the
  *semantics* (self-approval rejected, quorum arithmetic, hash
  binding); a real deployment needs authenticated approver identity
  in front of it, exactly like the Cloud skeleton's approver caveat.
- **Append-only is a convention, not tamper-proofing.** Both JSONL
  files can be edited by anyone with filesystem access. Hash binding
  detects plan edits made through the plan object; it does not make
  the trail itself immutable (that needs signing/hash-chaining —
  a separate, later idea).
- **Amounts are payload claims.** Quorum keys off `payload.amount`
  as stated by the proposer. A proposer who understates an amount
  understates the quorum — classification/payload honesty is the
  integrator's load-bearing duty, as everywhere in GhostGuard.
- **Prefix execution on deviation.** Steps before a deviation have
  real effects that are not rolled back. GhostGuard governs whether
  actions run; it is not a transaction manager.
- **hand_off steps** are recorded in plans, but this prototype treats
  a hand_off verdict at execution time as a block — routing to the
  named approver is the transport layer's job and is not built here.
- Approving the plan is approval of the *steps as recorded*; side
  effects an executor performs beyond its action's payload are
  outside what any record can bind.

## Run it

```sh
npm run verify   # test suite (17 checks)
npm run demo     # plan -> self-approval rejected -> quorum -> execute
```

## Repository layout note

This add-on imports the GhostGuard core engine from the **published
`ghostguard` package** (`"ghostguard": "^0.1.0"` in `package.json`; nothing
in the core is modified). To run it, clone this repo and install:

```sh
git clone https://github.com/littlestjames82-sys/ghostguard-plan
cd ghostguard-plan && npm install && npm test
```

Part of the GhostGuard family by **Ghost Developer Studio**.

## The GhostGuard family

GhostGuard is built in public by **Ghost Developer Studio** as a family of small, single-purpose packages around one core engine:

- [ghostguard](https://github.com/littlestjames82-sys/ghostguard) — the core — record-first gateway, fail-closed policy, approvals, and audit for any agent
- [ghostguard-mcp](https://github.com/littlestjames82-sys/ghostguard-mcp) — governed MCP proxy — every `tools/call` is classified, decided, and recorded before it is forwarded
- [ghostguard-budgets](https://github.com/littlestjames82-sys/ghostguard-budgets) — stateful budgets, velocity rules, and a kill-switch freeze (stricter-only)
- [ghostguard-secrets](https://github.com/littlestjames82-sys/ghostguard-secrets) — just-in-time secrets broker — the agent never holds the raw key
- [ghostguard-replay](https://github.com/littlestjames82-sys/ghostguard-replay) — policy replay/backtest against a recorded trail, plus the Guard Score
- [ghostguard-plan](https://github.com/littlestjames82-sys/ghostguard-plan) — hash-bound plan approvals and separation of duties / quorum *(this repo)*
- [ghostguard-reports](https://github.com/littlestjames82-sys/ghostguard-reports) — Ed25519 agent passports, incident reports, and the Guarded-by-GhostGuard badge
- [ghostguard-voice](https://github.com/littlestjames82-sys/ghostguard-voice) — voice approval prototype — a recorded, hash-bound voice decision on a pending ask
- [ghostguard-distribution](https://github.com/littlestjames82-sys/ghostguard-distribution) — GitHub Action gate, red-team bench, plain-English policy author, approval channels, and browser Lite
- [ghostguard-services](https://github.com/littlestjames82-sys/ghostguard-services) — agent governance audit service pack and white-label audit portal prototype
- [policy-packs](https://github.com/littlestjames82-sys/policy-packs) — pre-written, behavior-tested governance policy packs for agent jobs

**Studio roadmap board:** [ghost-roadmaps](https://github.com/littlestjames82-sys/ghost-roadmaps) — the visual board showing where everything in the studio stands.

More from Ghost Developer Studio: [GhostBus](https://github.com/littlestjames82-sys/ghostbus) · [Ghost Hands](https://github.com/littlestjames82-sys/ghost-hands) · [Agent Seatbelt](https://github.com/littlestjames82-sys/agent-seatbelt) · [Ghost Bridge](https://github.com/littlestjames82-sys/ghost-bridge) · [Storefront](https://github.com/littlestjames82-sys/storefront)

## License

MIT — see `LICENSE`. Copyright (c) 2026 Ghost Developer Studio.
