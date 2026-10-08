import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ConfigEditor } from './ConfigEditor';
import { fieldSpan, type ConfigField } from './configForm';
import type { ConfigEditorState } from './useConfigEditor';

const noop = (): void => undefined;

const fields: ConfigField[] = [
  { name: 'effort', kind: 'enum', optional: true, enumOptions: ['low', 'high'] },
  { name: 'maxTokens', kind: 'number', optional: true },
  { name: 'stream', kind: 'boolean', optional: true },
  { name: 'prompt', kind: 'text', optional: false },
  { name: 'headers', kind: 'json', optional: true },
];

// The view reads only these members of the hook's state.
const editor = {
  kind: 'llm_call',
  fields,
  inputs: {},
  setInput: noop,
  jsonMode: false,
  canToggle: true,
  toggleMode: noop,
  jsonText: '{}',
  setJsonText: noop,
  unrenderable: [],
  carried: [],
} as unknown as ConfigEditorState<string>;

describe('ConfigEditor — one grid cell per field (#1477 OR29)', () => {
  it('wraps each field in a cell that says whether it packs or spans', () => {
    const { container } = render(
      <ConfigEditor
        editor={editor}
        kindLabel="LLM call"
        className="contract-section"
        rows={4}
        advisory={null}
      />,
    );
    const root = container.querySelector('[role="group"]')!;
    expect(root).toHaveClass('config-editor', 'contract-section');
    const cells = Array.from(root.querySelectorAll(':scope > .config-cell'));
    expect(cells.map((c) => c.getAttribute('data-field-span'))).toEqual([
      'short',
      'short',
      'short',
      'long',
      'long',
    ]);
    // Each cell holds its own field's control, in the schema's order.
    expect(cells[1]!.querySelector('input')).toHaveAccessibleName('maxTokens');
    expect(cells[2]!.querySelector('input[type="checkbox"]')).toHaveAccessibleName('stream');
  });
});

describe('fieldSpan', () => {
  it('packs numbers and checkboxes and spans free text, JSON and row lists', () => {
    expect(
      (
        [
          'number',
          'boolean',
          'text',
          'json',
          'stringList',
          'objectList',
          'keyValue',
          'outputSchema',
        ] as const
      ).map((kind) => fieldSpan({ kind })),
    ).toEqual(['short', 'short', 'long', 'long', 'long', 'long', 'long', 'long']);
  });

  it('packs a choice only while every option it shows is short', () => {
    expect(fieldSpan({ kind: 'enum', enumOptions: ['low', 'high'] })).toBe('short');
    expect(fieldSpan({ kind: 'enum', enumOptions: ['json_schema_strict_mode'] })).toBe('long');
    // What it SHOWS: a short key with a long title spans.
    expect(
      fieldSpan({
        kind: 'enum',
        enumOptions: ['a'],
        label: { title: 'Mode', options: { a: 'A very long option title' } },
      }),
    ).toBe('long');
  });
});
