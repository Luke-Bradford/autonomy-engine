import { describe, expect, it } from 'vitest';
import { webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { DEFAULT_THEME_MODE, FLUENT_ROOT_CLASS, THEMES, syncColorScheme } from './fluentTheme';

describe('fluentTheme', () => {
  it('maps each mode to the matching Fluent web theme', () => {
    expect(THEMES.light).toBe(webLightTheme);
    expect(THEMES.dark).toBe(webDarkTheme);
  });

  it('defaults to dark, so an absent stored preference keeps the shipped look', () => {
    expect(DEFAULT_THEME_MODE).toBe('dark');
    expect(THEMES[DEFAULT_THEME_MODE]).toBe(webDarkTheme);
  });

  it('exposes the FluentProvider root class the --xy-* bridge is keyed on', () => {
    expect(FLUENT_ROOT_CLASS).toBe('app-fluent-root');
  });

  it('syncColorScheme mirrors the mode onto the document root', () => {
    syncColorScheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.colorScheme).toBe('light');

    syncColorScheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });
});
