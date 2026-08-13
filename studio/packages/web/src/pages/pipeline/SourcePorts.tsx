import { Handle, Position } from '@xyflow/react';
import type { CSSProperties } from 'react';
import { sourcePortOffset, type SourcePort } from './ports';

/**
 * U19 — the outgoing ports, drawn as a labelled column down the node's right
 * edge.
 *
 * The LABEL is a sibling of the handle, not a child of it, and inert
 * (`pointer-events: none` in the stylesheet). React Flow reads a handle's
 * position from its own `getBoundingClientRect`, and the e2e helper aims a drag
 * at that rect's centre — putting the text inside the handle would widen the dot
 * to the width of the word `completion` and move the point every edge attaches
 * to off the port it is drawn at.
 *
 * `top` is set inline rather than in CSS because the offset is a function of the
 * port's index and the column's length, and it must be the SAME function
 * `containerHandles` uses for its stated `y` — see `sourcePortOffset`.
 *
 * The hue repeats the edge's own variant colour, so the port an edge leaves and
 * the line it draws are the same colour rather than two conventions to learn.
 * An ORPHANED port — a condition an existing edge routes on that the source no
 * longer declares — is drawn muted and says so in its accessible name. It is
 * there at all because without it React Flow would resolve that edge's
 * `sourceHandle` to nothing and draw no line, silently.
 */
export function SourcePorts({ ports }: { ports: readonly SourcePort[] }) {
  return (
    <>
      {ports.map((port, index) => {
        /* #997 — the offset is published as a CUSTOM PROPERTY, not as `top`.
           The stylesheet then owns WHICH position applies: `50%` at rest so
           every edge appears to leave one point mid-node, `calc(50% + offset)`
           when the node's `data-ports-expanded` says the fan is out. Writing
           `top` inline here instead would win over both rules and freeze the
           ports fanned — the same inline-beats-stylesheet trap `drive.sh`'s
           `STUDIO_QUOTA_URL` pin records, in CSS.

           The port keeps its `id`, stays MOUNTED and stays in the accessible
           name at rest: this is a visual collapse, never a structural one, so
           `sourceHandle` resolution and screen-reader output are untouched. */
        const style = {
          '--port-offset': `${sourcePortOffset(index, ports.length)}px`,
        } as CSSProperties;
        const name = port.orphaned ? `${port.label} — not offered by this source` : port.label;
        return (
          <span key={port.id}>
            <Handle
              type="source"
              id={port.id}
              position={Position.Right}
              style={style}
              className={`flow-port flow-port--${port.orphaned ? 'orphaned' : port.condition.on}`}
              title={name}
              aria-label={name}
            />
            <span className="flow-port-label" style={style} aria-hidden="true">
              {port.label}
            </span>
          </span>
        );
      })}
    </>
  );
}
