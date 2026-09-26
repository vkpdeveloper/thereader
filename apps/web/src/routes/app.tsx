import { Link, Outlet, useLocation } from '@tanstack/react-router';

const tabs = [
  { path: '/app/library', label: 'Library' },
  { path: '/app/browse', label: 'Browse' },
  { path: '/app/settings', label: 'Settings' },
];

export default function AppLayout() {
  const { pathname } = useLocation();
  return (
    <>
      <Outlet />
      <nav className="tab-row">
        {tabs.map((t) => (
          <Link
            key={t.path}
            to={t.path}
            className={`tab ${pathname === t.path || pathname.startsWith(`${t.path}/`) ? 'active' : ''}`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </>
  );
}
