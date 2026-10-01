/** Methods the mobile Add-project entry (repo add/clone/create) adds beyond the
 *  shared mobile allowlist, which sits at the repo's file-size cap. */
export const MOBILE_REPO_RPC_METHOD_ALLOWLIST = new Set(['repo.add', 'repo.clone', 'repo.create'])
