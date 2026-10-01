/**
 * #1396 — a field's inline error, in a RESERVED slot: always mounted and a line
 * tall, so an error arriving does not push the fields below it down (#1393's
 * rule, and its `.field-error-slot` style). The control points at `id` with
 * `aria-describedby` while there is a message. The message's first letter is
 * capitalised here, because it stands alone; the summary shows the same text
 * after a field's name and a colon, where lower case reads right.
 *
 * `role="alert"` only where nothing else announces the error: a drawer form's
 * footer summary is its one alert, so its fields' lines take no role, while a
 * canvas field (`DraftNumberField`) has no summary and its line is the alert.
 * The role sits on the populated line, never the empty slot: an empty
 * `role="alert"` would still be found by every page-wide alert query.
 */
export function FieldError({
  id,
  message,
  role,
}: {
  id: string;
  message: string | undefined | null;
  role?: 'alert';
}) {
  return (
    <div className="field-error-slot">
      {message !== undefined && message !== null && (
        <p id={id} className="error" role={role}>
          {message.charAt(0).toUpperCase() + message.slice(1)}
        </p>
      )}
    </div>
  );
}
