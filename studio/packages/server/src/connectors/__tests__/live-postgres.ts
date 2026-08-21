/**
 * #1190/#1196 — WHETHER THE LIVE POSTGRES SUITE IS ALLOWED TO SKIP.
 *
 * A plain module rather than an export from `postgres.test.ts`, which is where
 * it lived until slice 3a gave it a SECOND consumer. Importing it from a `.test`
 * file re-registers that whole file's suites inside the importer, so
 * `postgres.test.ts`'s cases ran twice — and one of them, a DNS-resolution
 * probe, is timing-sensitive enough that the sink suite's lock test perturbed it
 * into failing. A shared predicate belongs in a shared module; its own tests
 * stay in `postgres.test.ts`.
 *
 * THE RULE: skipping is a DEVELOPER convenience and never a CI outcome. The
 * slices from #1190 on move real data, so CI stands up a `postgres:17` service
 * container; if that container is missing the live half must go RED, because a
 * suite CI quietly stops running certifies nothing while reading as coverage.
 *
 * Keyed on `CI`, which was MEASURED rather than assumed: vitest does NOT set it
 * (`process.env.CI` is `undefined` under a local `vitest run`) — it passes the
 * ambient value through, and GitHub Actions exports `CI=true` for every job.
 */
export function liveSuiteMustRun(env: Record<string, string | undefined>): boolean {
  return env.CI !== undefined && env.CI !== '' && env.CI !== 'false';
}
