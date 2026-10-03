import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useStore } from 'zustand';
import { ReactFlowProvider } from '@xyflow/react';
import {
  Menu,
  MenuDivider,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import {
  ArrowRedoRegular,
  ArrowUndoRegular,
  ChevronDownRegular,
  MoreHorizontalRegular,
} from '@fluentui/react-icons';
import { useNavigate } from 'react-router';
import { ZodError } from 'zod';
import { triggersPath } from '../triggers/triggersPath';
import { serverOnlyIssues, validationAnnouncement } from './validateDraft';
import { useElementSize } from './useElementSize';
import {
  CONTAINER_KIND_LABELS,
  ContainerKindSchema,
  ContainerSchema,
  fieldLabelThrough,
  autoMapMapping,
  checkSinkCoverage,
  checkSourceDrift,
  projectMappingRows,
  splitUnwritten,
  formatZodIssues,
  getActivity,
  authorsCallBlob,
  type ActivePipelineVersion,
  type CallConfig,
  type Container,
  type ConnectionPublic,
  type ContainerKind,
  type Dataset,
  type Edge,
  type Node,
  type Pipeline,
  type PipelineVersion,
  type WorkspaceGitStatus,
} from '@autonomy-studio/shared';
import {
  clipboardCommandFor,
  arrangeDisabledReason,
  historyCommandFor,
  isDeleteKeystroke,
  isModalDialogOpen,
  redoDisabledReason,
  undoDisabledReason,
} from './undoRedo';
import { arrangeMoves, type MeasuredSizes } from './autoLayout';
import { messageOf } from '../../api/client';
import {
  archiveConfirmMessage,
  archivePipeline,
  createPipelineVersion,
  latestVersion,
  listPipelineVersions,
  publishPipeline,
  restorePipeline,
  TRIGGERS_STAY_DISABLED_NOTE,
  validatePipelineDraft,
} from '../../api/pipelines';
import { downloadPipelineExport } from '../../api/pipelineExport';
import { listConnections } from '../../api/connections';
import { listDatasets } from '../../api/datasets';
import { listGlobalParams, toGlobalReads } from '../../api/globalParams';
import { useGuardedLoad } from '../../hooks/useGuardedLoad';
import { eligibleForBinding } from './bindingPickers';
import { ActivityToolbox } from './ActivityToolbox';
import {
  assignContainerChild,
  buildContainer,
  containersWithNew,
  createCanvasStore,
  singleSelection,
  type PasteOutcome,
  type Selection,
  type CanvasState,
} from './canvasStore';
import { useExpressionPicker } from './useExpressionPicker';
import { ConfigEditor } from './ConfigEditor';
import { useConfigEditor } from './useConfigEditor';
import { autoMappableField, describeSkips } from './copyMappingAids';
import { CallPanel } from './CallPanel';
import type { FieldChoices, FieldPicker } from './ConfigFieldControl';
import { variableWriteChoices } from './variableChoices';
import { ParamOverridesEditor } from './ParamOverridesEditor';
import { DraftNumberField, type DraftNumberParse } from './DraftNumberField';
import { connectionOptionLabel, datasetOptionLabel } from '../../lib/resourceOptionLabel';
import { parseWholeNumber } from '../triggers/formFields';
import {
  connectionOverrideResource,
  datasetOverrideResource,
  type OverrideResource,
} from './paramOverrides';
import { ContainerPanel } from './ContainerPanel';
import { activityLabels } from './activityLabel';
import {
  deriveConfigFields,
  emptyControlValue,
  formatFieldValue,
  parseFieldInput,
  readConfigDraft,
  schemaPrecheckCandidate,
  seedFieldInputs,
  type ConfigDraft,
  type ConfigField,
} from './configForm';
import {
  CONTAINER_EDIT_TONE,
  containerEditQuestion,
  containerLabels,
  withArticle,
  issuesBySubject,
  readableIssue,
  sameAttribution,
} from './containerRules';
import { nameIssues, propertyIssues } from './paramRules';
import { PipelineGeneral } from './PipelineGeneral';
import { ContractSection, OutputRow, ParamRow, VariableRow } from './ContractEditor';
import {
  isOwnPolicyIssue,
  policyIssues,
  saveDisabledReason,
  toVersionBody,
  validateCanvas,
} from './canvasDoc';
import { SubjectIssues } from './SubjectIssues';
import { SubjectIssuesContext, useSubjectIssues } from './issueContext';
import { PolicyEditor } from './PolicyEditor';
import { PanelTabs } from './PanelTabs';
import { branchConditionsOf, conditionLabel, declaredConditionsOf } from './ports';
import {
  completionSibling,
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
import { PipelineTriggersColumn } from './PipelineTriggersColumn';
import { newTriggerBinding, newTriggerReason, newTriggerTitle } from './triggerColumnRules';
import {
  activeVersionLabel,
  describePublishRefusal,
  describeRestoreConflict,
  describeSaveConflict,
  docUnchanged,
  type DocSnapshot,
  historyEntries,
  isPublishRefused,
  isStaleWrite,
  publishConfirmMessage,
  publishOutcomeMessage,
  publishRefusal,
  restoreBodyFrom,
  restoreConfirmMessage,
  restoreRefusal,
  mergeVersionLists,
  saveAnywayLabel,
  type ActiveVersionState,
} from './versionHistory';
import { useTransientNotice } from './useTransientNotice';
import { EditorStatusStrip } from './EditorStatusStrip';
import { DOCK_HEIGHT_VAR, DOCK_WIDTH_VAR, DockSplitter } from './DockSplitter';
import { TOOLBOX_WIDTH_VAR, ToolboxSplitter } from './ToolboxSplitter';
import { PROBLEMS_WIDTH_VAR, ProblemsSplitter } from './ProblemsSplitter';
import { TOOLBOX_RAIL_WIDTH, uiStore, type NodeTab, type PipelineTab } from '../../stores/uiStore';
import { DebugRunPanel, RunNowPanel } from './RunNowPanel';
import { EditorRunDrawer, EditorRunProvider } from './editorRun';
import { EditorRunContext, type EditorRun } from './editorRunContext';
import { runDetailPath } from '../runs/runPath';
import {
  DEBUG_TITLE,
  VALIDATE_TITLE,
  debugDisabledReason,
  validateDisabledReason,
  debugStartedText,
  runDisabledReason,
  runTitle,
} from './runNowRules';
import { useShellUnsaved } from '../../shell/shellLabel';
import { useUnsavedChangesGuard } from '../../lib/form/useUnsavedChangesGuard';
import { leavesPath } from '../../lib/form/leavesPath';
import { UnsavedChangesPrompt } from '../../lib/form/UnsavedChangesPrompt';
import { FormSection } from '../../lib/form/FormSection';
import { FORM_SECTION_HINTS } from '../../lib/form/sectionHints';
import { readPublishState } from './publishState';
import { EditorStateBadge } from './EditorStateBadge';
import { canvasVersion, editingState, gitState, liveState, partText } from './editorState';
import { LabelledControl } from '../../lib/LabelledControl';
import { useConfirm } from '../../lib/confirm/useConfirm';

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

/**
 * U21 — the notice a paste leaves, for ⌘V and the Paste button alike. A paste
 * from another pipeline says so (#935): its copies arrive without the in-edges
 * and container a local paste re-derives, and the line is where that shows.
 *
 * A pasted container is named by its COPY's label, read off `containers` AFTER
 * the paste — the name the operator now sees on the new box, as ⌘D's notice does.
 */
function pasteNotice(outcome: PasteOutcome, containers: Container[]): string {
  if (!outcome.ok) return outcome.reason;
  const what =
    outcome.containerId === undefined
      ? `${outcome.count} ${outcome.count === 1 ? 'activity' : 'activities'}`
      : (containerLabels(containers).get(outcome.containerId) ?? 'a container');
  return outcome.crossPipeline ? `Pasted ${what} from another pipeline.` : `Pasted ${what}.`;
}

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
  /**
   * #1397 — called with the pipeline the archive returned, so the route's copy
   * says archived (and the banner appears). The ROW, not a flag: the archive
   * drops the pipeline from the side pane's list, which is where the heading's
   * live name came from, so the route needs the current name in hand.
   */
  onArchived: (pipeline: Pipeline) => void;
  /* #1397 — no `backTo` any more: the editor's "Back to pipelines" duplicated
     the breadcrumb's Pipelines crumb, which is the same anchor (#1242) one
     line above it. */
}

/** The doc slices `docUnchanged` compares — picked, so a held snapshot keeps
 * no undo history alive. */
function docOf(s: CanvasState): DocSnapshot {
  return {
    nodes: s.nodes,
    edges: s.edges,
    containers: s.containers,
    params: s.params,
    outputs: s.outputs,
    variables: s.variables,
    description: s.description,
    annotations: s.annotations,
  };
}

/**
 * The working graph as Debug and Validate send it: the SAME body a save sends.
 * Its `basedOnVersionId` is a save's CAS basis and means nothing to either —
 * they overwrite nothing — so `PipelineDraftBodySchema` strips it.
 */
function draftBody(s: CanvasState) {
  return toVersionBody(
    s.nodes,
    s.edges,
    s.containers,
    s.params,
    s.outputs,
    s.variables,
    s.description,
    s.annotations,
    null,
  );
}

/**
 * The authoring canvas for one pipeline: loads the latest immutable version
 * into a working store, renders the React Flow editor with a palette and a
 * property panel, and saves the working graph as a NEW immutable version.
 */
/**
 * #1502 — an ordering for reads of one piece of state that several callers
 * read and one caller writes: see `publishSeq` in the editor.
 */
interface ReadSequence {
  issued: number;
  applied: number;
}

function takeTicket(seq: ReadSequence): number {
  return ++seq.issued;
}

/** Whether an answer with this ticket is newer than what is applied; if so, it now is. */
function claimTicket(seq: ReadSequence, ticket: number): boolean {
  if (ticket <= seq.applied) return false;
  seq.applied = ticket;
  return true;
}

export function PipelineCanvas({
  pipelineId,
  pipelineName,
  archived,
  onUnarchived,
  onArchived,
}: PipelineCanvasProps) {
  const store = useState(() => createCanvasStore())[0];
  const [connections, setConnections] = useState<ConnectionPublic[]>([]);
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  /* #852 — the property dock can be folded away to give the canvas the height.
     #1475 — that, its height and the Problems toggle are per-viewer
     preferences that survive a reload (`uiStore`). */
  const dockOpen = useStore(uiStore, (s) => s.dockOpen);
  const setDockOpen = useStore(uiStore, (s) => s.setDockOpen);
  const dockHeight = useStore(uiStore, (s) => s.dockHeight);
  /* #1475 OR27 — bottom or right, per viewer. A FOLDED dock is the header bar
     under the canvas in both, so it never costs the canvas any width. */
  const dockPosition = useStore(uiStore, (s) => s.dockPosition);
  const setDockPosition = useStore(uiStore, (s) => s.setDockPosition);
  const dockWidth = useStore(uiStore, (s) => s.dockWidth);
  const dockRight = dockOpen && dockPosition === 'right';
  const dockId = useId();
  const dockBodyId = useId();
  const canvasMainRef = useRef<HTMLDivElement>(null);
  /* #1475 — the toolbox's width and fold, per viewer. Written onto the grid on
     every render, so a reload paints the operator's width first time. */
  const toolboxWidth = useStore(uiStore, (s) => s.toolboxWidth);
  const toolboxRail = useStore(uiStore, (s) => s.toolboxCollapsed);
  const toolboxId = useId();
  const canvasGridRef = useRef<HTMLDivElement>(null);
  const dockRef = useRef<HTMLDivElement>(null);
  /* #1393 — the Problems column beside the properties. Open by default, and
     present while open whether or not anything is wrong, so an issue arriving
     never narrows the properties it sits beside. */
  const problemsOpen = useStore(uiStore, (s) => s.problemsOpen);
  const setProblemsOpen = useStore(uiStore, (s) => s.setProblemsOpen);
  const problemsWidth = useStore(uiStore, (s) => s.problemsWidth);
  const dockBodyRef = useRef<HTMLDivElement>(null);
  const problemsId = useId();
  const unsavedId = useId();
  const saveReasonId = useId();
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // #1395 OR4 — the Run form's open state, and the last run it started. Its
  // notice links to the run page, and stays until the next press of Run — the
  // save line's rule — so the link is there for as long as it is wanted.
  //
  // #1502 — the form holds the version it was OPENED for, not the live head: a
  // focus re-read can move the head while it is open, and following it would
  // remount the form (it is keyed by version), dropping what was typed, and run
  // a version the form never named.
  const [runFor, setRunFor] = useState<PipelineVersion | null>(null);
  const runOpen = runFor !== null;
  // #1395 slice 3 — the Debug form's. Opening one form closes the other: both
  // hang from the same anchor over the canvas.
  const [debugOpen, setDebugOpen] = useState(false);
  // #1476 OR28 — the last Validate's server-only findings, with the draft they
  // describe (see `sameDraft`).
  const [serverCheck, setServerCheck] = useState<{
    doc: DocSnapshot;
    raw: string[];
  } | null>(null);
  const [validating, setValidating] = useState(false);
  const headerRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const [runStarted, setRunStarted] = useState<{ text: string; runId: string } | null>(null);
  /* #1395 OR4 — the run drawn over the canvas. Held apart from `runStarted`,
     which pressing Run clears to open the form: the overlay stays until the
     next run actually STARTS, so a finished run's outcome is still on the cards
     while the next one's params are being typed. */
  const [editorRun, setEditorRun] = useState<EditorRun | null>(null);
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
  // #1397 — the ⋯ menu's Export/Archive outcome. Its own line, not `saveMsg`,
  // which describes the last SAVE and is wiped by the next one.
  const [actionMsg, setActionMsg] = useState<string | null>(null);
  const [archiving, setArchiving] = useState(false);

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
  // #1475 OR27 — a per-viewer preference, like the dock's fold.
  const historyOpen = useStore(uiStore, (s) => s.historyOpen);
  /**
   * #1476 OR28 — the Triggers column: `null` closed, else open, with
   * `newRequest` bumped by each Trigger ▾ → New trigger… (0 = opened on the
   * list). Not remembered: it is an errand, not a layout preference.
   */
  const [triggersColumn, setTriggersColumn] = useState<{ newRequest: number } | null>(null);
  const triggerButtonRef = useRef<HTMLButtonElement>(null);
  const setHistoryOpen = useStore(uiStore, (s) => s.setHistoryOpen);
  /** The version NUMBER being previewed read-only, or `null` while editing. */
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [confirm, confirmDialog] = useConfirm();
  /**
   * #979 — the publish state: the active pointer, and whether a repo is
   * connected at all. Both start `undefined` and STAY `undefined` if the read
   * fails, which is what stops a publish from being attempted on a guess — see
   * `ActiveVersionState`. They are one piece of state because they are read
   * together and are meaningless apart.
   */
  const [active, setActive] = useState<ActiveVersionState>(undefined);
  /**
   * #1476 OR28 — the repo itself, `null` when none is connected; whether one is
   * connected is derived from it so the two cannot disagree.
   */
  const [git, setGit] = useState<WorkspaceGitStatus | null | undefined>(undefined);
  const gitConnected = git === undefined ? undefined : git !== null;
  /**
   * #1502 — the publish state is read on open, on focus, and after a refused
   * publish, and is written by a publish. Every read and write takes the next
   * number from `issued`; a read's answer applies only if it is newer than the
   * last thing applied (`applied`), and applying records it. So a slow read
   * cannot put back a pointer a later read or a publish has already set, while
   * a read that FAILED claims nothing and voids nothing — an older read still in
   * flight is then still the newest answer, and lands.
   */
  const publishSeq = useRef<ReadSequence>({ issued: 0, applied: 0 });
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
   * (this preview's own "Back to editing", the ⋯ menu's "Hide version history",
   * and a version row), so the lock is named once and applied to all three rather
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
   * Close the version-history column — from the ⋯ menu or its own Close
   * button. Closing also leaves any preview it opened, which would otherwise
   * be stranded with no list to leave it from. Both setters at the TOP LEVEL:
   * an impure updater is double-invoked by StrictMode.
   */
  const closeHistory = () => {
    setPreviewing(null);
    setHistoryOpen(false);
  };
  /**
   * Why the ⋯ menu's version-history item is dead, or `null` while it is live.
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

  const dirty = useStore(store, (s) => s.dirty);
  // #1393 — and the tab title carries it, for the operator who tabs away.
  //
  // #1476 — the Triggers column's open form is a second draft on this page, so
  // the title and the leave guard below count it too.
  const [triggerFormDirty, setTriggerFormDirty] = useState(false);
  useShellUnsaved(dirty || triggerFormDirty);
  // #1396 — the draft lives in this mount's store, so leaving the editor's path
  // (Back, another pipeline in the tree, Open run) throws it away. Hold that at
  // the shared prompt. A same-path change keeps this instance, and the draft.
  //
  // #1476 — the Triggers column's form holds no route of its own (the router
  // consults one blocker), so it is folded in here: one prompt for either.
  const leaveGuard = useUnsavedChangesGuard(dirty || triggerFormDirty, {
    holdRoute: leavesPath,
  });
  // The prompt takes focus while it asks and, on Keep, hands it back to wherever
  // the operator was: a field, a node, the tree link they clicked. Not on
  // Discard: the editor is on its way out, and focusing into it would only
  // fire handlers on a page being torn down.
  const leaveKeepRef = useRef<HTMLButtonElement>(null);
  const leaveReturnFocus = useRef<Element | null>(null);
  const leavePrompt = {
    ...leaveGuard,
    discard: () => {
      leaveReturnFocus.current = null;
      leaveGuard.discard();
    },
  };
  useEffect(() => {
    if (leaveGuard.confirming) {
      leaveReturnFocus.current = document.activeElement;
      leaveKeepRef.current?.focus();
      return;
    }
    const back = leaveReturnFocus.current;
    leaveReturnFocus.current = null;
    if (back instanceof HTMLElement && back.isConnected) back.focus();
  }, [leaveGuard.confirming]);

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
      /* #1396 — while the leave prompt asks, no shortcut edits the graph it is
         asking about. Checked here rather than by stopping keys at the prompt,
         because the prompt is not modal: focus can be anywhere on the page. */
      if (leaveGuard.confirming) return;
      /* #1397 — nor while a modal dialog asks (`isModalDialogOpen`): a container
         delete, an Archive, a membership move. Unlike `window.confirm` the
         in-app dialog lets keys bubble here. */
      if (isModalDialogOpen()) return;
      /* U21 — Backspace/Delete, taken off React Flow (`deleteKeyCode={null}`)
         so the whole gesture is ONE undo entry. Read on the same document
         listener and behind the same text-entry guard as the history keys.
         #1397 — and locked out as the clipboard keys are: behind a preview the
         editor is unmounted but its selection is not (the restore dialog no
         longer swallows the key as `window.confirm` did), and a save or restore
         in flight would land over the deletion. */
      if (isDeleteKeystroke(e)) {
        if (previewing !== null || previewLocked) return;
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
        if (clip === 'copy' || clip === 'cut') {
          const box = singleSelection(store.getState().selected);
          if (box?.kind === 'container') {
            // #935 — a container copies whole. It is never cut: its only delete
            // (the ✕) keeps the body, so there is no delete a cut could be.
            if (clip === 'cut') {
              e.preventDefault();
              showCanvasMsg('A container cannot be cut. Copy it with ⌘C.');
              return;
            }
            if (!store.getState().copyContainer(box.id, pipelineId)) return;
            e.preventDefault();
            const name = containerLabels(store.getState().containers).get(box.id);
            showCanvasMsg(`Copied ${name ?? 'container'}.`);
            return;
          }
          const n =
            clip === 'copy'
              ? store.getState().copySelection(pipelineId)
              : store.getState().cutSelection(pipelineId);
          // Nothing of OURS to copy — leave the key alone so the browser's own
          // text copy/cut still works for an operator selecting text on the page.
          if (n === 0) return;
          e.preventDefault();
          const what = `${n} ${n === 1 ? 'activity' : 'activities'}`;
          showCanvasMsg(clip === 'copy' ? `Copied ${what}.` : `Cut ${what}.`);
          return;
        }
        if (clip === 'duplicate') {
          const box = singleSelection(store.getState().selected);
          if (box?.kind === 'container') {
            // A container is selection-EXCLUSIVE, so a selected box is the whole
            // selection and ⌘D means "another one of these", as it does for nodes.
            const name = containerLabels(store.getState().containers).get(box.id);
            if (store.getState().duplicateContainer(box.id) === null) return;
            e.preventDefault();
            showCanvasMsg(`Duplicated ${name ?? 'container'}.`);
            return;
          }
          if (store.getState().selected.every((sel) => sel.kind !== 'node')) return;
          e.preventDefault();
          const made = store.getState().duplicateSelection();
          showCanvasMsg(`Duplicated ${made} ${made === 1 ? 'activity' : 'activities'}.`);
          return;
        }
        e.preventDefault();
        const pasted = store.getState().pasteClipboard(pipelineId);
        showCanvasMsg(pasteNotice(pasted, store.getState().containers));
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
  }, [
    store,
    undoReason,
    redoReason,
    pipelineId,
    previewing,
    previewLocked,
    showCanvasMsg,
    leaveGuard.confirming,
  ]);

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
    //
    // #844 GL3 — the workspace's global parameters join it for the same reason:
    // without them every `${global.x}` would badge unknown, and any badge blocks
    // Save, so a canvas that could not read them could not save a pipeline that
    // uses one.
    Promise.all([
      listPipelineVersions(pipelineId, ctrl.signal),
      listConnections(ctrl.signal),
      listDatasets(ctrl.signal),
      listGlobalParams(ctrl.signal),
    ])
      .then(([loadedVersions, conns, sets, globals]) => {
        store.getState().setGlobals(toGlobalReads(globals));
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
   * #844 GL3 (spec GL-D8) — the globals change in ANOTHER page (Manage → Global
   * parameters), so the canvas re-reads them when the window regains focus, and
   * after a save the server refused (its gate reads the live list, which may be
   * newer than ours). Latest-wins, so a slow older answer cannot overwrite a
   * newer one. A failed re-read keeps the last list: the server's gate is the
   * authority either way, and a Save it would refuse still says why.
   */
  const guardedLoad = useGuardedLoad();
  const refreshGlobals = useCallback(
    () =>
      guardedLoad(listGlobalParams, {
        onData: (globals) => store.getState().setGlobals(toGlobalReads(globals)),
        onError: () => {},
      }),
    [guardedLoad, store],
  );
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
    const ticket = takeTicket(publishSeq.current);
    readPublishState(pipelineId, ctrl.signal)
      .then((s) => {
        if (!claimTicket(publishSeq.current, ticket)) return;
        setActive(s.active);
        setGit(s.git);
      })
      .catch(() => {
        if (ctrl.signal.aborted || !claimTicket(publishSeq.current, ticket)) return;
        // Back to unread, not to a default. A failed read that left a STALE
        // pointer on screen would be worse than one showing none: the CAS would
        // then be sent an expectation nothing currently supports.
        setActive(undefined);
        setGit(undefined);
      });
    return () => ctrl.abort();
  }, [pipelineId]);

  /**
   * #1502 — the version list and the publish state are re-read when the window
   * regains focus, beside the globals above. Another tab, another operator or
   * the build loop can save or publish while this editor sits idle, and without
   * this the badge and the history's `latest`/`active` tags kept naming what was
   * true when the page opened.
   *
   * No write is decided by these reads alone: a save's basis is `loaded`, which
   * neither touches, and a restore or publish carries a CAS the server checks,
   * built from what the operator was looking at when they clicked. These reads
   * make the page TELL the truth sooner; the server keeps it honest.
   *
   * ONE read of both, applied together, so the history and the badge cannot
   * disagree — a pointer newer than the list would flash "Live: not listed
   * yet". The versions MERGE into the list (`mergeVersionLists`) rather than
   * replace it, so a read racing this page's own save cannot drop the version
   * it just minted.
   *
   * A failed read KEEPS what is on screen, unlike the open-time read above,
   * which has nothing to keep. Focus arrives on wake and reconnect, exactly when
   * requests fail, and blanking the pointer then would hide the badge, hold
   * Publish back and re-word the Triggers column over a network blip — while
   * the kept value is one the server read and every write re-checks.
   *
   * Its own `useGuardedLoad` instance, so it is unmount-safe and latest-wins
   * among focus reads without superseding the globals' re-read on the other
   * instance. The `publishSeq` ticket orders it against the publish state's
   * OTHER readers and its one local writer, a publish, which the hook cannot
   * see.
   */
  const guardedFocusLoad = useGuardedLoad();
  const refreshOnFocus = useCallback(() => {
    void refreshGlobals();
    const ticket = takeTicket(publishSeq.current);
    void guardedFocusLoad(
      (signal) =>
        Promise.all([
          listPipelineVersions(pipelineId, signal),
          readPublishState(pipelineId, signal),
        ]),
      {
        onData: ([fresh, s]) => {
          setVersions((prev) => mergeVersionLists(prev, fresh));
          if (!claimTicket(publishSeq.current, ticket)) return;
          setActive(s.active);
          setGit(s.git);
        },
        onError: () => {},
      },
    );
  }, [refreshGlobals, guardedFocusLoad, pipelineId]);
  useEffect(() => {
    window.addEventListener('focus', refreshOnFocus);
    return () => window.removeEventListener('focus', refreshOnFocus);
  }, [refreshOnFocus]);

  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const containers = useStore(store, (s) => s.containers);
  const params = useStore(store, (s) => s.params);
  const variables = useStore(store, (s) => s.variables);
  const globals = useStore(store, (s) => s.globals);
  const outputs = useStore(store, (s) => s.outputs);
  const description = useStore(store, (s) => s.description);
  const annotations = useStore(store, (s) => s.annotations);
  // #852 — read by the folded dock's toggle, so a selection made while the
  // properties are folded away still gets a visible answer.
  const selectedCount = useStore(store, (s) => s.selected.length);
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

  // #1476 OR28 — the toolbar's state badge. `previewed`, not `previewing`: only
  // a version this page holds is actually drawn in place of the editor.
  const editingInput = {
    dirty,
    loadedVersion: loaded?.version ?? null,
    headVersion,
    previewedVersion: previewed?.version ?? null,
    archived,
  };
  const editingBadge = editingState(editingInput);
  const liveBadge = liveState({
    gitConnected,
    active: activeVersionLabel(active, versions),
    canvas: canvasVersion(editingInput),
  });
  // The saved version on (or under) the canvas: the preview, else `loaded`.
  const gitBadge = gitState({ git, source: previewed ?? loaded ?? null });

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
  //
  // #863 — each id-bearing issue is rewritten ONCE and kept paired with its raw
  // string, because the raw form is what `issuesBySubject` attributes on (the
  // rewrite replaces the ids it reads). `nameIssues` names no element, so it is
  // never attributed and joins the full list only.
  const located = useMemo(
    () =>
      // #1312 — `policyIssues` mirrors a THIRD gate, the write schema's
      // `StrictNodeSchema.policy`, and names nodes, so it is rewritten too.
      [
        ...validateCanvas(nodes, edges, containers, params, variables, globals),
        ...policyIssues(nodes),
      ].map((raw) => ({
        raw,
        text: readableIssue(raw, nodes, edges, containers),
      })),
    [nodes, edges, containers, params, variables, globals],
  );
  const clientIssues = useMemo(
    () => [
      ...located.map((issue) => issue.text),
      ...nameIssues(params, outputs, variables),
      ...propertyIssues(description, annotations),
    ],
    [located, params, outputs, variables, description, annotations],
  );
  // #1476 OR28 — what the last Validate found that the badges above cannot see
  // (the server's call-graph and debug-callee reads). Listed, attributed, and
  // refusing Save — as the server would — only while the doc is the one it
  // checked: by identity, as `docUnchanged` judges a save, so any edit (a node
  // drag included) retires it and the save's own 400 still stands behind that.
  // `globals` is not part of it: the window-focus refresh replaces that array
  // with the doc unchanged, and the server-only checks never read it.
  const serverCheckCurrent =
    serverCheck !== null &&
    docUnchanged(serverCheck.doc, {
      nodes,
      edges,
      containers,
      params,
      outputs,
      variables,
      description,
      annotations,
    });
  const serverLocated = useMemo(
    () =>
      serverCheckCurrent
        ? serverCheck.raw.map((raw) => ({
            raw,
            text: readableIssue(raw, nodes, edges, containers),
          }))
        : [],
    [serverCheckCurrent, serverCheck, nodes, edges, containers],
  );
  const issues = useMemo(
    () =>
      serverLocated.length === 0
        ? clientIssues
        : [...clientIssues, ...serverLocated.map((issue) => issue.text)],
    [clientIssues, serverLocated],
  );
  const attribution = useMemo(
    () =>
      issuesBySubject(
        serverLocated.length === 0 ? located : [...located, ...serverLocated],
        nodes,
        edges,
        containers,
      ),
    [located, serverLocated, nodes, edges, containers],
  );
  // Held at a STABLE identity while its content is unchanged. `located` is
  // recomputed on every param keystroke, so without this each one would hand
  // the context a fresh map and re-render every box on the canvas for an edit
  // that attributed nothing new. State adjusted during render — React's
  // "information from previous renders" pattern — rather than a ref read.
  const [bySubject, setBySubject] = useState(attribution);
  if (bySubject !== attribution && !sameAttribution(bySubject, attribution)) {
    setBySubject(attribution);
  }

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
  const runReason = runDisabledReason({
    ready,
    archived,
    headVersion,
    previewing: previewing !== null,
  });
  // A refusal arriving (a preview opened, the pipeline archived) CLOSES the Run
  // form rather than hiding it, so it does not spring back open with reset
  // values when the refusal lifts. Render-phase, like `EditorStatusStrip`'s.
  if (runOpen && runReason !== null) setRunFor(null);
  const debugReason = debugDisabledReason({
    ready,
    archived,
    previewing: previewing !== null,
    issueCount: issues.length,
  });
  if (debugOpen && debugReason !== null) setDebugOpen(false);
  const newReason = newTriggerReason({ ready, archived, headVersion });
  const newBinding = newTriggerBinding({ pipelineId, head, active, gitConnected });
  /** Open the Triggers column — on a new form, or on the list — and close
   * version history: one side column at a time, so the canvas keeps its width. */
  const openTriggersColumn = (withNewForm: boolean) => {
    // Not while a restore or save holds the preview: closing history leaves
    // the preview, which every other route into it is locked against.
    if (historyOpen && !previewLocked) closeHistory();
    setTriggersColumn((open) => ({
      newRequest: withNewForm ? (open?.newRequest ?? 0) + 1 : (open?.newRequest ?? 0),
    }));
  };
  /* #1476 OR28 — the ticket's rule for a toolbar row that cannot hold every
     act: overflow goes into ⋯, it never wraps or spills. Two things fold, one
     at a time and in this order: Validate — the act used least often of those
     in the row — and then the git part of the badge, the widest pill and the
     one fact with a page of its own to open (Manage → Git). Each folds when
     the row overflows, remembering the width it needed, and comes back only
     once the row is that wide again: comparing against the width that DID
     overflow, not the narrower one without it, is what stops it flapping.
     `folds` holds those widths, last-folded last. Measured on the header's own
     width and on what changes the row's content (the badge's labels, the Save
     label) — not on every render, which would force a layout on every node
     drag. */
  const [folds, setFolds] = useState<readonly number[]>([]);
  const foldable = gitBadge === null ? 1 : 2;
  const headerWidth = useElementSize(headerRef, 'width');
  const rowContent = `${editingBadge.label}|${liveBadge?.label ?? ''}|${gitBadge?.label ?? ''}|${String(saving)}`;
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (header === null) return;
    const last = folds.at(-1);
    if (last !== undefined && (header.clientWidth >= last || folds.length > foldable)) {
      setFolds((f) => f.slice(0, -1));
    } else if (header.scrollWidth > header.clientWidth && folds.length < foldable) {
      setFolds((f) => [...f, header.scrollWidth]);
    }
  }, [headerWidth, rowContent, folds, foldable]);
  const validateFolded = folds.length >= 1;
  const gitFolded = folds.length >= 2;
  const foldedGitAlert =
    gitFolded && gitBadge !== null && gitBadge.tone !== 'neutral' ? gitBadge : null;
  const moreActionsLabel =
    foldedGitAlert === null
      ? 'More pipeline actions'
      : `More pipeline actions (git: ${foldedGitAlert.label})`;
  const validateReason = validateDisabledReason({
    ready,
    previewing: previewing !== null,
    validating,
  });

  /**
   * #1476 OR28 — Validate: run the server's save gate over the working graph as
   * a dry run, open Problems, and say how many there are. The editor's badges
   * already mirror most of that gate; the server adds what needs its database.
   *
   * A draft that cannot even be SENT (the client's write-schema badges — a
   * nameless param, a bad policy — make the body refuse to parse) is already
   * listed in Problems, so that refusal announces the listed count rather than
   * an error. Only a Validate that found nothing to point at says it failed.
   */
  async function onValidate() {
    const s = store.getState();
    const checked = docOf(s);
    const clientRaw = new Set(located.map((issue) => issue.raw));
    const clientCount = clientIssues.length;
    setDockOpen(true);
    setProblemsOpen(true);
    setValidating(true);
    try {
      const result = await validatePipelineDraft(pipelineId, draftBody(s));
      // Edited while the check was in flight: the answer is about a doc that
      // is no longer on screen. Said, so a quiet button does not read as a pass.
      if (!docUnchanged(checked, store.getState())) {
        showCanvasMsg('Validation: the graph changed while it was checked — validate again.');
        return;
      }
      const found = serverOnlyIssues(result, clientRaw);
      setServerCheck({ doc: checked, raw: found.raw });
      showCanvasMsg(validationAnnouncement(clientCount + found.raw.length, found.truncated));
    } catch (err) {
      setServerCheck(null);
      // The draft's own body refused to parse before any request: that is the
      // write-schema badges already in Problems, so it reports their count. Any
      // other failure means the save check did not run, and says so.
      showCanvasMsg(
        err instanceof ZodError && clientCount > 0
          ? validationAnnouncement(clientCount)
          : `Validation could not run: ${messageOf(err)}`,
      );
    } finally {
      setValidating(false);
    }
  }

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
      // `containers` alone. What the checks together now assert is the
      // property that actually matters — they cover every doc field the store
      // owns, and every action mints a fresh array reference, so no concurrent
      // edit can be silently overwritten by the rebase.
      const savedParams = store.getState().params;
      const savedOutputs = store.getState().outputs;
      const savedVariables = store.getState().variables;
      const savedDescription = store.getState().description;
      const savedAnnotations = store.getState().annotations;
      try {
        const created = await createPipelineVersion(
          pipelineId,
          toVersionBody(
            savedNodes,
            savedEdges,
            savedContainers,
            savedParams,
            savedOutputs,
            savedVariables,
            savedDescription,
            savedAnnotations,
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
              variables: savedVariables,
              description: savedDescription,
              annotations: savedAnnotations,
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
        setVersions((prev) => mergeVersionLists(prev, [created]));
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
            setVersions((prev) => mergeVersionLists(prev, fresh));
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
        // #844 GL3 — a refusal may be over a global renamed or deleted since the
        // canvas read the list; re-read it so the badges catch up.
        if (!isStaleWrite(err)) void refreshGlobals();
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
    [pipelineId, store, refreshGlobals],
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
    // #1397 — `primary`, not `danger`: a restore mints a new version and keeps
    // every old one. While the dialog asks, the editor stays unmounted behind
    // the preview and every value below is the one the operator read; the
    // version list is also the CAS basis, so a list that moved fails the write.
    if (
      !(await confirm({
        message: restoreConfirmMessage({ selectedVersion: previewed.version, headVersion }),
        confirmLabel: 'Restore',
        tone: 'primary',
      }))
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
      setVersions((prev) => mergeVersionLists(prev, [created]));
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
          setVersions((prev) => mergeVersionLists(prev, fresh));
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
  }, [dirty, head, headVersion, pipelineId, previewed, store, confirm]);

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
    // #1397 — `primary`: publishing moves a pointer and destroys nothing. The
    // pointer can move while the dialog asks; `expectedActiveVersionId` is the
    // one this page read, so the server refuses a publish over a moved pointer.
    if (
      !(await confirm({
        message: publishConfirmMessage({
          selectedVersion: previewed.version,
          activeVersion: activeVersionLabel(active, versions),
        }),
        confirmLabel: 'Publish',
        tone: 'primary',
      }))
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
      // with the version it just minted). It is the newest fact, so it voids
      // any publish-state read still in flight (#1502).
      claimTicket(publishSeq.current, takeTicket(publishSeq.current));
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
        const ticket = takeTicket(publishSeq.current);
        try {
          const s = await readPublishState(pipelineId);
          fresh = s.active;
          if (claimTicket(publishSeq.current, ticket)) {
            setActive(s.active);
            setGit(s.git);
          }
        } catch {
          fresh = undefined;
          if (claimTicket(publishSeq.current, ticket)) {
            setActive(undefined);
            setGit(undefined);
          }
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
  }, [active, archived, gitConnected, pipelineId, previewed, versions, confirm]);

  /* #1397 — the ⋯ menu's id, so a confirm opened from one of its items can
     hand focus back to it: the item that asked is unmounted by then. */
  const moreActionsId = useId();

  /**
   * #1397 — Export from the editor. It downloads what the SERVER holds, i.e.
   * the latest SAVED version: the menu says so while there are unsaved edits,
   * because exporting the file and finding the edits missing is the surprise.
   */
  const onExport = useCallback(async () => {
    setActionMsg(null);
    try {
      await downloadPipelineExport({ id: pipelineId, name: pipelineName });
    } catch (err) {
      setActionMsg(`Could not export “${pipelineName}”: ${messageOf(err)}`);
    }
  }, [pipelineId, pipelineName]);

  /**
   * #1397 — Archive from the editor, through the SAME confirmation text the
   * pipelines list uses (`archiveConfirmMessage`). An archived pipeline refuses
   * every save, so unsaved edits are named too: they stay on the canvas but
   * cannot be saved until the pipeline is unarchived.
   */
  const onArchive = useCallback(async () => {
    const message = dirty
      ? `${archiveConfirmMessage(pipelineName)}\n\nYour unsaved changes stay in the editor, but cannot be saved until you unarchive it.`
      : archiveConfirmMessage(pipelineName);
    const confirmed = await confirm({
      message,
      confirmLabel: 'Archive',
      restoreFocus: () => document.getElementById(moreActionsId),
    });
    if (!confirmed) return;
    setActionMsg(null);
    setArchiving(true);
    try {
      onArchived(await archivePipeline(pipelineId));
    } catch (err) {
      setActionMsg(`Could not archive “${pipelineName}”: ${messageOf(err)}`);
    } finally {
      setArchiving(false);
    }
  }, [confirm, dirty, moreActionsId, onArchived, pipelineId, pipelineName]);

  const archiveReason = archived
    ? 'This pipeline is already archived.'
    : archiving
      ? 'Archiving…'
      : saving || restoring || publishing || unarchiving
        ? 'Wait for the current action to finish.'
        : null;

  return (
    <section aria-labelledby="canvas-heading" className="canvas-page">
      {leaveGuard.routeHold}
      {/* #1396 — over the editor, not in its flow: asking must not move the
          canvas (#1393). Escape keeps editing, as it does in a drawer. */}
      {leaveGuard.confirming && (
        <div
          className="editor-leave-prompt"
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.defaultPrevented || e.nativeEvent.isComposing) return;
            e.preventDefault();
            leaveGuard.keep();
          }}
        >
          <UnsavedChangesPrompt guard={leavePrompt} keepRef={leaveKeepRef} />
        </div>
      )}
      <div className="page-header" ref={headerRef}>
        {/* `title`: the toolbar row truncates a long name (#1475). */}
        <h2 id="canvas-heading" title={pipelineName}>
          {pipelineName}
        </h2>
        {/* #1476 OR28 — nothing until the load lands: an empty version list
            before then would read as "Not saved" on every open. */}
        {ready && (
          <EditorStateBadge
            editing={editingBadge}
            live={liveBadge}
            git={gitFolded ? null : gitBadge}
          />
        )}
        {/* #907 — an archived pipeline refuses every save, so say it BEFORE the
            work happens. Without this the first Save simply bounces with a 409,
            after however long the operator spent editing.

            `role="alert"` and the `.notice-conflict` shape (not the transient
            `.notice` below) for the same reason the save-conflict banner uses
            them: this is a standing FACT about the pipeline that must be acted
            on, not a message about the last thing that happened — and it carries
            the act that resolves it. */}
        {/* #1393 — every notice lives in ONE fixed-height strip, so none of them
            resizes the canvas by arriving or leaving. The standing ones keep their
            role, class and buttons unchanged; only where they are drawn moved.
            Order is priority, but at most one of them can hold at a time: an
            archived pipeline's save is refused before it can conflict, and a
            failed load has nothing to save.
            #1475 OR27 — the strip is a slot IN this toolbar row, between the
            title and the actions, so it costs the canvas no height of its own. */}
        <EditorStatusStrip
          standing={[
            archived && {
              key: 'archived',
              node: (
                <div className="notice-conflict" role="alert">
                  {/* The trailing clause is the SHARED constant, not a second copy:
                the pipelines-list archive confirmation (#1058) states the same
                contract, and two hand-written copies would drift. */}
                  {/* `title`: the strip draws this on one line and truncates it. */}
                  <p
                    title={`This pipeline is archived, so saving is refused. Unarchive it to edit again — ${TRIGGERS_STAY_DISABLED_NOTE}.`}
                  >
                    This pipeline is archived, so saving is refused. Unarchive it to edit again —{' '}
                    {TRIGGERS_STAY_DISABLED_NOTE}.
                  </p>
                  {unarchiveError !== null && (
                    <p title={`Unarchive failed: ${unarchiveError}`}>
                      Unarchive failed: {unarchiveError}
                    </p>
                  )}
                  <div className="form-actions">
                    <button type="button" onClick={() => void onUnarchive()} disabled={unarchiving}>
                      {unarchiving ? 'Unarchiving…' : 'Unarchive pipeline'}
                    </button>
                  </div>
                </div>
              ),
            },
            /* #904 — a refused save. `role="alert"` because it is the ONE save
               outcome that is not self-explanatory and that the operator must act
               on: unannounced, the Save button simply appears to have done nothing.
               Distinct from the `.notice` messages rather than folded into them,
               because this one carries the two acts that resolve it. */
            conflict && {
              key: 'conflict',
              node: (
                <div className="notice-conflict" role="alert">
                  <p title={describeSaveConflict(conflict.version)}>
                    {describeSaveConflict(conflict.version)}
                  </p>
                  <div className="form-actions">
                    <button
                      type="button"
                      onClick={() => {
                        // Show them the version that landed, in the surface that
                        // already exists for it (#903) — a prose pointer to a panel
                        // they then have to find is not the same thing.
                        setHistoryOpen(true);
                        setPreviewing(conflict.version);
                        // One side column at a time, as the ⋯ menu's item.
                        if (!triggerFormDirty) setTriggersColumn(null);
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
              ),
            },
            loadError !== null && {
              key: 'load',
              node: <p className="error" role="alert">{`Could not load pipeline: ${loadError}`}</p>,
            },
          ].filter((n) => n !== false && n !== null)}
          transient={[
            // `role="status"` so a keyboard-driven copy/paste — which changes
            // nothing an operator is looking at — is still announced.
            { key: 'canvas', text: canvasMsg, role: 'status' },
            { key: 'save', text: saveMsg },
            // `status`, so a failed Export or Archive — chosen from a menu that
            // has closed by the time it fails — is still announced.
            { key: 'action', text: actionMsg, role: 'status' },
            {
              key: 'run',
              text: runStarted?.text ?? null,
              ...(runStarted !== null
                ? { link: { to: runDetailPath(runStarted.runId), label: 'Open run' } }
                : {}),
            },
          ]}
        />
        <div className="form-actions">
          {/* U17 — undo/redo. Before the Save button because they act on the
              working graph that Save is about to mint, and in that order.
              `onMouseDown={preventDefault}` keeps the click from moving focus
              off whatever the operator was editing: pressing Undo should not
              also blur the field they are typing in.

              #1397 — icon buttons. The tooltip is the native `title`, not
              Fluent's `Tooltip`: these are DISABLED most of the time, a
              disabled button fires no pointer events, and so a Fluent tooltip
              would never show the one thing worth saying then — why. */}
          <button
            type="button"
            className="icon-button editor-header__icon-button"
            aria-label="Undo"
            onClick={() => store.getState().undo()}
            disabled={undoReason !== null}
            title={undoReason ?? 'Undo the last edit (⌘Z)'}
            onMouseDown={(e) => e.preventDefault()}
          >
            <ArrowUndoRegular aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-button editor-header__icon-button"
            aria-label="Redo"
            onClick={() => store.getState().redo()}
            disabled={redoReason !== null}
            title={redoReason ?? 'Redo the last undone edit (⇧⌘Z)'}
            onMouseDown={(e) => e.preventDefault()}
          >
            <ArrowRedoRegular aria-hidden="true" />
          </button>
          {/* #1397 — the header's ONE primary act: Save keeps the work. Run and
              Debug sit beside it as ordinary buttons, so the region never
              offers two equally loud choices. */}
          <button
            type="button"
            className="primary"
            onClick={() => void onSave()}
            /* The named reason, not a hand-written copy of the terms: every
               refusal this button carries — including "previewing", where Save
               would otherwise mint a version of a graph the operator cannot see
               — is stated once in `saveDisabledReason`. */
            disabled={saveReason !== null}
            title={saveReason ?? undefined}
            /* Both, by id: a present `aria-describedby` REPLACES `title` as the
               description, so naming only the dirty note would silence the
               refusal reason on the case that has both — the usual one. */
            aria-describedby={
              [dirty ? unsavedId : null, saveReason !== null ? saveReasonId : null]
                .filter((id) => id !== null)
                .join(' ') || undefined
            }
          >
            {saving ? 'Saving…' : 'Save version'}
            {/* #1393 — the dirty state is this dot, not a paragraph under the
                canvas that shrank it on the first edit. Always rendered and
                hidden by `visibility`, so the button does not widen when it
                appears. Out of the accessible NAME ("Save version" stays
                stable); the description carries it. */}
            <span className="dirty-dot" aria-hidden="true" data-dirty={dirty}>
              •
            </span>
          </button>
          {dirty && (
            <span id={unsavedId} className="visually-hidden">
              Unsaved changes
            </span>
          )}
          {saveReason !== null && (
            <span id={saveReasonId} className="visually-hidden">
              {saveReason}
            </span>
          )}
          {/* #1476 OR28 — Validate: the save's own check, without saving.
              In ⋯ instead while the row is too narrow (`validateFolded`). */}
          {!validateFolded && (
            <button
              type="button"
              disabled={validateReason !== null}
              title={validateReason ?? VALIDATE_TITLE}
              onClick={() => void onValidate()}
            >
              Validate
            </button>
          )}
          {/* #1395 OR4 — the run forms. The anchor positions them over the
              canvas, so opening one moves nothing (#1393). */}
          <span className="run-now-anchor">
            {/* #1395 slice 3 — Debug: run the working graph as it stands, saved
                or not, as a hidden debug version. */}
            <button
              type="button"
              aria-expanded={debugOpen}
              disabled={debugReason !== null}
              title={debugReason ?? DEBUG_TITLE}
              onClick={() => {
                setRunStarted(null);
                setRunFor(null);
                setDebugOpen((o) => !o);
              }}
            >
              Debug
            </button>
            {/* #1476 OR28 — Trigger ▾, ADF's: Trigger now is #1395's Run (the
                latest saved version, no trigger); View triggers lists this
                pipeline's. Always pressable — an item that cannot run says why
                on its own second line, as the ⋯ menu's do. Fluent's default
                body portal, as the ⋯ menu (U0: never inside the viewport). */}
            <Menu>
              <MenuTrigger disableButtonEnhancement>
                <button type="button" ref={triggerButtonRef}>
                  Trigger <ChevronDownRegular aria-hidden="true" />
                </button>
              </MenuTrigger>
              <MenuPopover>
                <MenuList>
                  <MenuItem
                    disabled={runReason !== null}
                    subText={
                      runReason ?? (headVersion !== null ? runTitle(headVersion, dirty) : undefined)
                    }
                    onClick={() => {
                      // Like every save opening with `setSaveMsg(null)`: the next
                      // Run owns the notice, so it always describes the latest run.
                      setRunStarted(null);
                      setDebugOpen(false);
                      setRunFor(head);
                    }}
                  >
                    Trigger now
                  </MenuItem>
                  {/* #1476 slice 3 — create and edit this pipeline's triggers in
                      a column beside the canvas, without leaving the editor. */}
                  <MenuItem
                    disabled={newReason !== null || newBinding === null}
                    subText={
                      newReason ??
                      (newBinding !== null && headVersion !== null
                        ? newTriggerTitle(newBinding, headVersion, gitConnected, dirty)
                        : undefined)
                    }
                    onClick={() => openTriggersColumn(true)}
                  >
                    New trigger…
                  </MenuItem>
                  <MenuItem onClick={() => openTriggersColumn(false)}>Edit triggers…</MenuItem>
                  <MenuItem onClick={() => void navigate(triggersPath(pipelineId))}>
                    View triggers
                  </MenuItem>
                </MenuList>
              </MenuPopover>
            </Menu>
            {runFor !== null && runReason === null && (
              <RunNowPanel
                key={runFor.id}
                pipelineId={pipelineId}
                version={runFor}
                dirty={dirty}
                onClose={() => setRunFor(null)}
                onStarted={(runId) => {
                  setRunFor(null);
                  setRunStarted({ text: `Run started from v${String(runFor.version)}.`, runId });
                  setEditorRun({ runId, version: runFor });
                }}
              />
            )}
            {debugOpen && debugReason === null && (
              <DebugRunPanel
                // Re-seeded when the draft's params change under an open form,
                // so its rows never describe params the draft no longer has.
                key={JSON.stringify(params)}
                pipelineId={pipelineId}
                params={params}
                draft={() => draftBody(store.getState())}
                onClose={() => setDebugOpen(false)}
                onStarted={(result) => {
                  setDebugOpen(false);
                  setRunStarted({
                    text: debugStartedText(result.retentionDays),
                    runId: result.runId,
                  });
                  setEditorRun({ runId: result.runId, version: result.pipelineVersion });
                }}
              />
            )}
          </span>
          {/* #1397 — everything the header does less often, in one ⋯ menu.
              Fluent's default body portal, like the Factory Resources row
              menu: the U0 spike forbids reparenting a surface into the React
              Flow viewport. A disabled item says WHY on its own second line,
              because a `title` is only ever seen by a mouse. */}
          <Menu>
            <MenuTrigger disableButtonEnhancement>
              <button
                id={moreActionsId}
                type="button"
                className="icon-button editor-header__icon-button"
                // #1476 — a git state that needs attention, folded in here,
                // must not vanish with its pill: the button takes its colour
                // and says it in words.
                data-tone={foldedGitAlert?.tone}
                aria-label={moreActionsLabel}
                title={moreActionsLabel}
              >
                <MoreHorizontalRegular aria-hidden="true" />
              </button>
            </MenuTrigger>
            <MenuPopover>
              <MenuList>
                {validateFolded && (
                  <MenuItem
                    onClick={() => void onValidate()}
                    disabled={validateReason !== null}
                    subText={validateReason ?? undefined}
                  >
                    Validate
                  </MenuItem>
                )}
                {/* The git part, folded: its label is the item, its sentence
                    the second line, and opening it goes where the repo is
                    managed. */}
                {gitFolded && gitBadge !== null && (
                  <MenuItem
                    data-part="git"
                    data-tone={gitBadge.tone}
                    onClick={() => void navigate('/manage/git')}
                    subText={gitBadge.detail}
                  >
                    Git: {partText(gitBadge)}
                  </MenuItem>
                )}
                {/* U9 — Arrange moves the DOCUMENT, not the view, so it is not
                    in React Flow's `<Controls>` (the camera). Undoable with the
                    Undo button beside this menu. */}
                <MenuItem
                  onClick={onArrange}
                  disabled={arrangeReason !== null}
                  subText={arrangeReason ?? undefined}
                >
                  Arrange
                </MenuItem>
                <MenuItem
                  // `previewLocked` — closing the list also drops the preview
                  // (below), which would remount the editor mid-restore.
                  disabled={!ready || previewLocked}
                  subText={historyDisabledReason ?? undefined}
                  onClick={() => {
                    if (historyOpen) closeHistory();
                    else {
                      setHistoryOpen(true);
                      // One side column at a time — unless the Triggers column
                      // holds an unsaved form, which is never closed under it.
                      if (!triggerFormDirty) setTriggersColumn(null);
                    }
                  }}
                >
                  {historyOpen ? 'Hide version history' : 'Show version history'}
                </MenuItem>
                <MenuItem
                  onClick={() => void onExport()}
                  subText={
                    dirty ? 'The last saved version — unsaved changes are not included.' : undefined
                  }
                >
                  Export
                </MenuItem>
                <MenuDivider />
                <MenuItem
                  onClick={() => void onArchive()}
                  disabled={archiveReason !== null}
                  subText={archiveReason ?? undefined}
                >
                  Archive
                </MenuItem>
              </MenuList>
            </MenuPopover>
          </Menu>
        </div>
      </div>

      {/* #1475 OR27 — the editor (or a preview) and the version-history column
          side by side. History used to be a band ABOVE the editor, so opening it
          pushed the canvas down; as a column it takes width instead, and the
          canvas top never moves. */}
      <div className="canvas-body">
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
              publishRefusal={publishRefusal({
                selected: previewed,
                active,
                gitConnected,
                archived,
              })}
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
            <RunCanvas
              key={previewed.id}
              doc={previewed}
              state={null}
              showStatus={false}
              datasets={datasets}
            />
          </div>
        )}

        {ready && previewed === null && (
          /* #863 — one provider over the canvas AND the property panel, so a box's
           badge and the panel's list read the same attribution. */
          <SubjectIssuesContext.Provider value={bySubject}>
            {/* #1395 OR4 — the editor's run, over the canvas and in the dock. */}
            <EditorRunProvider run={editorRun}>
              <div
                ref={canvasGridRef}
                className={dockRight ? 'canvas-grid canvas-grid--dock-right' : 'canvas-grid'}
                /* Folded, the track is the rail's; the stored width is kept for
                 unfolding to restore. */
                style={
                  {
                    [TOOLBOX_WIDTH_VAR]: `${String(toolboxRail ? TOOLBOX_RAIL_WIDTH : toolboxWidth)}px`,
                  } as CSSProperties
                }
              >
                {/* The toolbox is OUTSIDE the provider; the canvas reads the drop
              position via `useReactFlow` on its own side of the drag. */}
                <ActivityToolbox store={store} id={toolboxId} />
                <ToolboxSplitter gridRef={canvasGridRef} toolboxId={toolboxId} />
                {/* #852 / #844 — U7's dock: by default the canvas takes the width
                and the properties sit under it (ADF's layout), and one dock
                serves both the activity forms and the pipeline's params/outputs.
                #1475 — or beside it, per viewer. The position is a CLASS on the same tree, never a
                second branch: the dock holds drafts a remount would drop. */}
                <div
                  className={dockRight ? 'canvas-main canvas-main--dock-right' : 'canvas-main'}
                  ref={canvasMainRef}
                >
                  <div className="canvas-wrap">
                    <ReactFlowProvider>
                      <FlowCanvas
                        store={store}
                        fitSignal={fitSignal}
                        measuredSizesRef={measuredSizesRef}
                        datasets={datasets}
                        onNotice={showCanvasMsg}
                      />
                    </ReactFlowProvider>
                  </div>
                  {dockOpen && (
                    <DockSplitter
                      key={dockPosition}
                      columnRef={canvasMainRef}
                      dockRef={dockRef}
                      dockId={dockId}
                      position={dockPosition}
                    />
                  )}
                  <div
                    id={dockId}
                    ref={dockRef}
                    className={
                      dockOpen ? 'property-dock' : 'property-dock property-dock--collapsed'
                    }
                    /* Written from the stored preference on EVERY render, so a
                     reload paints the operator's height first time rather than
                     the default and then a jump. `null` leaves the CSS default. */
                    style={
                      {
                        ...(dockHeight === null
                          ? {}
                          : { [DOCK_HEIGHT_VAR]: `${String(dockHeight)}px` }),
                        ...(dockWidth === null
                          ? {}
                          : { [DOCK_WIDTH_VAR]: `${String(dockWidth)}px` }),
                      } as CSSProperties
                    }
                  >
                    <div className="property-dock__header">
                      <button
                        type="button"
                        className="property-dock__toggle"
                        aria-expanded={dockOpen}
                        aria-controls={dockBodyId}
                        onClick={() => setDockOpen(!dockOpen)}
                      >
                        {/* Folded, a selection would otherwise change nothing on screen
                      but the canvas highlight. The dock does NOT reopen by itself:
                      the operator folded it to look at the graph, and a click or a
                      drag selects — so the toggle says what is waiting instead. */}
                        {dockOpen
                          ? 'Hide properties'
                          : selectedCount > 0
                            ? `Show properties (${String(selectedCount)} selected)`
                            : 'Show properties'}
                      </button>
                      {/* #1393 — the count is on the header, so a folded dock still
                    says why Save is refused. Opening Problems from a folded
                    dock opens the dock too: a toggle whose effect is hidden
                    would read as broken. */}
                      <button
                        type="button"
                        className="property-dock__toggle"
                        aria-expanded={dockOpen && problemsOpen}
                        aria-controls={problemsId}
                        onClick={() => {
                          if (!dockOpen) {
                            setDockOpen(true);
                            setProblemsOpen(true);
                          } else setProblemsOpen(!problemsOpen);
                        }}
                      >
                        Problems{' '}
                        <span
                          className={
                            issues.length > 0 ? 'count-badge count-badge--error' : 'count-badge'
                          }
                        >
                          {issues.length}
                        </span>
                      </button>
                      {/* #1475 OR27 — the label names where the dock GOES, so it
                      needs no pressed state on top. Offered folded too: it
                      decides where the dock opens. */}
                      <button
                        type="button"
                        className="property-dock__toggle"
                        onClick={() =>
                          setDockPosition(dockPosition === 'right' ? 'bottom' : 'right')
                        }
                      >
                        {dockPosition === 'right' ? 'Dock to bottom' : 'Dock to right'}
                      </button>
                      {/* The page's ONE announcer of a blocked save (#1249). Here
                      in the always-shown header, not on the list: the list is
                      `hidden` whenever Problems or the dock is folded, and a
                      `display: none` region announces nothing. Always mounted,
                      because a live region is announced only if it already
                      exists when its content changes. */}
                      <span className="visually-hidden" role="status">
                        {issues.length > 0
                          ? `${String(issues.length)} validation issue(s) — fix these to save.`
                          : ''}
                      </span>
                    </div>
                    {/* HIDDEN, not unmounted, when collapsed: the panel holds drafts
                    (an unapplied config form, a half-typed param) that closing
                    the dock to look at the graph must not throw away. */}
                    <div
                      id={dockBodyId}
                      ref={dockBodyRef}
                      className="property-dock__body"
                      hidden={!dockOpen}
                      /* #1475 — from the stored preference on every render, like
                       the dock's height, so a reload paints it first time. */
                      style={
                        { [PROBLEMS_WIDTH_VAR]: `${String(problemsWidth)}px` } as CSSProperties
                      }
                    >
                      <SelectedRunDrawer store={store} />
                      <PropertyPanel
                        store={store}
                        connections={connections}
                        datasets={datasets}
                        pipelineId={pipelineId}
                        onNotice={showCanvasMsg}
                      />
                      {/* Stacked under the properties in a right-hand dock, at a
                      fixed height, so there is no width to resize there. */}
                      {problemsOpen && dockPosition === 'bottom' && (
                        <ProblemsSplitter bodyRef={dockBodyRef} problemsId={problemsId} />
                      )}
                      {/* #1393 — the validation list, moved here from above the
                      canvas, where it grew by one line per issue on every
                      keystroke. Plain text: the header above announces. */}
                      <aside
                        id={problemsId}
                        className="problems-panel"
                        aria-label="Problems"
                        hidden={!problemsOpen}
                      >
                        {issues.length === 0 && <p className="page-hint">No problems.</p>}
                        {issues.length > 0 && (
                          <div className="badge-list">
                            {/* #444: this used to say "you can still save … a run will refuse an
                                invalid graph". Both halves were wrong — nothing refused a save,
                                and no run refused the doc either. The server now refuses it on
                                save, so the copy states what actually happens, and no more: the
                                graph on screen is an editable draft, so anything about immutable
                                stored versions would just read as "yours is unfixable". */}
                            <strong>{issues.length} validation issue(s)</strong> — fix these to
                            save.
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
                      </aside>
                    </div>
                  </div>
                </div>
              </div>
            </EditorRunProvider>
          </SubjectIssuesContext.Provider>
        )}

        {/* `ready` gates the column, because `versions` is `[]` both before the
            load resolves AND forever after it fails — and its empty state says
            "no versions yet", which would be a flat falsehood printed next to
            the load-error banner. An unloaded page has no history to show, not
            an empty one. */}
        {historyOpen && ready && (
          <VersionHistoryPanel
            entries={entries}
            previewing={previewing}
            /* Non-null exactly while `previewLocked`: the column only renders
               once `ready`, so the reason's "loading" branch never reaches it. */
            locked={historyDisabledReason}
            onPreview={(version) => {
              setPreviewing((current) => (current === version ? null : version));
            }}
            onClose={() => {
              closeHistory();
              // The button that had focus is gone with the column; hand focus to
              // the ⋯ menu that reopens it rather than dropping it on <body>.
              document.getElementById(moreActionsId)?.focus();
            }}
          />
        )}
        {triggersColumn !== null && (
          <PipelineTriggersColumn
            pipelineId={pipelineId}
            headId={head?.id ?? null}
            newBinding={newBinding}
            newReason={newReason}
            newRequest={triggersColumn.newRequest}
            returnFocusTo={triggerButtonRef}
            onClose={() => setTriggersColumn(null)}
            onDirtyChange={setTriggerFormDirty}
          />
        )}
      </div>
      {confirmDialog}
    </section>
  );
}

/** #1395 OR4 — the editor run's drawer for the ONE selected activity, if any. */
function SelectedRunDrawer({ store }: { store: ReturnType<typeof createCanvasStore> }) {
  const selected = singleSelection(useStore(store, (s) => s.selected));
  const nodeId = selected?.kind === 'node' ? selected.id : null;
  const type = useStore(store, (s) =>
    nodeId === null ? null : (s.nodes.find((n) => n.id === nodeId)?.type ?? null),
  );
  // Keyed so a Close lasts only while the same node of the same run is selected.
  const runId = useContext(EditorRunContext)?.runId ?? '';
  return <EditorRunDrawer key={`${runId}:${nodeId ?? ''}`} nodeId={nodeId} type={type} />;
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
  const variables = useStore(store, (s) => s.variables);
  const globals = useStore(store, (s) => s.globals);
  // #852 / #844 — the dock's tab choices live HERE, above the panels, because
  // `NodePanel` is keyed per node: selecting another activity remounts it, and
  // the operator should land on the tab they were using, as ADF does. #1475 —
  // in `uiStore`, so that holds across a reload and across pipelines too.
  const nodeTab = useStore(uiStore, (s) => s.dockNodeTab);
  const setNodeTab = useStore(uiStore, (s) => s.setDockNodeTab);
  const pipelineTab = useStore(uiStore, (s) => s.dockPipelineTab);
  const setPipelineTab = useStore(uiStore, (s) => s.setDockPipelineTab);
  const pipelinePanel = (
    <PipelinePanel
      store={store}
      pipelineId={pipelineId}
      onNotice={onNotice}
      tab={pipelineTab}
      onTab={setPipelineTab}
    />
  );

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
  if (!selected) return pipelinePanel;

  if (selected.kind === 'edge') {
    const edge = edges.find((e) => e.id === selected.id);
    // A selection pointing at an element that no longer exists is, from the
    // operator's side, indistinguishable from having nothing selected — so it
    // gets the same pipeline-level panel as the `!selected` branch above.
    if (!edge) return pipelinePanel;
    // Keyed like `NodePanel`: `EdgePanel` holds a DRAFT for the bounce cap, and
    // selecting a different edge must not carry the previous one's half-typed
    // text (or its error) onto it.
    return <EdgePanel key={edge.id} store={store} edge={edge} nodes={nodes} edges={edges} />;
  }

  if (selected.kind === 'container') {
    const container = containers.find((c) => c.id === selected.id);
    if (!container) return pipelinePanel;
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
        variables={variables}
        globals={globals}
        onApply={(next) => store.getState().updateContainer(container.id, next)}
        onCopy={() => {
          if (store.getState().copyContainer(container.id, pipelineId)) {
            onNotice(
              `Copied ${containerLabels(containers).get(container.id) ?? CONTAINER_KIND_LABELS[container.kind]}.`,
            );
          }
        }}
        onDuplicate={() => {
          if (store.getState().duplicateContainer(container.id) !== null) {
            onNotice(
              `Duplicated ${containerLabels(containers).get(container.id) ?? CONTAINER_KIND_LABELS[container.kind]}.`,
            );
          }
        }}
      />
    );
  }

  const node = nodes.find((n) => n.id === selected.id);
  if (!node) return pipelinePanel;
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
      tab={nodeTab}
      onTab={setNodeTab}
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
    <LabelledControl label={label}>
      {(id) => (
        <select id={id} value={value ?? ''} onChange={(e) => onPick(e.target.value || undefined)}>
          <option value="">— none —</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
    </LabelledControl>
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
      {/* U21 — the bulk acts, in the order an operator reaches for them. Copy,
          Cut and Duplicate act on the ACTIVITIES only (an edge travels with the
          pair it joins, and an edge alone has nothing to copy into), which is
          why they are disabled when a marquee caught edges and nothing else.
          Cut is not Copy-then-Delete: it records what it removed around the
          activities, so a paste puts them back wired (#935, `cutSelection`). */}
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
          const cut = store.getState().cutSelection(pipelineId);
          onNotice(`Cut ${cut} ${cut === 1 ? 'activity' : 'activities'}.`);
        }}
      >
        Cut selection
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
  tab,
  onTab,
}: {
  store: ReturnType<typeof createCanvasStore>;
  pipelineId: string;
  onNotice: (message: string) => void;
  /** #844 — the dock's lifted tab choice; see `PanelTabs`. */
  tab?: PipelineTab;
  onTab?: (tab: PipelineTab) => void;
}) {
  const params = useStore(store, (s) => s.params);
  const outputs = useStore(store, (s) => s.outputs);
  const variables = useStore(store, (s) => s.variables);

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>Pipeline</h3>
      <p className="page-hint">
        Select a node or an edge to edit it, or use the ⚙ on a container box.
      </p>

      {/* U21 — Paste lives in the NOTHING-selected panel because that is where an
          operator is standing when they want it: they have just clicked the
          background to deselect, and ⌘V is otherwise invisible. It is always
          enabled — the refusal reason (empty clipboard, or a copy from another
          pipeline that reads a node it did not bring) is more useful said than
          hidden behind a grey button. */}
      <button
        type="button"
        onClick={() => {
          const pasted = store.getState().pasteClipboard(pipelineId);
          onNotice(pasteNotice(pasted, store.getState().containers));
        }}
      >
        Paste
      </button>

      {/* #844 — the U16 contract editor, as the dock's pipeline-level tabs (ADF's
          Parameters / Output). Each section keeps its heading inside its tab, so
          a panel read on its own still says what it is. */}
      <PanelTabs
        label="Pipeline properties"
        selected={tab}
        onSelect={onTab}
        tabs={[
          {
            key: 'params',
            label: 'Parameters',
            content: (
              <ContractSection
                heading="Params"
                hint={
                  <>
                    The typed inputs a run supplies. Referenced as <code>{'${params.name}'}</code>,
                    and what a trigger binds its values to.
                  </>
                }
                count={params.length}
                addLabel="Add param"
                onAdd={() => store.getState().addParam()}
              >
                {params.map((p, i) => (
                  <ParamRow key={i} store={store} index={i} param={p} />
                ))}
              </ContractSection>
            ),
          },
          {
            key: 'variables',
            label: 'Variables',
            content: (
              <ContractSection
                heading="Variables"
                hint={
                  // #844 V5 — the set/append activities now write a variable.
                  <>
                    Named values a run holds from start to finish, read as{' '}
                    <code>{'${vars.name}'}</code>. Every run starts each one at its default; a Set
                    variable or Append variable activity changes it.
                  </>
                }
                count={variables.length}
                addLabel="Add variable"
                onAdd={() => store.getState().addVariable()}
              >
                {variables.map((v, i) => (
                  <VariableRow key={i} store={store} index={i} variable={v} />
                ))}
              </ContractSection>
            ),
          },
          {
            key: 'outputs',
            label: 'Outputs',
            content: (
              <ContractSection
                heading="Outputs"
                hint="The results this pipeline declares to a caller."
                count={outputs.length}
                addLabel="Add output"
                onAdd={() => store.getState().addOutput()}
              >
                {outputs.map((o, i) => (
                  <OutputRow key={i} store={store} index={i} output={o} />
                ))}
              </ContractSection>
            ),
          },
          {
            // #1 F8a — ADF's pipeline properties (description, annotations).
            // Last, so the dock still opens on Parameters.
            key: 'general',
            label: 'General',
            content: <PipelineGeneral store={store} />,
          },
        ]}
      />
    </aside>
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
  const edgeIssues = useSubjectIssues('edge', edge.id);
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
   * Conditions this edge cannot be retyped to — held by another edge between
   * the same two nodes, or (#1064) overlapping an outcome that pair already
   * routes on — each with the reason.
   *
   * `rewireEdge` refuses such a retype (it would mint a duplicate), and a
   * refusal the operator cannot see is a control that silently does nothing:
   * they pick `failure`, React re-renders from the unchanged store, and the
   * control snaps back with no explanation. Showing the choice DISABLED says the
   * same "no" before the click, and says why.
   */
  const taken = takenConditions(edges, edge);
  /* #1064 — this edge's `success`/`failure` partner, if the pair is a
     completion spelled as two edges. */
  const sibling = completionSibling(edges, edge);

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
      {sibling !== null && (
        <button type="button" onClick={() => store.getState().collapseToCompletion(edge.id)}>
          Replace both with one completion edge
        </button>
      )}
      <p className="edge-rewire-hint">
        Drag either end of this edge on the canvas to move it to another activity.
      </p>
      <button type="button" onClick={() => store.getState().deleteEdge(edge.id)}>
        Delete edge
      </button>
      {/* #1393 — AFTER the fields, not above them: an issue arriving must not push
          the control being edited out from under the pointer. The Problems column
          beside the panel lists it too. */}
      <SubjectIssues issues={edgeIssues} />
    </aside>
  );
}

/**
 * U6e — a back-edge's BOUNCE CAP.
 *
 * The one number that decides whether an authored loop terminates, so it is
 * first in the panel rather than tucked under the condition picker.
 *
 * A `DraftNumberField` (#1315). The cap is REQUIRED: blank is refused, never
 * read as unset — a back-edge with no `maxBounces` is refused by the save gate,
 * and `Number('')` would have made clearing the box a silent cap of zero.
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
     because a blur equal to the stored text is a no-op, it made the field a
     DEAD END: the operator sees `10`, types `10`, and nothing is written, so
     the doc stays unsavable ("must declare maxBounces") and the only way out is
     to type some other number and then type 10 back. Reachable for exactly the
     imported / pre-#444 doc this feature keeps invoking. Empty is the honest
     rendering, and `parseBounceCap` already says a cap is required. */
  return (
    <DraftNumberField
      label="Bounce cap"
      stored={edge.maxBounces}
      parse={parseBounceCap}
      onCommit={(n) => store.getState().updateEdgeBounces(edge.id, n)}
      hint={
        <>
          How many times this loop may repeat before the run fails as <code>capped</code>. Zero
          never bounces.
        </>
      }
    />
  );
}

/** A bounce cap: a whole number, 0 or more, and never blank. */
function parseBounceCap(raw: string): DraftNumberParse<number> {
  const parsed = parseWholeNumber(raw);
  if (parsed.ok && parsed.value !== undefined && isMaxBounces(parsed.value)) {
    return { ok: true, value: parsed.value };
  }
  return { ok: false, reason: 'A bounce cap must be a whole number, 0 or more' };
}

/** One condition option, disabled (with the reason) when it cannot be chosen. */
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
  taken: ReadonlyMap<string, string>;
  checked: boolean;
}) {
  const value = encodeCondition(condition);
  const reason = taken.get(value);
  const isTaken = reason !== undefined;
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
      {isTaken ? `${label} — ${reason}` : label}
    </label>
  );
}

/**
 * U6d — the selected activity's container membership, and the gesture that
 * wraps an EXISTING activity in a new container (#1420 added the palette's
 * empty-box path beside it).
 *
 * Membership lives on the container (`children: string[]`), but disjointness
 * makes it a per-NODE fact, which is why one `<select>` on the node is the whole
 * control: picking a container joins it, picking `— none —` leaves, and "New
 * container" is the same act against a container that does not exist yet. There
 * is no multi-select to group N nodes at once (U21). Dragging a node INTO a
 * box joins it since #1420 (`FlowCanvas`'s drag-stop hit test); dragging one
 * OUT is still this select, because a derived box grows with its dragged child.
 *
 * THIS path creates a container around the SELECTED node, so a `loop`/`foreach`
 * made here is past its one-child rule the moment it exists. (The palette's
 * empty box, #1420, starts short of it — a save badge until filled.)
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
  const variables = useStore(store, (s) => s.variables);
  const globals = useStore(store, (s) => s.globals);

  const [kind, setKind] = useState<ContainerKind>('stage');
  const [exitWhen, setExitWhen] = useState('');
  const [items, setItems] = useState('');
  const [maxRounds, setMaxRounds] = useState('');
  const [error, setError] = useState<string | null>(null);

  const labels = containerLabels(containers);
  const ownerId = containers.find((c) => c.children.includes(nodeId))?.id ?? '';
  const [confirm, confirmDialog] = useConfirm();

  /**
   * Apply an edit once the operator has seen what it costs.
   *
   * ONE evaluation, at the moment of the click, against live state — the
   * consequence is never stored, so it cannot go stale the way a frozen
   * `role="alert"` does (`FlowCanvas` documents that failure). It asks through
   * the shared `useConfirm` dialog (#1397), and only when there is something
   * to ask: an edit that costs nothing applies on the click, synchronously.
   */
  async function withConfirmation(
    nextContainers: Container[],
    recovery: string,
    question: string,
    confirmLabel: string,
    apply: () => void,
  ): Promise<boolean> {
    // The gate itself is `containerEditQuestion`, hoisted into `containerRules`
    // when U23's config panel became its second call site. This wrapper is only
    // the "and then apply it" half, which the two callers below share.
    const message = containerEditQuestion(
      { nodes, edges, containers, params, variables, globals },
      nextContainers,
      recovery,
      question,
    );
    if (
      message !== null &&
      !(await confirm({ message, confirmLabel, tone: CONTAINER_EDIT_TONE }))
    ) {
      return false;
    }
    apply();
    return true;
  }

  function changeOwner(value: string) {
    const target = value === '' ? null : value;
    setError(null);
    void withConfirmation(
      assignContainerChild(containers, nodeId, target),
      'You can undo it by setting the activity back to — none —.',
      target === null
        ? 'Take this activity out of its container?'
        : `Move this activity into ${labels.get(target) ?? 'the container'}?`,
      target === null ? 'Take it out' : 'Move',
      () => store.getState().setNodeContainer(nodeId, target),
    );
  }

  async function create() {
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
    const applied = await withConfirmation(
      containersWithNew(containers, built.container),
      // NOT "set it back to — none —": emptying a freshly-made loop leaves a
      // worse doc than the one being escaped (see `consequenceMessage`).
      'You can undo it with the ✕ on the container box.',
      `Create ${withArticle(CONTAINER_KIND_LABELS[kind])} container around this activity?`,
      'Create container',
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

  // #1396 — the Settings tab's Container section, on both panels that show it.
  // The section's body is already the flex column these controls want, so no
  // wrapper of their own is needed.
  return (
    <FormSection title="Container" hint={FORM_SECTION_HINTS.node.container}>
      {confirmDialog}
      {/* The visible label matches the select's name, so a voice command that
          reads the label reaches the control (WCAG 2.5.3). */}
      <LabelledControl label="Container membership">
        {(id) => (
          <select
            id={id}
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
        )}
      </LabelledControl>
      <fieldset className="container-create">
        <legend>New container</legend>
        <LabelledControl label="Kind">
          {(id) => (
            <select
              id={id}
              value={kind}
              aria-label="New container kind"
              onChange={(e) => {
                const parsed = ContainerKindSchema.safeParse(e.target.value);
                if (parsed.success) setKind(parsed.data);
              }}
            >
              {ContainerKindSchema.options.map((k) => (
                <option key={k} value={k}>
                  {CONTAINER_KIND_LABELS[k]}
                </option>
              ))}
            </select>
          )}
        </LabelledControl>
        {kind === 'loop' && (
          <>
            <label>
              {containerSettingTitle('exitWhen')}
              <input
                value={exitWhen}
                spellCheck={false}
                placeholder="${equals(nodes.x.output.status, 200)}"
                onChange={(e) => setExitWhen(e.target.value)}
              />
            </label>
            <label>
              {containerSettingTitle('maxRounds')}
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
            {containerSettingTitle('items')}
            <input
              value={items}
              spellCheck={false}
              placeholder="${run.params.rows}"
              onChange={(e) => setItems(e.target.value)}
            />
          </label>
        )}
        <button type="button" disabled={!canCreate} onClick={() => void create()}>
          Create container
        </button>
      </fieldset>
      {error !== null && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </FormSection>
  );
}

/** A copy of `config` without the `outputs` key — see `NodePanel` for why neither editor holds it. */
function withoutOutputs(config: Record<string, unknown>): Record<string, unknown> {
  const rest = { ...config };
  delete rest.outputs;
  return rest;
}

/** A node's two-mode config draft, seeded from its stored config (minus `outputs`). */
function seedNodeDraft(
  kind: string,
  config: Record<string, unknown>,
  fields: readonly ConfigField[] | null,
  jsonMode: boolean,
): ConfigDraft<string> {
  return {
    kind,
    config,
    inputs: seedFieldInputs(fields, config),
    jsonText: JSON.stringify(config, null, 2),
    jsonMode,
  };
}

/**
 * #1304 — the overridable view of the bound row, or `null` when this workspace
 * does not list it (see `ParamOverridesEditor.resource`).
 */
function overrideResourceFor<T extends { id: string }>(
  rows: readonly T[],
  id: string,
  view: (row: T) => OverrideResource,
): OverrideResource | null {
  const row = rows.find((r) => r.id === id);
  return row === undefined ? null : view(row);
}

/**
 * #1304 — one dataset end's overrides. Rendered only for an end the DOC binds.
 * A half-picked pending end is not in `datasetIds`, and `validateDoc` refuses
 * `datasetParams` for an end with no binding.
 */
function DatasetOverrides({
  store,
  node,
  side,
  datasets,
  picker,
}: {
  store: ReturnType<typeof createCanvasStore>;
  /** The DOC's node, never a pending half-pick. */
  node: Node | undefined;
  side: 'source' | 'sink';
  datasets: readonly Dataset[];
  picker: FieldPicker | undefined;
}) {
  const bound = node?.datasetIds?.[side];
  if (node === undefined || bound === undefined) return null;
  const nodeId = node.id;
  return (
    <ParamOverridesEditor
      legend={side === 'source' ? 'Source dataset overrides' : 'Sink dataset overrides'}
      noun="dataset"
      resource={overrideResourceFor(datasets, bound, datasetOverrideResource)}
      value={node.datasetParams?.[side]}
      onChange={(next, key) => store.getState().setNodeParamOverrides(nodeId, side, next, key)}
      picker={picker}
      place={(n, key, v) => ({
        ...n,
        datasetParams: {
          ...n.datasetParams,
          [side]: { ...n.datasetParams?.[side], [key]: v },
        },
      })}
    />
  );
}

/**
 * #1396 — a container setting's title, from `ContainerSchema`, so the New
 * container fieldset and the container panel cannot name one setting twice.
 */
function containerSettingTitle(key: 'exitWhen' | 'maxRounds' | 'items'): string {
  return fieldLabelThrough(ContainerSchema.shape[key])?.title ?? key;
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
 * The two-mode editor itself is the SHARED one the connection and dataset forms
 * use (`useConfigEditor` + `ConfigEditor`, #1088): one toggle idiom, one parse
 * rule, and a toggle that commits the draft it leaves rather than hiding it.
 *
 * The internal `outputs` contract — seeded by `lowerPipelineNodes` on creation
 * AND on load since #526, and authored by U16 — is held by neither editor: the
 * draft is the config WITHOUT it, and Apply puts the stored one back
 * (`withStoredOutputs`). Every OTHER key no derived field owns is preserved by
 * `assembleConfig`'s general rule, which `legacyExtra` in the tests exercises.
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
  tab,
  onTab,
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
  /** #852 — the dock's lifted tab choice; see `PanelTabs`. */
  tab?: NodeTab;
  onTab?: (tab: NodeTab) => void;
}) {
  const entry = getActivity(nodeType);
  // Edit config WITHOUT the internal `outputs` contract.
  const outputs = config.outputs;
  const editable = withoutOutputs(config);

  // U8a — the whole doc, read reactively, because which references are legal
  // here is a property of the GRAPH: adding an upstream edge changes the answer
  // while this panel is open.
  const docNodes = useStore(store, (s) => s.nodes);
  const docEdges = useStore(store, (s) => s.edges);
  const docContainers = useStore(store, (s) => s.containers);
  const docParams = useStore(store, (s) => s.params);
  const docVariables = useStore(store, (s) => s.variables);
  const docGlobals = useStore(store, (s) => s.globals);
  /**
   * Every activity's identifying name (#878), built ONCE for this panel and read
   * by both surfaces that need one — the heading below and the expression
   * picker's producer list. Two constructions would be two answers that merely
   * happen to agree.
   */
  const nodeNames = useMemo(() => activityLabels(docNodes), [docNodes]);
  /* #863 — what the validator says is wrong with THIS node. Its own policy
     refusals are left to `PolicyEditor`, which lists them beside the fields
     that cause them; showing them here too would print each one twice. */
  const attributed = useSubjectIssues('node', nodeId);
  const ownIssues = useMemo(
    () => attributed.filter((issue) => !isOwnPolicyIssue(issue.raw, nodeId)),
    [attributed, nodeId],
  );
  const policyElsewhere = {
    count: attributed.length - ownIssues.length,
    where: 'Run policy, on the General tab',
  };
  const picker = useExpressionPicker(
    docNodes,
    docEdges,
    docContainers,
    docParams,
    docVariables,
    docGlobals,
    { kind: 'node', nodeId },
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
  // #1413 OR22 — under the name, what the activity DOES and which type it is.
  // The panel is the one place the type id still shows: the palette's hover now
  // carries the description instead. An uncatalogued type has no description,
  // so it gets no line rather than an empty one.
  const about = entry ? (
    <p className="page-hint property-panel__about">
      {entry.description} <code>{nodeType}</code>
    </p>
  ) : null;

  // U7 — the per-activity form, derived from the activity's own `configSchema`
  // (see `configForm.ts` for why the schema, not hand-written metadata, is the
  // source). `null` when the schema is not object-rooted.
  const fields = useMemo(() => (entry ? deriveConfigFields(entry.configSchema) : null), [entry]);

  const [draft, setDraft] = useState(() => seedNodeDraft(nodeType, editable, fields, false));
  const [error, setError] = useState<string | null>(null);
  // Declared HERE, above the render-phase re-seed below that clears it.
  const [autoMapNotice, showAutoMapNotice, clearAutoMapNotice] =
    useTransientNotice(CANVAS_NOTICE_MS);

  // A node has exactly one "kind" — its activity — so there are never carried
  // keys. A schema that is not object-rooted derives no form at all, and the
  // page forces JSON for it. Memoised on `fields` because `useConfigEditor`
  // keys its view on these; `fields` is stable per catalog entry.
  const fieldsFor = useCallback(() => ({ fields: fields ?? [], carried: [] }), [fields]);
  const forcedJson = useCallback(() => fields === null, [fields]);
  // Whether a value is UNRENDERABLE is judged on the draft's config, every
  // render: a value whose type disagrees with its control cannot round-trip, so
  // the node falls back to the JSON editor rather than corrupting the doc on an
  // apply the author thinks touched one other field — and the moment they
  // repair it, the form becomes available again.
  const editor = useConfigEditor({
    form: draft,
    onChange: setDraft,
    setError,
    fieldsFor,
    forcedJson,
  });

  // #844 V6 — a variable writer names its variable from the DECLARED list, the
  // one thing its `variable` field may hold. The chooser only fills the draft,
  // exactly as typing would; Apply is still the act that writes the node. A
  // name that is no longer declared (renamed or deleted on the Variables tab)
  // leaves the chooser on its placeholder, and the node's own issue list says
  // why.
  const variableChoices = useMemo(
    () => variableWriteChoices(nodeType, docVariables),
    [nodeType, docVariables],
  );
  const choicesFor = (fieldName: string): FieldChoices | undefined =>
    fieldName === 'variable' && variableChoices !== undefined
      ? {
          label: 'Declared variable',
          ...variableChoices,
          onChoose: (value) => editor.setInput('variable', value),
        }
      : undefined;

  // Re-seed the draft whenever a DIFFERENT config object arrives.
  //
  // Without this, applying in JSON mode and then switching back to the form
  // would show — and apply — the form's MOUNT-TIME values over the author's
  // JSON edit, silently reverting work with no message. Re-seeding on identity
  // is `ParamRow`'s precedent above, and safe for the same reason: the store's
  // `map` preserves element identity for untouched nodes, so a new `config`
  // object arrives exactly when this node's config was replaced. The author's
  // mode choice survives it.
  //
  // A render-phase set-on-prop-change, not an effect — React's derived-state
  // pattern, which this repo's React 19 lint permits where `useEffect` + setState
  // would not be.
  const [syncedConfig, setSyncedConfig] = useState(config);
  if (syncedConfig !== config) {
    setSyncedConfig(config);
    setDraft(seedNodeDraft(nodeType, editable, fields, draft.jsonMode));
    setError(null);
    // The auto-map line describes a DRAFT. A new `config` identity means that
    // draft is gone (usually because Apply just committed it), so a notice still
    // saying "Apply config to save" would be telling the author to do something
    // they have already done.
    clearAutoMapNotice();
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
  // #1221 M12 slice 2 — which connection the SOURCE dataset list is narrowed by.
  // A paired activity (`copy`) binds it on `connectionIds.source`; an UNPAIRED
  // one (`lookup`) has no pair at all and binds the singular `connectionId`, so
  // reading only the pair left `boundConnections?.source` permanently
  // `undefined` there and the connection axis silently degraded to kind-only —
  // offering every `table` dataset in the workspace, including ones on stores
  // the node is not bound to, which slice 4a refuses at dispatch with
  // `DATASET_CONNECTION_MISMATCH`. Falling back rather than branching on
  // `paired`: the pair is authoritative where it exists, and `validateDoc`
  // refuses the two fields together, so they can never disagree.
  const sourceConnectionId = boundConnections?.source ?? thisNode?.connectionId;
  // A pair the author has STARTED but not finished. It is not on the node, so it
  // is not saved — and saying so is the point: without this the first pick would
  // survive on screen, vanish on reload, and look like the canvas lost it.
  const halfBound =
    (paired && thisNode?.connectionIds === undefined && boundConnections !== undefined) ||
    (datasetKinds !== undefined &&
      thisNode?.datasetIds === undefined &&
      boundDatasets !== undefined);
  // #1396 — whether the Settings tab has a Bindings section at all. The union of
  // what renders inside it: a single-connection picker, a paired activity's
  // pickers (and its stray-binding repair), the dataset pickers. `halfBound`
  // implies `paired` or `datasetKinds`, so it needs no term of its own.
  const hasBindings =
    (entry !== undefined && entry.connectionKinds.length > 0) ||
    paired ||
    datasetKinds !== undefined;

  /**
   * Validate a candidate settings blob against the activity's own schema.
   *
   * A UX PRE-CHECK, never the gate. Several activities' `configSchema` is palette
   * metadata whose real constraints live server-side in `validateDoc`, so a clean
   * result here does not mean the version will save — it only spares the author a
   * round-trip to a 400 they were going to get anyway.
   */
  function schemaIssues(candidate: Record<string, unknown>): string | null {
    if (!entry) return null;
    const check = entry.configSchema.safeParse(schemaPrecheckCandidate(candidate, fields));
    if (check.success) return null;
    return formatZodIssues(check.error.issues);
  }

  /**
   * The stored `outputs` contract put back onto what the editor produced — and
   * any `outputs` the author typed into the JSON dropped, because U16 owns it
   * and this editor never showed it. Omitted when the node had none.
   */
  function withStoredOutputs(next: Record<string, unknown>): Record<string, unknown> {
    const rest = withoutOutputs(next);
    return outputs === undefined ? rest : { ...rest, outputs };
  }

  function apply() {
    // `readConfigDraft` reads whichever draft is ON SCREEN — the one answer to
    // "what would Apply write" that the connection and dataset forms share.
    const read = readConfigDraft(editor.jsonMode, draft, editor.fields);
    if (!read.ok) {
      setError(read.message);
      return;
    }
    // Stripped before the pre-check too: a `.strict()` schema would otherwise
    // refuse a typed `outputs` as an unknown key the author cannot see is dropped.
    const issues = schemaIssues(withoutOutputs(read.owned));
    if (issues) {
      setError(issues);
      return;
    }
    setError(null);
    store.getState().updateNodeConfig(nodeId, withStoredOutputs(read.config));
  }

  // A call node stores its settings in `node.call`, not `node.config`, so this
  // generic `node.config` editor cannot author it — validating the edited blob
  // against `entry.configSchema` (`CallConfigSchema`) would always fail
  // (`pipelineVersionId` lives in `node.call`, unseen here). #425 replaced the
  // read-only stub that used to stand here with `CallPanel`, the dedicated editor
  // for that blob. (The hooks above run unconditionally — this early return only
  // skips the editor JSX.)
  //
  // ---- #1170 M8 slice 2 — the copy mapping's authoring aids ----
  //
  // Everything here reads a dataset's DECLARED columns, which §7 calls schema
  // (1) — a mutable authoring aid. The dispatch gate deliberately reads the
  // store's ACTUAL columns (3) instead, so none of this may ever refuse
  // anything: it advises, and a stale declared list is a wrong warning rather
  // than a blocked copy.
  const mappingField = useMemo(() => autoMappableField(fields), [fields]);
  const sourceDataset = datasets.find((d) => d.id === boundDatasets?.source);
  const sinkDataset = datasets.find((d) => d.id === boundDatasets?.sink);

  /**
   * The draft mapping, projected exactly the way Apply will project it.
   *
   * `parseFieldInput` is the ONE draft→config rule (it owns "a cleared optional
   * cell omits its key" and every per-cell kind), so going through it makes the
   * advisory describe what Apply would actually write rather than a second
   * reading of the same cells.
   *
   * The `null` branch is DEFENSIVE and unreachable for this field as it stands:
   * `parseFieldInput` refuses only a `number` cell ("must be a number"), and the
   * mapping element is four text/enum cells. It is kept because the cell that
   * makes it live is one schema edit away — add a numeric cell (a batch size, a
   * column width) and a half-typed value would otherwise reach the aids as a
   * shape that does not exist. A test for it would assert nothing today, so
   * there is not one.
   */
  // Depends on the MAPPING CELL, not on `inputs`. Every edit in the panel
  // replaces the whole `inputs` object (`editor.setInput`) while leaving
  // the other keys' identities intact, so keying on the object would recompute
  // this — and the `mappedRows`/advisory chain below it — on every keystroke in
  // an unrelated field.
  const mappingInput = mappingField ? draft.inputs[mappingField.name] : undefined;
  const draftMapping = useMemo(() => {
    if (!mappingField) return null;
    const parsed = parseFieldInput(mappingField, mappingInput ?? emptyControlValue(mappingField));
    if (!parsed.ok || parsed.omit || !Array.isArray(parsed.value)) return null;
    return parsed.value as readonly Record<string, unknown>[];
  }, [mappingField, mappingInput]);

  /**
   * The draft rows that actually claim a sink column.
   *
   * A row whose `sink` is still blank — "Add mapping row" inserts an empty one —
   * names nothing yet, so counting it would report a column as written before
   * the author has said which.
   *
   * The projection itself is SHARED (#1185): M9's dataset detail page reads the
   * same advisory off a stored mapping, and two hand-written readings of one
   * shape is the drift `copy-automap.ts` exists to prevent. `unnamed` is dropped
   * here — this panel already shows the blank row it counts.
   */
  const mappedRows = useMemo(() => projectMappingRows(draftMapping ?? []).rows, [draftMapping]);

  const sourceAdvisory =
    mappingField && sourceDataset && draftMapping !== null
      ? checkSourceDrift(
          mappedRows,
          sourceDataset.columns.map((c) => c.name),
        )
      : null;
  const sinkAdvisory =
    mappingField && sinkDataset && draftMapping !== null
      ? checkSinkCoverage(mappedRows, sinkDataset.columns)
      : null;
  // The two sides are deliberately asymmetric on an EMPTY mapping.
  // `checkSourceDrift` reports nothing unmapped for one (listing every source
  // column would bury `.min(1)`'s refusal under a warning about its
  // consequence), while the sink side still names its NOT NULL columns —
  // because those are what makes the copy unrunnable, and they are exactly what
  // the author needs to see before pressing Auto-map.
  const { required: requiredUnwritten, optional: optionalUnwritten } = splitUnwritten(
    sinkAdvisory?.notWritten ?? [],
  );

  const autoMapBlocked =
    sourceDataset === undefined || sinkDataset === undefined
      ? 'Bind a source and a sink dataset to map their columns.'
      : draftMapping === null
        ? 'Finish the mapping row being edited before mapping the rest.'
        : null;

  function runAutoMap() {
    if (!mappingField || !sourceDataset || !sinkDataset || draftMapping === null) return;
    // Three distinct no-op outcomes, named apart. `columns: []` is a
    // DELIBERATELY authorable state ("this table has none"), so collapsing it
    // into "nothing matched" would send the author looking at their column
    // names when the answer is that a dataset declares no columns at all.
    if (sourceDataset.columns.length === 0 || sinkDataset.columns.length === 0) {
      showAutoMapNotice(
        sourceDataset.columns.length === 0
          ? `${sourceDataset.name} declares no columns, so there is nothing to map from.`
          : `${sinkDataset.name} declares no columns, so there is nothing to map to.`,
      );
      return;
    }
    const result = autoMapMapping(
      sourceDataset.columns,
      sinkDataset.columns,
      mappedRows.map((r) => r.sink),
    );
    if (result.rows.length === 0) {
      // The draft is left ALONE, not cleared: a press that matches nothing must
      // not cost the author the rows they wrote by hand.
      showAutoMapNotice(`No new columns matched.${describeSkips(result)}`);
      return;
    }
    const rendered = formatFieldValue(mappingField, [...draftMapping, ...result.rows]);
    if (!rendered.ok) {
      // Unreachable for rows this module built — but that refusal is the
      // property that keeps the button honest if the mapping element ever
      // changes shape, so it is reported rather than swallowed.
      setError(`Auto-map could not fill the mapping: ${rendered.reason}`);
      return;
    }
    // Into the DRAFT, never `updateNodeConfig`: the author reviews the rows and
    // commits them with Apply, which is what puts them through `schemaIssues`.
    // `ExpressionPicker` writes a computed value the same way.
    editor.setInput(mappingField.name, rendered.value);
    showAutoMapNotice(
      `Mapped ${result.rows.length} column${result.rows.length === 1 ? '' : 's'}.` +
        `${describeSkips(result)} Apply config to save.`,
    );
  }

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
        {about}
        <PanelTabs
          label="Activity properties"
          selected={tab}
          onSelect={onTab}
          tabs={[
            {
              key: 'settings',
              label: 'Settings',
              content: (
                <>
                  {/* Not in a section of its own: `CallPanel` already heads its two
                      parts ("Call target", "Parameters"). */}
                  <CallPanel store={store} nodeId={nodeId} call={call} picker={picker} />
                  {/* Membership is orthogonal to the call blob, so this early
                      return must not swallow it: a container is exactly the
                      construct that puts a call node in one, and this is the
                      only panel such a node ever gets. */}
                  <ContainerSection store={store} nodeId={nodeId} />
                </>
              ),
            },
            {
              key: 'general',
              label: 'General',
              content: (
                // #1312 — likewise policy: retry applies to a call, and a secure
                // flag is refused on one, which is explained only if the section
                // is here.
                <PolicyEditor store={store} nodeId={nodeId} />
              ),
            },
          ]}
        />
        {/* #1393 — AFTER the fields, not above them: an issue arriving must not push
            the control being edited out from under the pointer. The Problems column
            beside the panel lists it too. */}
        <SubjectIssues issues={ownIssues} listedElsewhere={policyElsewhere} />
      </aside>
    );
  }

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>{nodeName}</h3>
      {about}
      {/* #852 — ADF's split: what the activity DOES under Settings, how it RUNS
          (retry, timeout, secure input/output) under General. Policy was already
          outside the config form's Apply draft (#1312), so the tab boundary
          follows a line the panel already drew. Container MEMBERSHIP stays on
          Settings: it is also where a container is CREATED (U6d), an authoring
          act that must not hide behind a second tab. */}
      <PanelTabs
        label="Activity properties"
        selected={tab}
        onSelect={onTab}
        tabs={[
          {
            key: 'settings',
            label: 'Settings',
            content: (
              <>
                {/* #1396 — three sections, in the order the panel already had:
                    what the step reads and writes through, where it sits, what
                    it does. Apply, Duplicate and Delete act on the whole node,
                    so they stay after every section. */}
                {hasBindings && (
                  <FormSection title="Bindings" hint={FORM_SECTION_HINTS.node.bindings}>
                    {entry && !paired && entry.connectionKinds.length > 0 && (
                      <LabelledControl label="Connection">
                        {(id) => (
                          <select
                            id={id}
                            value={connectionId ?? ''}
                            onChange={(e) =>
                              store
                                .getState()
                                .setNodeConnection(nodeId, e.target.value || undefined)
                            }
                          >
                            <option value="">— none —</option>
                            {eligible.map((c) => (
                              <option key={c.id} value={c.id}>
                                {connectionOptionLabel(c)}
                              </option>
                            ))}
                          </select>
                        )}
                      </LabelledControl>
                    )}
                    {entry &&
                      !paired &&
                      entry.connectionKinds.length > 0 &&
                      thisNode?.connectionId !== undefined && (
                        <ParamOverridesEditor
                          legend="Connection overrides"
                          noun="connection"
                          resource={overrideResourceFor(
                            connections,
                            thisNode.connectionId,
                            connectionOverrideResource,
                          )}
                          value={thisNode.connectionParams}
                          onChange={(next, key) =>
                            store.getState().setNodeParamOverrides(nodeId, 'connection', next, key)
                          }
                          picker={picker}
                          place={(n, key, v) => ({
                            ...n,
                            connectionParams: { ...n.connectionParams, [key]: v },
                          })}
                        />
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
                          ).map((c) => ({ id: c.id, label: connectionOptionLabel(c) }))}
                          onPick={(id) =>
                            store.getState().setNodeBindingEnd(nodeId, 'connections', 'source', id)
                          }
                        />
                        <BindingSelect
                          label="Sink connection"
                          value={boundConnections?.sink}
                          options={eligibleForBinding(
                            connections,
                            (c) => sinkConnectionKinds.includes(c.kind),
                            boundConnections?.sink,
                          ).map((c) => ({ id: c.id, label: connectionOptionLabel(c) }))}
                          onPick={(id) =>
                            store.getState().setNodeBindingEnd(nodeId, 'connections', 'sink', id)
                          }
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
                              (sourceConnectionId === undefined ||
                                d.connectionId === sourceConnectionId),
                            boundDatasets?.source,
                          ).map((d) => ({ id: d.id, label: datasetOptionLabel(d) }))}
                          onPick={(id) =>
                            store.getState().setNodeBindingEnd(nodeId, 'datasets', 'source', id)
                          }
                        />
                        <DatasetOverrides
                          store={store}
                          node={thisNode}
                          side="source"
                          datasets={datasets}
                          picker={picker}
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
                            ).map((d) => ({ id: d.id, label: datasetOptionLabel(d) }))}
                            onPick={(id) =>
                              store.getState().setNodeBindingEnd(nodeId, 'datasets', 'sink', id)
                            }
                          />
                        )}
                        {datasetKinds.sink !== undefined && (
                          <DatasetOverrides
                            store={store}
                            node={thisNode}
                            side="sink"
                            datasets={datasets}
                            picker={picker}
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
                        This node also carries a single-connection binding, which a paired activity
                        may not have.{' '}
                        <button
                          type="button"
                          onClick={() => store.getState().setNodeConnection(nodeId, undefined)}
                        >
                          Clear it
                        </button>
                      </p>
                    )}
                  </FormSection>
                )}
                <ContainerSection store={store} nodeId={nodeId} />

                <FormSection
                  title="Activity settings"
                  hint={FORM_SECTION_HINTS.node.activitySettings}
                >
                  <ConfigEditor
                    editor={editor}
                    kindLabel={entry?.title ?? nodeType}
                    className="contract-section"
                    rows={10}
                    advisory={null}
                    picker={picker}
                    choicesFor={choicesFor}
                    emptyHint="This activity has no settings."
                    fieldModeExtra={
                      /* #1170 M8 slice 2 — Auto-map (§6.3) and §13's explicit *unmapped*
             state. After the derived controls, never inside them: that loop is
             the generic U7 renderer and a field-name branch inside it would be
             the activity-specific fork U7 exists to keep out. A field-mode
             extra because it describes the FORM draft, which the author is not
             editing in JSON mode. */
                      mappingField && (
                        <div className="contract-section">
                          <button
                            type="button"
                            onClick={runAutoMap}
                            disabled={autoMapBlocked !== null}
                          >
                            Auto-map columns
                          </button>
                          {autoMapBlocked !== null && <p className="page-hint">{autoMapBlocked}</p>}
                          {autoMapNotice !== null && (
                            <p className="contract-advisory" role="status">
                              {autoMapNotice}
                            </p>
                          )}
                          {/* NOT a live region, deliberately, though it sits beside one that is.
                  This is recomputed STATE rather than the outcome of a gesture, and
                  it changes on every keystroke in a mapping cell — announced, it
                  would talk over the author continuously and collide with the
                  notice above (#960's two-live-regions failure). It is plain
                  visible text, always present, read on demand. */}
                          {requiredUnwritten.length > 0 && (
                            <p className="contract-advisory">
                              The sink requires a value for{' '}
                              {requiredUnwritten.map((c) => c.name).join(', ')}, and nothing writes{' '}
                              {requiredUnwritten.length === 1 ? 'it' : 'them'} — the copy cannot
                              succeed until every one is mapped.
                            </p>
                          )}
                          {optionalUnwritten.length > 0 && (
                            <p className="contract-advisory">
                              Not copied: {optionalUnwritten.map((c) => c.name).join(', ')}.
                            </p>
                          )}
                          {sinkAdvisory !== null &&
                            sinkAdvisory.duplicateWrites.map((pair) => (
                              <p className="contract-advisory" key={`${pair.first}/${pair.second}`}>
                                {pair.first} and {pair.second} differ only by case, so both write
                                the same sink column — the store refuses that when the copy runs.
                              </p>
                            ))}
                          {sinkAdvisory !== null && sinkAdvisory.undeclared.length > 0 && (
                            <p className="contract-advisory">
                              {sinkAdvisory.undeclared.join(', ')}{' '}
                              {sinkAdvisory.undeclared.length === 1 ? 'is' : 'are'} not declared by
                              the sink dataset.
                            </p>
                          )}
                          {sourceAdvisory !== null && sourceAdvisory.unmapped.length > 0 && (
                            <p className="contract-advisory">
                              Not read from the source: {sourceAdvisory.unmapped.join(', ')}.
                            </p>
                          )}
                          {sourceAdvisory !== null && sourceAdvisory.missing.length > 0 && (
                            <p className="contract-advisory">
                              {sourceAdvisory.missing.join(', ')}{' '}
                              {sourceAdvisory.missing.length === 1 ? 'is' : 'are'} not declared by
                              the source dataset.
                            </p>
                          )}
                          {sourceAdvisory !== null && sourceAdvisory.ambiguous.length > 0 && (
                            <p className="contract-advisory">
                              {sourceAdvisory.ambiguous.join(', ')} match more than one source
                              column case-insensitively — name the column exactly.
                            </p>
                          )}
                          {/* A declared column list is an authoring aid and can be stale, so
                  every line above is a warning and none of them is a refusal. The
                  gate reads the store's ACTUAL columns at dispatch. */}
                          {(sinkAdvisory !== null || sourceAdvisory !== null) && (
                            <p className="page-hint">
                              Read from each dataset&rsquo;s declared columns, which can be out of
                              date — the copy is checked against the store itself when it runs.
                            </p>
                          )}
                        </div>
                      )
                    }
                  />
                </FormSection>

                {error && (
                  <p className="error" role="alert">
                    {error}
                  </p>
                )}
                <div className="form-actions">
                  <button type="button" onClick={apply}>
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
              </>
            ),
          },
          {
            key: 'general',
            label: 'General',
            content: <PolicyEditor store={store} nodeId={nodeId} />,
          },
        ]}
      />
      {/* #1393 — AFTER the fields, not above them: an issue arriving must not push
          the control being edited out from under the pointer. The Problems column
          beside the panel lists it too. */}
      <SubjectIssues issues={ownIssues} listedElsewhere={policyElsewhere} />
    </aside>
  );
}
