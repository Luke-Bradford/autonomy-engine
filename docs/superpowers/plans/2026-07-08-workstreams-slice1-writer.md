# Workstreams slice 1 — var-live config writer + effective-config resolver

Spec: `docs/superpowers/specs/2026-07-08-config-workstreams-design.md`
(write-model section). Foundation only — no UI change.

## Tasks (TDD each; bash 3.2; stdlib only)

### 1. `lib/config_parser.py` — the resolver (single choke point)

- `effective_config_path(path)`: when `path` ends with
  `.autonomy/config.yaml` and `<repo>/var/autonomy/config.yaml` exists,
  return the var-live path; else `path` unchanged. Pure string/fs check —
  no parsing, never raises (OSError → original path).
- CLI `main` applies it to the file argument. EVERY bash reader
  (supervisor `resolve_config_value`, safe_merge `CONFIG_GET`, board.sh,
  doctor) funnels through the CLI, so they all agree with zero call-site
  changes.
- Python importers switched to the resolver: `roles._load_config`,
  dashboard `_read_config` + `build_org` (2 direct-open sites).
- Doctor: a PRESENT-but-unparseable var-live file must FAIL the pack check
  (session refused) — never silently fall back to committed (a remit
  change behind the operator's back). The resolver returns the live path;
  the existing parse-failure handling then does the refusing naturally.
  Doctor line names the LIVE path so the operator sees which file is bad.

### 2. `lib/dashboard_control.py` — the var-live writer

- `live_config_path(repo)`, `live_config_seed(repo)`: seed = committed
  bytes; fold the legacy overlay's model/fallback/effort/board keys into
  the seeded TEXT via `config_parser.set_scalar`, then DELETE the overlay
  file (retirement). Seed happens on first structural write only.
- `roles_block_emit(roles_dict)`: emit the `roles:` block in the
  restricted subset (2-space indent, inline `[a, b]` lists, inline
  `{ key: val }` maps for trigger/scope) such that config_parser
  round-trips it EXACTLY (the compare step enforces).
- `set_block(text, "roles", block_text)`: replace the top-level block in
  TEXT (top-level key line → next top-level key/EOF); append when absent.
  In-block comments are an accepted loss (SD-29); everything outside the
  block is byte-preserved.
- `structural_write_plan(repo, new_roles)`: candidate = seeded-or-existing
  live text with the roles block replaced → parse candidate →
  `roles.validate_roles` (refuse on errors, verbatim reason) → deep-compare
  parsed `roles` == `new_roles` AND every OTHER top-level key unchanged vs
  the pre-write parse (refuse on any drift) → atomic tmp+rename write plan.
  Any refusal leaves every file untouched.
- Drift data: `live_config_drift(repo)` → {"live": bool, "differs": bool}
  (bytes compare vs committed) for the page badge.

### 3. `bin/onboard.sh` — `.gitignore var/`

Idempotent: append `var/` to the target repo's `.gitignore` when no line
already covers it (exact `var/` or `var` match — no clever glob analysis);
create the file if missing. Preflight's stash `-u` would otherwise sweep
the live config in repos that don't ignore `var/`.

### 4. settled-decisions entry 34

SD-28 superseded for target-repo packs (operator 2026-07-08): UI writes go
to the var-live shadow, committed config seeds it, resolver in
config_parser is the single read choke point, unparseable live = pack
failure, loop stays barred from editing packs, persistent overlay retired.

## CP1 findings folded

- Doctor names the EFFECTIVE path explicitly (new report line; stderr was
  discarded before) — not "naturally".
- **Fingerprint material gains the var-live file** (passed as a required
  extra when present, like the overlay) — otherwise a live edit could hide
  behind an unchanged hash and be skipped (wrongful-skip class).
- First-write compare baseline = the SEEDED + overlay-FOLDED text (folding
  intentionally changes agent/board keys; comparing against raw committed
  would refuse the migration itself).
- `roles_block_emit` quotes every string scalar and REFUSES values the
  restricted subset cannot represent (both quote types, newlines); refusal
  reason names the offending role/key.
- safe_merge's total CONFIG_GET silently reads unparseable-live as absent →
  `merge_gate.strategy` defaults to `manual` — ACCEPTED: that is the safest
  possible direction (no merge happens); doctor/preflight carry the loud
  failure.
- `quickstart --set`/onboard write the COMMITTED file (setup-time, before
  any live shadow exists) — correct and stated; their READS go through the
  CLI resolver like everything else.
- Already-onboarded repos: `structural_write_plan` REFUSES when
  `git check-ignore` says `var/autonomy/config.yaml` would be tracked, with
  the exact fix in the error ("add 'var/' to .gitignore") — a swept live
  config is silent config loss.
- Mid-tick mixed snapshot ACCEPTED and documented: the write is an atomic
  rename (each individual read is consistent); a tick that straddles the
  swap may mix two individually-valid configs once; the next tick
  converges. No lock.

## Fail-safe table

| Failure | Behaviour |
| --- | --- |
| var-live present, unparseable | doctor/preflight REFUSE session; page shows error |
| validation errors on candidate | write refused, reason verbatim, files untouched |
| reparse-compare mismatch | write refused, files untouched |
| overlay unreadable during fold-in | fold-in skipped values logged; overlay NOT deleted |
| resolver fs error | original committed path (pre-feature behaviour) |

## Tests

- `tests/test_config_parser.py`: resolver cases (no var-live → same path;
  var-live → live path; non-pack path untouched; CLI reads live values).
- `tests/test_dashboard_control.py`: emit round-trip (emit → parse →
  deep-equal); set_block replace/append/byte-preservation outside block;
  structural_write_plan happy + every refusal row above; seed + overlay
  fold-in + overlay deletion; drift tuple.
- `tests/test_safe_merge_config_get.sh` extension: CONFIG_GET returns the
  var-live value when present (bash reader agreement).
- `tests/test_onboard.sh`: gitignore appended once, never duplicated,
  existing file preserved.
- doctor test: unparseable var-live fails the pack check naming the live
  path.
