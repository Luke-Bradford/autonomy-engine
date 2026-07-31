import { getActivity, type Node } from '@autonomy-studio/shared';

/**
 * How an ACTIVITY is named to the operator: by its catalog title, which is the
 * text its box actually carries on the canvas.
 *
 * One function rather than the expression, because the canvas had grown three
 * hand-rolled copies of it — the node's own label (`FlowCanvas`), a connection
 * refusal's endpoint (`connectRules.endpointLabel`) and a validation issue's
 * identifiers (`containerRules.readableIssue`) — and a message that names an
 * activity differently from the box it points at is worse than one that does not
 * name it at all. Same argument `edgeEndpointIds` was exported under.
 *
 * A type the catalog does not know falls back to the raw type rather than
 * inventing a name: it is what the doc says, and an imported doc can carry one.
 */
export function activityLabel(node: Node): string {
  return getActivity(node.type)?.title ?? node.type;
}
