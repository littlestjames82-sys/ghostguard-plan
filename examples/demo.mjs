/**
 * Demo: plan -> approve -> execute, plus the failure modes.
 * Run: npm run demo
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanner, examplePolicyDoc } from "../src/planner.mjs";

const dir = mkdtempSync(join(tmpdir(), "ghostguard-plan-demo-"));
const planner = createPlanner({
  policyDoc: examplePolicyDoc(),
  auditFile: join(dir, "audit.jsonl"),
  approvalsFile: join(dir, "approvals.jsonl"),
  spendQuorumThreshold: 500,
});

const actions = [
  { kind: "web.fetch", permission_class: "READ", actor: "agent-7", payload: { url: "https://example.com/report" } },
  { kind: "shop.buy", permission_class: "SPEND", actor: "agent-7", payload: { item: "laptop", amount: 750 } },
];

const plan = planner.buildPlan(actions);
console.log(`Plan ${plan.plan_id} hash ${plan.plan_hash.slice(0, 16)}… quorum ${plan.quorum_required}`);
for (const s of plan.steps) console.log(`  step ${s.index}: ${s.kind} (${s.permission_class}) -> ${s.verdict} [dry_run]`);

console.log("agent tries to approve its own plan:", planner.approvePlan(plan, "agent-7").reason);
console.log("ryan approves:", planner.approvePlan(plan, "ryan").status);
console.log("run before quorum:", planner.executePlan(plan, actions, () => {}).reason);
console.log("alex approves (2nd):", planner.approvePlan(plan, "alex").status.satisfied ? "quorum met" : "?");
const res = planner.executePlan(plan, actions, (a) => console.log(`  EXECUTED ${a.kind}`));
console.log("run:", res.status);
