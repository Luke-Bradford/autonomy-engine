import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { ConfigEditor } from './ConfigEditor';
import { fieldSize, fieldSpan, type ConfigField } from './configForm';
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

// #1694 OR42 F10 — the pane's three size classes, by what a field holds.
describe('fieldSize', () => {
  it('sizes a number S and free text, JSON and row lists L', () => {
    expect(
      (['number', 'text', 'json', 'stringList', 'objectList', 'keyValue'] as const).map((kind) =>
        fieldSize({ kind }),
      ),
    ).toEqual(['s', 'l', 'l', 'l', 'l', 'l']);
  });

  it('sizes a choice S exactly where fieldSpan packs it, and M otherwise', () => {
    const short = { kind: 'enum' as const, enumOptions: ['low', 'high'] };
    const long = { kind: 'enum' as const, enumOptions: ['json_schema_strict_mode'] };
    expect([fieldSize(short), fieldSpan(short)]).toEqual(['s', 'short']);
    expect([fieldSize(long), fieldSpan(long)]).toEqual(['m', 'long']);
  });

  it('sizes a one-line literal (a name) M, a one-line field with a unit S, other one-liners L', () => {
    expect(fieldSize({ kind: 'text', singleLine: true, literal: true })).toBe('m');
    expect(fieldSize({ kind: 'text', singleLine: true, label: { unit: 'seconds' } })).toBe('s');
    expect(fieldSize({ kind: 'text', singleLine: true })).toBe('l');
    // A literal that may span lines is free text, not a name.
    expect(fieldSize({ kind: 'text', literal: true })).toBe('l');
  });
});
