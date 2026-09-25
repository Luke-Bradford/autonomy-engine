import { useId } from 'react';
import { SECURE_REDACTED } from '@autonomy-studio/shared';
import type { CapturedText, NodeCapture } from './runSummary';

/**
 * #605 L9b — the prompt and completion TEXT a `capture: 'full'` `llm_call`
 * stored, one disclosure per captured provider exchange.
 *
 * Only exchanges that stored text reach here (`deriveNodeActivity` folds nothing
 * for a metadata-mode capture), so the section's absence means "this node did
 * not ask for text", never "the text was empty".
 *
 * Three readings a naive renderer would blur, each stated instead:
 *  - a field the server's capture budget CUT (`truncated`) says how much it
 *    kept of how much there was — the cut is a storage bound, not the text;
 *  - a SECURE node's texts arrive as the marker, and say why here rather than
 *    through `SecureMarkerHint`, whose copy names Secure OUTPUT alone — a
 *    capture is withheld under either flag;
 *  - an ABSENT completion (the exchange failed, or asked for a tool) and an
 *    EMPTY one (the model returned nothing) are different facts.
 */

/**
 * The most recent exchanges rendered. A foreach of retried LLM calls can store
 * many, and each may hold up to the server's per-event budget of text; this
 * keeps that out of the DOCUMENT, as `MAX_TOOL_ROWS` does for tool calls.
 */
export const MAX_CAPTURE_EXCHANGES = 3;

export function CaptureSection({ captures }: { captures: NodeCapture[] }) {
  const shown =
    captures.length > MAX_CAPTURE_EXCHANGES ? captures.slice(-MAX_CAPTURE_EXCHANGES) : captures;
  const offset = captures.length - shown.length;
  const showAttempt = captures.some((x) => x.attempt !== captures[0]?.attempt);
  const headingId = useId();
  const withheld = shown.some((c) =>
    [c.system, c.completion, ...c.messages].some((f) => f?.text === SECURE_REDACTED),
  );
  return (
    <section className="contract-section" aria-labelledby={headingId}>
      <h4 id={headingId}>Prompt &amp; completion</h4>
      <p className="page-hint">
        Stored because this node&rsquo;s <em>capture</em> setting is <code>full</code>.
      </p>
      {withheld && (
        <p className="page-hint">
          <code>{SECURE_REDACTED}</code> marks text withheld from the run log: this node&rsquo;s run
          policy has Secure input or Secure output set, so its prompt and completion were redacted
          before they were recorded.
        </p>
      )}
      {shown.map((c, i) => {
        const n = offset + i + 1;
        const latest = i === shown.length - 1;
        return (
          <details
            key={`${c.instanceId ?? ''}#${c.attempt}#${n}`}
            className="node-capture"
            open={latest}
          >
            <summary>
              Exchange {n}
              {showAttempt && <> · attempt {c.attempt}</>}
              {c.instanceId !== undefined && <> · item {c.instanceId}</>} · {c.model}
            </summary>
            {c.system !== undefined && <CapturedBlock label="System" field={c.system} />}
            {c.messages.map((m, j) => (
              <CapturedBlock key={j} label={m.role === 'user' ? 'User' : 'Assistant'} field={m} />
            ))}
            {c.completion !== undefined ? (
              <CapturedBlock label="Completion" field={c.completion} />
            ) : (
              <p className="page-hint">
                No completion was recorded: this exchange ended without readable text (it failed, or
                the model asked for a tool).
              </p>
            )}
          </details>
        );
      })}
      {offset > 0 && (
        <p className="page-hint">
          … showing the most recent {shown.length} of {captures.length} exchanges.
        </p>
      )}
    </section>
  );
}

function CapturedBlock({ label, field }: { label: string; field: CapturedText }) {
  return (
    <div className="node-capture-field">
      <h5>{label}</h5>
      {field.text === SECURE_REDACTED ? (
        <code>{SECURE_REDACTED}</code>
      ) : field.text === '' && !field.truncated ? (
        <p className="page-hint">Empty.</p>
      ) : (
        <pre className="node-capture-text">{field.text}</pre>
      )}
      {field.truncated && field.text !== SECURE_REDACTED && (
        <p className="page-hint">
          {field.text === ''
            ? `Not stored: the capture budget was spent on later parts of this exchange (${field.chars} characters).`
            : `… stored the first ${field.text.length} of ${field.chars} characters.`}
        </p>
      )}
    </div>
  );
}
