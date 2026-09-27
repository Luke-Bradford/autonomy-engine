import type { GlobalParamUsage } from '@autonomy-studio/shared';

/**
 * #844 GL3 (spec GL-D4) — the delete confirmation: what reads the global, and
 * what deleting it does to them. `usage` is `null` when it could not be read,
 * which is said rather than shown as "nothing reads it".
 */
export function deleteConfirmText(name: string, usage: GlobalParamUsage | null): string {
  const lines = [
    `Delete global parameter "${name}"?`,
    '',
    'Its value is lost. A global of the same name can be created again.',
    '',
  ];
  if (usage === null) {
    lines.push('Which pipelines read it could not be checked.');
  } else if (usage.pipelines.length === 0 && usage.triggers.length === 0) {
    lines.push('No pipeline’s latest version reads it, and no trigger’s pinned version does.');
  } else {
    if (usage.pipelines.length > 0) {
      lines.push('Read by the latest version of:');
      for (const p of usage.pipelines) lines.push(`  • ${p.pipelineName} (v${p.version})`);
    }
    if (usage.triggers.length > 0) {
      lines.push('Read by the version these triggers run:');
      for (const t of usage.triggers) {
        const off = t.enabled ? '' : ', disabled';
        lines.push(`  • ${t.triggerName} (${t.pipelineName} v${t.version}${off})`);
      }
    }
    lines.push(
      '',
      'A new run of a version that reads it will not start until a global of that name ' +
        'and type exists again. A rerun from failure still uses the values its source run read.',
    );
  }
  return lines.join('\n');
}
