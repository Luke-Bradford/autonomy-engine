import { Link } from 'react-router';
import { HUBS } from '../shell/hubs';

/**
 * The Home hub's landing page.
 *
 * Deliberately thin: U15 is the ticket that builds the real overview (recent
 * runs, shortcuts, master-key status). What it must do TODAY is be a real
 * destination rather than a blank panel — `/` is both the app's entry point and
 * the catch-all target, so it is the first thing a new user and a stale
 * bookmark both land on. Signposting the hubs is the minimum that makes it one.
 */
export function HomePage() {
  const hubs = HUBS.filter((hub) => hub.id !== 'home');

  return (
    <>
      <div className="page-header">
        <h2>Home</h2>
      </div>
      <p className="page-hint">
        Author pipelines, watch them run, and manage the connections and triggers that drive them.
      </p>
      <ul className="hub-cards">
        {hubs.map((hub) => (
          <li key={hub.id}>
            <Link to={hub.path}>{hub.label}</Link>
          </li>
        ))}
      </ul>
    </>
  );
}
