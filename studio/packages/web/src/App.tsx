import { useRoute } from './router';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { PipelinesPage } from './pages/PipelinesPage';
import { TriggersPage } from './pages/TriggersPage';
import { RunsPage } from './pages/runs/RunsPage';
import { RunDetailPage } from './pages/runs/RunDetailPage';

interface NavItem {
  path: string;
  label: string;
  ready: boolean;
}

/**
 * The nav mirrors the MVP-bar flow (Connections → Pipelines → Triggers → Runs).
 * All four are now built: Connections (P5a), Pipelines (P5c canvas), Triggers
 * (P5b), and Runs (P6 live monitor).
 */
const NAV: NavItem[] = [
  { path: '/connections', label: 'Connections', ready: true },
  { path: '/pipelines', label: 'Pipelines', ready: true },
  { path: '/triggers', label: 'Triggers', ready: true },
  { path: '/runs', label: 'Runs', ready: true },
];

const RUN_DETAIL_PREFIX = '/runs/';

function routeContent(path: string) {
  // Default to Connections (the built page) for '/' and any unknown route.
  if (path === '/pipelines') return <PipelinesPage />;
  if (path === '/triggers') return <TriggersPage />;
  if (path === '/runs') return <RunsPage />;
  if (path.startsWith(RUN_DETAIL_PREFIX)) {
    const id = decodeURIComponent(path.slice(RUN_DETAIL_PREFIX.length));
    // key={id} so navigating between runs remounts with fresh state.
    return id ? <RunDetailPage key={id} runId={id} /> : <RunsPage />;
  }
  return <ConnectionsPage />;
}

/** The nav section a path belongs to (so a run-detail path keeps Runs active). */
function navSection(path: string): string {
  if (path === '/') return '/connections';
  if (path === '/runs' || path.startsWith(RUN_DETAIL_PREFIX)) return '/runs';
  return path;
}

export default function App() {
  const path = useRoute();
  const activePath = navSection(path);

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1 className="brand">autonomy&nbsp;studio</h1>
        <nav aria-label="Primary">
          <ul>
            {NAV.map((item) => (
              <li key={item.path}>
                <a
                  href={`#${item.path}`}
                  aria-current={activePath === item.path ? 'page' : undefined}
                  className={activePath === item.path ? 'active' : undefined}
                >
                  {item.label}
                  {!item.ready && <span className="badge">soon</span>}
                </a>
              </li>
            ))}
          </ul>
        </nav>
      </aside>
      <main className="content">{routeContent(path)}</main>
    </div>
  );
}
