import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import { ReactFlowProvider } from '@xyflow/react';
import {
  ContainerKindSchema,
  OutputTypeSchema,
  ParamTypeSchema,
  availableRefs,
  getActivity,
  isStructuralCallActivity,
  type RefSuggestion,
  type Container,
  type ConnectionPublic,
  type ContainerKind,
  type Edge,
  type Node,
  type Output,
  type OutputType,
  type Param,
  type ParamType,
  type PipelineVersion,
} from '@autonomy-studio/shared';
import { messageOf } from '../../api/client';
import { createPipelineVersion, latestVersion, listPipelineVersions } from '../../api/pipelines';
import { listConnections } from '../../api/connections';
import { ActivityToolbox } from './ActivityToolbox';
import {
  assignContainerChild,
  buildContainer,
  containersWithNew,
  createCanvasStore,
} from './canvasStore';
import { ConfigFieldControl, type FieldPicker } from './ConfigFieldControl';
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
import {
  coerceDefaultInput,
  defaultAdvisory,
  formatDefaultInput,
  nameIssues,
  withRequired,
} from './paramRules';
import { canSave, toVersionBody, validateCanvas } from './canvasDoc';
import {
  branchOptionsFor,
  conditionOf,
  decodeConditionValue,
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
  describeRestoreConflict,
  describeSaveConflict,
  docUnchanged,
  historyEntries,
  isStaleWrite,
  restoreBodyFrom,
  restoreConfirmMessage,
  restoreRefusal,
  saveAnywayLabel,
} from './versionHistory';

interface PipelineCanvasProps {
  pipelineId: string;
  pipelineName: string;
  onBack: () => void;
}

/**
 * The authoring canvas for one pipeline: loads the latest immutable version
 * into a working store, renders the React Flow editor with a palette and a
 * property panel, and saves the working graph as a NEW immutable version.
 */
export function PipelineCanvas({ pipelineId, pipelineName, onBack }: PipelineCanvasProps) {
  const store = useState(() => createCanvasStore())[0];
  const [connections, setConnections] = useState<ConnectionPublic[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);
  // #903 — the versions the initial load already fetched. Before this ticket
  // they were reduced to `latestVersion` and thrown away; the history is that
  // same array, kept.
  const [versions, setVersions] = useState<PipelineVersion[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  /** The version NUMBER being previewed read-only, or `null` while editing. */
  const [previewing, setPreviewing] = useState<number | null>(null);
  const [restoring, setRestoring] = useState(false);
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
    Promise.all([listPipelineVersions(pipelineId, ctrl.signal), listConnections(ctrl.signal)])
      .then(([loadedVersions, conns]) => {
        store.getState().loadVersion(latestVersion(loadedVersions));
        setVersions(loadedVersions);
        setConnections(conns);
        setReady(true);
      })
      .catch((err: unknown) => {
        if (ctrl.signal.aborted) return;
        setLoadError(err instanceof Error ? err.message : String(err));
      });
    return () => ctrl.abort();
  }, [pipelineId, store]);

  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const containers = useStore(store, (s) => s.containers);
  const params = useStore(store, (s) => s.params);
  const outputs = useStore(store, (s) => s.outputs);
  const dirty = useStore(store, (s) => s.dirty);
  const loaded = useStore(store, (s) => s.loaded);

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
    () => historyEntries(versions, loaded?.version ?? null),
    [versions, loaded],
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

  return (
    <section aria-labelledby="canvas-heading" className="canvas-page">
      <div className="page-header">
        <h2 id="canvas-heading">{pipelineName}</h2>
        <div className="form-actions">
          <button type="button" onClick={onBack}>
            ← Back to pipelines
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
            /* Disabled while previewing: Save writes the WORKING graph, which
               is not what is on screen, so the button would mint a version of
               something the operator cannot see. */
            disabled={!canSave({ saving, ready, issues }) || previewing !== null}
            title={
              previewing !== null ? 'Leave the preview to save your working graph.' : undefined
            }
          >
            {saving ? 'Saving…' : 'Save version'}
          </button>
        </div>
      </div>

      {saveMsg && <p className="notice">{saveMsg}</p>}

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
              // The same guard the Save button carries, for the same reason:
              // this writes the WORKING graph, which is not what is on screen
              // while a version is being previewed. Without it, the one route
              // this banner offers would mint a version of something the
              // operator cannot see — the very class of surprise write the
              // ticket is about.
              disabled={saving || previewing !== null}
              title={
                previewing !== null ? 'Leave the preview to save your working graph.' : undefined
              }
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
              <FlowCanvas store={store} />
            </ReactFlowProvider>
          </div>
          <PropertyPanel store={store} connections={connections} />
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
}: {
  store: ReturnType<typeof createCanvasStore>;
  connections: ConnectionPublic[];
}) {
  const selected = useStore(store, (s) => s.selected);
  const nodes = useStore(store, (s) => s.nodes);
  const edges = useStore(store, (s) => s.edges);
  const containers = useStore(store, (s) => s.containers);
  const params = useStore(store, (s) => s.params);

  if (!selected) return <PipelinePanel store={store} />;

  if (selected.kind === 'edge') {
    const edge = edges.find((e) => e.id === selected.id);
    // A selection pointing at an element that no longer exists is, from the
    // operator's side, indistinguishable from having nothing selected — so it
    // gets the same pipeline-level panel as the `!selected` branch above.
    if (!edge) return <PipelinePanel store={store} />;
    // Keyed like `NodePanel`: `EdgePanel` holds a DRAFT for the bounce cap, and
    // selecting a different edge must not carry the previous one's half-typed
    // text (or its error) onto it.
    return <EdgePanel key={edge.id} store={store} edge={edge} nodes={nodes} edges={edges} />;
  }

  if (selected.kind === 'container') {
    const container = containers.find((c) => c.id === selected.id);
    if (!container) return <PipelinePanel store={store} />;
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
  if (!node) return <PipelinePanel store={store} />;
  return (
    <NodePanel
      key={node.id}
      store={store}
      connections={connections}
      nodeId={node.id}
      nodeType={node.type}
      config={node.config}
      connectionId={node.connectionId}
    />
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
export function PipelinePanel({ store }: { store: ReturnType<typeof createCanvasStore> }) {
  const params = useStore(store, (s) => s.params);
  const outputs = useStore(store, (s) => s.outputs);

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>Pipeline</h3>
      <p className="page-hint">
        Select a node or an edge to edit it, or use the ⚙ on a container box.
      </p>

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

  const advisory = defaultAdvisory(param);

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
            // a mis-click, and `defaultAdvisory` already says plainly that the
            // run will fail. Repair beats silent deletion.
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
      {!error && advisory ? (
        // ADVISORY, never a save gate. The server accepts this doc, so refusing
        // to save it would leave an imported pipeline that already holds such a
        // default permanently unsaveable — the one-way trap #748 closed.
        <p className="page-hint contract-advisory">{advisory}</p>
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
  const branches = branchOptionsFor(nodes.find((n) => n.id === edge.from));

  const offered = [
    ...OPERATIONAL_CONDITIONS.map((on) => encodeCondition({ on })),
    ...(branches ?? []).map((branch) => encodeCondition({ on: 'branch', branch })),
  ];

  /**
   * Conditions ALREADY taken by another edge between the same two nodes.
   *
   * `updateEdgeCondition` refuses such a retype (it would mint a duplicate),
   * and a refusal the operator cannot see is a control that silently does
   * nothing: they pick `failure`, React re-renders from the unchanged store,
   * and the select snaps back with no explanation. Showing the option DISABLED
   * says the same "no" before the click, and says why.
   */
  const taken = takenConditions(edges, edge);

  /**
   * A `<select>` whose `value` matches no `<option>` renders the FIRST option
   * instead — a silent lie about what is persisted. Reachable without leaving
   * the canvas: `declaredBranchesOf` reads a `switch`'s `config.cases` LIVE, so
   * editing that config in the node panel can un-declare a branch an existing
   * edge still uses. (Also reachable via an API/git-imported doc.) The value is
   * shown as a DISABLED option so the panel states the truth and refuses to
   * re-select it; `validateCanvas` is already badging the doc as unsavable.
   */
  const orphaned = !offered.includes(currentValue);

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>{edge.back === true ? 'Back-edge' : 'Edge'}</h3>
      {edge.back === true && <BounceCapField store={store} edge={edge} />}
      <label>
        Fires on
        <select
          value={currentValue}
          onChange={(e) => {
            const next = decodeConditionValue(e.target.value);
            if (next) store.getState().updateEdgeCondition(edge.id, next);
          }}
        >
          {orphaned && (
            <option value={currentValue} disabled>
              {edgeLabel(edge)} — not offered by this source
            </option>
          )}
          <optgroup label="Outcome">
            {OPERATIONAL_CONDITIONS.map((on) => (
              <ConditionOption key={on} condition={{ on }} label={on} taken={taken} />
            ))}
          </optgroup>
          {branches !== null && (
            <optgroup label="Branch">
              {branches.map((branch) => (
                <ConditionOption
                  key={branch}
                  condition={{ on: 'branch', branch }}
                  label={branch}
                  taken={taken}
                />
              ))}
            </optgroup>
          )}
        </select>
      </label>
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
function ConditionOption({
  condition,
  label,
  taken,
}: {
  condition: EdgeCondition;
  label: string;
  taken: ReadonlySet<string>;
}) {
  const value = encodeCondition(condition);
  const isTaken = taken.has(value);
  return (
    <option value={value} disabled={isTaken}>
      {isTaken ? `${label} — already used by another edge` : label}
    </option>
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
}: {
  store: ReturnType<typeof createCanvasStore>;
  connections: ConnectionPublic[];
  nodeId: string;
  nodeType: string;
  config: Record<string, unknown>;
  connectionId: string | undefined;
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
  // its real binding instead of silently reading as "— none —".
  const eligible = entry
    ? connections.filter((c) => entry.connectionKinds.includes(c.kind) || c.id === connectionId)
    : connections;

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
    return check.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
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

  // A structural-call activity (`execute_pipeline`) stores its settings in
  // `node.call`, not `node.config`, so this generic `node.config` editor cannot
  // author it — validating the edited blob against `entry.configSchema`
  // (`CallConfigSchema`) would always fail (`pipelineVersionId` lives in
  // `node.call`, unseen here). Such a node cannot be created via the canvas (the
  // palette hides it, `addNode` refuses it), but one authored via the API can be
  // LOADED, so show a read-only stub rather than an un-appliable form. Dedicated
  // call-node authoring is #425. (The hooks above run unconditionally — this
  // early return only skips the editor JSX.)
  if (isStructuralCallActivity(nodeType)) {
    return (
      <aside className="property-panel" aria-label="Properties">
        <h3>{nodeName}</h3>
        <p className="page-hint">This activity is configured via the call-node editor (#425).</p>
        {/* Rendered in the STUB too, not just in the editor below. Membership is
            orthogonal to `node.config`, so this early return must not swallow it:
            a container is exactly the construct an IMPORTED doc puts a call node
            in, and this is the only panel such a node ever gets. */}
        <ContainerSection store={store} nodeId={nodeId} />
      </aside>
    );
  }

  return (
    <aside className="property-panel" aria-label="Properties">
      <h3>{nodeName}</h3>
      {entry && entry.connectionKinds.length > 0 && (
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
        <button type="button" onClick={() => store.getState().deleteNode(nodeId)}>
          Delete node
        </button>
      </div>
    </aside>
  );
}
