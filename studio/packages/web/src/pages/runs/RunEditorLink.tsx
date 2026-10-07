import { OpenRegular } from '@fluentui/react-icons';
import { Link } from 'react-router';
import { runVersionPath } from '../author/pipelinePath';
import { runEditorLabel } from './runPath';

/**
 * #1566 — a run's SECONDARY way into the editor: a small labelled icon beside
 * the pipeline's name, which itself opens the run. In the Monitor the run is
 * the primary destination (ADF's behaviour), so the editor is only ever this
 * explicit, named control, opening the version that ran.
 */
export function RunEditorLink({
  pipelineId,
  version,
  debug,
  pipelineName,
}: {
  pipelineId: string;
  version: number;
  debug: boolean;
  /** Where several runs share a screen, so each link's name is its own. */
  pipelineName?: string;
}) {
  const label = runEditorLabel(version, debug, pipelineName);
  return (
    <Link
      className="run-editor-link"
      to={runVersionPath(pipelineId, version, debug)}
      aria-label={label}
      title={label}
    >
      <OpenRegular aria-hidden="true" />
    </Link>
  );
}
