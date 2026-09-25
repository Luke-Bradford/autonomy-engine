import { useMemo } from 'react';
import {
  availableRefs,
  fnSignature,
  listFunctions,
  type Container,
  type Edge,
  type Node,
  type Param,
  type RefSite,
  type RefSuggestion,
} from '@autonomy-studio/shared';
import { validateCanvas } from './canvasDoc';
import type { FieldPicker, PickerTarget } from './ConfigFieldControl';
import { containerLabels } from './containerRules';
import { applyWrap, insertModeFor, LITERAL_PROBE } from './expressionInsert';

/**
 * The U8a flyout's context for one SITE — a node, or one container expression
 * field (#864): which references can be written there, how each is NAMED, and —
 * per field — how choosing one is applied and which of them that field would
 * actually accept.
 *
 * Naming lives on this side of the boundary deliberately. `availableRefs`
 * returns identity only — a node's operator-facing name comes from
 * `activityLabels`' within-kind ordinals (#878, the same text its box carries)
 * and a container's from `containerLabels`, neither reachable from `shared`.
 * Computing a label there would be a second answer to "what is this node
 * called", free to disagree with the canvas.
 *
 * The per-FIELD half is why `resolve` exists rather than a plain list.
 * `availableRefs` answers per SITE — is this reference resolvable and is its
 * producer guaranteed to have run — which is everything the graph decides and
 * nothing the field decides. The save gate ALSO type-checks some fields: a
 * `filter`'s `items` wants an array and its `predicate` a boolean, and an
 * `llm_call`'s `history` wants a turn list. On those fields most references are
 * refused, and because they are also whole-value fields the picker is in REPLACE
 * mode there — so an unfiltered list would destroy the author's working
 * expression AND leave the doc unsavable.
 *
 * Rather than restating the type rules (a second reader of `FUNCTIONS` that
 * would still miss `scanLlmHistoryRef`), each candidate is run through the SAME
 * whole-doc validator the mode probe uses and dropped if it adds an issue. One
 * mechanism, no rules copied, and it covers validators added later for free.
 */
export function useExpressionPicker(
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
  params: Param[],
  site: RefSite,
  /** The panel's ONE answer to "what is each activity called" — see `nodeName`. */
  nodeNames: ReadonlyMap<string, string>,
): FieldPicker {
  // The memo keys on the site's PARTS, not the object: callers build it inline,
  // and a fresh literal every render would recompute the catalog every render.
  const subjectId = site.kind === 'node' ? site.nodeId : site.containerId;
  const field = site.kind === 'container' ? site.field : undefined;
  return useMemo(() => {
    const doc = { params, nodes, edges, containers };
    // Asked per TARGET, because a node's scope can differ by field — a
    // `filter`'s predicate binds `${item}`, its items does not (#864). A
    // container site already names its one field.
    const suggestionsFor = (target: PickerTarget) =>
      availableRefs(
        doc,
        field === undefined
          ? { kind: 'node', nodeId: subjectId, field: target.field }
          : { kind: 'container', containerId: subjectId, field },
      );
    const labels = containerLabels(containers);
    // #878 — an activity is offered under the SAME name its box carries, which
    // is what lets the author match an option to a rectangle. This replaced a
    // hand-rolled disambiguator that appended the raw doc id where two producers
    // rendered the same title ("HTTP Request (n_7c44a16f-…)"). It bought
    // uniqueness with a string the canvas shows nowhere; `activityLabels` is
    // unique too — it counts by rendered name, so two types cannot collide into
    // one label — and it is readable.
    //
    // The cost, stated: the id used to double as the link between an option and
    // the `${nodes.<id>.output.…}` text it inserts, which for a hand-authored doc
    // was a real if accidental aid. That link is gone from the option text. The
    // canvas is where an author identifies a node, and the ordinal is the only
    // name that exists on both surfaces.
    const producerName = (id: string) => nodeNames.get(id) ?? labels.get(id) ?? id;

    // A container field is fixed by the SITE, so the control's `target.place` —
    // a position within a NODE — has nothing to place into there: the candidate
    // is the container with that one field set. `baseline`/`wholeValue` still
    // come from the target (a container field is top-level, so 'stored').
    const issuesWith = (target: PickerTarget, value: string) =>
      field === undefined
        ? validateCanvas(
            nodes.map((n) => (n.id === subjectId ? target.place(n, value) : n)),
            edges,
            containers,
            params,
          )
        : validateCanvas(
            nodes,
            edges,
            containers.map((c) => (c.id === subjectId ? { ...c, [field]: value } : c)),
            params,
          );

    // What a candidate is compared against — see `PickerTarget.baseline`. ONE
    // answer for references and functions alike: a candidate may carry only
    // what the field's position raises whatever it holds.
    const baselineFor = (target: PickerTarget) =>
      target.baseline === 'stored'
        ? validateCanvas(nodes, edges, containers, params)
        : (() => {
            const literal = issuesWith(target, LITERAL_PROBE);
            return issuesWith(target, '').filter((issue) => literal.includes(issue));
          })();

    return {
      describe: (s: RefSuggestion) => {
        if (s.kind === 'nodeOutput') return `${producerName(s.producerId ?? '')} → ${s.name}`;
        if (s.kind === 'nodeStatus') return `${producerName(s.producerId ?? '')} → status`;
        if (s.kind === 'item') return 'item — the element this round is processing';
        return s.name ?? s.ref;
      },
      // Run only when a flyout OPENS, never per render: this validates the whole
      // doc once for the mode and once more per candidate.
      resolve: (target: PickerTarget) => {
        const mode = target.wholeValue
          ? 'replace'
          : insertModeFor((value) => issuesWith(target, value));
        const baseline = baselineFor(target);
        // Filtered in BOTH modes. REPLACE makes the field become the reference,
        // which is where a field's own type check rejects one. INSERT used to
        // skip the filter on the argument that a template always resolves to a
        // string — true of TYPES, and false of a field that refuses `${}`
        // outright: a copy mapping's `source`/`sink` must be literal (§8), both
        // mode probes carry that refusal equally, so such a field reads as a
        // template and an unfiltered list offered references that were ALL
        // refused at save (#1178). An insert candidate is probed in the shape a
        // splice makes — the same prefix `INTERPOLATED_PROBE` uses.
        const shaped = (insert: string) =>
          mode === 'replace' ? insert : `${LITERAL_PROBE}${insert}`;
        return {
          mode,
          suggestions: suggestionsFor(target).filter((s) => {
            const after = issuesWith(target, shaped(s.insert));
            return !after.some((issue) => !baseline.includes(issue));
          }),
        };
      },
      // #864 — the FUNCTIONS half, under the same no-false-offer rule and by the
      // same mechanism: every catalog function is tried AROUND the target and
      // kept only if the whole-doc validator raises nothing the field's CURRENT
      // text does not already raise. Nothing about arity or argument types is
      // restated here — `default` (two args), `utcNow`-shaped zero-arg calls and
      // the lambda functions fall out because the save gate refuses them.
      //
      // The baseline is the SAME one references are judged by, not the field's
      // current text: a wrap cannot repair a refusal the expression already
      // earns (it only goes around it), so measuring against the current text
      // would cancel that refusal out and offer every function on a field the
      // save still refuses. Against the position's own baseline such a field is
      // offered nothing, which is what is true. An issue whose message quotes
      // the expression changes with the wrap and reads as new, so the error
      // only ever runs towards offering less.
      wraps: (target: PickerTarget, text: string, span) => {
        const baseline = baselineFor(target);
        return listFunctions()
          .filter((name) => {
            const after = issuesWith(target, applyWrap(text, span, name).value);
            return !after.some((issue) => !baseline.includes(issue));
          })
          .map((name) => ({ name, signature: fnSignature(name) }));
      },
    };
  }, [nodes, edges, containers, params, subjectId, field, nodeNames]);
}
