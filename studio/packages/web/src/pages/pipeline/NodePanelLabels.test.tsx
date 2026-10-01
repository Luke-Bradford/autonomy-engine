import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import {
  CONNECTION_KIND_LABELS,
  catalog,
  connectionConfigSchema,
  isStructuralCallActivity,
  type Connection,
  type ConnectionKind,
} from '@autonomy-studio/shared';
import { NodePanel } from './PipelineCanvas';
import { createCanvasStore } from './canvasStore';
import { configFieldTitle, deriveConfigFields } from './configForm';

vi.mock('../../api/pipelines', () => ({
  listAllPipelineVersions: () => Promise.resolve([]),
}));

/**
 * #1396 — a field's title is how an operator, a screen reader's "find" and a
 * spec's `getByLabel` reach its control, and all three match a SUBSTRING,
 * ignoring case. So a title that contains another label on the same panel, or
 * sits inside one, makes two controls answer to one name.
 *
 * This reads the RENDERED panel rather than a list of its labels: the panel
 * adds a connection picker, container membership, overrides and the policy tab
 * around the activity's own fields, and a copied list would drift from them.
 */

const FORM_ACTIVITIES = [...catalog.values()].filter((e) => !isStructuralCallActivity(e.type));

const connectionOf = (kind: ConnectionKind): Connection =>
  ({
    id: `c_${kind}`,
    resourceId: `r_${kind}`,
    ownerId: null,
    name: 'Bound',
    kind,
    config: {},
    parameters: [],
    secretRef: null,
    secretStatus: 'not_required',
    enabled: true,
    createdAt: 0,
    updatedAt: 0,
  }) as Connection;

/**
 * The name of every labelled form control, as its `<label>` or `aria-label`
 * gives it, and of every labelled group (a row list is one).
 *
 * Buttons are left out on purpose: the expression picker's ("Insert reference
 * into url") and a row list's ("Add tools row") are named by the KEY, which a
 * title often spells too. `docs/ui-patterns.md` records why they keep it.
 */
function controlNames(root: HTMLElement): string[] {
  const names: string[] = [];
  root.querySelectorAll('[role="group"][aria-label]').forEach((el) => {
    names.push(el.getAttribute('aria-label') ?? '');
  });
  root.querySelectorAll('input, select, textarea').forEach((el) => {
    const control = el as HTMLInputElement;
    const aria = control.getAttribute('aria-label');
    if (aria !== null) names.push(aria);
    control.labels?.forEach((label) => names.push(label.textContent?.trim() ?? ''));
  });
  return names.filter((n) => n !== '');
}

describe('node panel labels (#1396)', () => {
  it.each(FORM_ACTIVITIES.map((e) => [e.type, e] as const))(
    'no %s field title clashes with another label on its panel',
    (type, entry) => {
      const store = createCanvasStore();
      // A paired activity (copy) binds source and sink stores, not one
      // connection, so it has no connection picker or connection overrides.
      const kind = entry.sinkConnectionKinds === undefined ? entry.connectionKinds[0] : undefined;
      const fields = deriveConfigFields(entry.configSchema) ?? [];
      // One row in every row list, and an override row for every setting of the
      // bound connection: both carry labels of their own, which sit beside the
      // activity's titles.
      const config = Object.fromEntries(
        fields.filter((f) => f.kind === 'objectList').map((f) => [f.name, [{}]]),
      );
      const overrides =
        kind === undefined
          ? {}
          : Object.fromEntries(Object.keys(connectionConfigSchema(kind).shape).map((k) => [k, '']));
      const node = {
        id: 'n',
        type,
        config,
        position: { x: 0, y: 0 },
        ...(kind !== undefined && { connectionId: `c_${kind}`, connectionParams: overrides }),
      };
      store.setState({ nodes: [node] });
      const { container } = render(
        <NodePanel
          store={store}
          connections={kind === undefined ? [] : [connectionOf(kind)]}
          datasets={[]}
          nodeId="n"
          nodeType={type}
          config={config}
          connectionId={node.connectionId}
          call={undefined}
        />,
      );

      const titles = fields.map((f) => configFieldTitle(f).toLowerCase());
      const names = controlNames(container).map((n) => n.toLowerCase());
      // Each title must be on the panel exactly once, and no other name may
      // contain it or be contained by it. A list field's label adds its format
      // ("Cases — one per line"), and that is still its own.
      const isOwn = (title: string, n: string) => n === title || n.startsWith(`${title} — `);
      const clashes = titles.flatMap((title) => {
        const own = names.filter((n) => isOwn(title, n)).length;
        const others = names.filter(
          (n) => !isOwn(title, n) && (n.includes(title) || title.includes(n)),
        );
        return own === 1 && others.length === 0 ? [] : [`${title}: ${own}× ${others.join(' | ')}`];
      });
      expect(clashes).toEqual([]);
      // The seeding above is what puts those labels on the panel; prove it did.
      const rowList = fields.find((f) => f.kind === 'objectList');
      if (rowList !== undefined)
        expect(names.some((n) => n.startsWith(`${rowList.name} row 1 `))).toBe(true);
      if (kind !== undefined) {
        const overrideTitles = (deriveConfigFields(connectionConfigSchema(kind)) ?? []).map((f) =>
          configFieldTitle(f).toLowerCase(),
        );
        expect(overrideTitles.filter((t) => !names.includes(t))).toEqual([]);
      }
    },
  );

  it("names a bound connection by its kind's display name", () => {
    const store = createCanvasStore();
    store.setState({
      nodes: [
        {
          id: 'n',
          type: 'http_request',
          config: {},
          position: { x: 0, y: 0 },
          connectionId: 'c_http',
        },
      ],
    });
    const { getByRole } = render(
      <NodePanel
        store={store}
        connections={[connectionOf('http')]}
        datasets={[]}
        nodeId="n"
        nodeType="http_request"
        config={{}}
        connectionId="c_http"
        call={undefined}
      />,
    );
    expect(getByRole('option', { name: `Bound (${CONNECTION_KIND_LABELS.http})` })).toBeTruthy();
  });
});

describe('node panel enum choices (#1396)', () => {
  /** Each choice of the select labelled `title`, as `value=text`. */
  const choicesOf = (root: HTMLElement, title: string): string[] => {
    const select = [...root.querySelectorAll('select')].find((el) =>
      [...(el.labels ?? [])].some((l) => l.textContent?.trim() === title),
    );
    return [...(select?.options ?? [])].map((o) => `${o.value}=${o.textContent ?? ''}`);
  };

  it('names each value of an enum setting, and stores the value itself', () => {
    const store = createCanvasStore();
    const config = { capture: 'full' };
    store.setState({ nodes: [{ id: 'n', type: 'llm_call', config, position: { x: 0, y: 0 } }] });
    const { container } = render(
      <NodePanel
        store={store}
        connections={[]}
        datasets={[]}
        nodeId="n"
        nodeType="llm_call"
        config={config}
        connectionId={undefined}
        call={undefined}
      />,
    );
    expect(choicesOf(container, 'Capture level')).toEqual([
      '=— none —',
      'metadata=Metadata only',
      'full=Full text',
    ]);
    expect(choicesOf(container, 'Tool choice')).toContain('auto=Model decides');
  });
});
