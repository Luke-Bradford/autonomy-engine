# pack-skills — starter skills scaffolded into target repos

These are seeds: `onboard.sh` copies each `<name>/SKILL.md` to the target
repo's `.claude/skills/<name>/SKILL.md` (where Claude Code auto-loads
skills for sessions running in that repo), following the same contract as
the planner agent — opt-in, skip if present, never overwrite. After
scaffolding, the TARGET TEAM owns the copies: edit them freely; onboard
will not touch an existing file.

They live here (not inside `templates/autonomy-pack/`) because the pack
template is copied wholesale into `.autonomy/`, and skills belong in
`.claude/skills/` instead.

Design rule (issue #361): these skills are ADDITIVE elaboration only. Any
correctness protocol (verdict-file semantics, caps, merge gating) is
enforced by the engine and compiled into session briefs regardless — a
skill is never the sole carrier of a rule, because trigger-scoped loading
means it is sometimes not loaded.
