import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { AppMark } from './icons';

const destinations = [
  { to: '/library', label: 'Library' },
  { to: '/browse', label: 'Browse' },
  { to: '/settings', label: 'Settings' },
] as const;

/**
 * Three quiet destinations. Wide screens get a left sidebar with the app
 * mark; narrow screens keep the mobile text tab row at the bottom.
 */
export function AppShell() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <div className="shell">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <nav className="sidebar" aria-label="Main">
        <Link to="/library" className="sidebar-brand" aria-label="The Reader, Library">
          <AppMark size={26} />
          <span>The Reader</span>
        </Link>
        <ul className="sidebar-list">
          {destinations.map((d) => (
            <li key={d.to}>
              <Link to={d.to} className="sidebar-link" activeProps={{ className: 'is-active' }}>
                {d.label}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <main className="shell-main" id="main" tabIndex={-1}>
        <div key={pathname} className="page page-fade">
          <Outlet />
        </div>
      </main>
      <nav className="tab-row" aria-label="Main">
        {destinations.map((d) => (
          <Link key={d.to} to={d.to} className="tab" activeProps={{ className: 'is-active' }}>
            {d.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}
