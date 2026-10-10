import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGatewayRecords } from "../../ghostguard/dist/index.js";
import { createPlanner, examplePolicyDoc } from "../src/planner.mjs";

let passed = 0;
const failures = [];
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.log(`  ✗ ${name}\n    ${err.message}`);
  }
}

const AGENT = "agent-7";
const HUMAN = "ryan";
const HUMAN2 = "alex";

function freshPlanner(extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ghostguard-plan-"));
  const auditFile = join(dir, "audit.jsonl");
  const approvalsFile = join(dir, "approvals.jsonl");
  let clock = Date.parse("2026-10-10T05:00:00.000Z");
  const planner = createPlanner({
    policyDoc: examplePolicyDoc(),
    auditFile,
    approvalsFile,
    projectId: "demo-project",
    spendQuorumThreshold: 500,
    planTtlMs: 60_000,
    now: () => clock,
    ...extra,
  });
  return {
    planner,
    auditFile,
    approvalsFile,
    advanceClock: (ms) => {
      clock += ms;
    },
  };
}

function spyExecutor() {
  const calls = [];
  const fn = (action) => {
    calls.push(action);
    return `done:${action.kind}`;
  };
  fn.calls = calls;
  return fn;
}

const readAction = { kind: "web.fetch", permission_class: "READ", actor: AGENT, payload: { url: "https://example.com/report" } };
const emailAction = { kind: "email.send", permission_class: "COMMUNICATE", actor: AGENT, payload: { to: "client@example.com", subject: "Report ready" } };
const smallSpend = { kind: "shop.buy", permission_class: "SPEND", actor: AGENT, payload: { item: "domain", amount: 25 } };
const bigSpend = { kind: "shop.buy", permission_class: "SPEND", actor: AGENT, payload: { item: "laptop", amount: 750 } };
const hugeSpend = { kind: "shop.buy", permission_class: "SPEND", actor: AGENT, payload: { item: "server", amount: 25000 } };

// --- 1. Approved plan executes end-to-end; planning executed nothing ---
{
  const { planner, auditFile } = freshPlanner();
  const exec = spyExecutor();
  const plan = planner.buildPlan([readAction, emailAction, smallSpend]);

  check("plan steps are recorded with dry_run:true and real verdicts", () => {
    assert.equal(plan.steps.length, 3);
    assert.ok(plan.steps.every((s) => s.record.dry_run === true));
    assert.equal(plan.steps[0].verdict, "allow");
    assert.equal(plan.steps[1].verdict, "ask");
    assert.equal(plan.steps[2].verdict, "ask");
    const trail = readGatewayRecords(auditFile);
    assert.equal(trail.length, 3);
    assert.ok(trail.every((r) => r.dry_run === true));
  });

  check("unapproved plan does not execute", () => {
    const res = planner.executePlan(plan, [readAction, emailAction, smallSpend], exec);
    assert.equal(res.status, "blocked");
    assert.equal(res.reason, "not_approved");
    assert.equal(exec.calls.length, 0);
  });

  check("approved plan executes end-to-end, in order, record-first", () => {
    const ap = planner.approvePlan(plan, HUMAN);
    assert.equal(ap.ok, true);
    assert.equal(ap.status.satisfied, true);
    const res = planner.executePlan(plan, [readAction, emailAction, smallSpend], exec);
    assert.equal(res.status, "executed");
    assert.deepEqual(
      res.executed.map((e) => e.kind),
      ["web.fetch", "email.send", "shop.buy"],
    );
    assert.equal(exec.calls.length, 3);
    const trail = readGatewayRecords(auditFile);
    const realRecords = trail.filter((r) => r.dry_run === false);
    assert.equal(realRecords.length, 3);
  });
}

// --- 2. Tampered payload mid-run is a deviation ---
{
  const { planner } = freshPlanner();
  const exec = spyExecutor();
  const plan = planner.buildPlan([readAction, emailAction]);
  planner.approvePlan(plan, HUMAN);
  const tampered = { ...emailAction, payload: { to: "attacker@example.com", subject: "Report ready" } };

  check("tampered payload mid-run blocked as deviation; earlier step ran, tampered did not", () => {
    const res = planner.executePlan(plan, [readAction, tampered], exec);
    assert.equal(res.status, "deviation");
    assert.equal(res.reason, "step_mismatch");
    assert.equal(res.deviation_index, 1);
    assert.equal(res.verdict, "ask");
    assert.equal(exec.calls.length, 1);
    assert.equal(exec.calls[0].kind, "web.fetch");
  });
}

// --- 3. Extra unplanned action blocked; reordering blocked ---
{
  const { planner } = freshPlanner();
  const exec = spyExecutor();
  const plan = planner.buildPlan([readAction]);
  planner.approvePlan(plan, HUMAN);

  check("extra unplanned action after the plan is blocked, not executed", () => {
    const res = planner.executePlan(plan, [readAction, emailAction], exec);
    assert.equal(res.status, "deviation");
    assert.equal(res.reason, "extra_action");
    assert.equal(res.deviation_index, 1);
    assert.equal(exec.calls.length, 1); // only the planned read ran
  });

  const { planner: p2 } = freshPlanner();
  const exec2 = spyExecutor();
  const plan2 = p2.buildPlan([readAction, emailAction]);
  p2.approvePlan(plan2, HUMAN);
  check("reordered actions deviate at the first out-of-order step", () => {
    const res = p2.executePlan(plan2, [emailAction, readAction], exec2);
    assert.equal(res.status, "deviation");
    assert.equal(res.deviation_index, 0);
    assert.equal(exec2.calls.length, 0);
  });
}

// --- 4. Self-approval rejected and recorded ---
{
  const { planner, approvalsFile } = freshPlanner();
  const plan = planner.buildPlan([readAction], { actor: AGENT });

  check("self-approval is rejected, recorded, and does not satisfy the plan", () => {
    const res = planner.approvePlan(plan, AGENT);
    assert.equal(res.ok, false);
    assert.equal(res.reason, "self_approval");
    assert.equal(planner.approvalStatus(plan).count, 0);
    const entries = readFileSync(approvalsFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const rejection = entries.find((e) => e.entry_type === "approval_rejected");
    assert.ok(rejection, "rejection entry recorded on the board");
    assert.equal(rejection.reason, "self_approval");
    assert.equal(rejection.approver, AGENT);
    assert.equal(rejection.plan_hash, plan.plan_hash);
    const exec = spyExecutor();
    const run = planner.executePlan(plan, [readAction], exec);
    assert.equal(run.status, "blocked");
    assert.equal(exec.calls.length, 0);
  });
}

// --- 5. SPEND over threshold needs quorum of 2 distinct approvers ---
{
  const { planner } = freshPlanner();
  const exec = spyExecutor();
  const plan = planner.buildPlan([readAction, bigSpend]);

  check("big-spend plan requires quorum 2", () => {
    assert.equal(plan.quorum_required, 2);
  });

  check("one approver is not enough for a big spend", () => {
    const ap = planner.approvePlan(plan, HUMAN);
    assert.equal(ap.ok, true);
    assert.equal(ap.status.satisfied, false);
    const res = planner.executePlan(plan, [readAction, bigSpend], exec);
    assert.equal(res.status, "blocked");
    assert.equal(res.reason, "quorum_not_met");
    assert.equal(exec.calls.length, 0);
  });

  check("same approver twice still counts once", () => {
    const dup = planner.approvePlan(plan, HUMAN);
    assert.equal(dup.ok, false);
    assert.equal(dup.reason, "duplicate_approver");
    assert.equal(planner.approvalStatus(plan).count, 1);
  });

  check("second distinct approver releases the big spend", () => {
    const ap2 = planner.approvePlan(plan, HUMAN2);
    assert.equal(ap2.ok, true);
    assert.equal(ap2.status.satisfied, true);
    const res = planner.executePlan(plan, [readAction, bigSpend], exec);
    assert.equal(res.status, "executed");
    assert.equal(exec.calls.length, 2);
  });

  check("small spend needs only 1 approver (threshold is amount-bound)", () => {
    const { planner: p } = freshPlanner();
    const planSmall = p.buildPlan([smallSpend]);
    assert.equal(planSmall.quorum_required, 1);
  });
}

// --- 6. Denied step inside a plan kills the plan ---
{
  const { planner } = freshPlanner();
  const exec = spyExecutor();
  const plan = planner.buildPlan([readAction, hugeSpend]);

  check("plan containing a deny step is marked denied", () => {
    assert.equal(plan.has_deny, true);
    assert.equal(plan.status, "denied");
    assert.equal(plan.steps[1].verdict, "deny");
    assert.equal(plan.steps[1].rule_id, "no-huge-spend-ever");
  });

  check("approving a denied plan is rejected; executing it is blocked; nothing runs", () => {
    const ap = planner.approvePlan(plan, HUMAN);
    assert.equal(ap.ok, false);
    assert.equal(ap.reason, "plan_contains_deny");
    planner.approvePlan(plan, HUMAN2);
    const res = planner.executePlan(plan, [readAction, hugeSpend], exec);
    assert.equal(res.status, "blocked");
    assert.equal(res.reason, "plan_contains_deny");
    assert.equal(exec.calls.length, 0);
  });
}

// --- 7. Expired plan blocked (injected clock) ---
{
  const { planner, advanceClock } = freshPlanner();
  const exec = spyExecutor();
  const plan = planner.buildPlan([readAction]);
  planner.approvePlan(plan, HUMAN);
  advanceClock(61_000); // TTL is 60s

  check("expired plan cannot execute even though it was approved in time", () => {
    const res = planner.executePlan(plan, [readAction], exec);
    assert.equal(res.status, "blocked");
    assert.equal(res.reason, "plan_expired");
    assert.equal(exec.calls.length, 0);
  });

  check("approving after expiry is rejected as plan_expired", () => {
    const { planner: p2, advanceClock: adv2 } = freshPlanner();
    const plan2 = p2.buildPlan([readAction]);
    adv2(61_000);
    const ap = p2.approvePlan(plan2, HUMAN);
    assert.equal(ap.ok, false);
    assert.equal(ap.reason, "plan_expired");
  });
}

// --- 8. Plan hash binding: editing the plan itself voids approvals ---
{
  const { planner } = freshPlanner();
  const exec = spyExecutor();
  const plan = planner.buildPlan([readAction, emailAction]);
  planner.approvePlan(plan, HUMAN);
  plan.steps[1].payload = { to: "attacker@example.com", subject: "x" };
  plan.steps[1].payload_hash = "0".repeat(64);

  check("a plan edited after approval fails its hash check and does not execute", () => {
    const res = planner.executePlan(plan, [readAction, emailAction], exec);
    assert.equal(res.status, "blocked");
    assert.equal(res.reason, "plan_hash_mismatch");
    assert.equal(exec.calls.length, 0);
  });
}

console.log(`\nghostguard-plan: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
