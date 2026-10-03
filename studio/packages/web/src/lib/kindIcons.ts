import {
  ArrowClockwiseRegular,
  ArrowRepeatAllRegular,
  BotRegular,
  BugRegular,
  CalendarClockRegular,
  CursorClickRegular,
  DatabaseRegular,
  DatabaseSearchRegular,
  DocumentCsvRegular,
  DocumentTableRegular,
  EditRegular,
  FlashRegular,
  FlowchartRegular,
  FolderRegular,
  GlobeRegular,
  PlugConnectedRegular,
  SparkleRegular,
  TableRegular,
  TimerRegular,
  type FluentIcon,
} from '@fluentui/react-icons';
import type {
  ConnectionKind,
  DatasetKind,
  RunTriggeredByKind,
  TriggerMode,
} from '@autonomy-studio/shared';

/**
 * #1396 — a kind is shown as its display name WITH an icon ("Anthropic API"
 * beside a sparkle), in the lists, the detail page and beside the form's Kind
 * picker. The components that draw them are in `KindName.tsx`.
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
 * #1484 OR35 M1 — what started a run. A fire kind wears its trigger mode's
 * glyph, so "Schedule" looks the same on a trigger's row and on the runs it
 * fired.
 */
export const RUN_TRIGGERED_BY_ICONS: Record<RunTriggeredByKind, FluentIcon> = {
  manual: TRIGGER_MODE_ICONS.manual,
  schedule: TRIGGER_MODE_ICONS.schedule,
  tumbling: TRIGGER_MODE_ICONS.tumbling,
  webhook: TRIGGER_MODE_ICONS.webhook,
  event: TRIGGER_MODE_ICONS.event,
  editor: EditRegular,
  debug: BugRegular,
  rerun: ArrowClockwiseRegular,
  call: FlowchartRegular,
};
