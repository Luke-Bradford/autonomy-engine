import { BaseEdge, EdgeText, getBezierPath, type EdgeProps } from '@xyflow/react';

/**
 * The canvas's edge — a bézier that can be BOWED away from its siblings.
 *
 * React Flow's default edge draws the curve its endpoints imply, which is
 * exactly right until two edges share both endpoints. Since #997 collapsed the
 * source ports onto one point, `A -failure-> B` and `A -skipped-> B` have
 * identical endpoints and therefore identical paths: one line on screen for two
 * in the document. `parallelEdges.ts` computes the offset; this spends it.
 *
 * THE BOW IS IN THE CONTROL POINTS, not in the endpoints. Moving an endpoint
 * would detach the line from the port it is bound to — the precise disagreement
 * between dots and lines that #997 spent `updateNodeInternals` to avoid. Instead
 * the curve leaves and arrives exactly where its handles are and takes a
 * different route in between, which is what makes the pair legible without lying
 * about either end.
 */
export function SpreadEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  style,
  label,
  data,
}: EdgeProps) {
  const offset = typeof data?.spread === 'number' ? data.spread : 0;

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  if (offset === 0) {
    return (
      <>
        <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />
        <Label x={labelX} y={labelY} label={label} />
      </>
    );
  }

  /* The unit normal of the straight source→target line. `hypot` guards the
     degenerate case — a self-edge, or two nodes at the same point mid-drag —
     where the normal is undefined and the arithmetic would produce `NaN`, which
     SVG renders as no path at all rather than as an error. */
  const dx = targetX - sourceX;
  const dy = targetY - sourceY;
  const length = Math.hypot(dx, dy);
  const nx = length === 0 ? 0 : -dy / length;
  const ny = length === 0 ? 0 : dx / length;

  /* A quadratic through the bowed midpoint. The control point is placed at TWICE
     the offset because a quadratic passes halfway to its control — so the
     curve's apex lands on the intended `offset`, and three siblings sit at even
     spacing rather than bunching toward the middle. */
  const midX = (sourceX + targetX) / 2 + nx * offset * 2;
  const midY = (sourceY + targetY) / 2 + ny * offset * 2;
  const bowed = `M ${String(sourceX)},${String(sourceY)} Q ${String(midX)},${String(midY)} ${String(targetX)},${String(targetY)}`;

  return (
    <>
      <BaseEdge id={id} path={bowed} markerEnd={markerEnd} style={style} />
      <Label
        x={(sourceX + targetX) / 2 + nx * offset}
        y={(sourceY + targetY) / 2 + ny * offset}
        label={label}
      />
    </>
  );
}

/**
 * The edge's word — React Flow's OWN `EdgeText`, deliberately.
 *
 * The first cut of this drew a nicer DOM chip through `EdgeLabelRenderer`, and
 * it was wrong in a way the screenshot showed immediately: that portal renders
 * OUTSIDE the edge's `<g>`, so #992's reveal rules
 * (`.react-flow__edge:hover .react-flow__edge-textwrapper`, and the `.selected`
 * and `:focus` arms beside it) no longer matched their own subject and every
 * label vanished — including on the selected edge, which is the one case the
 * feature exists to serve. `edge-typing.spec.ts` reads the same
 * `.react-flow__edge-text` for a branch's routing key.
 *
 * `EdgeText` emits exactly the elements those rules and that spec name, inside
 * the group where the hover and selection state live.
 */
function Label({ x, y, label }: { x: number; y: number; label: EdgeProps['label'] }) {
  if (label === undefined || label === null || label === '') return null;
  return <EdgeText x={x} y={y} label={label} />;
}
