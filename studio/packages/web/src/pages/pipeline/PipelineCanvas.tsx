import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ContainerKindSchema,
  OutputTypeSchema,
  ParamTypeSchema,
  availableRefs,
  formatZodIssues,
  getActivity,
  authorsCallBlob,
  paramDefaultDefect,
  type RefSuggestion,
  type ActivePipelineVersion,
  type CallConfig,
  type Container,
  type ConnectionPublic,
  type ContainerKind,
  type Dataset,
  type Edge,
  type Node,
  type Output,
  type OutputType,
  type Param,
  type ParamType,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import {
  clipboardCommandFor,
  arrangeDisabledReason,
  historyCommandFor,
  isDeleteKeystroke,
  redoDisabledReason,
  undoDisabledReason,
} from './undoRedo';
import { arrangeMoves, type MeasuredSizes } from './autoLayout';
import { messageOf } from '../../api/client';
import {
  createPipelineVersion,
  latestVersion,
  listPipelineVersions,
  publishPipeline,
  restorePipeline,
  TRIGGERS_STAY_DISABLED_NOTE,
} from '../../api/pipelines';
import { listConnections } from '../../api/connections';
import { listDatasets } from '../../api/datasets';
import { eligibleForBinding } from './bindingPickers';
import { ActivityToolbox } from './ActivityToolbox';
import {
  assignContainerChild,
  buildContainer,
  containersWithNew,
  createCanvasStore,
  singleSelection,
  type Selection,
} from './canvasStore';
import { ConfigFieldControl, type FieldPicker } from './ConfigFieldControl';
import { CallPanel } from './CallPanel';
import { ContainerPanel } from './ContainerPanel';
import { activityLabels } from './activityLabel';
import { insertModeFor } from './expressionInsert';
import {
  assembleConfig,
  deriveConfigFields,
  seedFieldInputs,
  unrepresentableFields,
} from './configForm';
import { confirmContainerEdit, containerLabels, readableIssue } from './containerRules';
import { coerceDefaultInput, formatDefaultInput, nameIssues, withRequired } from './paramRules';
import { saveDisabledReason, toVersionBody, validateCanvas } from './canvasDoc';
import { branchConditionsOf, conditionLabel, declaredConditionsOf } from './ports';
import {
  conditionOf,
  edgeLabel,
  encodeCondition,
  isMaxBounces,
  OPERATIONAL_CONDITIONS,
  takenConditions,
  type EdgeCondition,
} from './edgeCondition';
import { FlowCanvas } from './FlowCanvas';
import { RunCanvas } from '../runs/RunCanvas';
import { VersionHistoryPanel, VersionPreviewBar } from './VersionHistoryPanel';
import {
  activeVersionLabel,
  describePublishRefusal,
  describeRestoreConflict,
  describeSaveConflict,
  docUnchanged,
  historyEntries,
  isPublishRefused,
  isStaleWrite,
  publishConfirmMessage,
  publishOutcomeMessage,
  publishRefusal,
  restoreBodyFrom,
  restoreConfirmMessage,
  restoreRefusal,
  saveAnywayLabel,
  type ActiveVersionState,
} from './versionHistory';
import { useTransientNotice } from './useTransientNotice';
import { readPublishState } from './publishState';

/**
 * How long a canvas-gesture notice stays up — copy/paste/duplicate, and U9's
 * Arrange.
 *
 * Long enough to read a short sentence unhurriedly, short enough that it is
 * gone before the next thing the operator does — the point of the line is to
 * confirm a gesture landed, and nothing about it is worth going back to.
 *
 * ONE line for all of them, not one per feature. They are the same kind of fact
 * (a gesture that is already over), only one gesture can be the most recent, and
 * two live regions on one page can announce over each other — a collision this
 * canvas already has a ticket for (#960). Arrange reuses it rather than adding
 * the third.
 */
const CANVAS_NOTICE_MS = 6_000;

interface PipelineCanvasProps {
  pipelineId: string;
  pipelineName: string;
  /**
   * #907 — is this pipeline ARCHIVED? An archived pipeline refuses every save
   * (the server 409s), so the canvas says so BEFORE the operator types rather
   * than only when their first Save bounces. The flag is the route's, because
   * the route is what fetched the pipeline.
   */
  archived: boolean;
  /** Called after a successful unarchive, so the route's copy stops saying archived. */
  onUnarchived: () => void;
  onBack: () => void;
}

/**
 * The authoring canvas for one pipeline: loads the latest immutable version
 * into a working store, renders the React Flow editor with a palette and a
 * property panel, and saves the working graph as a NEW immutable version.
 */
export function PipelineCanvas({
  pipelineId,
  pipelineName,
  archived,
  onUnarchived,
  onBack,
}: PipelineCanvasProps) {
  const store = useState(() => createCanvasStore())[0];
  const [connections, setConnections] = useState<ConnectionPublic[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  /* U21 — the clipboard's own line, not `saveMsg`: a copy is not a save
     outcome, and folding them would let a paste erase the sentence that
     says whether the last save landed.

     TRANSIENT, because nothing else on this canvas has any business clearing
     it. `saveMsg` is wiped by the next save attempt; a copy has no successor
     act, so an un-expiring line would sit under unrelated later work still
     claiming to describe it. */
  const [canvasMsg, showCanvasMsg] = useTransientNotice(CANVAS_NOTICE_MS);
  /* U9 — bumped by Arrange to ask the canvas to fit what it just laid out. See
     `FlowCanvas`'s `fitSignal` prop for why it is a counter. */
  const [fitSignal, setFitSignal] = useState(0);
  /* #1005 — the sizes React Flow has measured, filled in by `FlowCanvas` and
     read by Arrange. A ref, not state: nothing here RENDERS from it, and making
     a measurement re-render this component would feed the tree being measured.
     Initialised empty rather than null so every read is total — an empty map is
     honestly "nothing measured yet", which the layout already handles. */
  const measuredSizesRef = useRef<MeasuredSizes>(new Map());
  // #907 — the unarchive request's own in-flight + failure state. Kept apart
  // from `saveMsg` because that is a SAVE outcome and gets clobbered by the
  // next save; this one is about whether the pipeline can be saved at all.
  const [unarchiving, setUnarchiving] = useState(false);
  const [unarchiveError, setUnarchiveError] = useState<string | null>(null);

  /**
   * #907 — bring the pipeline back to an editable state.
   *
   * "Unarchive", never "restore", even though the route is `POST
   * /api/pipelines/:id/restore`: on THIS screen "restore" already means
   * restoring an old VERSION into the working graph (#903, `onRestore` below),
   * and one screen cannot use one word for two different acts.
   *
   * Leaves the working graph alone. Un-archiving is a fact about the PIPELINE,
   * not about the doc being edited — reloading the canvas here would discard
   * edits the operator made while archived, which is precisely the work this
   * banner exists to stop them losing.
   */
  const onUnarchive = useCallback(async () => {
    setUnarchiving(true);
    setUnarchiveError(null);
    try {
      await restorePipeline(pipelineId);
      onUnarchived();
    } catch (err: unknown) {
      setUnarchiveError(messageOf(err));
    } finally {
      setUnarchiving(false);
    }
  }, [pipelineId, onUnarchived]);
  // #903 — the versions the initial load already fetched. Before this ticket
  // they were reduced to `latestVersion` and thrown away; the history is that
  // same array, kept.
  const [versions, setVersions] = useState<PipelineVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** The version NUMBER being previewed read-only, or `null` while editing. */
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  /**
   * #979 — the publish state: the active pointer, and whether a repo is
   * connected at all. Both start `undefined` and STAY `undefined` if the read
   * fails, which is what stops a publish from being attempted on a guess — see
   * `ActiveVersionState`. They are one piece of state because they are read
   * together and are meaningless apart.
   */
  const [active, setActive] = useState<ActiveVersionState>(undefined);
  const [gitConnected, setGitConnected] = useState<boolean | undefined>(undefined);
  const [publishing, setPublishing] = useState(false);
  /**
   * #904 — the head this canvas was refused against, or `null` when there is no
   * conflict outstanding.
   *
   * Its own state and not `saveMsg`, which is a bare string with nowhere to put
   * an action. A conflict is the one save outcome the operator must DECIDE
   * about — look at the version that landed, or advance past it — so it needs
   * to carry the version those two buttons act on.
   */
  const [conflict, setConflict] = useState<PipelineVersion | null>(null);
  /**
   * While a version write is in flight, EVERY route in or out of the preview is
   * inert.
   *
   * Not politeness — a restore rebases the canvas onto the version it mints,
   * and it is only safe to do that into an editor that is not there. Leaving
   * the preview remounts the editor, and an operator who then types has work
   * that the arriving response would overwrite. There are three such routes
   * (this preview's own "Back to editing", the "Version history" toggle, and a
   * version row), so the lock is named once and applied to all three rather
   * than remembered at each.
   *
   * #904 — `saving` joins `restoring`, and it is the same argument run the
   * other way: a SAVE writes the working graph, so ENTERING a preview while one
   * is in flight would land "Saved vN" and a full rebase underneath a read-only
   * view of a different version. The property both halves hold is that the
   * canvas the operator can see is the canvas the in-flight write is about.
   */
  const previewLocked = restoring || saving;
  /**
   * Why the "Version history" toggle is dead, or `null` while it is live.
   *
   * Named rather than inlined because it has TWO causes and a nested ternary in
   * the attribute reads as one. `!ready` is checked first to match the
   * `disabled` expression beside it: during the initial load nothing has been
   * restored yet, so "restoring" would be the wrong sentence even if both were
   * somehow true.
   */
  /**
   * U17 — the undo/redo control state, and the shortcut that drives the same
   * two actions.
   *
   * The stack DEPTHS are selected as booleans, not as arrays: a selector
   * returning `s.past` would re-render this component on every recorded edit,
   * where what it actually draws is only whether the button is live.
   */
  const canUndo = useStore(store, (s) => s.past.length > 0);
  const canRedo = useStore(store, (s) => s.future.length > 0);
  const undoReason = undoDisabledReason({ available: canUndo, previewing, busy: previewLocked });
  const redoReason = redoDisabledReason({ available: canRedo, previewing, busy: previewLocked });

  /**
   * U9 — re-lay-out the working graph (#1004).
   *
   * Read through `store.getState()` rather than the rendered `nodes`, for the
   * reason Undo and Redo do: the handler must act on the graph as it is at the
   * moment of the click, not as it was when this render was produced.
   *
   * The no-op case is REPORTED rather than left silent. `moveNodes` drops moves
   * that change nothing and records no history entry when none are real, so an
   * already-arranged graph would otherwise make the button look broken —
   * indistinguishable, from the operator's side, from one that failed.
   * `arrangeMoves` owns that distinction (and is where it is tested);
   * `moveNodes` still applies its own filter, so the two cannot disagree.
   *
   * It marks the document DIRTY, and that is intended. A position is real
   * persisted doc state — the same class of write as an undo of a move or a
   * version restore — so a re-layout that left `dirty` alone would be silently
   * discarded the moment the operator navigated away, having shown them a
   * readable graph it never meant to keep. The cost is that Arrange obliges a
   * Save to persist; Undo is right there if that is not wanted.
   */
  const onArrange = useCallback(() => {
    const state = store.getState();
    const changed = arrangeMoves(
      state.nodes,
      state.edges,
      state.containers,
      measuredSizesRef.current,
    );
    if (changed.length === 0) {
      showCanvasMsg('Already arranged — nothing moved.');
      return;
    }
    state.moveNodes(changed);
    setFitSignal((n) => n + 1);
    showCanvasMsg(
      `Arranged ${changed.length} ${changed.length === 1 ? 'activity' : 'activities'}.`,
    );
  }, [showCanvasMsg, store]);

  /**
   * ⌘Z / ⇧⌘Z on the document, gated by the same two reasons the buttons are.
   *
   * On the DOCUMENT rather than on a wrapper div, because the shortcut has to
   * work wherever the operator's focus happens to be on this page — the canvas
   * pane, the property panel, a toolbox item — and a keydown handler on a
   * container only sees what is focused inside it. `historyCommandFor` is what
   * keeps that reach safe: it declines every keystroke aimed at a text-entry
   * control, where ⌘Z means the browser's own text undo.
   *
   * `preventDefault` only for a keystroke actually taken, so a refused one still
   * does whatever it would have done.
   */
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      /* U21 — Backspace/Delete, taken off React Flow (`deleteKeyCode={null}`)
         so the whole gesture is ONE undo entry. Read on the same document
         listener and behind the same text-entry guard as the history keys. */
      if (isDeleteKeystroke(e)) {
        if (store.getState().selected.length === 0) return;
        e.preventDefault();
        store.getState().deleteSelection();
        return;
      }
      /* U21 — ⌘C/⌘V/⌘D, same document listener and same text-entry guard. Gated
         on the preview for the reason Save is: a preview REPLACES the editor, so
         a paste there would edit a working graph the operator cannot see. */
      const clip = clipboardCommandFor(e);
      if (clip !== null) {
        if (previewing !== null || previewLocked) return;
        if (clip === 'copy') {
          const copied = store.getState().copySelection(pipelineId);
          // Nothing of OURS to copy — leave ⌘C alone so the browser's own text
          // copy still works for an operator selecting text on the page.
          if (copied === 0) return;
          e.preventDefault();
          showCanvasMsg(`Copied ${copied} ${copied === 1 ? 'activity' : 'activities'}.`);
          return;
        }
        if (clip === 'duplicate') {
          if (store.getState().selected.every((sel) => sel.kind !== 'node')) return;
          e.preventDefault();
          const made = store.getState().duplicateSelection();
          showCanvasMsg(`Duplicated ${made} ${made === 1 ? 'activity' : 'activities'}.`);
          return;
        }
        e.preventDefault();
        const outcome = store.getState().pasteClipboard(pipelineId);
        showCanvasMsg(
          outcome.ok
            ? `Pasted ${outcome.count} ${outcome.count === 1 ? 'activity' : 'activities'}.`
            : outcome.reason,
        );
        return;
      }
      const command = historyCommandFor(e);
      if (command === null) return;
      const reason = command === 'undo' ? undoReason : redoReason;
      if (reason !== null) return;
      e.preventDefault();
      if (command === 'undo') store.getState().undo();
      else store.getState().redo();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // `showCanvasMsg` is stable (the notice window is a module constant), so
    // listing it does not re-bind the keydown listener on every render.
  }, [store, undoReason, redoReason, pipelineId, previewing, previewLocked, showCanvasMsg]);

  const historyDisabledReason = !ready
    ? 'Loading this pipeline’s versions…'
    : restoring
      ? 'Restoring — wait for it to finish.'
      : saving
        ? 'Saving — wait for it to finish.'
        : null;

  // Initial load: the promise-callback form keeps setState off the synchronous
  // effect body (React's `set-state-in-effect` guidance). The parent keys this
  // component by pipeline id, so a different pipeline remounts it fresh — no
  // in-place pipelineId change to reset for.
  useEffect(() => {
    const ctrl = new AbortController();
    // #1139 — datasets join the `Promise.all` rather than taking the publish
    // state's decorate-and-degrade path below, because they are load-bearing for
    // AUTHORING: they populate a `copy` node's source/sink pickers, and a picker
    // that renders empty because its fetch failed is indistinguishable from a
    // workspace with no datasets. An author who read it that way would conclude
    // there is nothing to bind. Failing the page loudly is the honest outcome.
    Promise.all([
      listPipelineVersions(pipelineId, ctrl.signal),
      listConnections(ctrl.signal),
      listDatasets(ctrl.signal),
    ])
      .then(([loadedVersions, conns, sets]) => {
        store.getState().loadVersion(latestVersion(loadedVersions));
        setVersions(loadedVersions);
        setConnections(conns);
        setDatasets(sets);
        setReady(true);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [pipelineId, store]);

  /**
   * #979 — the publish state, read SEPARATELY from the load above and never
   * folded into its `Promise.all`.
   *
   * That effect routes any rejection to `setLoadError`, which replaces the whole
   * page with an error. Its two reads are load-bearing for authoring; these two
   * are not — they decorate one panel. A workspace whose git read fails must
   * still open its canvas, so a failure here degrades to `undefined` (publish
   * held back, nothing claimed) rather than taking the editor down with it.
   */
  useEffect(() => {
    const ctrl = new AbortController();
    readPublishState(pipelineId, ctrl.signal)
      .then((s) => {
        setActive(s.active);
        setGitConnected(s.gitConnected);
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        // Back to unread, not to a default. A failed read that left a STALE
        // pointer on screen would be worse than one showing none: the CAS would
        // then be sent an expectation nothing currently supports.
        setActive(undefined);
        setGitConnected(undefined);
      });
    return () => ctrl.abort();
  }, [pipelineId]);

  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const containers = useStore(store, (s) => s.containers);
  const params = useStore(store, (s) => s.params);
  const outputs = useStore(store, (s) => s.outputs);
  const dirty = useStore(store, (s) => s.dirty);
  const loaded = useStore(store, (s) => s.loaded);

  const arrangeReason = arrangeDisabledReason({
    ready,
    available: nodes.length > 0,
    previewing,
    busy: previewLocked,
  });

  // #903 — three derived facts the history needs. `headVersion` is read off the
  // versions this page holds rather than off `loaded`: the two part company the
  // moment a save fails, and the head is what a restore is measured against.
  // Through `latestVersion`, whose docblock already claims to be the ONE rule
  // for "highest version" — a second reduce here would be exactly the drift it
  // names.
  // #904 — the head as a WHOLE, not just its number: a restore's CAS basis is
  // the head's id and is read off this same list, so deriving the two
  // separately would be two readers of one fact, free to drift.
  const head = useMemo(() => latestVersion(versions), [versions]);
  const headVersion = head?.version ?? null;
  const entries = useMemo(
    () => historyEntries(versions, loaded?.version ?? null, active?.versionId),
    [versions, loaded, active],
  );
  const previewed = useMemo(
    () => versions.find((v) => v.version === previewing) ?? null,
    [versions, previewing],
  );

  // U16 — `loaded` LEAVES the dep list: `params` moved into the store, and it
  // was the last thing this memo read off the opened version.
  //
  // The two sources are concatenated rather than merged into `validateCanvas`,
  // because they mirror DIFFERENT server gates and only one of them is
  // `validatePipelineDoc`. `nameIssues` mirrors the write SCHEMA
  // (`ParamSchema.name.min(1)` + `refuseDuplicateNames`), which
  // `validatePipelineDoc` never runs — folding it in would break that function's
  // stated contract of being exactly the gate the server calls.
  //
  // #884 — the `validateCanvas` half goes through `readableIssue`, the
  // `nameIssues` half does NOT, and the asymmetry is checkable rather than a
  // judgement call: `nameIssues` messages contain no node or container id at all
  // (`param #1 has no name`, `duplicate param name 'x'`), so there is nothing for
  // the rewrite to do, while every id it WOULD find in one is a param name the
  // operator typed and must keep reading verbatim.
  //
  // Mapping happens here, at the render site, and not inside `validateCanvas` —
  // `ContainerPanel` reads those same strings structurally (see `readableIssue`).
  const issues = useMemo(
    () => [
      ...validateCanvas(nodes, edges, containers, params).map((issue) =>
        readableIssue(issue, nodes, edges, containers),
      ),
      ...nameIssues(params, outputs),
    ],
    [nodes, edges, containers, params, outputs],
  );

  /**
   * #1141 — why a save is refused, computed ONCE and read by BOTH buttons that
   * save the working graph (the toolbar's Save and the conflict banner's
   * override). `disabled` and `title` are both derived from it, the idiom
   * `undoReason`/`redoReason`/`arrangeReason` beside it already use, so the two
   * buttons cannot gate differently — which is exactly what had happened: the
   * override omitted `issues` and let an invalid doc reach a client-side
   * `PipelineVersionWriteSchema.parse`, whose throw printed as a raw ZodError.
   *
   * The `ready` arm is live for the toolbar button, which exists while the
   * pipeline is still loading, and inert for the override BY CONSTRUCTION
   * rather than by luck: `conflict` is only ever set from a 409, which can only
   * follow a save, which can only follow a load. `setReady` is called exactly
   * once and only with `true`, so it never goes back.
   */
  const saveReason = saveDisabledReason({ saving, ready, issues, previewing });

  /**
   * Save the working graph as a new version, based on `basedOnVersionId`.
   *
   * #904 — the basis is a PARAMETER rather than read from `loaded` inside,
   * because the two callers disagree about it on purpose. An ordinary Save
   * declares the version the canvas is open on; "save anyway" (after a refusal)
   * declares the head that refused it, which is the operator explicitly saying
   * "yes, advance past that one". Both are honest CAS assertions — neither is a
   * force flag, and there is deliberately no server-side way to skip the check.
   */
  const saveWith = useCallback(
    async (basedOnVersionId: string | null) => {
      setSaving(true);
      setSaveMsg(null);
      // Snapshot the exact graph being saved. Store mutations always produce new
      // array references, so reference-equality tells us whether the operator
      // edited during the in-flight POST.
      const savedNodes = store.getState().nodes;
      const savedEdges = store.getState().edges;
      // #746 — containers ride along in the snapshot and the race check below.
      // Still redundant today, but no longer for the reason first written here,
      // and the update is the point: that comment said EVERY writer of
      // `containers` also writes `nodes`, and named the two that then existed
      // (`deleteNode`, `loadVersion`). #748's `deleteContainer` is the third, and
      // it does NOT write `nodes` — the case the line was added in anticipation of
      // has arrived. What keeps it redundant now is `edges`: `deleteContainer`
      // filters that array unconditionally, so it always hands back a fresh
      // reference and the edge check catches the race first. A future
      // container-ONLY mutator would leave this the only check standing, which is
      // why it stays.
      const savedContainers = store.getState().containers;
      // U16 — the typed contract rides in the same snapshot, and in the same race
      // check. Every param and output action writes `params`/`outputs` and nothing
      // else, so an edit made during the in-flight POST would be invisible to all
      // three of the checks above it.
      //
      // It is NOT the first such writer, though an earlier draft of this comment
      // claimed so: `createContainer` and `setNodeContainer` both write
      // `containers` alone. What the five checks together now assert is the
      // property that actually matters — they cover every doc field the store
      // owns, and every action mints a fresh array reference, so no concurrent
      // edit can be silently overwritten by the rebase.
      const savedParams = store.getState().params;
      const savedOutputs = store.getState().outputs;
      try {
        const created = await createPipelineVersion(
          pipelineId,
          toVersionBody(
            savedNodes,
            savedEdges,
            savedContainers,
            savedParams,
            savedOutputs,
            basedOnVersionId,
          ),
        );
        const s = store.getState();
        if (
          docUnchanged(
            {
              nodes: savedNodes,
              edges: savedEdges,
              containers: savedContainers,
              params: savedParams,
              outputs: savedOutputs,
            },
            s,
          )
        ) {
          // Nothing changed during the request: rebase fully onto the new
          // immutable version (clears `dirty`, and the next save carries THIS
          // version's params/outputs).
          s.loadVersion(created);
        } else {
          // The operator kept editing while the save was in flight — keep their
          // edits (and `dirty`), but point `loaded` at the new version so the
          // next save carries forward from it.
          s.rebaseLoaded(created);
        }
        // #903 — the history is appended to rather than refetched: the server
        // just told us the whole row, and a refetch would race the next save.
        setVersions((prev) => [...prev, created]);
        // #904 — the save landed, so whatever conflict sent us here is over.
        setConflict(null);
        setSaveMsg(`Saved v${created.version}.`);
      } catch (err) {
        if (isStaleWrite(err)) {
          // #904 — someone else saved while this canvas was open. The store is
          // NOT touched: their work is on the server, this operator's is on
          // screen, and the whole effect of the refusal is that neither moved.
          //
          // The versions are REFETCHED rather than left as they were, and that is
          // load-bearing three times over: the message names the head, the
          // history panel is fed from this array (so a "look at it" that led to a
          // list without it in would be a dead end), and `headVersion` — which
          // every restore refusal and confirmation is measured against — would
          // otherwise keep naming a version that is no longer newest. The refetch
          // is the one thing that makes the page honest again.
          try {
            const fresh = await listPipelineVersions(pipelineId);
            setVersions(fresh);
            const head = latestVersion(fresh);
            if (head) {
              setConflict(head);
              setSaveMsg(null);
              return;
            }
          } catch {
            // Fall through to the plain message: a refusal we cannot describe is
            // still a refusal, and reporting it as a success would be the one
            // unacceptable outcome. No conflict is set, so no "save anyway"
            // button offers a basis we failed to read.
          }
        }
        setConflict(null);
        setSaveMsg(
          // A stale write we could not describe (the refetch above threw) must
          // NOT print the server's own sentence: it names an internal pipeline
          // id, exactly as the restore path documents. Any other failure is the
          // server's to explain and passes through.
          isStaleWrite(err)
            ? 'Not saved: this pipeline changed while you were editing, and the version list could not be refreshed. Your changes are still here — reload the page to see what landed.'
            : `Save failed: ${messageOf(err)}`,
        );
      } finally {
        setSaving(false);
      }
    },
    [pipelineId, store],
  );

  /** An ordinary Save: the basis is the version this canvas is open on. */
  const onSave = useCallback(
    () => saveWith(store.getState().loaded?.id ?? null),
    [saveWith, store],
  );

  /**
   * #903 — restore the previewed version by minting a NEW version from ITS doc.
   *
   * Three properties are load-bearing and each is easy to lose:
   *
   *  - the body comes from the previewed version (`restoreBodyFrom`), never
   *    from the working canvas and never via `loadVersion`, which re-lowers
   *    nodes and drops dangling edges without saying so;
   *  - the refusal is re-checked HERE and not only on the disabled button,
   *    because `dirty` can turn true between render and click;
   *  - a REJECTED restore leaves the preview exactly as it was and does not
   *    touch the store. An old doc can genuinely fail today's write gate —
   *    `createPipelineVersion` runs `validatePipelineDoc` on the server
   *    (`repo/pipeline-versions.ts:190`) and the rules have moved since some of
   *    these versions were minted — so this is an expected path, not a
   *    theoretical one, and it must not half-apply.
   */
  const onRestore = useCallback(async () => {
    if (previewed === null) return;
    const refusal = restoreRefusal({ dirty, selectedVersion: previewed.version, headVersion });
    if (refusal !== null) {
      setSaveMsg(refusal);
      return;
    }
    if (
      !window.confirm(restoreConfirmMessage({ selectedVersion: previewed.version, headVersion }))
    ) {
      return;
    }
    setRestoring(true);
    setSaveMsg(null);
    try {
      // Snapshotted BEFORE the POST, for the same reason `onSave` does it.
      // An earlier draft called the race check unnecessary here — "the editor
      // is UNMOUNTED behind the preview, so there is no concurrent edit to
      // overwrite" — and that was false: it held only while the operator could
      // not LEAVE the preview mid-flight, which nothing enforced. Every exit is
      // locked while `restoring` now (see `previewLocked`), so the editor
      // really does stay unmounted — but the guarantee is "no write of ours
      // destroys an edit", and that belongs in the write, not in three
      // `disabled` attributes a fourth exit route would quietly bypass.
      const before = store.getState();
      // #904 — a restore is a save and declares a CAS basis too, but NOT the
      // one a save declares. A save asserts about the version its working graph
      // came from (`loaded`); a restore asserts about the version list the
      // operator was reading when they picked a row, which is `versions`.
      //
      // The two part company exactly when it matters. After a refused save
      // `loaded` still points at the old version by construction — nothing
      // re-points it on that path — so a `loaded`-based basis would make EVERY
      // restore 409 for as long as the conflict banner stood, with the only
      // exits being "save anyway" or a page reload. `versions` is refetched by
      // that same refusal, so it is both truthful and current.
      const created = await createPipelineVersion(
        pipelineId,
        restoreBodyFrom(previewed, head?.id ?? null),
      );
      setVersions((prev) => [...prev, created]);
      const s = store.getState();
      if (docUnchanged(before, s)) {
        s.loadVersion(created);
        setPreviewing(null);
        // The restore advanced the head, so any earlier save conflict is over —
        // its banner would otherwise stand naming versions that now exist.
        setConflict(null);
        setSaveMsg(`Restored v${previewed.version} as v${created.version}.`);
      } else {
        // BELT AND SUSPENDERS, not a live path: with `previewLocked` holding
        // all three exits shut, nothing can edit the doc between the snapshot
        // above and here, so this branch is currently unreachable through the
        // UI. It stays because the thing it guards is a GUARANTEE and the locks
        // are only an affordance — the reported bug was precisely an exit route
        // nobody had noticed, and a fourth one added later would reach here
        // rather than destroy work. Kept deliberately rather than trimmed.
        //
        // The restore SUCCEEDED — v`created` exists and holds the restored doc.
        // Only the canvas rebase is withheld, so say exactly that rather than
        // reporting a failure the server did not have. `rebaseLoaded` also
        // avoids the second hazard `loadVersion` would hit on a remounted
        // editor: it writes no node positions, so nothing lands half-applied.
        s.rebaseLoaded(created);
        setSaveMsg(
          `Restored v${previewed.version} as v${created.version}, but your canvas was left alone — it has edits that a restore would have discarded. Preview v${created.version} to load it.`,
        );
      }
    } catch (err) {
      if (isStaleWrite(err)) {
        // #904 — the head moved while this history list was on screen, so the
        // row that was clicked was chosen against a list that is now out of
        // date. Refetch and say so, rather than printing the server's sentence:
        // that names an internal pipeline id, and it leaves the list — and
        // every `v{head+1}` promise measured off it — stale.
        //
        // Deliberately NOT the save-conflict banner: that offers to save the
        // WORKING graph, which is not what was being attempted here.
        try {
          const fresh = await listPipelineVersions(pipelineId);
          setVersions(fresh);
          setSaveMsg(describeRestoreConflict(latestVersion(fresh)?.version ?? null));
          return;
        } catch {
          // Fall through: a refusal we cannot describe is still a refusal, and
          // reporting it as a success would be the one unacceptable outcome.
        }
      }
      setSaveMsg(`Restore failed: ${messageOf(err)}`);
    } finally {
      setRestoring(false);
    }
  }, [dirty, head, headVersion, pipelineId, previewed, store]);

  /**
   * #979 — make the previewed version the active published one.
   *
   * Publishing mints nothing and rebases nothing: it appends one pointer event.
   * So unlike a restore this touches neither `versions` nor the canvas store,
   * and it deliberately does NOT join `previewLocked` — the editor stays exactly
   * as it was.
   *
   * The refusal is re-checked here and not merely relied on from the disabled
   * button: the button's state is a render-time read, and the pointer can move
   * between the render and the click.
   */
  const onPublish = useCallback(async () => {
    if (previewed === null) return;
    const check = { selected: previewed, active, gitConnected, archived };
    const refusal = publishRefusal(check);
    if (refusal !== null) {
      setSaveMsg(refusal);
      return;
    }
    // Narrowing for TypeScript AND a genuine guard: `publishRefusal` returns
    // non-null for `undefined`, so this is unreachable — but the CAS argument is
    // too important to rest on a function's return value alone.
    if (active === undefined) return;
    if (
      !window.confirm(
        publishConfirmMessage({
          selectedVersion: previewed.version,
          activeVersion: activeVersionLabel(active, versions),
        }),
      )
    ) {
      return;
    }

    setPublishing(true);
    try {
      const result = await publishPipeline(pipelineId, {
        toVersionId: previewed.id,
        // The pointer this page read, stated positively. `null` here is the
        // claim "never published", which the refusal ladder above has already
        // established is a fact and not an unread.
        expectedActiveVersionId: active === null ? null : active.versionId,
      });
      // The response CARRIES the post-call pointer, so re-reading it would be a
      // round trip for a fact already in hand (the same move the restore makes
      // with the version it just minted).
      setActive(result.active);
      setSaveMsg(
        publishOutcomeMessage({ published: result.published, selectedVersion: previewed.version }),
      );
    } catch (err) {
      if (isPublishRefused(err)) {
        // All four refusal causes share one 409 code, so this cannot say WHICH.
        // Re-read the state — the page is otherwise left asserting a pointer the
        // server has just contradicted — and describe what it now shows.
        let fresh: ActivePipelineVersion | null | undefined;
        try {
          const s = await readPublishState(pipelineId);
          setActive(s.active);
          setGitConnected(s.gitConnected);
          fresh = s.active;
        } catch {
          setActive(undefined);
          setGitConnected(undefined);
          fresh = undefined;
        }
        // Through the ONE resolver, so a failed re-read stays `undefined` and a
        // version this page cannot name stays distinct from "nothing published".
        // Both were collapsed to `null` here, and both read as a false fact.
        setSaveMsg(describePublishRefusal(activeVersionLabel(fresh, versions)));
        return;
      }
      setSaveMsg(`Publish failed: ${messageOf(err)}`);
    } finally {
      setPublishing(false);
    }
  }, [active, archived, gitConnected, pipelineId, previewed, versions]);

  return (
    <section aria-labelledby="canvas-heading" className="canvas-page">
      <div className="page-header">
        <h2 id="canvas-heading">{pipelineName}</h2>
        <div className="form-actions">
          <button type="button" onClick={onBack}>
            ← Back to pipelines
          </button>
          {/* U17 — undo/redo. Before the Save button because they act on the
              working graph that Save is about to mint, and in that order.
              `onMouseDown={preventDefault}` keeps the click from moving focus
              off whatever the operator was editing: pressing Undo should not
              also blur the field they are typing in. */}
          <button
            type="button"
            aria-label="Undo"
            onClick={() => store.getState().undo()}
            disabled={undoReason !== null}
            title={undoReason ?? 'Undo the last edit (⌘Z)'}
            onMouseDown={(e) => e.preventDefault()}
          >
            ↶ Undo
          </button>
          <button
            type="button"
            aria-label="Redo"
            onClick={() => store.getState().redo()}
            disabled={redoReason !== null}
            title={redoReason ?? 'Redo the last undone edit (⇧⌘Z)'}
            onMouseDown={(e) => e.preventDefault()}
          >
            ↷ Redo
          </button>
          {/* U9 — Arrange. Beside Undo/Redo because it is the same kind of
              thing: a write to the working graph that Save will later mint,
              undoable by the button immediately to its left. Deliberately NOT
              in React Flow's `<Controls>` panel, which owns the CAMERA — this
              moves the document, not the view, and putting a document edit in
              the viewport chrome would be the one place an operator does not
              expect one. `onMouseDown={preventDefault}`, like its neighbours,
              so arranging does not blur the field being edited. */}
          <button
            type="button"
            onClick={onArrange}
            disabled={arrangeReason !== null}
            title={arrangeReason ?? 'Lay the activities out left to right by their dependencies'}
            onMouseDown={(e) => e.preventDefault()}
          >
            Arrange
          </button>
          <button
            type="button"
            aria-expanded={historyOpen}
            // Only while the panel is actually MOUNTED. It is unmounted rather
            // than hidden when collapsed (and `ready` gates it too), so naming
            // it unconditionally points a screen reader at an element that is
            // not in the DOM. `aria-expanded` alone carries the closed state.
            aria-controls={historyOpen && ready ? 'version-history-panel' : undefined}
            // `previewLocked` — closing the list also drops the preview (below),
            // which would remount the editor mid-restore. That is the same
            // escape "Back to editing" offers, just wearing a different button.
            disabled={!ready || previewLocked}
            // Both disabled cases get a reason. `!ready` is the commoner of the
            // two — it covers the whole initial load — and an unexplained dead
            // control is exactly what a title exists to prevent.
            title={historyDisabledReason ?? undefined}
            onClick={() => {
              // Both setters at the TOP LEVEL. Calling `setPreviewing` inside
              // the `setHistoryOpen` updater made that updater impure, which
              // StrictMode double-invokes in development — harmless while it is
              // idempotent, and a silent double-apply the moment it is not.
              //
              // Closing the list also leaves any preview it opened: the preview
              // is only reachable through a row, so one left on screen with no
              // list would be stranded.
              if (historyOpen) setPreviewing(null);
              setHistoryOpen(!historyOpen);
            }}
          >
            Version history
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            /* The named reason, not a hand-written copy of the terms: every
               refusal this button carries — including "previewing", where Save
               would otherwise mint a version of a graph the operator cannot see
               — is stated once in `saveDisabledReason`. */
            disabled={saveReason !== null}
            title={saveReason ?? undefined}
          >
            {saving ? 'Saving…' : 'Save version'}
          </button>
        </div>
      </div>

      {/* #907 — an archived pipeline refuses every save, so say it BEFORE the
          work happens. Without this the first Save simply bounces with a 409,
          after however long the operator spent editing.

          `role="alert"` and the `.notice-conflict` shape (not the transient
          `.notice` below) for the same reason the save-conflict banner uses
          them: this is a standing FACT about the pipeline that must be acted
          on, not a message about the last thing that happened — and it carries
          the act that resolves it. */}
      {archived && (
        <div className="notice-conflict" role="alert">
          {/* The trailing clause is the SHARED constant, not a second copy:
              the pipelines-list archive confirmation (#1058) states the same
              contract, and two hand-written copies would drift. */}
          <p>
            This pipeline is archived, so saving is refused. Unarchive it to edit again —{' '}
            {TRIGGERS_STAY_DISABLED_NOTE}.
          </p>
          {unarchiveError !== null && <p>Unarchive failed: {unarchiveError}</p>}
          <div className="form-actions">
            <button type="button" onClick={() => void onUnarchive()} disabled={unarchiving}>
              {unarchiving ? 'Unarchiving…' : 'Unarchive pipeline'}
            </button>
          </div>
        </div>
      )}

      {saveMsg && <p className="notice">{saveMsg}</p>}
      {/* `role="status"` so a keyboard-driven copy/paste — which changes
          nothing an operator is looking at — is still announced. */}
      {canvasMsg && (
        <p className="notice" role="status">
          {canvasMsg}
        </p>
      )}

      {/* #904 — a refused save. `role="alert"` because it is the ONE save
          outcome that is not self-explanatory and that the operator must act
          on: unannounced, the Save button simply appears to have done nothing.
          Distinct from the `.notice` above rather than folded into it, because
          this one carries the two acts that resolve it. */}
      {conflict && (
        <div className="notice-conflict" role="alert">
          <p>{describeSaveConflict(conflict.version)}</p>
          <div className="form-actions">
            <button
              type="button"
              onClick={() => {
                // Show them the version that landed, in the surface that
                // already exists for it (#903) — a prose pointer to a panel
                // they then have to find is not the same thing.
                setHistoryOpen(true);
                setPreviewing(conflict.version);
              }}
              // The same lock every other route into the preview carries: this
              // is a fourth one, and the reported bug was precisely a route
              // nobody had enumerated.
              disabled={previewLocked}
              // The NAMED reason, not a second hardcoded sentence: this button
              // is locked by `restoring` too, and a fixed "Saving…" would be
              // flatly wrong on that arm — reachable, and walked by the e2e.
              title={historyDisabledReason ?? undefined}
            >
              {`Preview v${String(conflict.version)}`}
            </button>
            <button
              type="button"
              // Re-declares the CAS basis as the head that refused us — an
              // informed assertion, not a bypass. If a THIRD save has landed in
              // the meantime, this is refused again and lands right back here
              // with the newer head, which is the correct behaviour and not a
              // loop to be short-circuited.
              onClick={() => void saveWith(conflict.id)}
              // EXACTLY the Save button's gate, from the same expression — not a
              // second one written to match. Two of its terms are load-bearing
              // here. `previewing`, because this writes the WORKING graph, which
              // is not what is on screen while a version is previewed, so the
              // one route this banner offers would otherwise mint a version of
              // something the operator cannot see. And `issues` (#1141), because
              // this button used to be the ONE save path that escaped the badge
              // gate: an author who hit the 409, then edited the doc into an
              // invalid state, found Save dead and this one alive, and clicking
              // it threw a raw ZodError out of `PipelineVersionWriteSchema.parse`
              // before the request was even made. Refusing here is not a new
              // refusal — the write was always going to be refused; it is the
              // refusal finally being stated where the author can read it.
              //
              // It cannot dead-end them, and that is worth saying because it is
              // the obvious objection. `conflict` is only ever set from the 409
              // branch, which does not touch the store, so reaching this banner
              // required a Save — which required `issues` to be empty. Every
              // issue on screen is therefore an edit made since, and Undo
              // (live: nothing is previewing or in flight) walks back out.
              disabled={saveReason !== null}
              title={saveReason ?? undefined}
            >
              {saveAnywayLabel(conflict.version)}
            </button>
          </div>
        </div>
      )}
      {loadError && <p className="error" role="alert">{`Could not load pipeline: ${loadError}`}</p>}

      {issues.length > 0 && (
        <div className="badge-list" role="status">
          {/* #444: this used to say "you can still save … a run will refuse an
              invalid graph". Both halves were wrong — nothing refused a save,
              and no run refused the doc either. The server now refuses it on
              save, so the copy states what actually happens, and no more: the
              graph on screen is an editable draft, so anything about immutable
              stored versions would just read as "yours is unfixable". */}
          <strong>{issues.length} validation issue(s)</strong> — fix these to save.
          <ul>
            {issues.map((msg, i) => (
              // Indexed, because the messages are NOT unique: three params sharing
              // a name emit the identical duplicate-name string twice, and a bare
              // `key={msg}` makes that a React duplicate-key warning — which the
              // e2e console guard treats as a failure.
              <li key={`${String(i)}-${msg}`}>{msg}</li>
            ))}
          </ul>
        </div>
      )}

      {/* `ready` gates the panel, because `versions` is `[]` both before the
          load resolves AND forever after it fails — and the panel's empty state
          says "no versions yet", which would be a flat falsehood printed next
          to the load-error banner. An unloaded page has no history to show, not
          an empty one. */}
      {historyOpen && ready && (
        <VersionHistoryPanel
          entries={entries}
          previewing={previewing}
          locked={previewLocked}
          onPreview={(version) => {
            setPreviewing((current) => (current === version ? null : version));
          }}
        />
      )}

      {/* The preview REPLACES the editor rather than hiding it, and that is
          correctness rather than tidiness: React Flow owns a node's position
          once its id is in the view array, so a restore into a live canvas
          would write the restored positions to the domain and leave the head's
          on screen. Unmounting here means the editor remounts empty after a
          restore and reads the restored geometry. */}
      {ready && previewed !== null && (
        <div className="canvas-preview" data-testid="canvas-preview">
          <VersionPreviewBar
            version={previewed.version}
            refusal={restoreRefusal({
              dirty,
              selectedVersion: previewed.version,
              headVersion,
            })}
            restoring={restoring}
            publishRefusal={publishRefusal({ selected: previewed, active, gitConnected, archived })}
            publishing={publishing}
            onPublish={() => void onPublish()}
            onRestore={() => void onRestore()}
            onBackToEditing={() => {
              setPreviewing(null);
            }}
          />
          {/* `showStatus={false}` — there is no run behind a stored version, so
              the monitor's "not projected" would be a sentence about a run that
              does not exist. */}
          {/* KEYED BY VERSION, and this is not cosmetic. `RunCanvas` was built
              for a doc that is immutable for its whole lifetime, so switching
              `doc` on a live instance leaves two things stale that nothing
              rebuilds: `mergeRunNodes` keeps a container box WHOLE when its
              `data` is unchanged, and a box's geometry, handles and child count
              live OUTSIDE `data` — with no status to differ, two versions'
              boxes compare equal, so a loop that gained a child would keep the
              previous version's width and draw that child outside the container
              it is in. And `fitView` is init-only, so a 2-node version followed
              by a 20-node one would stay at the first version's viewport with
              the rest culled by `onlyRenderVisibleElements`. Remounting is the
              same answer this page already gives for the editor. */}
          <RunCanvas key={previewed.id} doc={previewed} state={null} showStatus={false} />
        </div>
      )}

      {ready && previewed === null && (
        <div className="canvas-grid">
          {/* The toolbox is OUTSIDE the provider; the canvas reads the drop
              position via `useReactFlow` on its own side of the drag. */}
          <ActivityToolbox store={store} />
          <div className="canvas-wrap">
            <ReactFlowProvider>
              <FlowCanvas store={store} fitSignal={fitSignal} measuredSizesRef={measuredSizesRef} />
            </ReactFlowProvider>
          </div>
          <PropertyPanel
            store={store}
            connections={connections}
            datasets={datasets}
            pipelineId={pipelineId}
            onNotice={showCanvasMsg}
          />
        </div>
      )}

      {dirty && previewing === null && (
        <p className="page-hint">Unsaved changes — click “Save version” to persist.</p>
      )}
    </section>
  );
}

/** Edits the currently-selected node, edge or container; empty when nothing is. */
function PropertyPanel({
  store,
  connections,
  datasets,
  pipelineId,
  onNotice,
}: {
  store: ReturnType<typeof createCanvasStore>;
  connections: ConnectionPublic[];
  datasets: Dataset[];
  pipelineId: string;
  onNotice: (message: string) => void;
}) {
  const selection = useStore(store, (s) => s.selected);
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const containers = useStore(store, (s) => s.containers);
  const params = useStore(store, (s) => s.params);

  // U21 — a marquee selects many, and the editor below edits ONE. `singleSelection`
  // is the seam: many is its own state with its own panel, not "the first one".
  if (selection.length > 1) {
    return (
      <MultiSelectionPanel
        store={store}
        selection={selection}
        pipelineId={pipelineId}
        onNotice={onNotice}
      />
    );
  }
  const selected = singleSelection(selection);
  if (!selected) return <PipelinePanel store={store} pipelineId={pipelineId} onNotice={onNotice} />;

  if (selected.kind === 'edge') {
    const edge = edges.find((e) => e.id === selected.id);
    // A selection pointing at an element that no longer exists is, from the
    // operator's side, indistinguishable from having nothing selected — so it
    // gets the same pipeline-level panel as the `!selected` branch above.
    if (!edge) return <PipelinePanel store={store} pipelineId={pipelineId} onNotice={onNotice} />;
    // Keyed like `NodePanel`: `EdgePanel` holds a DRAFT for the bounce cap, and
    // selecting a different edge must not carry the previous one's half-typed
    // text (or its error) onto it.
    return <EdgePanel key={edge.id} store={store} edge={edge} nodes={nodes} edges={edges} />;
  }

  if (selected.kind === 'container') {
    const container = containers.find((c) => c.id === selected.id);
    if (!container)
      return <PipelinePanel store={store} pipelineId={pipelineId} onNotice={onNotice} />;
    // Keyed for the same reason the other two are: the form holds a draft per
    // field, and configuring a different container must not carry the previous
    // one's half-typed values (or its error) onto it.
    return (
      <ContainerPanel
        key={container.id}
        container={container}
        nodes={nodes}
        edges={edges}
        containers={containers}
        params={params}
        onApply={(next) => store.getState().updateContainer(container.id, next)}
      />
    );
  }

  const node = nodes.find((n) => n.id === selected.id);
  if (!node) return <PipelinePanel store={store} pipelineId={pipelineId} onNotice={onNotice} />;
  return (
    <NodePanel
      key={node.id}
      store={store}
      connections={connections}
      datasets={datasets}
      nodeId={node.id}
      nodeType={node.type}
      config={node.config}
      connectionId={node.connectionId}
      call={node.call}
    />
  );
}

/**
 * #996 M5 slice 4c (#1139) — one end of a paired resource binding.
 *
 * Four of these replace what would otherwise be four copies of the singular
 * connection picker's JSX. It keeps that picker's a11y idiom deliberately: the
 * label text sits INSIDE the `<label>` that wraps the control, so the accessible
 * name comes from the association rather than from a hand-written `aria-label`
 * that could drift from what is drawn.
 *
 * `options` are pre-labelled by the caller rather than typed generically over
 * the resource, because a connection reads `name (kind)` and a dataset reads
 * `name (kind)` from DIFFERENT fields of different shapes — pushing that into
 * this component would mean a discriminated union for no gain.
 */
function BindingSelect({
  label,
  value,
  options,
  onPick,
}: {
  label: string;
  value: string | undefined;
  options: { id: string; label: string }[];
  onPick: (id: string | undefined) => void;
}) {
  return (
    <label>
      {label}
      <select value={value ?? ''} onChange={(e) => onPick(e.target.value || undefined)}>
        <option value="">— none —</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * U21 — what the panel says when a marquee (or ⌘-click) has selected several
 * things at once.
 *
 * It reports the CONNECTIONS as well as the activities, because React Flow
 * selects every edge incident to a lassoed node, so a two-node marquee
 * routinely carries edges the operator did not aim at — and the delete below
 * removes them. Counting only the nodes would make that a surprise.
 *
 * Deleting a connection whose endpoints are both going anyway is not extra
 * destruction: `deleteNodesAndEdges` cascades those edges regardless.
 */
export function MultiSelectionPanel({
  store,
  selection,
  pipelineId,
  onNotice,
}: {
  store: ReturnType<typeof createCanvasStore>;
  selection: Selection[];
  pipelineId: string;
  onNotice: (message: string) => void;
}) {
  const activities = selection.filter((s) => s.kind === 'node').length;
  const connections = selection.filter((s) => s.kind === 'edge').length;
  const parts = [
    `${activities} ${activities === 1 ? 'activity' : 'activities'}`,
    ...(connections > 0
      ? [`${connections} ${connections === 1 ? 'connection' : 'connections'}`]
      : []),
  ];

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>{selection.length} selected</h3>
      <p className="page-hint">
        {parts.join(', ')}. Editing is one at a time — click a single activity to configure it.
      </p>
      {/* U21 — the three bulk acts, in the order an operator reaches for them.
          Copy and Duplicate act on the ACTIVITIES only (an edge travels with the
          pair it joins, and an edge alone has nothing to copy into), which is
          why they are disabled when a marquee caught edges and nothing else. */}
      <button
        type="button"
        disabled={activities === 0}
        onClick={() => {
          const copied = store.getState().copySelection(pipelineId);
          onNotice(`Copied ${copied} ${copied === 1 ? 'activity' : 'activities'}.`);
        }}
      >
        Copy selection
      </button>
      <button
        type="button"
        disabled={activities === 0}
        onClick={() => {
          const made = store.getState().duplicateSelection();
          onNotice(`Duplicated ${made} ${made === 1 ? 'activity' : 'activities'}.`);
        }}
      >
        Duplicate selection
      </button>
      <button type="button" onClick={() => store.getState().deleteSelection()}>
        Delete selection
      </button>
    </aside>
  );
}

/**
 * U16 — the PIPELINE-level property panel: the typed `params` (inputs) and
 * `outputs` (declared results) contract.
 *
 * Placement is the nothing-selected slot, which previously held only a hint.
 * That is the ADF pattern — click the canvas background to edit the pipeline
 * itself — and it needs no new shell chrome. The spec's U16 row calls for a
 * BOTTOM-pane tab; the bottom pane does not exist yet, and building one is shell
 * work this ticket does not own, so the editor lands where the canvas can
 * actually reach it today and moves when that pane arrives.
 *
 * Exported for its own tests, the same reason `EdgePanel`/`NodePanel` are.
 */
export function PipelinePanel({
  store,
  pipelineId,
  onNotice,
}: {
  store: ReturnType<typeof createCanvasStore>;
  pipelineId: string;
  onNotice: (message: string) => void;
}) {
  const params = useStore(store, (s) => s.params);
  const outputs = useStore(store, (s) => s.outputs);

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>Pipeline</h3>
      <p className="page-hint">
        Select a node or an edge to edit it, or use the ⚙ on a container box.
      </p>

      {/* U21 — Paste lives in the NOTHING-selected panel because that is where an
          operator is standing when they want it: they have just clicked the
          background to deselect, and ⌘V is otherwise invisible. It is always
          enabled — the refusal reason (empty clipboard, or one copied from
          another pipeline) is more useful said than hidden behind a grey
          button. */}
      <button
        type="button"
        onClick={() => {
          const outcome = store.getState().pasteClipboard(pipelineId);
          onNotice(
            outcome.ok
              ? `Pasted ${outcome.count} ${outcome.count === 1 ? 'activity' : 'activities'}.`
              : outcome.reason,
          );
        }}
      >
        Paste
      </button>

      <section className="contract-section">
        <h4>Params</h4>
        <p className="page-hint">
          The typed inputs a run supplies. Referenced as <code>{'${params.name}'}</code>, and what a
          trigger binds its values to.
        </p>
        {params.length === 0 ? <p className="page-hint">None declared.</p> : null}
        {params.map((p, i) => (
          <ParamRow key={i} store={store} index={i} param={p} />
        ))}
        <button type="button" onClick={() => store.getState().addParam()}>
          Add param
        </button>
      </section>

      <section className="contract-section">
        <h4>Outputs</h4>
        <p className="page-hint">The results this pipeline declares to a caller.</p>
        {outputs.length === 0 ? <p className="page-hint">None declared.</p> : null}
        {outputs.map((o, i) => (
          <OutputRow key={i} store={store} index={i} output={o} />
        ))}
        <button type="button" onClick={() => store.getState().addOutput()}>
          Add output
        </button>
      </section>
    </aside>
  );
}

/** What the default field should look like it wants, per declared type. */
const DEFAULT_PLACEHOLDER: Record<ParamType, string> = {
  string: 'text',
  number: '42',
  boolean: 'true or false',
  json: '{"key": "value"}',
  secret: 'credential label',
};

function ParamRow({
  store,
  index,
  param,
}: {
  store: ReturnType<typeof createCanvasStore>;
  index: number;
  param: Param;
}) {
  // The default field is the ONE control that cannot commit on every keystroke:
  // half-typed JSON is not JSON, so a commit-per-character would either reject
  // every intermediate state or store garbage. It holds a draft and commits on
  // blur; every other control writes straight through to the store.
  const stored = formatDefaultInput(param.default);
  const [draft, setDraft] = useState(stored);
  const [syncedParam, setSyncedParam] = useState(param);
  const [error, setError] = useState<string | null>(null);

  // Re-sync whenever a DIFFERENT param object arrives at this index.
  //
  // The identity check is the load-bearing choice, and it replaces a compare of
  // the formatted default STRING that was wrong in a way worth recording. The
  // rows are keyed by array index, so a removal SHIFTS the params after it into
  // a row that already holds draft text for the one that left. A string compare
  // misses that whenever the two defaults happen to format alike: with two
  // number params both defaulting to `1`, typing `9x` into row 1, blurring (the
  // commit fails, so nothing is written), then removing row 1 leaves row 1
  // rendering the SECOND param while still showing the first one's draft and
  // error — and the next successful blur writes that value onto a param the
  // operator never edited.
  //
  // The reason first given for the string compare — that a `json` default is a
  // fresh object every render, so identity would resync constantly — was simply
  // false. `map`/`filter` in the store preserve element identity for untouched
  // rows, so a new object arrives exactly when this row's param is REPLACED.
  //
  // It costs nothing in practice: every other control in this row takes focus to
  // reach, which blurs the default field and commits it first, so an
  // uncommitted draft cannot survive an edit to a sibling field anyway.
  if (syncedParam !== param) {
    setSyncedParam(param);
    setDraft(formatDefaultInput(param.default));
    setError(null);
  }

  const defect = paramDefaultDefect(param);

  function commitDefault(text: string) {
    // A blur that changed nothing must not write. Tabbing THROUGH the field
    // would otherwise mark the canvas dirty on an untouched doc — the same
    // no-op-write hazard `setNodeContainer` avoids — and, worse, would DELETE a
    // stored default of `''` or whitespace, which `coerceDefaultInput` reads as
    // "no default". An imported doc can legitimately hold one.
    if (text === stored) return;

    const parsed = coerceDefaultInput(param.type, text);
    if (!parsed.ok) {
      // Keep the operator's text on screen and say why it was not stored. The
      // alternative — silently reverting the field — loses what they typed.
      setError(parsed.error);
      return;
    }
    setError(null);
    if (parsed.has) {
      store.getState().updateParam(index, { ...param, default: parsed.value });
    } else {
      // Blank means NO default, which is the absence of the key, not
      // `default: undefined` — `resolveRunParams` reads it with `hasOwnProperty`.
      const { default: cleared, ...rest } = param;
      void cleared; // discard: lint has no ignoreRestSiblings here
      store.getState().updateParam(index, rest);
    }
  }

  return (
    <div className="contract-row">
      <label>
        Name
        <input
          aria-label={`param ${index + 1} name`}
          value={param.name}
          onChange={(e) => store.getState().updateParam(index, { ...param, name: e.target.value })}
        />
      </label>
      <label>
        Type
        <select
          aria-label={`param ${index + 1} type`}
          value={param.type}
          onChange={(e) => {
            const parsed = ParamTypeSchema.safeParse(e.target.value);
            if (!parsed.success) return;
            // The stored default is deliberately KEPT across a type change, even
            // when it no longer fits: dropping it would destroy authored data on
            // a mis-click, and the save gate below names the mismatch in the
            // author's own words. Repair beats silent deletion.
            store.getState().updateParam(index, { ...param, type: parsed.data });
          }}
        >
          {ParamTypeSchema.options.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="contract-check">
        <input
          type="checkbox"
          aria-label={`param ${index + 1} required`}
          checked={param.required}
          onChange={(e) =>
            store.getState().updateParam(index, withRequired(param, e.target.checked))
          }
        />
        Required
      </label>
      {param.required && !('default' in param) ? (
        <p className="page-hint">A run must supply this param.</p>
      ) : (
        // The field is shown whenever a default EXISTS, required or not.
        //
        // Hiding it for a required param — on the belief that a required param's
        // default is never read — was wrong, and silently so. `resolveRunParams`
        // tests `hasOwnProperty(p, 'default')` BEFORE it tests `p.required`, so a
        // required param carrying a default resolves from that default and is
        // never asked for a value. A doc minted through the API can hold one (the
        // write path accepts any `default`), and hiding the field made that value
        // invisible, un-editable, and immune to the advisory below — while the
        // panel asserted the opposite of what the engine does.
        <label>
          Default
          <input
            aria-label={`param ${index + 1} default`}
            placeholder={DEFAULT_PLACEHOLDER[param.type]}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onBlur={(e) => commitDefault(e.target.value)}
          />
          <span className="page-hint">
            {param.required
              ? 'Required, but this stored default already satisfies it — a run is never asked for a value. Blank the field to make the param truly required.'
              : 'Leave blank for no default.'}
          </span>
        </label>
      )}
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {!error && defect ? (
        // #843 — a SAVE GATE now, not the advisory this used to be. The server
        // refuses this doc (`paramDefaultDefect`, reached through
        // `validateDoc`), so the badge below already bars Save; this row-level
        // copy of the SAME sentence is where the fix is made. Word-for-word the
        // same string on purpose: an operator reading the badge can find the
        // field it is about.
        //
        // `role="alert"` like every other `.error` in this app, and the sibling
        // eleven lines up. It does mean this sentence is announced twice — the
        // doc-level badge is a `role="status"` carrying the same string — but
        // the badge only says the DOC has issues, while this one is attached to
        // the control the operator just changed. Announcing where the problem
        // is beats staying silent on the field that caused it.
        <p className="error" role="alert">
          {defect}
        </p>
      ) : null}
      <label>
        Description
        <input
          aria-label={`param ${index + 1} description`}
          value={param.description ?? ''}
          onChange={(e) => {
            const text = e.target.value;
            if (text) {
              store.getState().updateParam(index, { ...param, description: text });
            } else {
              const { description: cleared, ...rest } = param;
              void cleared;
              store.getState().updateParam(index, rest);
            }
          }}
        />
      </label>
      <button
        type="button"
        aria-label={`remove param ${index + 1}`}
        onClick={() => store.getState().removeParam(index)}
      >
        Remove
      </button>
    </div>
  );
}

function OutputRow({
  store,
  index,
  output,
}: {
  store: ReturnType<typeof createCanvasStore>;
  index: number;
  output: Output;
}) {
  return (
    <div className="contract-row">
      <label>
        Name
        <input
          aria-label={`output ${index + 1} name`}
          value={output.name}
          onChange={(e) =>
            store.getState().updateOutput(index, { ...output, name: e.target.value })
          }
        />
      </label>
      <label>
        Type
        <select
          aria-label={`output ${index + 1} type`}
          value={output.type}
          onChange={(e) => {
            // `OutputTypeSchema` excludes `secret` — a declared secret output
            // would be a leak channel. Parsing rather than casting means the
            // exclusion is enforced here, not merely reflected by the options.
            const parsed = OutputTypeSchema.safeParse(e.target.value);
            if (!parsed.success) return;
            store.getState().updateOutput(index, { ...output, type: parsed.data as OutputType });
          }}
        >
          {OutputTypeSchema.options.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </label>
      <label className="contract-check">
        <input
          type="checkbox"
          aria-label={`output ${index + 1} optional`}
          checked={output.optional ?? false}
          onChange={(e) => {
            if (e.target.checked) {
              store.getState().updateOutput(index, { ...output, optional: true });
            } else {
              // ABSENT means required in `OutputSchema`, so unchecking removes
              // the key rather than writing `optional: false`. Both read the
              // same, but only one matches what the schema documents.
              const { optional: cleared, ...rest } = output;
              void cleared;
              store.getState().updateOutput(index, rest);
            }
          }}
        />
        Optional
      </label>
      <label>
        Description
        <input
          aria-label={`output ${index + 1} description`}
          value={output.description ?? ''}
          onChange={(e) => {
            const text = e.target.value;
            if (text) {
              store.getState().updateOutput(index, { ...output, description: text });
            } else {
              const { description: cleared, ...rest } = output;
              void cleared;
              store.getState().updateOutput(index, rest);
            }
          }}
        />
      </label>
      <button
        type="button"
        aria-label={`remove output ${index + 1}`}
        onClick={() => store.getState().removeOutput(index)}
      >
        Remove
      </button>
    </div>
  );
}

/**
 * Editor for one edge's CONDITION (U6a) — the picker that replaced the pinned
 * three-value dropdown.
 *
 * It offers the four operational outcomes (`skipped` included: the engine has
 * routed it since #1 F1 and nothing ever refused it — only the canvas pin
 * stopped it being authorable) plus one option per business branch the edge's
 * SOURCE node declares. The branch list is `declaredBranchesOf`, the same SSOT
 * `validatePipelineDoc` reads, so every option offered is one a save accepts.
 *
 * Exported so the option rules can be tested without mounting the page and its
 * whole API surface — the same reason `NodePanel` is exported.
 */
export function EdgePanel({
  store,
  edge,
  nodes,
  edges,
}: {
  store: ReturnType<typeof createCanvasStore>;
  edge: Edge;
  nodes: Node[];
  edges: Edge[];
}) {
  const current = conditionOf(edge);
  const currentValue = encodeCondition(current);
  /* U19 — the source is found ONCE and asked to declare itself ONCE, and both
     lists below come off that single answer. The panel needs two shapes of it:
     the branch `<optgroup>` needs `branchConditionsOf`'s tri-state (`null` must
     hide the group, not show it empty), and `offered` needs the whole set. Asked
     separately, an `EdgePanel` render scanned `nodes` twice and re-derived the
     source's branches twice, for one selected edge. */
  const source = nodes.find((n) => n.id === edge.from);
  const branchConditions = branchConditionsOf(source);
  const branches = branchConditions?.map((c) => conditionLabel(c)) ?? null;

  /* The SAME predicate the source ports are drawn from (`declaredConditionsOf`),
     not a second list assembled the same way. The `orphaned` disabled option
     below and the canvas's orphan PORT are one fact asked from two sides; built
     separately they would eventually disagree about which conditions a node
     offers. */
  const offered = declaredConditionsOf(source, branchConditions).map((c) => encodeCondition(c));

  /**
   * Conditions ALREADY taken by another edge between the same two nodes.
   *
   * `rewireEdge` refuses such a retype (it would mint a duplicate), and a
   * refusal the operator cannot see is a control that silently does nothing:
   * they pick `failure`, React re-renders from the unchanged store, and the
   * control snaps back with no explanation. Showing the choice DISABLED says the
   * same "no" before the click, and says why.
   */
  const taken = takenConditions(edges, edge);

  /**
   * The persisted condition is one this source no longer declares.
   *
   * Reachable without leaving the canvas: `declaredBranchesOf` reads a
   * `switch`'s `config.cases` LIVE, so editing that config in the node panel can
   * un-declare a branch an existing edge still uses. (Also via an API- or
   * git-imported doc.)
   *
   * As a `<select>` this was a DISABLED option, because a select whose `value`
   * matches no option silently renders the first one — a lie about what is
   * persisted. A radio group has no such fallback: nothing is checked, which is
   * already truthful. So the orphan is now STATED instead, as a sentence naming
   * the value, and no radio is offered for it — it is a fact about the doc, not
   * a choice. `validateCanvas` is already badging the doc as unsavable.
   */
  const orphaned = !offered.includes(currentValue);
  /* Per EDGE, like the radio group's own `name`: two panels on one page must
     not point their groups at the same note. */
  const orphanNoteId = `edge-outcome-orphan-${edge.id}`;

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>{edge.back === true ? 'Back-edge' : 'Edge'}</h3>
      {edge.back === true && <BounceCapField store={store} edge={edge} />}
      {/**
       * U19 slice 2 — the outcome picker, retired as a `<select>`.
       *
       * The row's shape change is that an outcome is a PORT: you draw from the
       * one you mean, and you retype by dragging that end onto another. This is
       * the same set, in the same hues, rather than a generic dropdown over
       * condition strings — it mirrors the ports rather than competing with them,
       * and both come off `declaredConditionsOf`.
       *
       * It is not kept purely for symmetry. React Flow's handles are
       * `pointer-events`-driven with no `tabIndex`, so the canvas gesture has no
       * keyboard equivalent; deleting this control outright would leave NO way to
       * retype an edge without a pointer. A radio group is the keyboard-native
       * shape for "one of these" — arrow keys move within it, and the group is
       * one tab stop.
       */}
      {/* The orphan note is tied to the GROUP, not left as a loose sibling: with
          no radio checked, a screen-reader user tabbing in lands on an unchecked
          `success` and would otherwise get no hint that the edge holds a value
          this source no longer offers. The old `<select>` announced it for free,
          because it WAS the control's current value. */}
      <fieldset className="edge-outcomes" aria-describedby={orphaned ? orphanNoteId : undefined}>
        <legend>Fires on</legend>
        {orphaned && (
          <p className="edge-outcome-orphan" id={orphanNoteId}>
            {edgeLabel(edge)} — not offered by this source
          </p>
        )}
        {OPERATIONAL_CONDITIONS.map((on) => (
          <ConditionChoice
            key={on}
            store={store}
            edge={edge}
            condition={{ on }}
            label={on}
            taken={taken}
            checked={encodeCondition({ on }) === currentValue}
          />
        ))}
        {branches?.map((branch) => (
          <ConditionChoice
            key={`branch:${branch}`}
            store={store}
            edge={edge}
            condition={{ on: 'branch', branch }}
            label={branch}
            taken={taken}
            checked={encodeCondition({ on: 'branch', branch }) === currentValue}
          />
        ))}
      </fieldset>
      <p className="edge-rewire-hint">
        Drag either end of this edge on the canvas to move it to another activity.
      </p>
      <button type="button" onClick={() => store.getState().deleteEdge(edge.id)}>
        Delete edge
      </button>
    </aside>
  );
}

/**
 * U6e — a back-edge's BOUNCE CAP.
 *
 * The one number that decides whether an authored loop terminates, so it is
 * first in the panel rather than tucked under the condition picker.
 *
 * Holds a DRAFT and commits on blur, the `ParamRow` idiom and for the same
 * reason: a numeric field cannot commit per keystroke, because clearing it to
 * retype gives `''`, which `Number('')` reads as `0` — a legal, silently
 * different cap. Committing that would rewrite the operator's loop mid-edit.
 * A refused value KEEPS the text on screen and says why, rather than reverting
 * to the stored value and losing what they typed.
 */
function BounceCapField({
  store,
  edge,
}: {
  store: ReturnType<typeof createCanvasStore>;
  edge: Edge;
}) {
  /* An edge with NO cap renders EMPTY, not `DEFAULT_MAX_BOUNCES`.
     Showing `10` for an absent value was wrong twice over. It stated a cap the
     doc does not hold — a third answer for one undefined value, against the
     canvas label's `×?` and the aria-label's "no bounce cap declared" — and,
     because `commit` early-returns on `text === stored`, it made the field a
     DEAD END: the operator sees `10`, types `10`, and nothing is written, so
     the doc stays unsavable ("must declare maxBounces") and the only way out is
     to type some other number and then type 10 back. Reachable for exactly the
     imported / pre-#444 doc this feature keeps invoking. Empty is the honest
     rendering, and the blank branch of `commit` already says a cap is required. */
  const stored = edge.maxBounces === undefined ? '' : String(edge.maxBounces);
  const [draft, setDraft] = useState(stored);
  const [error, setError] = useState<string | null>(null);
  /* U17 — re-seed when the STORED cap changes underneath the draft. The panel is
     keyed by `edge.id`, so switching edges remounts; an undo changes the cap of
     the SAME edge, which remounts nothing, and without this the field would go
     on showing the value the operator had just undone. Render-phase derived
     state, not an effect — `NodePanel`'s precedent, which this repo's React 19
     lint permits where `useEffect` + setState would not be. */
  const [syncedCap, setSyncedCap] = useState(stored);
  if (syncedCap !== stored) {
    setSyncedCap(stored);
    setDraft(stored);
    setError(null);
  }

  function commit(text: string) {
    // A blur that changed nothing must not write — tabbing THROUGH the field
    // would otherwise mark the canvas dirty on an untouched doc.
    //
    // It must still CLEAR a standing error, though, and that ordering is the
    // whole point: type `1.5`, blur (error shown), retype the original value,
    // blur — and an early return that skipped this would leave the banner
    // asserting "not a whole number" over a field showing a perfectly valid,
    // unchanged cap. The write is what a no-op blur must skip, not the
    // acknowledgement that the value on screen is now fine.
    if (text === stored) {
      setError(null);
      return;
    }
    const n = Number(text.trim());
    // `Number('')` is 0 and `Number('  ')` is 0, so an EMPTY field has to be
    // caught before the numeric test or clearing the box would silently store
    // a cap of zero.
    if (text.trim() === '' || !isMaxBounces(n)) {
      setError('A bounce cap must be a whole number, 0 or more');
      return;
    }
    setError(null);
    store.getState().updateEdgeBounces(edge.id, n);
  }

  return (
    <>
      <label>
        Bounce cap
        <input
          type="number"
          min={0}
          step={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={(e) => commit(e.target.value)}
        />
      </label>
      {error !== null ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <p className="page-hint">
          How many times this loop may repeat before the run fails as <code>capped</code>. Zero
          never bounces.
        </p>
      )}
    </>
  );
}

/** One condition option, disabled (with the reason) when another edge holds it. */
function ConditionChoice({
  store,
  edge,
  condition,
  label,
  taken,
  checked,
}: {
  store: ReturnType<typeof createCanvasStore>;
  edge: Edge;
  condition: EdgeCondition;
  label: string;
  taken: ReadonlySet<string>;
  checked: boolean;
}) {
  const value = encodeCondition(condition);
  const isTaken = taken.has(value);
  return (
    <label /* The class suffix IS the outcome — the same `${on}` shape
         `edgeVariantClass` and `SourcePorts` use, and `palette.test.ts`
         now pins all three to one hue table. */
      className={`edge-outcome edge-outcome--${condition.on}`}
    >
      <input
        type="radio"
        /* One group per EDGE, not per panel: the name has to be unique on the
           page or a second panel's radios would join this group. */
        name={`edge-outcome-${edge.id}`}
        value={value}
        checked={checked}
        disabled={isTaken}
        onChange={() => {
          /* The endpoints do not move — this is the retype half of a rewire.
             Reading them off the edge (rather than passing them in) keeps the one
             seam that writes an edge's shape as the only writer. */
          store.getState().rewireEdge(edge.id, { from: edge.from, to: edge.to, condition });
        }}
      />
      <span className="edge-outcome-swatch" aria-hidden="true" />
      {isTaken ? `${label} — already used by another edge` : label}
    </label>
  );
}

/**
 * U6d — the selected activity's container membership, and the one gesture that
 * CREATES a container.
 *
 * Membership lives on the container (`children: string[]`), but disjointness
 * makes it a per-NODE fact, which is why one `<select>` on the node is the whole
 * control: picking a container joins it, picking `— none —` leaves, and "New
 * container" is the same act against a container that does not exist yet. There
 * is no multi-select to group N nodes at once (U21), and no drop target to drag
 * one in (U23) — a derived box only HINTS at enclosure until React Flow
 * `parentId` subflows make it authoritative.
 *
 * A container is created around the SELECTED node rather than empty, which is
 * what keeps a `loop`/`foreach` past its one-child rule the moment it exists.
 */
function ContainerSection({
  store,
  nodeId,
}: {
  store: ReturnType<typeof createCanvasStore>;
  nodeId: string;
}) {
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const containers = useStore(store, (s) => s.containers);
  // U16 — the WORKING params, not `loaded`'s. The container-edit consequence is
  // computed against the doc as it stands on screen, so reading the opened
  // version here would judge a container against a param contract the operator
  // has already changed.
  const params = useStore(store, (s) => s.params);

  const [kind, setKind] = useState<ContainerKind>('stage');
  const [exitWhen, setExitWhen] = useState('');
  const [items, setItems] = useState('');
  const [maxRounds, setMaxRounds] = useState('');
  const [error, setError] = useState<string | null>(null);

  const labels = containerLabels(containers);
  const ownerId = containers.find((c) => c.children.includes(nodeId))?.id ?? '';

  /**
   * Apply an edit once the operator has seen what it costs.
   *
   * ONE evaluation, at the moment of the click, against live state — the
   * consequence is never stored, so it cannot go stale the way a frozen
   * `role="alert"` does (`FlowCanvas` documents that failure). `window.confirm`
   * is the canvas's existing confirmation route (`confirmDeleteContainer`,
   * and every list page).
   */
  function withConfirmation(
    nextContainers: Container[],
    recovery: string,
    apply: () => void,
  ): boolean {
    // The gate itself is `confirmContainerEdit`, hoisted into `containerRules`
    // when U23's config panel became its second call site. This wrapper is only
    // the "and then apply it" half, which the two callers below share.
    if (!confirmContainerEdit({ nodes, edges, containers, params }, nextContainers, recovery)) {
      return false;
    }
    apply();
    return true;
  }

  function changeOwner(value: string) {
    const target = value === '' ? null : value;
    setError(null);
    withConfirmation(
      assignContainerChild(containers, nodeId, target),
      'You can undo it by setting the activity back to — none —.',
      () => store.getState().setNodeContainer(nodeId, target),
    );
  }

  function create() {
    const trimmedRounds = maxRounds.trim();
    const built = buildContainer(kind, nodeId, {
      ...(kind === 'loop' ? { exitWhen: exitWhen.trim() } : {}),
      ...(kind === 'foreach' ? { items: items.trim() } : {}),
      // An empty numeric input is ABSENT, not zero — `Number('')` is 0, which
      // `ContainerSchema` rejects as non-positive and which no canvas check
      // would have caught before the server's zod parse 400'd the save.
      ...(kind === 'loop' && trimmedRounds !== '' ? { maxRounds: Number(trimmedRounds) } : {}),
    });
    if ('error' in built) {
      setError(built.error);
      return;
    }
    setError(null);
    const applied = withConfirmation(
      containersWithNew(containers, built.container),
      // NOT "set it back to — none —": emptying a freshly-made loop leaves a
      // worse doc than the one being escaped (see `consequenceMessage`).
      'You can undo it with the ✕ on the container box.',
      () => store.getState().createContainer(built.container),
    );
    if (applied) {
      setExitWhen('');
      setItems('');
      setMaxRounds('');
    }
  }

  // A loop with no exit condition and a foreach with no items are docs
  // `validateDoc` refuses outright, so the form cannot offer to author one.
  const canCreate =
    kind === 'loop' ? exitWhen.trim() !== '' : kind === 'foreach' ? items.trim() !== '' : true;

  // A fragment, not a wrapper: `.property-panel` is already the flex column
  // these controls want, so a `<div>` here would need its own rule saying the
  // same thing — two declarations that have to agree about one rhythm.
  return (
    <>
      <label>
        Container
        <select
          value={ownerId}
          aria-label="Container membership"
          onChange={(e) => changeOwner(e.target.value)}
        >
          <option value="">— none —</option>
          {containers.map((c) => (
            <option key={c.id} value={c.id}>
              {labels.get(c.id)}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="container-create">
        <legend>New container</legend>
        <label>
          Kind
          <select
            value={kind}
            aria-label="New container kind"
            onChange={(e) => {
              const parsed = ContainerKindSchema.safeParse(e.target.value);
              if (parsed.success) setKind(parsed.data);
            }}
          >
            {ContainerKindSchema.options.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {kind === 'loop' && (
          <>
            <label>
              Exit when
              <input
                value={exitWhen}
                spellCheck={false}
                placeholder="${equals(nodes.x.output.status, 200)}"
                onChange={(e) => setExitWhen(e.target.value)}
              />
            </label>
            <label>
              Max rounds (optional)
              <input
                value={maxRounds}
                inputMode="numeric"
                onChange={(e) => setMaxRounds(e.target.value)}
              />
            </label>
          </>
        )}
        {kind === 'foreach' && (
          <label>
            Items
            <input
              value={items}
              spellCheck={false}
              placeholder="${run.params.rows}"
              onChange={(e) => setItems(e.target.value)}
            />
          </label>
        )}
        <button type="button" disabled={!canCreate} onClick={create}>
          Create container
        </button>
      </fieldset>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The U8a flyout's context for one node: which references this node can use, how
 * each is NAMED, and — per field — how choosing one is applied and which of them
 * that field would actually accept.
 *
 * Naming lives on this side of the boundary deliberately. `availableRefs`
 * returns identity only — a node's operator-facing name comes from
 * `activityLabels`' within-kind ordinals (#878, the same text its box carries)
 * and a container's from `containerLabels`, neither reachable from `shared`.
 * Computing a label there would be a second answer to "what is this node
 * called", free to disagree with the canvas.
 *
 * The per-FIELD half is why `resolve` exists rather than a plain list.
 * `availableRefs` answers at NODE granularity — is this reference resolvable and
 * is its producer guaranteed to have run — which is everything the graph decides
 * and nothing the field decides. The save gate ALSO type-checks some fields: a
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
function useExpressionPicker(
  nodes: Node[],
  edges: Edge[],
  containers: Container[],
  params: Param[],
  nodeId: string,
  /** The panel's ONE answer to "what is each activity called" — see `nodeName`. */
  nodeNames: ReadonlyMap<string, string>,
): FieldPicker {
  return useMemo(() => {
    const doc = { params, nodes, edges, containers };
    const suggestions = availableRefs(doc, { kind: 'node', nodeId });
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

    const issuesWith = (fieldName: string, value: string) =>
      validateCanvas(
        nodes.map((n) =>
          n.id === nodeId ? { ...n, config: { ...n.config, [fieldName]: value } } : n,
        ),
        edges,
        containers,
        params,
      );

    return {
      describe: (s: RefSuggestion) => {
        if (s.kind === 'nodeOutput') return `${producerName(s.producerId ?? '')} → ${s.name}`;
        if (s.kind === 'nodeStatus') return `${producerName(s.producerId ?? '')} → status`;
        if (s.kind === 'item') return 'item — the element this round is processing';
        return s.name ?? s.ref;
      },
      // Run only when a flyout OPENS, never per render: this validates the whole
      // doc once for the mode and once more per candidate.
      resolve: (fieldName: string) => {
        const mode = insertModeFor((value) => issuesWith(fieldName, value));
        // In INSERT mode the field becomes an interpolated template, which always
        // resolves to a string whatever is spliced in — so no candidate can be
        // type-refused, and the node-level answer is already exact. Only REPLACE
        // mode makes the field BECOME the reference, which is where a field's own
        // type check can reject it.
        if (mode === 'insert') return { mode, suggestions };
        const baseline = validateCanvas(nodes, edges, containers, params);
        return {
          mode,
          suggestions: suggestions.filter((s) => {
            const after = issuesWith(fieldName, s.insert);
            return !after.some((issue) => !baseline.includes(issue));
          }),
        };
      },
    };
  }, [nodes, edges, containers, params, nodeId, nodeNames]);
}

/**
 * Editor for one activity node.
 *
 * Settings are authored through a FORM derived from the activity's own
 * `configSchema` (U7 — `configForm.ts` owns the derivation and the apply
 * semantics). The whole-config JSON editor it replaced remains reachable two
 * ways: as an opt-in toggle, and as the automatic surface when a value already
 * saved cannot round-trip through its control. Either path validates against
 * `configSchema` before committing, so an invalid blob never reaches the store —
 * a UX pre-check only; `validateDoc` on the server remains the gate.
 *
 * The internal `outputs` contract — seeded by `lowerPipelineNodes` on creation
 * AND on load since #526 — is not surfaced by either editor, and is preserved
 * across an apply by the same rule that preserves every other key no derived
 * field owns.
 *
 * The connection dropdown is filtered to the kinds this activity accepts.
 * Container membership (U6d) is `ContainerSection` above.
 */
export function NodePanel({
  store,
  connections,
  nodeId,
  nodeType,
  config,
  connectionId,
  call,
  datasets,
}: {
  store: ReturnType<typeof createCanvasStore>;
  connections: ConnectionPublic[];
  datasets: Dataset[];
  nodeId: string;
  nodeType: string;
  config: Record<string, unknown>;
  connectionId: string | undefined;
  /** #425 — the structural call blob, passed through to `CallPanel` for a call node. */
  call: CallConfig | undefined;
}) {
  const entry = getActivity(nodeType);
  // Edit config WITHOUT the internal `outputs` contract.
  const { outputs, ...editable } = config;

  // U8a — the whole doc, read reactively, because which references are legal
  // here is a property of the GRAPH: adding an upstream edge changes the answer
  // while this panel is open.
  const docNodes = useStore(store, (s) => s.nodes);
  const docEdges = useStore(store, (s) => s.edges);
  const docContainers = useStore(store, (s) => s.containers);
  const docParams = useStore(store, (s) => s.params);
  /**
   * Every activity's identifying name (#878), built ONCE for this panel and read
   * by both surfaces that need one — the heading below and the expression
   * picker's producer list. Two constructions would be two answers that merely
   * happen to agree.
   */
  const nodeNames = useMemo(() => activityLabels(docNodes), [docNodes]);
  const picker = useExpressionPicker(
    docNodes,
    docEdges,
    docContainers,
    docParams,
    nodeId,
    nodeNames,
  );

  /**
   * What this panel is a panel FOR.
   *
   * It used to read `entry?.title` — a fourth hand-rolled copy of
   * `activityLabel`, and one that names the activity's KIND. With two
   * `http_request` nodes on the canvas the box now reads "HTTP Request 2" while
   * its own panel said "HTTP Request", which is the disagreement `activityLabel`'s
   * docblock exists to prevent. Falls back to the catalog title, then the raw
   * type, for a node the doc no longer holds.
   */
  const nodeName = nodeNames.get(nodeId) ?? entry?.title ?? nodeType;

  // U7 — the per-activity form, derived from the activity's own `configSchema`
  // (see `configForm.ts` for why the schema, not hand-written metadata, is the
  // source). `null` when the schema is not object-rooted.
  const fields = useMemo(() => (entry ? deriveConfigFields(entry.configSchema) : null), [entry]);

  // Recomputed every render from the CURRENT config, deliberately: a value whose
  // type disagrees with its control cannot round-trip, so the node falls back to
  // the JSON editor rather than corrupting the doc on an apply the author thinks
  // touched one other field — but the moment they REPAIR it there, the form must
  // become available and this advisory must stop naming a field that is now fine.
  // Memoising it on mount left both stuck saying otherwise.
  const unrenderable = fields ? unrepresentableFields(fields, editable) : [];
  const formAvailable = fields !== null && unrenderable.length === 0;

  const [text, setText] = useState(() => JSON.stringify(editable, null, 2));
  const [inputs, setInputs] = useState(() => seedFieldInputs(fields, editable));
  const [error, setError] = useState<string | null>(null);
  // The author's PREFERENCE, not the mode: the mode is this OR forced. Kept
  // apart so that repairing an unrenderable value hands the form back, instead of
  // leaving the author in an editor they never chose.
  const [jsonPreferred, setJsonPreferred] = useState(false);
  const jsonMode = jsonPreferred || !formAvailable;

  // Re-seed both editors whenever a DIFFERENT config object arrives.
  //
  // The two editors hold independent drafts of the same doc, so without this they
  // desync the moment one of them commits: applying in JSON mode and then
  // switching back to the form would apply the form's MOUNT-TIME values over the
  // author's JSON edit — silently reverting work with no message. Re-seeding on
  // identity is `ParamRow`'s precedent above, and safe for the same reason: the
  // store's `map` preserves element identity for untouched nodes, so a new
  // `config` object arrives exactly when this node's config was replaced.
  //
  // A render-phase set-on-prop-change, not an effect — React's derived-state
  // pattern, which this repo's React 19 lint permits where `useEffect` + setState
  // would not be.
  const [syncedConfig, setSyncedConfig] = useState(config);
  if (syncedConfig !== config) {
    setSyncedConfig(config);
    setText(JSON.stringify(editable, null, 2));
    setInputs(seedFieldInputs(fields, editable));
    setError(null);
  }

  // Kinds this activity accepts, PLUS whatever is currently bound — so a node
  // bound to an off-kind connection (e.g. loaded from an older doc) still shows
  // its real binding instead of silently reading as "— none —". The rule now
  // lives in `bindingPickers.ts`, because #1139 needs it four more times.
  const eligible = entry
    ? eligibleForBinding(connections, (c) => entry.connectionKinds.includes(c.kind), connectionId)
    : [...connections];

  // #996 M5 slice 4c (#1139) — a PAIRED activity (`copy`) binds two connections
  // and two datasets instead of one connection. Read from the CATALOG, never
  // inferred from the node: that is the executor's own rule
  // (`executor.ts` — "a node's shape is operator input"), and a panel that
  // inferred pairing from a stray `connectionIds` would offer a binding the
  // dispatch would then ignore.
  const sinkConnectionKinds = entry?.sinkConnectionKinds;
  const datasetKinds = entry?.datasetKinds;
  const paired = sinkConnectionKinds !== undefined;
  const pending = useStore(store, (s) => s.pendingBindings[nodeId]);
  const thisNode = docNodes.find((n) => n.id === nodeId);
  // The node's COMMITTED pair wins; `pendingBindings` only ever holds the
  // half-picked remainder (see `canvasStore.pendingBindings`).
  const boundConnections = thisNode?.connectionIds ?? pending?.connections;
  const boundDatasets = thisNode?.datasetIds ?? pending?.datasets;
  // A pair the author has STARTED but not finished. It is not on the node, so it
  // is not saved — and saying so is the point: without this the first pick would
  // survive on screen, vanish on reload, and look like the canvas lost it.
  const halfBound =
    (paired && thisNode?.connectionIds === undefined && boundConnections !== undefined) ||
    (datasetKinds !== undefined &&
      thisNode?.datasetIds === undefined &&
      boundDatasets !== undefined);

  /**
   * Validate a candidate settings blob against the activity's own schema.
   *
   * A UX PRE-CHECK, never the gate. Several activities' `configSchema` is palette
   * metadata whose real constraints live server-side in `validateDoc`, so a clean
   * result here does not mean the version will save — it only spares the author a
   * round-trip to a 400 they were going to get anyway.
   */
  function schemaIssues(candidate: unknown): string | null {
    if (!entry) return null;
    const check = entry.configSchema.safeParse(candidate);
    if (check.success) return null;
    return formatZodIssues(check.error.issues);
  }

  function applyJson() {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setError('Config is not valid JSON.');
      return;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      setError('Config must be a JSON object.');
      return;
    }
    const issues = schemaIssues(parsed);
    if (issues) {
      setError(issues);
      return;
    }
    setError(null);
    // Preserve the seeded `outputs` contract, which is edited elsewhere.
    store.getState().updateNodeConfig(nodeId, { ...(parsed as Record<string, unknown>), outputs });
  }

  function applyForm() {
    if (!fields) return;
    // The FULL config is the original, `outputs` included — no key is re-attached
    // afterwards. `assembleConfig` preserves everything no derived field owns, so
    // the F13 outputs contract is carried by that ONE rule rather than by a
    // special case beside it. Re-attaching it here would work, and would also
    // MASK the general rule: a regression that dropped every other undeclared key
    // would still leave `outputs` intact and look correct.
    const assembled = assembleConfig(config, fields, inputs);
    if (!assembled.ok) {
      setError(assembled.message);
      return;
    }
    const issues = schemaIssues(assembled.owned);
    if (issues) {
      setError(issues);
      return;
    }
    setError(null);
    store.getState().updateNodeConfig(nodeId, assembled.config);
  }

  // A call node stores its settings in `node.call`, not `node.config`, so this
  // generic `node.config` editor cannot author it — validating the edited blob
  // against `entry.configSchema` (`CallConfigSchema`) would always fail
  // (`pipelineVersionId` lives in `node.call`, unseen here). #425 replaced the
  // read-only stub that used to stand here with `CallPanel`, the dedicated editor
  // for that blob. (The hooks above run unconditionally — this early return only
  // skips the editor JSX.)
  //
  // #953 — routed on `authorsCallBlob`, not on the type alone. `Node.call` is an
  // optional discriminant valid on a node of any type, so a doc carrying the
  // literal `type: 'call_pipeline'` (reachable by import or an API seed, and used
  // throughout the engine test suite) used to land on the generic form instead —
  // and since that type is not catalogued, the form derived no fields and the
  // call blob was neither visible nor editable. `authorsCallBlob` is the shared
  // reading of what actually dispatches the node, so this cannot drift from the
  // reducer the way a local type check did.
  if (authorsCallBlob({ type: nodeType, call })) {
    return (
      <aside className="property-panel" aria-label="Properties">
        <h3>{nodeName}</h3>
        <CallPanel store={store} nodeId={nodeId} call={call} />
        {/* Membership is orthogonal to the call blob, so this early return must
            not swallow it: a container is exactly the construct that puts a call
            node in one, and this is the only panel such a node ever gets. */}
        <ContainerSection store={store} nodeId={nodeId} />
      </aside>
    );
  }

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>{nodeName}</h3>
      {entry && !paired && entry.connectionKinds.length > 0 && (
        <label>
          Connection
          <select
            value={connectionId ?? ''}
            onChange={(e) =>
              store.getState().setNodeConnection(nodeId, e.target.value || undefined)
            }
          >
            <option value="">— none —</option>
            {eligible.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.kind})
              </option>
            ))}
          </select>
        </label>
      )}

      {/* #1139 — a PAIRED activity binds a source and a sink store. The singular
          picker above is hidden rather than shown alongside, because
          `validateDoc` refuses `connectionId` and `connectionIds` together. */}
      {entry && paired && sinkConnectionKinds !== undefined && (
        <>
          <BindingSelect
            label="Source connection"
            value={boundConnections?.source}
            options={eligibleForBinding(
              connections,
              (c) => entry.connectionKinds.includes(c.kind),
              boundConnections?.source,
            ).map((c) => ({ id: c.id, label: `${c.name} (${c.kind})` }))}
            onPick={(id) => store.getState().setNodeBindingEnd(nodeId, 'connections', 'source', id)}
          />
          <BindingSelect
            label="Sink connection"
            value={boundConnections?.sink}
            options={eligibleForBinding(
              connections,
              (c) => sinkConnectionKinds.includes(c.kind),
              boundConnections?.sink,
            ).map((c) => ({ id: c.id, label: `${c.name} (${c.kind})` }))}
            onPick={(id) => store.getState().setNodeBindingEnd(nodeId, 'connections', 'sink', id)}
          />
        </>
      )}

      {/* #1139 — the dataset ADDRESSES within those stores. Narrowed by the
          connection bound to the SAME end as well as by kind: slice 4a refuses a
          node/dataset connection disagreement at dispatch
          (`DATASET_CONNECTION_MISMATCH`), so an unnarrowed list would offer
          bindings that cannot run. `sink` is optional — M12's `lookup` reads a
          source only. */}
      {datasetKinds !== undefined && (
        <>
          <BindingSelect
            label="Source dataset"
            value={boundDatasets?.source}
            options={eligibleForBinding(
              datasets,
              (d) =>
                datasetKinds.source.includes(d.kind) &&
                (boundConnections?.source === undefined ||
                  d.connectionId === boundConnections.source),
              boundDatasets?.source,
            ).map((d) => ({ id: d.id, label: `${d.name} (${d.kind})` }))}
            onPick={(id) => store.getState().setNodeBindingEnd(nodeId, 'datasets', 'source', id)}
          />
          {datasetKinds.sink !== undefined && (
            <BindingSelect
              label="Sink dataset"
              value={boundDatasets?.sink}
              options={eligibleForBinding(
                datasets,
                (d) =>
                  (datasetKinds.sink ?? []).includes(d.kind) &&
                  (boundConnections?.sink === undefined ||
                    d.connectionId === boundConnections.sink),
                boundDatasets?.sink,
              ).map((d) => ({ id: d.id, label: `${d.name} (${d.kind})` }))}
              onPick={(id) => store.getState().setNodeBindingEnd(nodeId, 'datasets', 'sink', id)}
            />
          )}
        </>
      )}

      {halfBound && (
        <p className="contract-advisory" role="status">
          Both ends of a binding are needed — a half-bound pair is not saved.
        </p>
      )}

      {/* A `copy` node that arrived by import or an API seed can carry a stray
          singular `connectionId`. The paired branch hides the picker that would
          clear it, and `validateDoc` refuses the two together — so without this
          the doc would be unsaveable with no affordance to repair it. */}
      {paired && connectionId !== undefined && (
        <p className="contract-advisory">
          This node also carries a single-connection binding, which a paired activity may not have.{' '}
          <button
            type="button"
            onClick={() => store.getState().setNodeConnection(nodeId, undefined)}
          >
            Clear it
          </button>
        </p>
      )}
      <ContainerSection store={store} nodeId={nodeId} />

      {formAvailable && (
        <label className="contract-check">
          <input
            type="checkbox"
            checked={jsonPreferred}
            onChange={(e) => setJsonPreferred(e.target.checked)}
          />
          Edit as JSON
        </label>
      )}

      {/* Not a preference the author can dismiss: the form genuinely cannot
          round-trip what is saved, so saying which fields is the only way they
          can repair it in the JSON editor they have been given instead. */}
      {fields !== null && unrenderable.length > 0 && (
        <p className="contract-advisory">
          {`Saved settings this form cannot show (${unrenderable.join(', ')}) — editing as JSON.`}
        </p>
      )}

      {jsonMode || fields === null ? (
        <label>
          Config (JSON)
          <textarea
            value={text}
            rows={10}
            spellCheck={false}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      ) : (
        <div className="contract-section">
          {fields.length === 0 && <p className="page-hint">This activity has no settings.</p>}
          {fields.map((field) => (
            <ConfigFieldControl
              key={field.name}
              field={field}
              value={inputs[field.name] ?? (field.kind === 'boolean' ? false : '')}
              onChange={(next) => setInputs((prev) => ({ ...prev, [field.name]: next }))}
              picker={picker}
            />
          ))}
        </div>
      )}

      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <div className="form-actions">
        <button type="button" onClick={jsonMode || fields === null ? applyJson : applyForm}>
          Apply config
        </button>
        {/* U21 — duplicate. Between Apply and Delete because that is the order
            of consequence, and because it acts on the node as SAVED into the
            store, not on the unapplied form state: the copy carries the config
            `Apply config` last wrote, which is why it sits after it. Ungated for
            the same reason `Delete node` is — what #907 gated is the SAVE of an
            archived pipeline, which the server REFUSES (the button itself stays
            live); editing was left alone, and a copy that cannot yet be saved is
            still an edit the operator can undo. */}
        <button type="button" onClick={() => store.getState().duplicateNode(nodeId)}>
          Duplicate node
        </button>
        <button type="button" onClick={() => store.getState().deleteNode(nodeId)}>
          Delete node
        </button>
      </div>
    </aside>
  );
}
