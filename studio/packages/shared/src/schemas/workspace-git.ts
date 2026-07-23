import { z } from 'zod';

/**
 * #3 G2 — the workspace↔git association (Foundation Spec #3, Option A:
 * DB-SSOT + git seam). ONE row per owner: which repo, which collaboration
 * branch, and the last OBSERVED collaboration-branch head (the drift
 * reference G3's commit guard and G4's import will read). The managed
 * checkout itself lives on disk under the server's `workspaceGitRoot`; this
 * schema is the DB's record of it.
 *
 * No `resourceId` here, deliberately: `workspace_git` is per-machine
 * workspace CONFIG — it is never serialized into the repo, so it sits
 * outside the export/import identity universe G1 built. Owner-scoping
 * (`ownerId`) is the identity that matters.
 */

const MAX_REPO_URL_LEN = 2000;

/**
 * The repo source handed to `git clone`. A closed ALLOWLIST of forms, not a
 * free string — `repoUrl` is user-controlled input that becomes a git argv
 * element, and git accepts transport schemes that execute commands
 * (`ext::sh -c …`), so unknown forms are refused at the boundary (the argv is
 * additionally `--`-separated in the provider; this is defence in depth).
 *
 * Allowed: `https://`, `ssh://`, scp-like `user@host:path`, `file://`, or an
 * absolute filesystem path (a LOCAL repo is connected by using its path as
 * the clone REMOTE — the user's own checkout is never studio's working tree).
 *
 * Embedded userinfo PASSWORDS are refused outright: the URL is stored
 * plaintext in the DB row and quoted in error messages, so a
 * `https://user:token@host` credential would leak into both. Auth in G2 is
 * the operator's own environment (SSH agent / credential helper); stored
 * PATs are G10. A bare username (`https://user@host`) is fine — not a secret.
 */
export const WorkspaceGitRepoUrlSchema = z
  .string()
  .min(1)
  .max(MAX_REPO_URL_LEN)
  .superRefine((value, ctx) => {
    const refuse = (message: string) => ctx.addIssue({ code: 'custom', message });

    if (/^(https|ssh|file):\/\//.test(value)) {
      // Userinfo-with-password: `scheme://user:password@host…`. Matched by
      // regex, not `new URL()` — this schema is FE/BE-shared and the shared
      // package compiles against no DOM/node globals. A malformed URL that
      // slips past is git's to refuse (surfaced as a redacted `git_error`).
      if (/^[a-z]+:\/\/[^/@]*:[^/@]*@/.test(value)) {
        refuse(
          'repoUrl must not embed a credential (user:password@…) — use the SSH agent or a git credential helper',
        );
      }
      // Option-shaped userinfo/host (`ssh://-oProxyCommand=…`). Git ≥2.14.1
      // blocks dash-leading hostnames itself; refusing here keeps the
      // boundary defence self-contained rather than leaning on git's.
      if (/^[a-z]+:\/\/(?:[^/@]*@)?-/.test(value)) {
        refuse('repoUrl host must not start with "-"');
      }
      return;
    }

    // scp-like `user@host:path` (the classic `git@github.com:org/repo.git`).
    // Conservative charset on user/host, first char never `-` (an
    // option-shaped user/host like `git@-oBatchMode:…` must not pass — git
    // blocks "strange hostnames" itself, but the boundary defence stays
    // self-contained). A `:` in the user part (an embedded `user:password@`
    // credential) fails this match and falls through to the refusal below,
    // so the credential rule holds here by construction.
    if (/^[A-Za-z0-9._][A-Za-z0-9._-]*@[A-Za-z0-9._][A-Za-z0-9._-]*:[^:]/.test(value)) return;

    // Absolute local path (the clone REMOTE for a local repo).
    if (value.startsWith('/')) return;

    refuse(
      'repoUrl must be an https://, ssh://, file:// URL, an scp-like user@host:path, or an absolute path',
    );
  });

const MAX_BRANCH_LEN = 255;

/**
 * A git branch name, validated to `git check-ref-format`'s shape. The
 * provider interpolates this into `refs/remotes/origin/<branch>` — a `..` or
 * `@{` would address a DIFFERENT ref (or produce garbage errors), so refusal
 * happens here at the system boundary, not in git's error output.
 */
export const WorkspaceGitBranchSchema = z
  .string()
  .min(1)
  .max(MAX_BRANCH_LEN)
  .superRefine((value, ctx) => {
    const refuse = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (value === '@') return refuse('branch must not be "@"');
    if (value.includes('..')) return refuse('branch must not contain ".."');
    if (value.includes('@{')) return refuse('branch must not contain "@{"');
    if (value.includes('//')) return refuse('branch must not contain "//"');
    // eslint-disable-next-line no-control-regex
    if (/[ ~^:?*[\\\x00-\x1f\x7f]/.test(value))
      return refuse('branch contains a character git refs forbid');
    if (value.startsWith('/') || value.endsWith('/'))
      return refuse('branch must not start or end with "/"');
    if (value.startsWith('.') || value.endsWith('.'))
      return refuse('branch must not start or end with "."');
    if (value.endsWith('.lock')) return refuse('branch must not end with ".lock"');
  });

/**
 * The full `workspace_git` row. Tracking fields are REQUIRED-nullable — a
 * `null` means "not observed" and must be stated, never manufactured by a
 * `.default()` (#473: an absent fact is not a benign default).
 */
export const WorkspaceGitSchema = z.object({
  id: z.string(),
  ownerId: z.string().nullable(),
  // STRUCTURAL strings, deliberately NOT the input-policy validators above:
  // policy is enforced once, at the connect boundary (`ConnectWorkspaceGitBody`).
  // The ROW schema re-parses on every read — if it embedded the allowlist, any
  // future policy TIGHTENING (G10 revisiting a scheme, say) would turn
  // previously-valid stored rows into read-time throws (500 on GET) instead of
  // only refusing new connects.
  repoUrl: z.string().min(1),
  collabBranch: z.string().min(1),
  /** Last observed `refs/remotes/origin/<collabBranch>` sha; null = the branch was not found at the last sync. */
  observedCollabHead: z.string().nullable(),
  /** Epoch-ms of the last sync attempt (connect counts); null = never synced. */
  lastFetchAt: z.number().int().nullable(),
  /** REDACTED failure message from the last sync attempt; null = it succeeded. */
  lastFetchError: z.string().nullable(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});
export type WorkspaceGit = z.infer<typeof WorkspaceGitSchema>;

/** Connect body: the repo source + optionally which branch is the collaboration branch. */
export const ConnectWorkspaceGitBodySchema = z
  .object({
    repoUrl: WorkspaceGitRepoUrlSchema,
    collabBranch: WorkspaceGitBranchSchema.default('main'),
  })
  .strict();
export type ConnectWorkspaceGitBody = z.infer<typeof ConnectWorkspaceGitBodySchema>;

export const WorkspaceGitStateSchema = z.enum(['ready', 'collab_branch_missing', 'fetch_error']);
export type WorkspaceGitState = z.infer<typeof WorkspaceGitStateSchema>;

/**
 * Derives the human-facing sync state from the tracking fields. Precedence is
 * pinned (and FE/BE-shared so the two can't disagree): a recorded error wins
 * over a stale prior head — "fetch failed" must not render as "ready" just
 * because an EARLIER fetch once saw the branch; then a missing head means the
 * collaboration branch does not exist at the remote (a real onboarding state:
 * connect an empty repo, then G3's first export creates the branch); else ready.
 */
export function deriveWorkspaceGitState(fields: {
  lastFetchError: string | null;
  observedCollabHead: string | null;
}): WorkspaceGitState {
  if (fields.lastFetchError !== null) return 'fetch_error';
  if (fields.observedCollabHead === null) return 'collab_branch_missing';
  return 'ready';
}

/** The GET/POST response shape: the row plus the derived state. */
export const WorkspaceGitStatusSchema = WorkspaceGitSchema.extend({
  state: WorkspaceGitStateSchema,
});
export type WorkspaceGitStatus = z.infer<typeof WorkspaceGitStatusSchema>;
