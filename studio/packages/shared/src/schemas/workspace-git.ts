import { z } from 'zod';
import { ExportKindSchema } from '../portability/envelope.js';

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
 * #3 G9 — the DEFAULT working branch a workspace gets on connect: the
 * studio-owned convention `studio/<ownerId>/work`. The SINGLE source of this
 * convention (CLAUDE.md: one source of truth for constants) — the connect route
 * seeds `working_branch` with it, and the `0031` migration backfill reproduces
 * it in SQL (`'studio/' || COALESCE(owner_id,'null') || '/work'`) as a
 * documented snapshot-duplicate (the same posture the `secret_status` kind list
 * takes across `deriveSecretStatus` + its `0030` backfill). `ownerId` is the
 * principal's owner (always a concrete string in v1, `'local'`); the `null`
 * branch mirrors JS `` `studio/${null}/work` `` = `studio/null/work`, which the
 * SQL `COALESCE` matches exactly.
 */
export function deriveDefaultWorkingBranch(ownerId: string | null): string {
  return `studio/${ownerId}/work`;
}

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
  /**
   * The studio-owned working branch a Commit lands on and a PR is opened FROM
   * (#3 G9). Unlike `repoUrl`/`collabBranch` (fixed at connect), this is the ONE
   * post-connect-mutable field — feature-branch selection re-points it (see
   * `updateWorkspaceGitWorkingBranch`). STRUCTURAL string here for the same
   * reason as the two above: the row re-parses on every read, so it must not
   * embed the check-ref-format validator (`SetWorkingBranchBodySchema` enforces
   * that at the input boundary). Defaults to `deriveDefaultWorkingBranch` on
   * connect; never null (nullable-in-SQL + backfilled + always-set-on-write, the
   * `secret_status` #473 posture — a null would fail loudly here, not read as a
   * benign default).
   */
  workingBranch: z.string().min(1),
  /** Last observed `refs/remotes/origin/<collabBranch>` sha; null = the branch was not found at the last sync. */
  observedCollabHead: z.string().nullable(),
  /**
   * #3 G10 — the collab commit the most recent NON-REFUSED import read from (the
   * PROACTIVE descendant-guard base, settled #662: "the commit the DB was
   * imported from — NOT collab-HEAD, that defeats feature branches"). It records
   * PROVENANCE/ancestry, NOT content-equality: an import can leave `deferred`
   * resources, so this never claims "the DB equals this commit" (that is DRIFT's
   * job, `/drift`). `null` = no import has ever been applied for this owner (a
   * pre-G10 row, or a workspace that only ever committed OUT) — the divergence
   * report is `unknown` until the first import stamps it. REQUIRED-nullable, no
   * `.default()`: an absent import fact is stated `null`, never manufactured
   * (#473 — the same posture as `observedCollabHead`).
   */
  importedFromCommit: z.string().nullable(),
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
  /**
   * #3 G10 — whether a per-workspace git token is stored (encrypted at rest).
   * The ONLY client-facing signal about the stored token: the ciphertext itself
   * is kept out of `WorkspaceGitSchema` (stripped on read) and NEVER returned.
   * An EXPLICIT boolean, never defaulted — the presence of a credential is a
   * fact stated honestly, not manufactured (#473). Computed server-side from the
   * `git_token_encrypted` column's non-nullness.
   */
  hasStoredToken: z.boolean(),
});
export type WorkspaceGitStatus = z.infer<typeof WorkspaceGitStatusSchema>;

const MAX_GIT_TOKEN_LEN = 500;

/**
 * #3 G10 — a stored git token (a GitHub PAT / installation token). `.trim()`
 * first so a whitespace-padded value normalizes and a whitespace-only value
 * fails `.min(1)` (an all-blank token is never a real credential). Control
 * chars — CR/LF especially — are refused OUTRIGHT: the token is passed RAW into
 * an `Authorization: Bearer <token>` HTTP header on the REST PR-open path
 * (`git/github-host.ts`), where a CR/LF is a header-injection / `Headers`-throw
 * hazard (the transport path base64-wraps it, so it is inert there, but the
 * REST path is not — validate at the boundary for the stricter consumer). Capped
 * so a pathological body can't be stored/encrypted. Input policy lives HERE at
 * the boundary, mirroring the repoUrl/branch/commit-message validators above.
 */
export const WorkspaceGitTokenSchema = z
  .string()
  .trim()
  .min(1, 'token must not be empty')
  .max(MAX_GIT_TOKEN_LEN)
  // eslint-disable-next-line no-control-regex
  .refine((value) => !/[\x00-\x1f\x7f]/.test(value), 'token must not contain control characters');

/**
 * #3 G10 — the `PUT /api/workspace/git/token` body: just the token. `.strict()`
 * — an unknown key is a 400, so a client can't smuggle an unexpected field past
 * the boundary onto a credential-setting route.
 */
export const SetWorkspaceGitTokenBodySchema = z
  .object({
    token: WorkspaceGitTokenSchema,
  })
  .strict();
export type SetWorkspaceGitTokenBody = z.infer<typeof SetWorkspaceGitTokenBodySchema>;

const MAX_COMMIT_MESSAGE_LEN = 2000;

/**
 * #3 G3a — a Commit message. `.trim()` first so a whitespace-only message
 * fails `.min(1)` (git refuses `commit -m ""` without `--allow-empty-message`,
 * which would surface as a raw non-zero exit); the trimmed value is what
 * reaches the git argv. NUL is refused outright — git cannot carry it in a
 * commit message and it has no business at a text boundary. Newlines ARE
 * allowed (multi-paragraph messages are valid git). Input policy lives here at
 * the boundary, mirroring the repoUrl/branch validators above.
 */
export const CommitMessageSchema = z
  .string()
  .trim()
  .min(1, 'commit message must not be empty')
  .max(MAX_COMMIT_MESSAGE_LEN)
  .refine((value) => !value.includes('\x00'), 'commit message must not contain a NUL byte');

/** Commit body: just the message — the working branch is now the persisted,
 * per-workspace `working_branch` (#3 G9; set via `SetWorkingBranchBodySchema`,
 * defaulted on connect), no longer derived per-commit. */
export const CommitWorkspaceGitBodySchema = z
  .object({
    message: CommitMessageSchema,
  })
  .strict();
export type CommitWorkspaceGitBody = z.infer<typeof CommitWorkspaceGitBodySchema>;

/**
 * #3 G9 — feature-branch SELECTION: set which working branch the workspace
 * commits to and opens PRs from. The check-ref-format policy validator lives
 * HERE at the input boundary (not on the row schema — see `WorkspaceGitSchema`),
 * so a hostile/typo'd branch is refused before it reaches the git argv or a
 * `refs/…/<branch>` interpolation. `.strict()` — an unknown key is a 400.
 */
export const SetWorkingBranchBodySchema = z
  .object({
    workingBranch: WorkspaceGitBranchSchema,
  })
  .strict();
export type SetWorkingBranchBody = z.infer<typeof SetWorkingBranchBodySchema>;

/**
 * The Commit result. `committed:false` (with `commitSha:null`) is the no-op
 * outcome — the serialized files were already identical to the working
 * branch's tip, so nothing was committed or pushed. `files` is the managed
 * file set the serialization produced (always the current working copy),
 * regardless of whether a commit happened.
 */
export const WorkspaceGitCommitResultSchema = z.object({
  committed: z.boolean(),
  branch: z.string().min(1),
  commitSha: z.string().min(1).nullable(),
  files: z.array(z.string().min(1)),
});
export type WorkspaceGitCommitResult = z.infer<typeof WorkspaceGitCommitResultSchema>;

/**
 * #3 G4 — one problem the workspace parser found in a committed file. Reported
 * from the import-preview so a malformed branch is VISIBLE, never silently
 * dropped (#473 shape). The `message` is a fixed, categorical string keyed by
 * `code` — deliberately NOT the raw JSON/Zod error text, which could echo
 * arbitrary committed file content into an API response.
 * - `unparseable`: not valid JSON / failed envelope upgrade+validation.
 * - `kind_mismatch`: a valid envelope whose `kind` disagrees with its directory.
 * - `duplicate_resource_id`: a non-null `resourceId` claimed by 2+ files of a kind.
 * - `unknown_dir`: a file outside the three managed directories.
 * - `unreadable`: the committed blob could not be READ from the object store
 *   (over the provider's 1 MiB collected-output cap, or a per-blob git failure).
 *   Its content was never parsed, so — like `unparseable` — it makes a preview
 *   VISIBLE (never a whole-workspace 502, #664) and REFUSES an apply fail-closed
 *   (an incomplete snapshot must not archive a pipeline whose file merely failed
 *   to read).
 */
export const WorkspaceParseDiagnosticCodeSchema = z.enum([
  'unparseable',
  'kind_mismatch',
  'duplicate_resource_id',
  'unknown_dir',
  'unreadable',
]);
export type WorkspaceParseDiagnosticCode = z.infer<typeof WorkspaceParseDiagnosticCodeSchema>;

export const WorkspaceParseDiagnosticSchema = z.object({
  path: z.string().min(1),
  code: WorkspaceParseDiagnosticCodeSchema,
  message: z.string().min(1),
});
export type WorkspaceParseDiagnostic = z.infer<typeof WorkspaceParseDiagnosticSchema>;

/**
 * #3 G5b — the reconcile DISPOSITION of a resource on the branch, relative to
 * the DB workspace, matched by stable `resourceId`:
 * - `create`: no DB resource has this `resourceId` (or the file is pre-G1 with
 *   no `resourceId` — legacy-no-identity → create-new).
 * - `unchanged`: a DB resource matches and neither its content NOR its name
 *   differs — a pull would be a no-op for it.
 * - `update`: a DB resource matches but its canonical CONTENT differs (a pull
 *   would mint a new immutable version / upsert). May ALSO be a rename — see the
 *   independent `nameChanged` flag (a content edit outranks it in the label).
 * - `rename`: a DB resource matches, content is identical, only the display
 *   name (hence the cosmetic file path) differs.
 * - `superseded` (#983): PIPELINES ONLY — the branch's version doc is one this
 *   workspace ALREADY HOLDS and has since authored PAST (the ordinary "commit,
 *   keep working, then pull" loop). The content really does differ from the
 *   pipeline's head, so `contentChanged` stays `true`; what the label adds is
 *   that a pull would write NOTHING for it, because immutable versions are
 *   additive and the version the branch names is already present and
 *   byte-identical. Its own value rather than `unchanged` for the same reason
 *   `WorkspaceGitAppliedAction.superseded` gives on the apply side: a bare
 *   `unchanged` beside a `contentChanged: true` is two statements that
 *   contradict each other, with no way to tell which is wrong. The two enums are
 *   deliberately kept in step so the preview and the outcome name one fact one
 *   way — before #983 the preview said `update` here and the apply then reported
 *   `superseded`, which read as the import having quietly declined to do what
 *   the preview promised.
 * The apply of these dispositions (the transactional write-path) is G5c; this
 * preview is read-only.
 */
export const WorkspaceGitDispositionSchema = z.enum([
  'create',
  'unchanged',
  'update',
  'rename',
  'superseded',
]);
export type WorkspaceGitDisposition = z.infer<typeof WorkspaceGitDispositionSchema>;

/**
 * #983 — whether a previewed `disposition` means a pull would WRITE NOTHING for
 * that resource. The pull-direction twin of `appliedActionWroteNothing`, and it
 * exists for the same reason that one does: every reader of this enum is really
 * asking "will anything change?", and each spells it `disposition !== 'unchanged'`
 * — a comparison that keeps compiling when a SECOND did-nothing value appears
 * and silently starts counting a no-op as a pending change. That is exactly what
 * adding `superseded` would have done to the Git page's import confirmation,
 * which counts the resources an import will touch.
 */
export function dispositionWritesNothing(disposition: WorkspaceGitDisposition): boolean {
  return disposition === 'unchanged' || disposition === 'superseded';
}

/**
 * #3 G4/G5b — a resource the parser recognised on the branch, as a PREVIEW
 * SUMMARY (path, kind, stable id, display name) carrying its reconcile
 * `disposition` vs the DB (#3 G5b). `nameChanged`/`contentChanged` are the
 * independent signals the `disposition` label summarises — kept explicit so a
 * rename that ALSO edits content loses neither signal (the apply, G5c, needs
 * both). Both are `false` for a `create` (there is no DB counterpart to diff).
 * `resourceId` is `null` for a pre-G1 file with no stable identity.
 *
 * `contentUnverified` (#1018) is the preview twin of
 * `WorkspaceGitAppliedResource.versionContentUnverified`, and exists for the same
 * reason the two enums are kept in step: the import that follows will report it,
 * so a preview silent about it would be describing a different comparison from
 * the one the apply makes. It is TRUE when the branch's version names a stored
 * row that references a DELETED resource, whose ref therefore cannot be put in
 * resourceId-space and is excused from the comparison. Always `false` for a
 * connection or a trigger (neither has versions) and for a `create`.
 */
export const WorkspaceGitPreviewResourceSchema = z.object({
  path: z.string().min(1),
  kind: ExportKindSchema,
  resourceId: z.string().min(1).nullable(),
  name: z.string(),
  disposition: WorkspaceGitDispositionSchema,
  nameChanged: z.boolean(),
  contentChanged: z.boolean(),
  contentUnverified: z.boolean(),
});
export type WorkspaceGitPreviewResource = z.infer<typeof WorkspaceGitPreviewResourceSchema>;

/**
 * #3 G5b — a DB pipeline the pull would ARCHIVE: it exists (non-archived) in the
 * DB workspace but its `resourceId` is ABSENT from the branch, i.e. its file was
 * deleted in git. Only PIPELINES have an archive state (G5a) — a connection or
 * trigger absent from the branch is DELIBERATELY not surfaced here (its
 * delete/orphan semantics are undecided in the spec — "never DB-delete on
 * import" — and are deferred to the G5c apply). `path` is where the pipeline's
 * file WOULD be, for display continuity with `resources`.
 */
export const WorkspaceGitArchiveProposalSchema = z.object({
  path: z.string().min(1),
  kind: z.literal('pipeline'),
  resourceId: z.string().min(1),
  name: z.string(),
});
export type WorkspaceGitArchiveProposal = z.infer<typeof WorkspaceGitArchiveProposalSchema>;

/**
 * #3 G4/G5b — the `POST /api/workspace/git/import-preview` result: the
 * collab-branch head the preview was parsed at (`null` when the collaboration
 * branch does not exist yet — the empty-repo / first-run state), the recognised
 * resources each carrying its reconcile `disposition` vs the DB, the pipelines a
 * pull would archive, and every parse diagnostic. Read-only: the classify reads
 * DB rows but WRITES nothing (the apply is G5c).
 */
export const WorkspaceGitImportPreviewSchema = z.object({
  head: z.string().min(1).nullable(),
  resources: z.array(WorkspaceGitPreviewResourceSchema),
  archive: z.array(WorkspaceGitArchiveProposalSchema),
  diagnostics: z.array(WorkspaceParseDiagnosticSchema),
});
export type WorkspaceGitImportPreview = z.infer<typeof WorkspaceGitImportPreviewSchema>;

/**
 * #3 G10 — a resource's DRIFT vs the studio working branch, the COMMIT-direction
 * dual of the pull-direction `WorkspaceGitDisposition`. Matched by stable
 * `resourceId` (identity; the PATH is cosmetic, G1); equality is the canonical
 * CONTENT FORM (`content-form.ts`) exactly as the reconcile classifier uses,
 * NOT byte/blob equality — so a re-mint that only bumps volatile fields (version
 * id/number, `node.position`) is NOT drift (settled #662: "uncommitted iff
 * canonicalHash(latest version, G1 volatile-exclusions) ≠ the blob last
 * committed/imported for that resourceId"). `clean` resources are omitted from
 * the report, so only these four ever appear:
 * - `added`: in the DB working copy, ABSENT from the working branch (a new
 *   resource the next Commit would create).
 * - `removed`: on the working branch, ABSENT from the DB (a deleted/archived
 *   resource the next Commit would drop; also a pre-G1 committed file with no
 *   `resourceId`, which can never match an identity-bearing DB resource).
 * - `modified`: matched, but the canonical content form DIFFERS.
 * - `renamed`: matched, content form IDENTICAL, only the display name (hence the
 *   cosmetic file path) differs. A resource that is BOTH renamed and content-
 *   edited is `modified` (content supersedes, mirroring the reconcile's
 *   `disposition()` precedence).
 */
export const WorkspaceGitDriftChangeSchema = z.enum(['added', 'removed', 'modified', 'renamed']);
export type WorkspaceGitDriftChange = z.infer<typeof WorkspaceGitDriftChangeSchema>;

/**
 * #3 G10 — one drifted resource in the drift report (path, kind, stable id,
 * display name, its `change` vs the working branch). `resourceId` is `null` only
 * for a pre-G1 committed file with no stable identity (always a `removed`).
 * `path` is the DB working-copy path for `added`/`modified`/`renamed` (the
 * current/target path) and the committed path for `removed`.
 */
export const WorkspaceGitDriftResourceSchema = z.object({
  path: z.string().min(1),
  kind: ExportKindSchema,
  resourceId: z.string().min(1).nullable(),
  name: z.string(),
  change: WorkspaceGitDriftChangeSchema,
});
export type WorkspaceGitDriftResource = z.infer<typeof WorkspaceGitDriftResourceSchema>;

/**
 * #3 G10 — the `POST /api/workspace/git/drift` result: an ADVISORY, read-only
 * "do I have uncommitted changes, and which resources" report. `base` is the
 * resolved commit the DB was compared against — the working-branch tip if it
 * exists, else the collaboration-branch tip, else `null` (nothing committed yet,
 * so every DB resource is `added`) — mirroring the Commit route's base
 * selection, so drift answers "what my next Commit would change". Drift is
 * advisory (spec #662): the real serialization point is push non-fast-forward /
 * PR-merge. `diagnostics` carries a committed file that would NOT parse
 * (VISIBLE, never a silent `clean`, #473/#664 shape) — its content could not be
 * compared, so it is excluded from `changes` rather than manufactured as a match,
 * but it DOES set `hasUncommittedChanges` (the next Commit's managed-dir
 * reconcile would drop it, so an uncomparable committed file is pending drift).
 */
export const WorkspaceGitDriftSchema = z.object({
  base: z.string().min(1).nullable(),
  hasUncommittedChanges: z.boolean(),
  changes: z.array(WorkspaceGitDriftResourceSchema),
  diagnostics: z.array(WorkspaceParseDiagnosticSchema),
});
export type WorkspaceGitDrift = z.infer<typeof WorkspaceGitDriftSchema>;

/**
 * #3 G10 — the PROACTIVE descendant-guard verdict: has the collaboration branch
 * moved relative to the commit the DB was last imported from (settled #662)? The
 * ADVISORY, commit-source-side complement to slice-2's reactive push-conflict
 * classification. Never blocks — the real serialization point is push
 * non-fast-forward / PR-merge.
 * - `current`: the import base IS the current collab head — the DB was imported
 *   from exactly where collab sits now.
 * - `behind`: collab has fast-forwarded PAST the import base (the base is an
 *   ancestor of the current head) — a pull/re-import would fast-forward. The
 *   normal "collab advanced since you imported" advisory.
 * - `diverged`: the current collab head is NOT a descendant of the import base —
 *   collab history was rewritten (force-push) relative to the base, so a merge
 *   would not fast-forward.
 * - `unknown`: no base to guard against — either no import has ever been applied
 *   (`importBase` null) OR the collaboration branch is absent at the last sync
 *   (`collabHead` null: empty repo, or the branch was DELETED since import —
 *   the deleted case is subsumed here rather than distinguished, because a null
 *   head is also the empty-repo state and the two are indistinguishable; a
 *   missing collab branch is already surfaced by the main status'
 *   `collab_branch_missing`). Raw `importBase`/`collabHead` are echoed so a
 *   caller can see which null it was.
 */
export const WorkspaceGitDivergenceStateSchema = z.enum([
  'current',
  'behind',
  'diverged',
  'unknown',
]);
export type WorkspaceGitDivergenceState = z.infer<typeof WorkspaceGitDivergenceStateSchema>;

/**
 * #3 G10 — the `POST /api/workspace/git/divergence` result. `importBase` is the
 * persisted `importedFromCommit` (the collab commit the last non-refused import
 * read from); `collabHead` is the freshly-fetched `observedCollabHead`. Both are
 * echoed (required-nullable) so the raw shas are visible alongside the verdict.
 */
export const WorkspaceGitDivergenceSchema = z.object({
  state: WorkspaceGitDivergenceStateSchema,
  importBase: z.string().nullable(),
  collabHead: z.string().nullable(),
});
export type WorkspaceGitDivergence = z.infer<typeof WorkspaceGitDivergenceSchema>;

/**
 * The GIT-INDEPENDENT part of the divergence classification (a pure fn so it is
 * unit-tested without a real repo, mirroring the reconcile/drift pure
 * classifiers). Decides the cases that need no history walk; a `needs-history`
 * result tells the route to run the one `merge-base --is-ancestor` git read that
 * splits `behind` (base is an ancestor of head) from `diverged` (it is not).
 * Keeping the null/equality logic here means the route's only impurity is that
 * single git call.
 */
export type DivergencePrecheck = 'unknown' | 'current' | 'needs-history';
export function precheckDivergence(
  importBase: string | null,
  collabHead: string | null,
): DivergencePrecheck {
  // No base to guard against, or no head to compare it to (empty repo /
  // deleted-since-import collab branch) — cannot classify divergence.
  if (importBase === null || collabHead === null) return 'unknown';
  // Imported from exactly where collab sits now — no walk needed.
  if (importBase === collabHead) return 'current';
  // The heads differ: only a history walk (`merge-base --is-ancestor`) can tell
  // a fast-forward (`behind`) from a rewrite (`diverged`).
  return 'needs-history';
}

/**
 * #3 G5c — what the transactional apply DID to one branch resource:
 * - `created`: no DB resource had this `resourceId` → a fresh row (+ version) was
 *   inserted, PRESERVING the file's `resourceId`.
 * - `restored`: the `resourceId` matched a soft-archived pipeline whose file
 *   reappeared → the existing row was un-archived (not duplicated; spec note 1).
 *   A restore MAY also advance the version — see the orthogonal `versionMinted`.
 * - `updated`: the version doc and/or a row field (`concurrency`) changed → a new
 *   immutable version was minted and/or the row patched.
 * - `renamed`: only the display name changed → the row's `name` was patched, no
 *   version minted.
 * - `unchanged`: a matching resource was identical → no write.
 * - `superseded` (#963): the branch's version doc is one this workspace ALREADY
 *   holds and has since authored PAST — the ordinary "commit, keep working, then
 *   pull" loop. Nothing is written, because immutable versions are additive and
 *   the named row is already present and byte-identical. Its own value rather
 *   than `unchanged` because the preview truthfully said "content differs"
 *   (the branch does differ from the HEAD), so reporting a bare `unchanged`
 *   would leave the operator with two statements that contradict each other and
 *   no way to tell which is wrong. Note this is NOT a revert: branch content
 *   alone cannot distinguish "re-pull of an older commit" from "deliberate
 *   revert to an older version", and going back is re-authoring, not importing.
 *
 * `action` and `versionMinted` are ORTHOGONAL: `action` is the row-level
 * disposition, `versionMinted` is whether a new immutable version was minted in
 * the SAME apply. They coincide for `updated` (a content change mints) but a
 * `restored` can carry EITHER value (#672 — un-archive alone, or un-archive + a
 * changed version doc), so the version signal is not derivable from `action`.
 * `superseded` ranks BELOW every write-bearing action and above `unchanged`: a
 * restore/rename/concurrency patch in the same apply is the louder fact and
 * still wins, since those describe a write that happened and this describes one
 * that was correctly not needed.
 */
export const WorkspaceGitAppliedActionSchema = z.enum([
  'created',
  'restored',
  'updated',
  'renamed',
  'superseded',
  'unchanged',
]);
export type WorkspaceGitAppliedAction = z.infer<typeof WorkspaceGitAppliedActionSchema>;

/**
 * #963 — whether an `action` means NOTHING WAS WRITTEN for that resource.
 *
 * A predicate rather than the `action !== 'unchanged'` comparison its two callers
 * used to spell out, because adding `superseded` proved that comparison is a
 * silent trap: both readers ask "did anything change?" structurally, so neither
 * failed to compile when a THIRD did-nothing value appeared, and both would have
 * started counting a pure no-op as a change — the audit log emitting an
 * `import.applied` for an import that wrote nothing, and the Git page's roll-up
 * saying "N changed" about resources it did not touch.
 *
 * `versionMinted` is deliberately NOT folded in here: it is ORTHOGONAL to
 * `action` (#672), so a caller that cares about mints must test it separately —
 * as `buildImportAppliedEvent` does. This answers only the row-level question.
 */
export function appliedActionWroteNothing(action: WorkspaceGitAppliedAction): boolean {
  return action === 'unchanged' || action === 'superseded';
}

/** #3 G5c — one resource the apply wrote (or confirmed unchanged), with the
 * concrete `action` taken. `resourceId` is the resource's stable identity after
 * apply (never null — a pre-G1 file's create mints one). `versionMinted` is the
 * orthogonal "did this apply mint a new immutable version" signal (#672): always
 * `false` for a connection; for a pipeline it is independent of `action` (a
 * `restored` that also advances the version reports `restored` + `true`, which
 * `action` alone cannot express). Explicit boolean, never defaulted — an absent
 * fact must not be manufactured as `false`.
 *
 * `versionContentUnverified` (#1018) is the second such orthogonal signal, and it
 * qualifies the CONFIDENCE of the action rather than its content: the branch's
 * version doc names a stored row that references a resource which has since been
 * DELETED (typically a connection — versions are immutable and nothing stops the
 * delete), so that ref cannot be expressed in resourceId-space and the two forms
 * cannot be compared there. The apply masks exactly those fields and judges the
 * rest, so `unchanged`/`superseded` here means "differs nowhere we can decide"
 * rather than "byte-identical". Always `false` for a connection (no versions),
 * and `false` for every ordinary apply. Reported rather than folded into
 * `action`, because a single-valued action cannot carry it and silently
 * upgrading the weaker fact to the stronger one is the #473 shape. */
export const WorkspaceGitAppliedResourceSchema = z.object({
  path: z.string().min(1),
  kind: ExportKindSchema,
  resourceId: z.string().min(1),
  action: WorkspaceGitAppliedActionSchema,
  versionMinted: z.boolean(),
  versionContentUnverified: z.boolean(),
});
export type WorkspaceGitAppliedResource = z.infer<typeof WorkspaceGitAppliedResourceSchema>;

/**
 * #3 G5c — a branch resource the apply recognised but did NOT write. This was
 * how G5c-1 reported an incoming TRIGGER (connections + pipelines + archive
 * applied; triggers deferred). As of G5c-2 (#670) triggers apply too, so EVERY
 * recognised resource is now in `applied` and this array has NO producers — it
 * is retained in the result contract for forward-compatibility (a future
 * resource kind added ahead of its apply slice). `resourceId` may be `null` for
 * a pre-G1 file.
 */
export const WorkspaceGitDeferredResourceSchema = z.object({
  path: z.string().min(1),
  kind: ExportKindSchema,
  resourceId: z.string().min(1).nullable(),
  disposition: WorkspaceGitDispositionSchema,
});
export type WorkspaceGitDeferredResource = z.infer<typeof WorkspaceGitDeferredResourceSchema>;

/** #3 G5c — a pipeline the apply ARCHIVED (its file was absent from the branch),
 * with the dependent triggers that archive flipped enabled→disabled. */
export const WorkspaceGitArchivedResultSchema = z.object({
  resourceId: z.string().min(1),
  name: z.string(),
  disabledTriggerIds: z.array(z.string().min(1)),
});
export type WorkspaceGitArchivedResult = z.infer<typeof WorkspaceGitArchivedResultSchema>;

/**
 * #3 G5c — the `POST /api/workspace/git/import` result. The apply is ATOMIC: on
 * any parse diagnostic the whole import is REFUSED (`refused: true`, everything
 * empty) rather than partially applying a known-corrupt branch — fail-closed,
 * the merge-gate "a `gh` failure is never CI-green" posture. When not refused,
 * `diagnostics` is empty and `applied`/`archived` describe every write
 * (connections, pipelines, AND triggers as of G5c-2 #670); `deferred` now has no
 * producers (see `WorkspaceGitDeferredResourceSchema`). `head` is the
 * collab-branch commit the snapshot was taken at (`null` for an empty repo,
 * where nothing is applied).
 */
export const WorkspaceGitApplyResultSchema = z.object({
  head: z.string().min(1).nullable(),
  refused: z.boolean(),
  applied: z.array(WorkspaceGitAppliedResourceSchema),
  deferred: z.array(WorkspaceGitDeferredResourceSchema),
  archived: z.array(WorkspaceGitArchivedResultSchema),
  diagnostics: z.array(WorkspaceParseDiagnosticSchema),
});
export type WorkspaceGitApplyResult = z.infer<typeof WorkspaceGitApplyResultSchema>;

/**
 * #3 G9 — the git-host coordinates a `repoUrl` points at: `{ host, owner, repo }`.
 * Parsed from the connect-allowlisted URL forms so a PR can be opened (G9b) or a
 * guided-manual compare URL built (G9a). `null` for a form with no web host (a
 * `file://` URL or a local absolute path — a local remote has no PR surface).
 */
export interface GitHostRepo {
  host: string;
  owner: string;
  repo: string;
}

/**
 * Extract `{ host, owner, repo }` from a `WorkspaceGitRepoUrlSchema`-allowlisted
 * `repoUrl`. Regex/string-only (this package compiles against no DOM/node
 * globals — no `new URL()`, same constraint the repoUrl validator works under).
 * Handles `https://`/`ssh://` (strips userinfo + port) and scp-like
 * `user@host:path`; returns `null` for `file://`, absolute paths, or any URL
 * without at least an `owner/repo` tail. A trailing `.git` on the repo segment
 * is stripped; owner/repo are the LAST two path segments (so a deeper GitLab-
 * style group path degrades to its final `group/repo`).
 */
export function parseGitHostRepo(repoUrl: string): GitHostRepo | null {
  const value = repoUrl.trim();
  // A local remote (file:// or absolute path) has no web/API host.
  if (value.startsWith('file://') || value.startsWith('/')) return null;

  let host: string;
  let path: string;
  const scheme = /^(?:https|ssh):\/\/(.+)$/.exec(value);
  if (scheme && scheme[1] !== undefined) {
    const rest = scheme[1];
    const slash = rest.indexOf('/');
    if (slash < 0) return null; // authority but no path
    let authority = rest.slice(0, slash);
    path = rest.slice(slash + 1);
    const at = authority.lastIndexOf('@');
    if (at >= 0) authority = authority.slice(at + 1); // strip userinfo
    const colon = authority.indexOf(':');
    if (colon >= 0) authority = authority.slice(0, colon); // strip port
    host = authority;
  } else {
    // scp-like `user@host:path` (the classic `git@github.com:org/repo.git`).
    const scp = /^[^@]+@([^:]+):(.+)$/.exec(value);
    if (!scp || scp[1] === undefined || scp[2] === undefined) return null;
    host = scp[1];
    path = scp[2];
  }

  if (!host) return null;
  const segments = path.split('/').filter((s) => s.length > 0);
  const owner = segments[segments.length - 2];
  const lastSegment = segments[segments.length - 1];
  if (owner === undefined || lastSegment === undefined) return null; // no owner/repo tail
  const repo = lastSegment.endsWith('.git') ? lastSegment.slice(0, -'.git'.length) : lastSegment;
  if (!repo) return null; // a bare ".git" segment
  return { host, owner, repo };
}

/** Is this host GitHub? (GitHub is the only host G9a builds a compare URL for.)
 * Accepts the `www.` alias — `https://www.github.com/…` is a legitimate remote
 * (it redirects to the apex) and should still get a compare URL, which
 * `buildGitHubCompareUrl` emits against the canonical `github.com` regardless.
 * Module-private — its only consumer is `buildGuidedManualPullRequest`; G9b can
 * export it if the host-API path needs a host discriminator. */
function isGitHubHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === 'github.com' || h === 'www.github.com';
}

/**
 * Encode a git branch name for a URL PATH position, preserving `/` (a git branch
 * may contain slashes, e.g. `studio/local/work`, which GitHub compare URLs carry
 * literally) while percent-encoding any other URL-significant char (`#`, `&`, …
 * — git ref names permit some of these). Per-segment `encodeURIComponent`.
 */
function encodeBranchForUrl(branch: string): string {
  return branch.split('/').map(encodeURIComponent).join('/');
}

/**
 * The GitHub PR-create ("compare") URL for `working` → `collab`:
 * `https://github.com/<owner>/<repo>/compare/<collab>...<working>?expand=1`
 * (`base...head` = merge head into base; `expand=1` pre-opens the create form).
 * Module-private — composed only by `buildGuidedManualPullRequest`.
 *
 * `owner`/`repo` are `encodeURIComponent`-encoded just like the branch segments:
 * `WorkspaceGitRepoUrlSchema` restricts only scheme/credential shape, NOT the
 * path charset, so a stored repoUrl path segment containing `#`/`?`/space (e.g.
 * a directly-seeded row) would otherwise produce a malformed or silently
 * truncated link. Both are single segments (no `/`), so a flat encode is right.
 */
function buildGitHubCompareUrl(
  repo: GitHostRepo,
  collabBranch: string,
  workingBranch: string,
): string {
  const owner = encodeURIComponent(repo.owner);
  const name = encodeURIComponent(repo.repo);
  return `https://github.com/${owner}/${name}/compare/${encodeBranchForUrl(
    collabBranch,
  )}...${encodeBranchForUrl(workingBranch)}?expand=1`;
}

/** Which git host a PR flow recognises. `unknown` = no auto/guided PR surface
 * (a local remote, or a non-GitHub host G9a does not build URLs for yet). */
export const GitHostProviderSchema = z.enum(['github', 'unknown']);
export type GitHostProvider = z.infer<typeof GitHostProviderSchema>;

/** How a pull request was produced. `guided_manual` = studio returns a URL/branch
 * pair for the user to open the PR themselves (G9a); `opened` = studio opened it
 * via the host API (G9b). */
export const PullRequestModeSchema = z.enum(['opened', 'guided_manual']);
export type PullRequestMode = z.infer<typeof PullRequestModeSchema>;

/**
 * #3 G9 — the `POST /api/workspace/git/pull-request` result.
 * - `mode:'guided_manual'` (G9a): for a GitHub remote, `provider:'github'` + a
 *   compare `url` the user clicks to open the PR (`number:null`); for a
 *   local/non-GitHub remote, `provider:'unknown'` + `url:null` + `number:null`
 *   (open the PR by hand from the branch pair).
 * - `mode:'opened'` (G9b): studio opened (or observed an existing) PR via the
 *   GitHub REST API using an operator-env token; `provider:'github'`, `url` is
 *   the PR's `html_url`, `number` is its PR number.
 * `number` is REQUIRED-nullable (#473: an absent PR number is stated `null`, never
 * a manufactured default). `workingBranch`/`collabBranch` are echoed so a
 * guided-manual client knows the branch pair.
 */
export const PullRequestResultSchema = z.object({
  mode: PullRequestModeSchema,
  provider: GitHostProviderSchema,
  url: z.string().min(1).nullable(),
  /** The opened/observed PR number (`opened` only); `null` for `guided_manual`. */
  number: z.number().int().positive().nullable(),
  workingBranch: z.string().min(1),
  collabBranch: z.string().min(1),
});
export type PullRequestResult = z.infer<typeof PullRequestResultSchema>;

/**
 * #3 G9 — classify a repo's PR surface: is it a GitHub remote we can auto-open a
 * PR against (G9b), and what is the guided-manual compare URL (G9a) either way?
 * The SINGLE source of github-detection + compare-url building (CLAUDE.md: one
 * source of truth) — both the guided-manual builder below and the route's
 * auto-open decision read it, so the two can never drift on "is this GitHub".
 *
 * - `provider:'github'`, `githubRepo` non-null, `compareUrl` a compare link:
 *   a GitHub remote. The route auto-opens via the host API when an operator-env
 *   token is present (G9b), else serves `compareUrl` as guided-manual.
 * - `provider:'unknown'`, `githubRepo:null`, `compareUrl:null`: a local
 *   (`file://`/absolute-path) or non-GitHub host — no PR surface studio drives;
 *   the user opens the PR by hand from the branch pair.
 *
 * `githubRepo` is exposed (not just the URL) so the server can build the host-API
 * request WITHOUT re-parsing the URL — the parse happens once, here.
 */
export function resolvePullRequestTarget(
  repoUrl: string,
  collabBranch: string,
  workingBranch: string,
): { provider: GitHostProvider; githubRepo: GitHostRepo | null; compareUrl: string | null } {
  const parsed = parseGitHostRepo(repoUrl);
  if (parsed && isGitHubHost(parsed.host)) {
    return {
      provider: 'github',
      githubRepo: parsed,
      compareUrl: buildGitHubCompareUrl(parsed, collabBranch, workingBranch),
    };
  }
  return { provider: 'unknown', githubRepo: null, compareUrl: null };
}

/**
 * Build the GUIDED-MANUAL pull-request payload (G9a) from a repo's coordinates
 * and its branch pair: a GitHub compare URL when the remote is GitHub, else
 * `{ provider:'unknown', url:null }`. Delegates to `resolvePullRequestTarget` so
 * the github-detection + url-building live in ONE place. The G9b route composes
 * `resolvePullRequestTarget` directly (it also needs `githubRepo` for the host
 * API); this thin wrapper is retained for the guided-only callers/tests.
 */
export function buildGuidedManualPullRequest(
  repoUrl: string,
  collabBranch: string,
  workingBranch: string,
): { provider: GitHostProvider; url: string | null } {
  const { provider, compareUrl } = resolvePullRequestTarget(repoUrl, collabBranch, workingBranch);
  return { provider, url: compareUrl };
}
