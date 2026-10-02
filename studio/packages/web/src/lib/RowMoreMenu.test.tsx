import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FluentProvider, webLightTheme } from '@fluentui/react-components';
import { RowMoreMenu, type RowMenuOrigin } from './RowMoreMenu';

function renderMenu(props: Partial<Parameters<typeof RowMoreMenu>[0]> = {}) {
  const exportFn = vi.fn<(origin: RowMenuOrigin) => void>();
  const deleteFn = vi.fn<(origin: RowMenuOrigin) => void>();
  render(
    <FluentProvider theme={webLightTheme}>
      <RowMoreMenu
        name="Nightly load"
        actions={[
          { label: 'Export', onSelect: exportFn },
          { label: 'Archive', onSelect: vi.fn(), disabled: true },
        ]}
        destructive={{ label: 'Delete', onSelect: deleteFn }}
        {...props}
      />
    </FluentProvider>,
  );
  return { exportFn, deleteFn };
}

describe('#1397 RowMoreMenu', () => {
  it('names its row, and keeps everything but the trigger out of the row until opened', () => {
    renderMenu();
    expect(screen.getByRole('button', { name: 'Actions for Nightly load' })).toBeTruthy();
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('takes a caller label when the default would collide with another menu on the page', () => {
    renderMenu({ label: 'More actions for Nightly load' });
    expect(screen.getByRole('button', { name: 'More actions for Nightly load' })).toBeTruthy();
  });

  it('puts the destructive item last, after a separator, in the danger class', async () => {
    const user = userEvent.setup();
    renderMenu();
    await user.click(screen.getByRole('button', { name: 'Actions for Nightly load' }));
    const menu = await screen.findByRole('menu');
    // Items and the divider only: Fluent pads the list with focus-trap elements,
    // and its divider is `role="presentation"`, so it is found by class.
    const kids = Array.from(menu.querySelectorAll('[role="menuitem"], .fui-MenuDivider')).map(
      (el) => (el.getAttribute('role') === 'menuitem' ? (el.textContent ?? '') : '—'),
    );
    expect(kids).toEqual(['Export', 'Archive', '—', 'Delete']);
    const del = screen.getByRole('menuitem', { name: 'Delete' });
    expect(del.classList.contains('row-menu__danger')).toBe(true);
    expect(screen.getByRole('menuitem', { name: 'Export' }).classList).not.toContain(
      'row-menu__danger',
    );
  });

  it('hands the chosen action its trigger, live and by lookup', async () => {
    const user = userEvent.setup();
    const { deleteFn } = renderMenu({ id: 'row-menu-x' });
    const trigger = screen.getByRole('button', { name: 'Actions for Nightly load' });
    await user.click(trigger);
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
    expect(deleteFn).toHaveBeenCalledTimes(1);
    const origin = deleteFn.mock.calls[0]![0];
    expect(origin.element).toBe(trigger);
    expect(origin.find()).toBe(trigger);
  });

  it('a disabled item cannot be chosen', async () => {
    const user = userEvent.setup();
    const onArchive = vi.fn();
    renderMenu({
      actions: [{ label: 'Archive', onSelect: onArchive, disabled: true }],
    });
    await user.click(screen.getByRole('button', { name: 'Actions for Nightly load' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Archive' }));
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('draws no separator when there is nothing destructive', async () => {
    const user = userEvent.setup();
    renderMenu({ destructive: undefined });
    await user.click(screen.getByRole('button', { name: 'Actions for Nightly load' }));
    const menu = await screen.findByRole('menu');
    expect(menu.querySelectorAll('[role="menuitem"]')).toHaveLength(2);
    expect(menu.querySelector('.fui-MenuDivider')).toBeNull();
  });
});
