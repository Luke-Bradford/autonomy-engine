import { useCallback, useMemo, useRef, useState, type FocusEvent, type FormEvent } from 'react';

/** A message per field key: `name`, `config.timeoutMs`, `columns`. */
export type FieldErrors = Readonly<Record<string, string>>;

/** One validation issue: a Zod issue (array path) or a server one (dotted path). */
export interface PathedIssue {
  readonly path?: string | readonly PropertyKey[];
  readonly message?: string;
}

/**
 * #1396 — sort issues onto the form's fields. An issue belongs to the LONGEST
 * prefix of its path that is a field key (`config.headers.2.key` to
 * `config.headers`, the row list that owns the cell). The rest of the path is
 * kept in front of the message (`2.key: Required`), so a row's issue still
 * says which row, and two issues on one field are both kept, joined by `; `.
 * What matches no field comes back in `rest`, in order, for the caller to word
 * through its usual formatter (`formatZodIssues`, or `formatApiIssues` for a
 * server body), so the remainder is spelt and capped the one way it already is.
 */
export function splitIssues<I extends PathedIssue>(
  issues: readonly I[],
  isKey: (key: string) => boolean,
): { fields: FieldErrors; rest: I[] } {
  const fields: Record<string, string> = {};
  const rest: I[] = [];
  for (const issue of issues) {
    const path = issue.path ?? [];
    const parts = typeof path === 'string' ? path.split('.') : path.map(String);
    let end = parts.length;
    while (end > 0 && !isKey(parts.slice(0, end).join('.'))) end -= 1;
    if (end === 0) {
      rest.push(issue);
      continue;
    }
    const key = parts.slice(0, end).join('.');
    const within = parts.slice(end).join('.');
    const message = issue.message ?? 'Invalid value';
    const line = within === '' ? message : `${within}: ${message}`;
    fields[key] = fields[key] === undefined ? line : `${fields[key]}; ${line}`;
  }
  return { fields, rest };
}

/** The element a field key names, and the control in it that can take focus. */
function controlOf(container: ParentNode, key: string): HTMLElement | null {
  const field = container.querySelector<HTMLElement>(`[data-field="${CSS.escape(key)}"]`);
  if (field === null) return null;
  // A row list is a `group` div; its first cell is where the keyboard goes.
  return field.matches('input, select, textarea, button')
    ? field
    : field.querySelector<HTMLElement>('input, select, textarea, button');
}

/**
 * Focus a field by key, opening any collapsed section it sits in first (an
 * Advanced `<details>` would otherwise swallow the focus).
 */
export function focusField(container: ParentNode, key: string): void {
  const control = controlOf(container, key);
  if (control !== null) focusControl(control);
}

/** Focus a control, opening any collapsed section it sits in first. */
function focusControl(control: HTMLElement): void {
  for (let el = control.parentElement; el !== null; el = el.parentElement) {
    if (el instanceof HTMLDetailsElement) el.open = true;
  }
  control.focus();
}

/** Focus the first field, in document order, that is marked invalid. */
export function focusFirstInvalid(container: ParentNode): void {
  const first = container.querySelector<HTMLElement>('[data-field][data-invalid]');
  const key = first?.dataset.field;
  if (key !== undefined) focusField(container, key);
}

/**
 * #1396 — the attributes that make a control a field of the form's validation:
 * its key, an invalid mark, and its description (the error first, then any
 * hint). `data-invalid` is what focus looks for; `aria-invalid` is left off a
 * row list, because ARIA does not allow it on a `group`.
 */
export function fieldAttrs({
  key,
  error,
  errorId,
  hintId,
  group = false,
}: {
  key: string;
  error: string | undefined;
  errorId: string;
  hintId?: string | undefined;
  group?: boolean;
}): {
  'data-field': string;
  'data-invalid': true | undefined;
  'aria-invalid'?: boolean;
  'aria-describedby': string | undefined;
} {
  const invalid = error !== undefined;
  const ids = [invalid ? errorId : undefined, hintId].filter((id) => id !== undefined);
  return {
    'data-field': key,
    'data-invalid': invalid || undefined,
    ...(group ? {} : { 'aria-invalid': invalid }),
    'aria-describedby': ids.length === 0 ? undefined : ids.join(' '),
  };
}

/**
 * The check on a required name: the write schemas' `min(1)`, with no trim, so
 * the form never refuses what the server accepts.
 */
export function nameCheck(name: string): FieldErrors {
  return name === '' ? { name: 'Enter a name.' } : {};
}

/**
 * #1396 — the first control holding input the browser could not read: a
 * half-typed `datetime-local`, or `1e` in a `type="number"`. Such a control's
 * `value` is `''`, so a form that reads it sees a blank and quietly drops the
 * setting. The browser's own check refused the submit; a form that takes over
 * with `noValidate` must refuse it itself. `FormDrawer` does, for every form
 * given `validation`, using this (`validity` is still kept under `noValidate`).
 */
export function firstBadInput(form: HTMLFormElement): HTMLInputElement | null {
  for (const el of Array.from(form.elements)) {
    if (el instanceof HTMLInputElement && el.validity.badInput) return el;
  }
  return null;
}

/** What a native control's input is, in words: `datetime-local` is a date and time. */
const INPUT_NOUN: Readonly<Record<string, string>> = {
  number: 'number',
  date: 'date',
  time: 'time',
  'datetime-local': 'date and time',
  month: 'month',
  week: 'week',
};

/** What a refusal says about a bad-input control: its label's text, and what it holds. */
export function badInputMessage(control: HTMLInputElement): string {
  const label = control.labels?.[0]?.textContent?.trim();
  const what = label === undefined || label === '' ? 'A field' : `“${label}”`;
  return `${what} holds something that is not a complete ${
    INPUT_NOUN[control.type] ?? 'value'
  }. Finish it or clear it.`;
}

/** The key of the field an event happened in, if it happened in one. */
function keyOf(target: EventTarget | null): string | undefined {
  if (!(target instanceof Element)) return undefined;
  return target.closest<HTMLElement>('[data-field]')?.dataset.field;
}

export interface FieldValidation {
  /** What to show beside a field now, or `undefined`. */
  errorFor: (key: string) => string | undefined;
  /** `fieldAttrs` for a hand-written control: its key, its error now, and its error line's id. */
  attrsFor: (key: string, errorId: string) => ReturnType<typeof fieldAttrs>;
  /**
   * A refusal of input the browser could not read, in a control that is not
   * one of the form's fields (a mode editor's date). Shown in the footer's
   * alert until the next submit.
   */
  readonly notice: string | null;
  /**
   * A submit refused for a bad-input control (`firstBadInput`); `FormDrawer`
   * calls this instead of the page's submit. Every failing check is raised as
   * a Save would, so one press lists everything. On a field of the form the
   * message goes beside it; elsewhere it is the `notice`. Focus goes to the
   * first invalid field, or to the control when nothing else is.
   */
  refuseBadInput: (control: HTMLInputElement) => void;
  /** What the summary calls a field; `undefined` for a key this form does not show now. */
  labelOf: (key: string) => string | undefined;
  /** Whether a key is one of the form's fields now: a refusal's issue on one is shown beside it. */
  isKey: (key: string) => boolean;
  /** Every shown field error, client checks first (in the page's order), then the server's. */
  readonly shown: ReadonlyArray<{ readonly key: string; readonly message: string }>;
  /** Whether a submit (or a Test) has been attempted: the summary shows only after one. */
  readonly attempted: boolean;
  /**
   * A submit: raise every failing check, drop the last refusal, and return
   * whether it may go ahead. When it may not, focus moves to the first invalid
   * field once the errors are on screen.
   *
   * With `inScope` (Test connection, which needs no name) only those keys are
   * raised and cleared, and the other fields are left as they were: an
   * untouched Name is not armed to shout on its next blur.
   */
  attempt: (inScope?: (key: string) => boolean) => boolean;
  /**
   * Mark fields with a verdict the checks cannot re-judge (the server's, or a
   * write schema's), and take focus to the first. Keys must pass `isKey`.
   */
  showRefusedFields: (errors: FieldErrors) => void;
  /** Bumped when focus should go to the first invalid field; `FormDrawer` watches it. */
  readonly focusRequest: number;
  /** Put on the `<form>` (FormDrawer does): they see every field's edits and blurs. */
  readonly formHandlers: {
    onChange: (event: FormEvent<HTMLFormElement>) => void;
    onBlur: (event: FocusEvent<HTMLFormElement>) => void;
  };
}

/**
 * #1396 — inline validation for a drawer form.
 *
 * `checks` is what is wrong with the draft NOW, keyed by field, recomputed by
 * the page every render (an empty name, a number field holding `x`). What is
 * SHOWN is narrower, so the form never shouts at a field nobody has finished
 * with:
 *
 * - a check is shown once it is RAISED: on blur of a field that was edited, or
 *   by a submit, which raises every failing one;
 * - typing never raises one (DraftNumberField's #1393 rule), but a fix shows at
 *   once: a raised key whose check passes is dropped, so breaking it again
 *   waits for the next blur;
 * - a field that leaves the form (a kind change, the JSON view) has no check,
 *   so nothing stale points at a control that is not there.
 *
 * A server's field errors are held apart, because the client cannot re-judge
 * them: each stays until that field is edited, or the next submit, or the
 * field leaves the form (`labelOf` stops naming it).
 *
 * `labelOf` names the form's fields as they are now (it changes with the kind
 * and the JSON view); it is also what tells a refusal's issue which field it
 * belongs to.
 *
 * Fields take part by carrying `data-field="<key>"` (a row list on its group);
 * the form-level handlers find the key with `closest`, so no field needs its
 * own blur or change wiring.
 */
export function useFieldValidation(
  checks: FieldErrors,
  labelOf: (key: string) => string | undefined,
): FieldValidation {
  const [raised, setRaised] = useState<ReadonlySet<string>>(() => new Set());
  // Which fields have been edited: read only by the blur handler, so a ref. A
  // field that leaves and comes back keeps its "edited": the operator did edit
  // it. (Save needs no part in this: it raises every failing check itself.)
  const edited = useRef(new Set<string>());
  const [server, setServer] = useState<FieldErrors>({});
  const [attempted, setAttempted] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  // A raised key that now passes is dropped, during render (React's derived-
  // state pattern, as in DraftNumberField): the fix shows at once, and the
  // field must be left again before a new problem in it is shown.
  if ([...raised].some((key) => checks[key] === undefined)) {
    setRaised(new Set([...raised].filter((key) => checks[key] !== undefined)));
  }
  // The same for a refusal on a field that has left the form.
  const isKey = useCallback((key: string) => labelOf(key) !== undefined, [labelOf]);
  if (Object.keys(server).some((key) => !isKey(key))) {
    setServer(Object.fromEntries(Object.entries(server).filter(([key]) => isKey(key))));
  }

  const errorFor = useCallback(
    (key: string) => (raised.has(key) ? checks[key] : undefined) ?? server[key],
    [raised, checks, server],
  );

  const shown = useMemo(() => {
    const out: { key: string; message: string }[] = [];
    for (const [key, message] of Object.entries(checks)) {
      if (raised.has(key)) out.push({ key, message });
    }
    for (const [key, message] of Object.entries(server)) {
      if (!out.some((item) => item.key === key)) out.push({ key, message });
    }
    return out;
  }, [checks, raised, server]);

  const attempt = useCallback(
    (inScope?: (key: string) => boolean) => {
      const scope = inScope ?? (() => true);
      const failing = Object.keys(checks).filter(scope);

      setAttempted(true);
      setNotice(null);
      setServer((prev) =>
        inScope === undefined
          ? {}
          : Object.fromEntries(Object.entries(prev).filter(([key]) => !scope(key))),
      );
      setRaised((prev) => new Set([...prev, ...failing]));
      if (failing.length > 0) setFocusRequest((n) => n + 1);
      return failing.length === 0;
    },
    [checks],
  );

  const showRefusedFields = useCallback((errors: FieldErrors) => {
    setAttempted(true);
    setServer(errors);
    if (Object.keys(errors).length > 0) setFocusRequest((n) => n + 1);
  }, []);

  const attrsFor = useCallback(
    (key: string, errorId: string) => fieldAttrs({ key, error: errorFor(key), errorId }),
    [errorFor],
  );

  const refuseBadInput = useCallback(
    (control: HTMLInputElement) => {
      const message = badInputMessage(control);
      const key = keyOf(control);
      const failing = Object.keys(checks);
      setAttempted(true);
      setRaised((prev) => new Set([...prev, ...failing]));
      if (key !== undefined && isKey(key)) {
        setServer({ [key]: message });
        setNotice(null);
        setFocusRequest((n) => n + 1);
        return;
      }
      setServer({});
      setNotice(message);
      if (failing.length > 0) setFocusRequest((n) => n + 1);
      else focusControl(control);
    },
    [checks, isKey],
  );

  const formHandlers = useMemo(
    () => ({
      onChange: (event: FormEvent<HTMLFormElement>) => {
        const key = keyOf(event.target);
        if (key === undefined) return;
        edited.current.add(key);
        setServer((prev) => {
          if (!(key in prev)) return prev;
          return Object.fromEntries(Object.entries(prev).filter(([held]) => held !== key));
        });
      },
      onBlur: (event: FocusEvent<HTMLFormElement>) => {
        const key = keyOf(event.target);
        // Moving between the cells of one row list is not leaving the field.
        if (key === undefined || keyOf(event.relatedTarget) === key) return;
        if (!edited.current.has(key)) return;
        setRaised((prev) => (prev.has(key) ? prev : new Set([...prev, key])));
      },
    }),
    [],
  );

  return {
    errorFor,
    attrsFor,
    notice,
    refuseBadInput,
    labelOf,
    isKey,
    shown,
    attempted,
    attempt,
    showRefusedFields,
    focusRequest,
    formHandlers,
  };
}
