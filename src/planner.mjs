import { randomUUID } from "node:crypto";
import {
  compilePolicy,
  evaluatePolicy,
  gatewayRecordFromDecision,
  createJsonlRecorder,
} from "ghostguard";
import { actionHash, planHash } from "./hash.mjs";
import { appendApprovalEntry, readApprovalEntries, validApprovals } from "./approvals.mjs";

/**
 * GhostGuard Plan Approval + Separation of Duties (ideas #6 + #7).
 *
 * PLAN APPROVAL (dry-run twin): an agent first proposes a PLAN — a
 * sequence of intended actions, each evaluated by the real
 * GhostGuard engine and written to the gateway trail with
 * dry_run:true. Nothing executes during planning: this module never
 * calls an executor while building a plan. A human approves the
 * plan as a whole; the approval is bound to a hash of the plan's
 * exact contents. The real run then executes ONLY actions matching
 * the approved plan — same kind, same permission class, same
 * canonical payload hash, in plan order. Any deviation (changed
 * payload, new/extra action, reordering) is not executed; it is
 * recorded fresh and returned as an `ask` — it needs new approval.
 *
 * A plan containing a `deny` verdict is dead on arrival: plan
 * approval never overrides a deny, approving it is rejected (and
 * the rejection recorded), and executing it is blocked.
 *
 * SEPARATION OF DUTIES: an approval counts only when the approver
 * is not the actor who proposed the plan. Self-approval attempts
 * are rejected AND recorded on the approvals board. SPEND steps
 * whose payload.amount exceeds `spendQuorumThreshold` raise the
 * quorum for the whole plan to 2 distinct approvers.
 *
 * GhostBus shape, local transport: the approvals board is an
 * append-only JSONL file modelled as a GhostBus-style approvals
 * channel (thread = plan, messages = approval entries). No live
 * bus is contacted.
 */

export const DEFAULT_SPEND_QUORUM_THRESHOLD = 500;
export const DEFAULT_PLAN_TTL_MS = 15 * 60 * 1000;

export function createPlanner(config = {}) {
  if (!config.policyDoc && !config.compiledPolicy) {
    throw new Error("ghostguard-plan: a policyDoc (or compiledPolicy) is required");
  }
  if (!config.auditFile) throw new Error("ghostguard-plan: auditFile is required");
  if (!config.approvalsFile) throw new Error("ghostguard-plan: approvalsFile is required");

  const policy = config.compiledPolicy ?? compilePolicy(config.policyDoc);
  const recorder = createJsonlRecorder(config.auditFile);
  const approvalsFile = config.approvalsFile;
  const projectId = config.projectId ?? "ghostguard-plan";
  const spendQuorumThreshold = config.spendQuorumThreshold ?? DEFAULT_SPEND_QUORUM_THRESHOLD;
  const planTtlMs = config.planTtlMs ?? DEFAULT_PLAN_TTL_MS;
  const now = config.now ?? (() => Date.now());

  const isoNow = () => new Date(now()).toISOString();

  function evaluate(action, { approved, dryRun, actionId }) {
    const decision = evaluatePolicy(policy, {
      kind: action.kind,
      permission_class: action.permission_class ?? null,
      actor: action.actor,
      project_id: action.project_id ?? projectId,
      approved,
      initiator: action.initiator ?? "person",
      payload: action.payload ?? {},
    });
    const record = gatewayRecordFromDecision(
      {
        action_id: actionId,
        kind: action.kind,
        permission_class: action.permission_class ?? null,
        actor: action.actor,
        initiator: action.initiator ?? "person",
        project_id: action.project_id ?? projectId,
        action_payload: action.payload ?? {},
        dry_run: dryRun,
      },
      decision,
    );
    recorder(record); // record first — throws -> nothing proceeds
    return record;
  }

  /** Quorum for one action: 2 distinct approvers for big SPENDs, else 1. */
  function requiredApprovalsForAction(action) {
    const amount = action?.payload?.amount;
    if (
      action?.permission_class === "SPEND" &&
      typeof amount === "number" &&
      amount > spendQuorumThreshold
    ) {
      return 2;
    }
    return 1;
  }

  /** Quorum for a plan = the strictest quorum any of its steps requires. */
  function requiredApprovalsForSteps(steps) {
    return steps.reduce((max, s) => Math.max(max, requiredApprovalsForAction(s)), 1);
  }

  /**
   * Build a plan from intended actions. Each action is evaluated
   * and recorded with dry_run:true. NO executor exists in this
   * phase — planning cannot cause an effect, by construction.
   */
  function buildPlan(actions, opts = {}) {
    if (!Array.isArray(actions) || actions.length === 0) {
      throw new Error("ghostguard-plan: buildPlan needs at least one action");
    }
    const planId = opts.plan_id ?? randomUUID();
    const createdMs = now();
    const steps = actions.map((action, index) => {
      const record = evaluate(action, {
        approved: false,
        dryRun: true,
        actionId: `${planId}:step:${index}`,
      });
      return {
        index,
        action_id: record.action_id,
        kind: action.kind,
        permission_class: action.permission_class ?? null,
        actor: action.actor,
        payload_hash: actionHash(action),
        payload: action.payload ?? {},
        verdict: record.verdict,
        rule_id: record.rule_id,
        record,
      };
    });
    const actor = opts.actor ?? actions[0].actor;
    const planProject = opts.project_id ?? actions[0].project_id ?? projectId;
    const hasDeny = steps.some((s) => s.verdict === "deny");
    const plan = {
      plan_id: planId,
      actor,
      project_id: planProject,
      initiator: opts.initiator ?? actions[0].initiator ?? "person",
      created_at: new Date(createdMs).toISOString(),
      expires_at: new Date(createdMs + planTtlMs).toISOString(),
      quorum_required: requiredApprovalsForSteps(steps),
      has_deny: hasDeny,
      status: hasDeny ? "denied" : "proposed",
      steps,
      plan_hash: "",
    };
    plan.plan_hash = planHash(plan);
    return plan;
  }

  function isExpired(plan) {
    return now() > Date.parse(plan.expires_at);
  }

  function approvalStatus(plan) {
    const approvals = validApprovals(approvalsFile, plan);
    return {
      approvers: approvals.map((a) => a.approver),
      count: approvals.length,
      required: plan.quorum_required,
      satisfied: approvals.length >= plan.quorum_required,
    };
  }

  function reject(plan, approver, reason) {
    appendApprovalEntry(approvalsFile, {
      entry_type: "approval_rejected",
      channel: "approvals",
      thread: plan.plan_id,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approver,
      actor: plan.actor,
      rejected_at: isoNow(),
      reason,
    });
    return { ok: false, reason, status: approvalStatus(plan) };
  }

  /**
   * Record a human's approval of a plan. Returns { ok, ... } —
   * ok:true means the entry was recorded (check status.satisfied
   * for quorum). Rejections (self-approval, denied plan, expired
   * plan) are recorded on the board too.
   */
  function approvePlan(plan, approver, opts = {}) {
    if (!approver || typeof approver !== "string") {
      throw new Error("ghostguard-plan: approvePlan needs an approver identity string");
    }
    if (planHash(plan) !== plan.plan_hash) return reject(plan, approver, "plan_hash_mismatch");
    if (plan.has_deny || plan.status === "denied") return reject(plan, approver, "plan_contains_deny");
    if (isExpired(plan)) return reject(plan, approver, "plan_expired");
    if (approver === plan.actor) return reject(plan, approver, "self_approval");

    const statusBefore = approvalStatus(plan);
    if (statusBefore.approvers.includes(approver)) {
      return { ok: false, reason: "duplicate_approver", status: statusBefore };
    }
    appendApprovalEntry(approvalsFile, {
      entry_type: "plan_approval",
      channel: "approvals",
      thread: plan.plan_id,
      plan_id: plan.plan_id,
      plan_hash: plan.plan_hash,
      approver,
      actor: plan.actor,
      approved_at: isoNow(),
      quorum_required: plan.quorum_required,
      note: opts.note ?? null,
    });
    return { ok: true, reason: "approved", status: approvalStatus(plan) };
  }

  /**
   * Execute a real run against an approved plan.
   *
   * executor(action) performs the effect and may return a result.
   * It is called ONLY for actions that match the next plan step
   * exactly (kind + permission_class + payload hash, in order),
   * after the real-run gateway record (dry_run:false) is written.
   * The first deviation stops the run: the deviating action is
   * recorded fresh with approved:false and reported as an `ask`.
   */
  function executePlan(plan, realActions, executor) {
    const base = { plan_id: plan.plan_id, executed: [], records: [] };
    if (planHash(plan) !== plan.plan_hash) {
      return { ...base, status: "blocked", reason: "plan_hash_mismatch" };
    }
    if (plan.has_deny || plan.status === "denied") {
      return { ...base, status: "blocked", reason: "plan_contains_deny" };
    }
    if (isExpired(plan)) {
      return { ...base, status: "blocked", reason: "plan_expired" };
    }
    const status = approvalStatus(plan);
    if (!status.satisfied) {
      return {
        ...base,
        status: "blocked",
        reason: status.count > 0 ? "quorum_not_met" : "not_approved",
        approval_status: status,
      };
    }

    const executed = [];
    const records = [];
    for (let i = 0; i < realActions.length; i++) {
      const action = realActions[i];
      const expected = plan.steps[i];
      const matches =
        expected &&
        action.kind === expected.kind &&
        (action.permission_class ?? null) === expected.permission_class &&
        actionHash(action) === expected.payload_hash;

      if (!matches) {
        // Deviation: new / changed / extra / reordered action.
        // Record it as its own fresh action and send it back to ask.
        const record = evaluate(action, {
          approved: false,
          dryRun: false,
          actionId: `${plan.plan_id}:deviation:${i}:${randomUUID()}`,
        });
        records.push(record);
        return {
          plan_id: plan.plan_id,
          status: "deviation",
          reason: expected ? "step_mismatch" : "extra_action",
          deviation_index: i,
          verdict: "ask",
          record,
          executed,
          records,
        };
      }

      // Matching step: record the REAL run (dry_run:false) first.
      // Plan approval is the carried approval (approved:true); a
      // step whose fresh verdict is deny still never executes.
      const record = evaluate(action, {
        approved: true,
        dryRun: false,
        actionId: `${plan.plan_id}:run:${i}`,
      });
      records.push(record);
      if (record.verdict === "deny" || record.verdict === "hand_off") {
        return {
          plan_id: plan.plan_id,
          status: "blocked",
          reason: `step_${record.verdict}`,
          blocked_index: i,
          record,
          executed,
          records,
        };
      }
      const result = executor(action);
      executed.push({ index: i, action_id: record.action_id, kind: action.kind, result });
    }
    return { plan_id: plan.plan_id, status: "executed", reason: "plan_complete", executed, records };
  }

  return {
    buildPlan,
    approvePlan,
    approvalStatus,
    executePlan,
    requiredApprovalsForAction,
    readApprovalEntries: () => readApprovalEntries(approvalsFile),
    config: { projectId, spendQuorumThreshold, planTtlMs },
  };
}

/** The example policy used by the demo and the tests. */
export function examplePolicyDoc() {
  return {
    rules: [
      {
        id: "no-huge-spend-ever",
        effect: "deny",
        locked: true,
        when: "permission_class == 'SPEND' && payload.amount > 10000",
        note: "Locked: no plan approval, overlay, or approver can release a spend over 10000.",
      },
      {
        id: "no-delete-ever",
        effect: "deny",
        locked: true,
        when: "permission_class == 'DELETE'",
      },
      { id: "spend-ask", effect: "ask", when: "permission_class == 'SPEND'" },
      { id: "deploy-ask", effect: "ask", when: "permission_class == 'DEPLOY'" },
      { id: "comms-ask", effect: "ask", when: "permission_class == 'COMMUNICATE'" },
      { id: "publish-ask", effect: "ask", when: "permission_class == 'PUBLISH'" },
      { id: "allow-rest", effect: "allow", when: "true" },
    ],
  };
}
