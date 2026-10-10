/**
 * Every page with a static route and a title, and how many toolbar controls
 * its header shows (so a toolbar check never passes empty). Shared by the specs
 * that walk every page (`page-header`, `heading-structure`).
 */
export const TITLED_PAGES: readonly { path: string; title: string; controls: number }[] = [
  { path: '/', title: 'Home', controls: 0 },
  { path: '/settings', title: 'Settings', controls: 0 },
  { path: '/author/pipelines', title: 'Pipelines', controls: 3 },
  { path: '/monitor/runs', title: 'Runs', controls: 9 },
  { path: '/monitor/ai', title: 'AI activity', controls: 1 },
  { path: '/monitor/audit', title: 'Audit', controls: 1 },
  { path: '/manage/connections', title: 'Connections', controls: 1 },
  { path: '/manage/datasets', title: 'Datasets', controls: 1 },
  { path: '/manage/secrets', title: 'Secrets', controls: 1 },
  { path: '/manage/global-params', title: 'Global parameters', controls: 1 },
  { path: '/manage/triggers', title: 'Triggers', controls: 1 },
  { path: '/manage/git', title: 'Git', controls: 0 },
  { path: '/no-such-page', title: 'Page not found', controls: 0 },
];
