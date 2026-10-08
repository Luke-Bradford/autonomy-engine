import type { ReactNode } from 'react';
import type { FluentIcon } from '@fluentui/react-icons';
import {
  CONNECTION_KIND_LABELS,
  DATASET_KIND_LABELS,
  RUN_TRIGGERED_BY_LABELS,
  TRIGGER_MODE_LABELS,
  type ConnectionKind,
  type DatasetKind,
  type RunTriggeredByKind,
  type TriggerMode,
} from '@autonomy-studio/shared';
import {
  CONNECTION_KIND_ICONS,
  DATASET_KIND_ICONS,
  RUN_TRIGGERED_BY_ICONS,
  TRIGGER_MODE_ICONS,
} from './kindIcons';

/**
 * The glyph alone, hidden from assistive technology: the name beside it (or
 * the picker it sits next to) already says the kind. `data-kind` names what it
 * draws, because the rendered SVG carries nothing that does. Taking the map
 * and the key, not a glyph, ties the two together by type.
 */
function KindGlyph<K extends string>({ icons, kind }: { icons: Record<K, FluentIcon>; kind: K }) {
  const Glyph: FluentIcon = icons[kind];
  return (
    <span className="kind-icon" data-kind={kind} aria-hidden="true">
      <Glyph />
    </span>
  );
}

function KindName<K extends string>({
  icons,
  labels,
  kind,
}: {
  icons: Record<K, FluentIcon>;
  labels: Record<K, string>;
  kind: K;
}) {
  return (
    <span className="kind-name">
      <KindGlyph icons={icons} kind={kind} />
      {labels[kind]}
    </span>
  );
}

/** #1477 slice 5c — a connection kind's icon alone, for a picker option. */
export function ConnectionKindGlyph({ kind }: { kind: ConnectionKind }) {
  return <KindGlyph icons={CONNECTION_KIND_ICONS} kind={kind} />;
}

export function ConnectionKindName({ kind }: { kind: ConnectionKind }) {
  return <KindName icons={CONNECTION_KIND_ICONS} labels={CONNECTION_KIND_LABELS} kind={kind} />;
}

export function DatasetKindName({ kind }: { kind: DatasetKind }) {
  return <KindName icons={DATASET_KIND_ICONS} labels={DATASET_KIND_LABELS} kind={kind} />;
}

export function TriggerModeName({ mode }: { mode: TriggerMode }) {
  return <KindName icons={TRIGGER_MODE_ICONS} labels={TRIGGER_MODE_LABELS} kind={mode} />;
}

/** #1484 — what started a run, as the Monitor's "Triggered by" column says it. */
export function RunTriggeredByName({ kind }: { kind: RunTriggeredByKind }) {
  return <KindName icons={RUN_TRIGGERED_BY_ICONS} labels={RUN_TRIGGERED_BY_LABELS} kind={kind} />;
}

/**
 * A form's Kind or Mode picker with the chosen kind's icon on its left. A
 * native `<option>` cannot hold an icon, so the picker shows the current one
 * beside it. `children` is the `<select>` itself, which keeps its label, id and
 * full width (`.kind-select > select` in index.css).
 */
export function KindSelect<K extends string>({
  icons,
  kind,
  children,
}: {
  icons: Record<K, FluentIcon>;
  kind: K;
  children: ReactNode;
}) {
  return (
    <span className="kind-select">
      <KindGlyph icons={icons} kind={kind} />
      {children}
    </span>
  );
}
