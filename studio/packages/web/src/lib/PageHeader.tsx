import { Children, type ReactNode, type Ref } from 'react';
import { AboutHelp } from './HelpDisclosure';

/**
 * #1594 OR40 S6d — the id of a page's `?` note, from its heading's id, so the
 * page's own `<section aria-labelledby>` can take it as `aria-describedby`, the
 * way a `Section` is described by its note.
 */
export function pageHelpId(headingId: string): string {
  return `${headingId}-about`;
}

/**
 * #1594 OR40 S3 — the ONE page header: the page's title on the left and its
 * `Toolbar` on the right, on a single `--header-h` row. Every page renders its
 * title through this, so the title's type, the row's height and the toolbar's
 * spacing are decided once (`.page-header` in `index.css`). The title is the
 * page's one h1 (#1594 OR40 S5), so every heading under it starts at h2.
 *
 * `adornment` sits right after the title, outside the heading so it never
 * joins the heading's accessible name: the editor's state badge and notices,
 * the run page's editor link. `children` are the toolbar's controls; a page
 * with no actions passes none and gets no toolbar.
 *
 * `help` (#1594 OR40 S6d) is the page's `?`, "About {title}", right after the
 * title: what the page holds, in a sentence, where a paragraph under the title
 * used to say it (labels, not prose). Its note opens under the header row, at
 * the row's width. It needs a plain-text title, to name the `?`, and the
 * heading's id, to name the note.
 */
export function PageHeader({
  title,
  headingId,
  headingTitle,
  help,
  adornment,
  children,
  ref,
}: {
  /** The heading's hover text: the full name where the title may ellipsize. */
  headingTitle?: string;
  adornment?: ReactNode;
  children?: ReactNode;
  ref?: Ref<HTMLDivElement>;
} & (
  | {
      title: ReactNode;
      /** For a page section's `aria-labelledby`. */
      headingId?: string;
      help?: undefined;
    }
  | { title: string; headingId: string; help: ReactNode }
)) {
  return (
    <div className="page-header" ref={ref}>
      <h1 id={headingId} title={headingTitle}>
        {title}
      </h1>
      {help !== undefined && headingId !== undefined && (
        <AboutHelp name={title as string} noteId={pageHelpId(headingId)}>
          {help}
        </AboutHelp>
      )}
      {adornment}
      {/* `toArray` drops what renders nothing (`{cond && <x />}` that is
          false), so a header whose every action is conditional and off draws
          no toolbar. A child that renders nothing itself (a component returning
          null) still mounts one, which `.toolbar:empty` hides. */}
      {Children.toArray(children).length > 0 && <Toolbar>{children}</Toolbar>}
    </div>
  );
}

/**
 * #1594 OR40 S3 — a row of controls: 8px apart, every one `--control-h` tall
 * and centred on one line, packed to the right of its row. Separate groups
 * with a `ToolbarDivider`.
 *
 * Deliberately not `role="toolbar"`: that role promises one tab stop with
 * arrow-key movement between the controls, which this row does not implement.
 * Each control keeps its own tab stop, as any group of buttons does.
 */
export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}

/** A 1px rule between two groups of toolbar controls. Decorative. */
export function ToolbarDivider() {
  return <span className="toolbar__divider" aria-hidden="true" />;
}
