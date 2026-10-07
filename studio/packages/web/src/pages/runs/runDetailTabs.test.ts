import { describe, expect, it } from 'vitest';
import { withParams } from '../../lib/withParams';
import {
  DEFAULT_RUN_DETAIL_TAB,
  readRunDetailTab,
  RUN_DETAIL_TAB_PARAM,
  runDetailTabParams,
} from './runDetailTabs';

describe('the run page tab in the URL (#1484 OR35 M2)', () => {
  it('opens on the default tab when the URL names none', () => {
    expect(readRunDetailTab(new URLSearchParams())).toBe(DEFAULT_RUN_DETAIL_TAB);
  });

  it('opens on the tab the URL names', () => {
    expect(readRunDetailTab(new URLSearchParams(`${RUN_DETAIL_TAB_PARAM}=events`))).toBe('events');
  });

  it('falls back to the default for a tab that does not exist', () => {
    expect(readRunDetailTab(new URLSearchParams(`${RUN_DETAIL_TAB_PARAM}=nope`))).toBe(
      DEFAULT_RUN_DETAIL_TAB,
    );
  });

  it('writes a chosen tab and leaves the other params alone', () => {
    const next = withParams(new URLSearchParams('arStatus=failure'), runDetailTabParams('graph'));
    expect(next.get(RUN_DETAIL_TAB_PARAM)).toBe('graph');
    expect(next.get('arStatus')).toBe('failure');
  });

  it('does not write the default, so a plain run link stays plain', () => {
    const next = withParams(
      new URLSearchParams(`${RUN_DETAIL_TAB_PARAM}=cost`),
      runDetailTabParams(DEFAULT_RUN_DETAIL_TAB),
    );
    expect(next.has(RUN_DETAIL_TAB_PARAM)).toBe(false);
  });
});
