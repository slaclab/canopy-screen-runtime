// Browse/search over the content manifest: title/category/id filter, one
// link card per screen (its variants listed when it has several).

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Search } from '@carbon/react';
import { AppHeader } from '@slaclab/canopy-shell';
import type { Manifest } from '../api.js';
import { fetchManifest } from '../api.js';
import { ErrorPanel } from '../ErrorPanel.js';
import type { LogicalScreen } from '../variants.js';
import { groupScreens, notViewable, variantLabel } from '../variants.js';

function matches(screen: LogicalScreen, query: string): boolean {
  if (!query) return true;
  const q = query.toLowerCase();
  return (
    screen.variants.some((v) => v.entry.title.toLowerCase().includes(q)) ||
    screen.category.toLowerCase().includes(q) ||
    screen.id.toLowerCase().includes(q)
  );
}

function ScreenCard({ screen }: { screen: LogicalScreen }) {
  const first = screen.variants[0];
  const viewable = screen.variants.some((v) => !notViewable(v));
  const body = (
    <>
      <span className="screen-card__title">{first.entry.title}</span>
      <span className="screen-card__meta">
        {screen.category} / {screen.id}
      </span>
      {screen.variants.length > 1 && (
        <span className="screen-card__variants">
          {screen.variants.map(variantLabel).join(' / ')}
        </span>
      )}
      {!viewable && (
        <span className="screen-card__note">
          {first.impl === 'react' ? 'code' : variantLabel(first)} screen — not yet viewable
        </span>
      )}
    </>
  );

  if (!viewable) {
    return <div className="screen-card screen-card--disabled">{body}</div>;
  }
  return (
    <Link
      className="screen-card"
      // Encode each segment but keep slashes as separators so the splat route matches.
      to={`/s/${encodeURIComponent(screen.category)}/${screen.id
        .split('/')
        .map(encodeURIComponent)
        .join('/')}`}
    >
      {body}
    </Link>
  );
}

export function BrowsePage({ screensBaseUrl }: { screensBaseUrl: string }) {
  const [manifest, setManifest] = useState<Manifest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetchManifest(screensBaseUrl).then(
      (m) => {
        if (!cancelled) setManifest(m);
      },
      (err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    );
    return () => {
      cancelled = true;
    };
  }, [screensBaseUrl]);

  const screens = useMemo(() => groupScreens(manifest?.screens ?? []), [manifest]);
  const visible = useMemo(() => screens.filter((s) => matches(s, query)), [screens, query]);

  return (
    <div className="viewer-page">
      <AppHeader title="Canopy Screens" />
      <main className="viewer-content">
        {error && <ErrorPanel title="Could not load the screen manifest" detail={error} />}
        {!error && !manifest && <p className="viewer-loading">Loading manifest…</p>}
        {manifest && (
          <>
            <Search
              id="screen-search"
              labelText="Search screens"
              placeholder="Filter by title, category, or id"
              value={query}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
            />
            <div className="screen-card-grid">
              {visible.map((s) => (
                <ScreenCard key={s.key} screen={s} />
              ))}
              {visible.length === 0 && <p>No screens match “{query}”.</p>}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
