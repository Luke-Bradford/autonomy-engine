import { useRoute } from './router';
import { ConnectionsPage } from './pages/ConnectionsPage';
import { PipelinesPage } from './pages/PipelinesPage';
import { TriggersPage } from './pages/TriggersPage';

interface NavItem {
  path: string;
  label: string;
  ready: boolean;
}

/**
 * The nav mirrors the MVP-bar flow (Connections → Pipelines → Triggers → Runs).
 * Connections (P5a), Pipelines (P5c canvas), and Triggers (P5b) are built; Runs
 * (P6 live monitor) is an honest placeholder so the shell is complete and the
 * final phase drops straight in without reworking navigation.
 */
const NAV: NavItem[] = [
  { path: '/connections', label: 'Connections', ready: true },
  { path: '/pipelines', label: 'Pipelines', ready: true },
  { path: '/triggers', label: 'Triggers', ready: true },
  { path: '/runs', label: 'Runs', ready: false },
];

function ComingSoon({ label, phase }: { label: string; phase: string }) {
  return (
    <section>
      <h2>{label}</h2>
      <p>This section arrives in {phase}.</p>
    </section>
  );
}

function routeContent(path: string) {
  // Default to Connections (the built page) for '/' and any unknown route.
  if (path === '/pipelines') return <PipelinesPage />;
  if (path === '/triggers') return <TriggersPage />;
  if (path === '/runs') return <ComingSoon label="Runs" phase="P6 (live monitor)" />;
  return <ConnectionsPage />;
}

export default function App() {
  const path = useRoute();
  const activePath = path === '/' ? '/connections' : path;

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
      <main className="content">{routeContent(activePath)}</main>
    </div>
  );
}
