# pre-push-checklist

Run before EVERY push — first push and every follow-up alike.

```bash
bash tests/run_all.sh
shellcheck -S warning start bin/*.sh bin/agents/*.sh tests/*.sh templates/autonomy-pack/qa/*.sh
```

Both must be completely clean (`ALL SUITES PASS`, zero shellcheck output).
These are exactly what CI's `lint-and-test` runs — a local failure IS the CI
failure, two minutes earlier.

Additionally:

1. **pre-flight-review** — the self-review checklist
   (`.claude/skills/engineering/pre-flight-review.md`) against the full branch
   diff.
2. **Codex checkpoint 2** (first push of a branch only) — see
   `codex-checkpoints.md`.
3. If the diff touched the dashboard: the browser verify loop from
   `.claude/skills/dashboard/SKILL.md`.
4. If the diff touched `templates/autonomy-pack/`: mechanically re-validate the
   template (copy to a temp repo pack, uncomment the roles example, run
   `python3 lib/roles.py <tmp-repo>` → exit 0) and run
   `bash tests/test_onboard.sh`.

Never `--no-verify`, never "CI will catch it" — every push resets the review
gate, so a broken push costs a full review round, not just a red X.
