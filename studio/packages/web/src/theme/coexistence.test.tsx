import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { FluentProvider, webDarkTheme } from '@fluentui/react-components';
import { FlowCanvas } from '../pages/pipeline/FlowCanvas';
import { createCanvasStore } from '../pages/pipeline/canvasStore';
import { FLUENT_ROOT_CLASS } from './fluentTheme';

/**
 * The U0 spike's headline risk was Fluent v9 (`@fluentui/react-components`) and
 * React Flow (`@xyflow/react`) coexisting in one tree. This smoke test pins the
 * green light: React Flow mounts inside a FluentProvider without throwing, and
 * both roots are present. (jsdom cannot render the real chrome colors — that is
 * the operator's attended visual verify — so this guards structure, not pixels.)
 */
describe('Fluent × React Flow coexistence', () => {
  it('mounts React Flow inside a FluentProvider without throwing', () => {
    const store = createCanvasStore();
    const { container } = render(
      <FluentProvider theme={webDarkTheme} className={FLUENT_ROOT_CLASS}>
        <div style={{ width: 400, height: 300 }}>
          <FlowCanvas store={store} />
        </div>
      </FluentProvider>,
    );

    expect(container.querySelector(`.${FLUENT_ROOT_CLASS}`)).not.toBeNull();
    expect(container.querySelector('.react-flow')).not.toBeNull();
  });
});
