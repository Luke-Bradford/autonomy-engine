import type { FluentIcon } from '@fluentui/react-icons';
import {
  CONNECTION_KIND_LABELS,
  DATASET_KIND_LABELS,
  TRIGGER_MODE_LABELS,
  type ConnectionKind,
  type DatasetKind,
  type TriggerMode,
} from '@autonomy-studio/shared';
import { CONNECTION_KIND_ICONS, DATASET_KIND_ICONS, TRIGGER_MODE_ICONS } from './kindIcons';

/**
 * The glyph alone, hidden from assistive technology: the name beside it (or
 * the control it sits next to) already says the kind. `data-kind` names what
 * it draws, because the rendered SVG carries nothing that does.
 */
export function KindGlyph({ glyph: Glyph, kind }: { glyph: FluentIcon; kind: string }) {
  return (
    <span className="kind-icon" data-kind={kind} aria-hidden="true">
      <Glyph />
    </span>
  );
}

function KindName({ glyph, kind, label }: { glyph: FluentIcon; kind: string; label: string }) {
  return (
    <span className="kind-name">
      <KindGlyph glyph={glyph} kind={kind} />
      {label}
    </span>
  );
}

export function ConnectionKindName({ kind }: { kind: ConnectionKind }) {
  return (
    <KindName
      glyph={CONNECTION_KIND_ICONS[kind]}
      kind={kind}
      label={CONNECTION_KIND_LABELS[kind]}
    />
  );
}

export function DatasetKindName({ kind }: { kind: DatasetKind }) {
  return (
    <KindName glyph={DATASET_KIND_ICONS[kind]} kind={kind} label={DATASET_KIND_LABELS[kind]} />
  );
}

export function TriggerModeName({ mode }: { mode: TriggerMode }) {
  return (
    <KindName glyph={TRIGGER_MODE_ICONS[mode]} kind={mode} label={TRIGGER_MODE_LABELS[mode]} />
  );
}
