// Shared presentational primitives for the dashboard.

export function PageHeader({ title, children }) {
  return (
    <div className="page-header">
      <h2 className="page-title">{title}</h2>
      {children ? <div className="page-actions">{children}</div> : null}
    </div>
  );
}

export function Subtitle({ children }) {
  return <p className="page-subtitle">{children}</p>;
}

export function Button({ variant = 'ghost', size, className = '', children, ...rest }) {
  const cls = [
    'btn',
    `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : '',
    className,
  ].filter(Boolean).join(' ');
  return <button className={cls} {...rest}>{children}</button>;
}

export function Chip({ active, children, ...rest }) {
  return (
    <button className={`filter-chip${active ? ' active' : ''}`} {...rest}>
      {children}
    </button>
  );
}

export function EmptyState({ icon, title, children }) {
  return (
    <div className="empty-state">
      {icon ? <div className="empty-state-icon">{icon}</div> : null}
      {title ? <h3>{title}</h3> : null}
      {children ? <p>{children}</p> : null}
    </div>
  );
}

export function ErrorState({ title = 'Connection Error', message }) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">⚠</div>
      <h3>{title}</h3>
      <p>{message}</p>
    </div>
  );
}

export function Skeleton({ count = 5 }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div className="skeleton skeleton-card" key={i} />
      ))}
    </>
  );
}
