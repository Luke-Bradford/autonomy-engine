import type { ReactNode } from 'react';
import { AboutHelp } from '../../lib/HelpDisclosure';

/**
 * #1694 OR42 — a property panel's one header row, shared by the activity and
 * container panels: the name, the type id (the one place it shows), what the
 * type is behind a `?` (labels, not prose), and the panel's acts at the row's
 * right end.
 */
export function PanelHeader({
  name,
  type,
  about,
  children,
}: {
  name: ReactNode;
  type: string;
  /** The palette's sentence for the type; none draws no `?`. */
  about?: { title: string; noteId: string; body: ReactNode };
  /** The acts on the whole panel. */
  children?: ReactNode;
}) {
  return (
    <div className="property-panel__header">
      <h2>{name}</h2>
      <code className="property-panel__type">{type}</code>
      {about !== undefined && (
        <AboutHelp name={about.title} noteId={about.noteId}>
          {about.body}
        </AboutHelp>
      )}
      {children !== undefined && <span className="property-panel__actions">{children}</span>}
    </div>
  );
}
