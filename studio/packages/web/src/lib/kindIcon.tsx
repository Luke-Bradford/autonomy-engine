import {
  ArrowRepeatAllRegular,
  BotRegular,
  CalendarClockRegular,
  CursorClickRegular,
  DatabaseRegular,
  DatabaseSearchRegular,
  DocumentCsvRegular,
  DocumentTableRegular,
  FlashRegular,
  FolderRegular,
  GlobeRegular,
  PlugConnectedRegular,
  SparkleRegular,
  TableRegular,
  TimerRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import {
  CONNECTION_KIND_LABELS,
  DATASET_KIND_LABELS,
  TRIGGER_MODE_LABELS,
  type ConnectionKind,
  type DatasetKind,
  type TriggerMode,
} from '@autonomy-studio/shared';

/**
 * #1396 — a kind is shown as its display name WITH an icon ("Anthropic API"
 * beside a sparkle), in the lists, the detail page and beside the form's Kind
 * picker.
 *
 * Glyphs go by FAMILY, not by vendor: Fluent has no brand marks, and inventing
 * a different shape for Anthropic and OpenAI would teach nothing. The label
 * tells kinds of one family apart. Where a family has an activity, the glyph is
 * the one `activityIcon.ts` draws for it (an HTTP connection is the globe of
 * `http_request`, an LLM connection the sparkle of `llm_call`, a webhook
 * trigger the plug of `webhook`), so the app speaks one icon language.
 *
 * Unsized glyphs (`GlobeRegular`, not `Globe20Regular`): they take the text's
 * font size, so an icon in a table cell is as tall as the words beside it.
 *
 * `Record`s, unlike the activity map: these enums are closed, so a new kind
 * without a glyph fails the typecheck rather than falling back.
 */
export const CONNECTION_KIND_ICONS: Record<ConnectionKind, FluentIcon> = {
  anthropic_api: SparkleRegular,
  openai_api: SparkleRegular,
  ollama: SparkleRegular,
  agent_cli: BotRegular,
  http: GlobeRegular,
  fs: FolderRegular,
  sqlite: DatabaseRegular,
  postgres: DatabaseRegular,
};

export const DATASET_KIND_ICONS: Record<DatasetKind, FluentIcon> = {
  delimited: DocumentCsvRegular,
  excel: DocumentTableRegular,
  table: TableRegular,
  query: DatabaseSearchRegular,
};

export const TRIGGER_MODE_ICONS: Record<TriggerMode, FluentIcon> = {
  manual: CursorClickRegular,
  schedule: CalendarClockRegular,
  webhook: PlugConnectedRegular,
  event: FlashRegular,
  continuous: ArrowRepeatAllRegular,
  tumbling: TimerRegular,
};

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
