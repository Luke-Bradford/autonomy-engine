import type { ConnectionProbeResult } from '@autonomy-studio/shared';

/**
 * #1191 — a connection probe's verdict. `role="status"` (not `alert`): a passing
 * test is informational, and the page's `alert` is already spoken for by
 * errors. A REFUSAL still lands here rather than in an error slot, because it is
 * the adapter's answer to a question that was asked and answered — not a
 * failure of the form.
 *
 * #1477 — shared by the connection form's Test connection and the editor's
 * connection pickers, so a probe reads the same wherever it was asked.
 */
export function ProbeVerdict({ result }: { result: ConnectionProbeResult }) {
  return (
    <p role="status" className={result.ok ? 'probe-ok' : 'probe-failed'}>
      {result.ok
        ? result.probed === 'liveness'
          ? 'Connected.'
          : // The honest half of the contract: two kinds cannot reach
            // anything (`agent_cli` will not spawn a command just to look;
            // `http` has nowhere to go without a baseUrl), so their `ok`
            // means the settings parse and nothing more.
            'These settings are valid — this kind is not contacted until it runs.'
        : result.error}
    </p>
  );
}
