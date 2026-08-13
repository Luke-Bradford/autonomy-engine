import { useEffect, type RefObject } from 'react';
import { useConnection } from '@xyflow/react';
import { useHoverIntent } from '../../hooks/useHoverIntent';

/**
 * #997/#1066 — whether a canvas node's source ports are fanned out, and the
 * handlers that decide it.
 *
 * Extracted from `ActivityNode` when #1066 gave a CONTAINER the same fan. The
 * two node kinds must open and close on identical terms — a container that
 * fanned on raw hover while an activity waited for intent would make the same
 * pointer gesture mean two things on one canvas — and the parts that are easy to
 * get subtly different (the dwell, the grace, the wrapper focus wiring, the
 * connecting-mode override) are exactly the parts that live here.
 *
 * What it deliberately does NOT do is tell React Flow to re-measure. That is the
 * one thing the two kinds genuinely differ on: an activity is measured from the
 * DOM and must call `updateNodeInternals` when this flips, while a container's
 * bounds are STATED (`containerHandles`) and a re-measure of one is discarded.
 * Both facts are the caller's to act on, so neither is hidden in here.
 */
export interface NodeFan {
  /** Whether the ports are fanned out right now. */
  expanded: boolean;
  /** Spread onto the node's box element. */
  handlers: {
    onPointerEnter: () => void;
    onPointerLeave: () => void;
  };
}

export function useNodeFan(boxRef: RefObject<HTMLElement | null>): NodeFan {
  /* Hover INTENT, not raw hover: a pass-over must not set off a wave of nodes
     opening behind the cursor, and a momentary exit must not snatch the ports
     away as the user reaches for one. The node and its ports are ONE hover
     region (the ports sit inside the box's bounds), so there is no gap to cross
     and no exit to debounce beyond the hook's own grace. */
  const { open, handlers } = useHoverIntent();

  /* WHILE A CONNECTION IS BEING DRAGGED, every node fans with NO dwell — the
     ticket's "connecting mode" clause, and it is load-bearing rather than a
     nicety. A drop happens the moment the pointer ARRIVES over a port, so no
     dwell can ever elapse: with hover intent alone the ports a drag is aiming
     for are unreachable by that drag. `connect-validation`'s backwards drag is
     the proof — it dropped onto a collapsed stack and authored a NEW edge where
     the duplicate should have been refused, which is a wrong graph, not a
     cosmetic miss. `useConnection` rather than plumbing a flag through node
     data, so a gesture does not rebuild the whole nodes array. */
  const connecting = useConnection((c) => c.inProgress);

  /* KEYBOARD ARRIVAL IS NOT OBSERVABLE FROM THE BOX without this. React Flow
     owns the focusable element — `.react-flow__node`, the PARENT of the box the
     caller renders — so focusing a node with Tab fires no focus event inside
     that subtree at all, and an `onFocus` on the box would never run. A CSS-only
     reveal keyed on `.react-flow__node:focus-visible` was the tempting shortcut
     and is wrong in a way that matters: it would fan the DOTS while the state
     this hook holds stayed closed, so the caller would never re-state or
     re-measure its handles and every edge would stay attached at the middle.

     It is also the ONLY arm that answers a keyboard user on a container, which
     is not focusable itself — its ⚙ and ✕ are, and `focusin` bubbles from them
     to the wrapper this listens on. */
  const { onFocus, onBlur } = handlers;
  useEffect(() => {
    const wrapper = boxRef.current?.parentElement;
    if (!wrapper) return;
    // `focusin`/`focusout` rather than `focus`/`blur`: the ports themselves are
    // focusable, and only the bubbling pair keeps the fan open while Tab moves
    // between them.
    wrapper.addEventListener('focusin', onFocus);
    wrapper.addEventListener('focusout', onBlur);
    return () => {
      wrapper.removeEventListener('focusin', onFocus);
      wrapper.removeEventListener('focusout', onBlur);
    };
  }, [boxRef, onFocus, onBlur]);

  return {
    expanded: open || connecting,
    handlers: { onPointerEnter: handlers.onPointerEnter, onPointerLeave: handlers.onPointerLeave },
  };
}
