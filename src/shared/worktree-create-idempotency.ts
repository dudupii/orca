// Why: older hosts strip worktree.create's clientMutationId, so mobile must only
// replay ambiguous cutovers when the host advertises idempotent create support;
// status.worktreeCreateIdempotency carries the optional host retention policy.
export const WORKTREE_CREATE_IDEMPOTENCY_RUNTIME_CAPABILITY =
  'worktree.create-idempotency.v1' as const
