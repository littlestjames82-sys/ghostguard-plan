import { createHash } from "node:crypto";

/**
 * Canonical JSON + SHA-256 hashing.
 *
 * Everything approval-related in this package is bound to a hash of
 * canonical JSON (object keys sorted recursively): the same logical
 * content hashes identically regardless of key order, and any change
 * to any value produces a different hash.
 */

export function canonicalStringify(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item)).join(",")}]`;
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`);
  return `{${parts.join(",")}}`;
}

export function sha256Hex(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Hash of one intended action: kind + permission class + exact payload. */
export function actionHash(action) {
  return sha256Hex(
    canonicalStringify({
      kind: action.kind,
      permission_class: action.permission_class,
      payload: action.payload ?? {},
    }),
  );
}

/**
 * Hash of a plan's exact contents: who proposed it, which project,
 * and the ordered sequence of per-step action hashes. Editing,
 * reordering, adding, or removing a step after approval changes
 * this hash — and approvals are bound to it, so they stop matching.
 */
export function planHash(planLike) {
  return sha256Hex(
    canonicalStringify({
      actor: planLike.actor,
      project_id: planLike.project_id,
      steps: (planLike.steps ?? []).map((s) => ({
        kind: s.kind,
        permission_class: s.permission_class,
        payload_hash: s.payload_hash,
      })),
    }),
  );
}
