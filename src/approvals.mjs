import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The approvals board — an append-only JSONL file shaped like a
 * GhostBus approvals channel (a "thread" per plan, one "message"
 * per approval or rejection), implemented locally: this prototype
 * does NOT depend on a live bus. Swapping this file for real
 * GhostBus posts later changes the transport, not the semantics.
 *
 * Entry kinds:
 *   plan_approval      { approver, plan_id, plan_hash, approved_at, ... }
 *   approval_rejected  { approver, plan_id, plan_hash, rejected_at, reason }
 *
 * The file is only ever appended to. A rejected approval (self-
 * approval, a denied plan, an expired plan) is recorded as its own
 * entry — the rejection is part of the trail, not a silent no-op.
 *
 * Honest trust model: `approver` is a claimed identity string.
 * Anyone who can append to this file can approve. That is a local
 * prototype boundary, not authentication — see README.
 */

export function appendApprovalEntry(approvalsFile, entry) {
  mkdirSync(dirname(approvalsFile), { recursive: true });
  appendFileSync(approvalsFile, `${JSON.stringify(entry)}\n`, "utf8");
  return entry;
}

export function readApprovalEntries(approvalsFile) {
  if (!approvalsFile || !existsSync(approvalsFile)) return [];
  const text = readFileSync(approvalsFile, "utf8").trim();
  if (!text) return [];
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * Valid approvals for a plan: plan_approval entries whose plan_hash
 * matches the plan's CURRENT hash, from approvers who are NOT the
 * plan's proposer (separation of duties), deduplicated by approver
 * (the same person approving twice still counts once toward quorum).
 */
export function validApprovals(approvalsFile, plan) {
  const byApprover = new Map();
  for (const entry of readApprovalEntries(approvalsFile)) {
    if (entry.entry_type !== "plan_approval") continue;
    if (entry.plan_id !== plan.plan_id) continue;
    if (entry.plan_hash !== plan.plan_hash) continue;
    if (entry.approver === plan.actor) continue; // self-approval never counts
    if (!byApprover.has(entry.approver)) byApprover.set(entry.approver, entry);
  }
  return [...byApprover.values()];
}
