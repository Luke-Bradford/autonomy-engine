import { EDGE_VARIANTS, edgeArrowMarkerId } from './edgeCondition';

/**
 * U6b — the arrowhead `<marker>` defs, one per edge variant.
 *
 * Until this landed, canvas edges had NO arrowheads: the direction of an edge
 * drawn right-to-left, or between two vertically-stacked nodes, was simply not
 * on screen. U6a documented why it could not just switch React Flow's own
 * markers on — RF generates a def per literal `color` value, and the condition
 * hues are CSS custom properties, so there is no colour to pass.
 *
 * Defining the markers here inverts that: each one is styled by CSS
 * (`index.css`, beside the stroke hues, from the SAME palette var), so both
 * themes and the selected-edge width follow for free. `markerUnits="strokeWidth"`
 * is what makes the arrowhead grow with the stroke when an edge is selected or
 * focused, instead of a 3px stroke ending in a 1.5px-scaled head.
 *
 * Rendered ONCE per canvas, outside `<ReactFlow>`. SVG markers are referenced by
 * document id, so they resolve from anywhere in the document — but NOT if the
 * element is `display: none`, which is why this is a zero-size absolutely
 * positioned svg rather than a hidden one. `aria-hidden` because it paints
 * nothing itself.
 */
export function EdgeMarkers() {
  return (
    <svg className="edge-marker-defs" aria-hidden="true" focusable="false">
      <defs>
        {EDGE_VARIANTS.map((on) => (
          <marker
            key={on}
            id={edgeArrowMarkerId({ on })}
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            markerUnits="strokeWidth"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        ))}
      </defs>
    </svg>
  );
}
