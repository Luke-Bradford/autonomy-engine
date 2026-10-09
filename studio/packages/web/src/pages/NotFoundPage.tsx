import { Link, useLocation } from 'react-router';
import { PageHeader } from '../lib/PageHeader';

/**
 * #1392 — what an unknown path renders.
 *
 * The catch-all used to redirect to Home, which answered a mistyped or stale
 * link by silently showing a different page: nothing said the link was wrong,
 * and the URL the operator had followed was gone from the address bar. This
 * says so, shows the path that did not match, and offers the way back.
 */
export function NotFoundPage() {
  const { pathname } = useLocation();
  return (
    <section aria-labelledby="not-found-heading">
      <PageHeader title="Page not found" headingId="not-found-heading" />
      <p>
        Nothing lives at <code>{pathname}</code>. The link may be out of date, or the address
        mistyped.
      </p>
      <p>
        <Link to="/">Go to Home</Link>
      </p>
    </section>
  );
}
