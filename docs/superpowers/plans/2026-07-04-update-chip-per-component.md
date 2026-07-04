# Plan — #240 (p1 bug): update chip cries wolf on aggregate staleness

## Root cause (confirmed)

`renderEngineUpdate(e)` (lib/dashboard_page.html:1001) fires on the AGGREGATE
`e.stale` (true if the dashboard OR any supervisor is behind) and shows one
warning call-to-action — `⟳ engine updated (N commits) — restart to apply` — with
the AGGREGATE `e.behind`. So when the dashboard is current but a supervisor is
behind, the operator (who just pulled + restarted the dashboard) still sees a
restart demand and concludes the refresh failed. And an unknown-sha supervisor
(pre-tracking, `sha:""`, `behind:null`) borrows the aggregate commit count →
"30 commits behind" about a component whose delta is unknown.

The SERVER already exposes everything needed (`dashboard_state.engine_status`,
lib/dashboard_state.py:1071): `e.dashboard{sha,behind,stale}`,
`e.supervisors[{repo,sha,behind,stale}]` with `behind:null` for unknown-sha. The
fix is purely in the RENDER — per-component messaging.

## Fix (render-only, lib/dashboard_page.html)

Rewrite `renderEngineUpdate`:

- **Dashboard stale** → the operator-visible shell they restart → keep the WARNING
  chip, call-to-action: `⟳ dashboard outdated (N commits) — pull + restart to
  apply` (N = `e.dashboard.behind`, omitted if not a positive int). "pull +
  restart", not "restart" — until auto-pull lands (#166), a bare restart applies
  nothing. Title also lists any stale supervisors.
- **Dashboard current, only supervisors stale** → INFORMATIONAL tone (new
  `.updchip.info`, muted not warn), NOT a restart demand about the dashboard:
  `ⓘ supervisors on older code — refresh at next session boundary` (supervisors
  hot-reload logic + self-refresh at a boundary). No aggregate count in the text;
  the title labels each stale supervisor with ITS OWN state.
- **Per-supervisor label** (title): own commit count when known; `version unknown
  — started before tracking` when `sha===""` (never a borrowed count).
- Not stale → hidden (unchanged).

`.updchip.info` CSS: `color:var(--mut);border-color:var(--hair2)` — informational,
so it does not read as an alarm.

## Invariants / scope

- Display-only, one page. No server / state-builder change (`engine_status`
  already correct). `lib/` repo-agnostic. No guardrail files.
- Fail-safe preserved: an unknown-sha LIVE supervisor still surfaces (informational
  tone), never hidden — hiding an unknown is fail-open (engine_status contract).

## TDD

Static (served page, new class): the render uses "pull + restart", "version
unknown", "session boundary", the `.info` toggle, and per-supervisor labelling
(not the aggregate `e.behind` in the supervisor-only branch).

Browser behavioral (the real acceptance — call `renderEngineUpdate(e)` directly
with synthetic `e`): (a) dashboard stale + supervisor stale → warning text
"dashboard outdated … pull + restart", chip NOT `.info`; (b) dashboard current +
supervisor stale → `ⓘ … session boundary`, chip `.info`, NO "restart to apply"
about the dashboard, NO borrowed count; (c) unknown-sha supervisor → title says
"version unknown", not a commit count; (d) not stale → hidden. Zero console errors.
