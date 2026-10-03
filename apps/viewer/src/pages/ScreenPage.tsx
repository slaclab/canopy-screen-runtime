// /s/:category/* — one screen of the manifest, in the variant chosen by
// variants.ts (link, then this user's choice, then the site policy, then the
// manifest's first viewable variant), with ?MACRO=value query macros. The
// screen id is the splat, so nested ids ("CBXFEL/Landing") match. A screen
// with several variants gets a switcher in the header.
//
// Reserved query parameters (never macros): `render` (edm | carbon, the IR
// render mode, overriding VITE_RENDER_MODE), `impl` and `look` (the variant).

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PVServiceProvider } from '@slaclab/canopy-react';
import { SCHEMA_VERSION } from '@slaclab/canopy-screen-ir';
import type { ScreenJSON } from '@slaclab/canopy-screen-ir';
import {
  DEFAULT_RENDER_MODE,
  FormulaSubscriberContext,
  parseRenderMode,
  ScreenRenderer,
} from '@slaclab/canopy-screen-runtime';
import type { RenderMode } from '@slaclab/canopy-screen-runtime';
import { AppHeader } from '@slaclab/canopy-shell';
import type { ManifestScreen } from '../api.js';
import { fetchManifest, fetchScreenDocument, makeResolveAsset, makeResolveScreen } from '../api.js';
import { ErrorPanel, ScreenErrorBoundary } from '../ErrorPanel.js';
import { IMPL_QUERY_PARAM, LOOK_QUERY_PARAM, RENDER_QUERY_PARAM, queryMacros } from '../macros.js';
import { browserPreferences } from '../preferences.js';
import type { VariantPreferences } from '../preferences.js';
import { useServices } from '../services.js';
import type {
  LogicalScreen,
  ScreenPolicy,
  ScreenVariant,
  VariantPick,
  VariantSource,
} from '../variants.js';
import {
  EMPTY_POLICY,
  chooseVariant,
  findScreen,
  matchVariant,
  notViewable,
  variantLabel,
} from '../variants.js';
import { EdlView } from './EdlView.js';

export { RENDER_QUERY_PARAM } from '../macros.js';

type Loaded<T> =
  | { status: 'loading' }
  | { status: 'error'; title: string; detail?: string }
  | ({ status: 'ready' } & T);

/**
 * Run `load` for `key`; the result is tagged with the key it answered, so a
 * route change reads as "loading" instead of being reset inside the effect.
 */
function useLoaded<T>(key: string, load: () => Promise<Loaded<T>>, failure: string): Loaded<T> {
  const [loaded, setLoaded] = useState<{ key: string; state: Loaded<T> } | null>(null);
  useEffect(() => {
    let cancelled = false;
    load().then(
      (state) => {
        if (!cancelled) setLoaded({ key, state });
      },
      (err: unknown) => {
        if (!cancelled)
          setLoaded({
            key,
            state: {
              status: 'error',
              title: failure,
              detail: err instanceof Error ? err.message : String(err),
            },
          });
      }
    );
    return () => {
      cancelled = true;
    };
    // `load` is a fresh closure every render; `key` names what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return loaded && loaded.key === key ? loaded.state : { status: 'loading' };
}

function useManifestScreen(
  screensBaseUrl: string,
  category: string | undefined,
  id: string | undefined
): Loaded<{ screen: LogicalScreen }> {
  return useLoaded<{ screen: LogicalScreen }>(
    `${screensBaseUrl}|${category}|${id}`,
    async () => {
      const manifest = await fetchManifest(screensBaseUrl);
      const screen = findScreen(manifest.screens, category, id);
      if (!screen)
        return { status: 'error', title: `No screen '${category}/${id}' in the manifest` };
      return { status: 'ready', screen };
    },
    'Could not load the screen'
  );
}

/** The site policy for a screen with variants, or undefined while it loads. */
function useSitePolicy(needed: boolean): ScreenPolicy | undefined {
  const { screenPolicy } = useServices();
  const [policy, setPolicy] = useState<ScreenPolicy | undefined>(undefined);
  useEffect(() => {
    if (!needed || !screenPolicy) return;
    let cancelled = false;
    void screenPolicy().then((p) => !cancelled && setPolicy(p));
    return () => {
      cancelled = true;
    };
  }, [needed, screenPolicy]);
  return needed && screenPolicy ? policy : EMPTY_POLICY;
}

/** This user's choice for a screen, and a setter that remembers it. */
function useUserPick(
  prefs: VariantPreferences,
  key: string
): [VariantPick | null, (pick: VariantPick | null) => void] {
  const [saved, setSaved] = useState<{ key: string; pick: VariantPick | null } | null>(null);
  const pick = saved && saved.key === key ? saved.pick : prefs.get(key);
  return [
    pick,
    (next) => {
      prefs.set(key, next);
      setSaved({ key, pick: next });
    },
  ];
}

const SOURCE_TEXT: Record<VariantSource, string> = {
  link: 'from the link',
  user: 'your choice',
  site: 'site default',
  listed: 'first listed',
};

function VariantSwitcher({
  screen,
  current,
  source,
  userPick,
  onSelect,
  onKeep,
  onForget,
}: {
  screen: LogicalScreen;
  current: ScreenVariant | undefined;
  source: VariantSource;
  userPick: VariantPick | null;
  onSelect: (v: ScreenVariant) => void;
  onKeep: (v: ScreenVariant) => void;
  onForget: () => void;
}) {
  const index = current ? screen.variants.indexOf(current) : -1;
  const kept =
    !!current &&
    !!userPick &&
    userPick.impl === current.impl &&
    (userPick.look ?? '') === current.look;
  return (
    <div className="viewer-variant">
      <label className="viewer-variant__label">
        <span>Variant</span>
        <select
          aria-label="Screen variant"
          value={index}
          onChange={(e) => {
            const v = screen.variants[Number(e.target.value)];
            if (v) onSelect(v);
          }}
        >
          {index < 0 && <option value={-1}>—</option>}
          {screen.variants.map((v, i) => (
            <option key={i} value={i} disabled={!!notViewable(v)}>
              {variantLabel(v)}
            </option>
          ))}
        </select>
      </label>
      <span className="viewer-variant__source">{SOURCE_TEXT[source]}</span>
      {current && !notViewable(current) && !kept && (
        <button type="button" className="viewer-variant__action" onClick={() => onKeep(current)}>
          Always open this
        </button>
      )}
      {userPick && (
        <button type="button" className="viewer-variant__action" onClick={onForget}>
          Use site default
        </button>
      )}
    </div>
  );
}

function IrView({
  entry,
  screensBaseUrl,
  macros,
  renderMode,
}: {
  entry: ManifestScreen;
  screensBaseUrl: string;
  macros: Record<string, string>;
  renderMode: RenderMode;
}) {
  const services = useServices();
  const state = useLoaded<{ screen: ScreenJSON }>(
    `${screensBaseUrl}|${entry.path}`,
    async () => {
      const screen = await fetchScreenDocument(screensBaseUrl, entry.path);
      if (screen.schemaVersion !== SCHEMA_VERSION) {
        return {
          status: 'error',
          title: 'Schema version mismatch',
          detail:
            `'${entry.path}' declares schemaVersion ${String(screen.schemaVersion)}, ` +
            `but this viewer speaks ${SCHEMA_VERSION}. Re-save the screen with a matching ` +
            `canopy-screen-builder, or update the viewer.`,
        };
      }
      return { status: 'ready', screen };
    },
    'Could not load the screen'
  );
  const resolveScreen = useMemo(
    () => makeResolveScreen(screensBaseUrl, entry.path),
    [screensBaseUrl, entry.path]
  );
  const resolveAsset = useMemo(
    () => makeResolveAsset(screensBaseUrl, entry.path),
    [screensBaseUrl, entry.path]
  );
  if (state.status === 'loading') return <p className="viewer-loading">Loading screen…</p>;
  if (state.status === 'error') return <ErrorPanel title={state.title} detail={state.detail} />;
  return (
    <ScreenErrorBoundary screenId={state.screen.id}>
      <PVServiceProvider service={services.pv}>
        <FormulaSubscriberContext.Provider value={services.formulas}>
          <div className="viewer-canvas">
            <ScreenRenderer
              screen={state.screen}
              macros={macros}
              resolveScreen={resolveScreen}
              resolveAsset={resolveAsset}
              renderMode={renderMode}
            />
          </div>
        </FormulaSubscriberContext.Provider>
      </PVServiceProvider>
    </ScreenErrorBoundary>
  );
}

export function ScreenPage({
  screensBaseUrl,
  defaultRenderMode = DEFAULT_RENDER_MODE,
  edmBaseUrl = '/displays/edm',
}: {
  screensBaseUrl: string;
  defaultRenderMode?: RenderMode;
  /** The static EDM display tree edm variants are drawn from. */
  edmBaseUrl?: string;
}) {
  const params = useParams();
  const category = params.category;
  const id = params['*']; // splat holds the (possibly slashed) screen id
  const [searchParams, setSearchParams] = useSearchParams();
  const services = useServices();
  const state = useManifestScreen(screensBaseUrl, category, id);
  const screen = state.status === 'ready' ? state.screen : undefined;

  const linkImpl = searchParams.get(IMPL_QUERY_PARAM);
  const linkLook = searchParams.get(LOOK_QUERY_PARAM);
  const link: VariantPick | null = linkImpl
    ? linkLook
      ? { impl: linkImpl, look: linkLook }
      : { impl: linkImpl }
    : null;
  const [userPick, setUserPick] = useUserPick(
    services.preferences ?? browserPreferences,
    screen?.key ?? ''
  );
  // The policy loads for any screen with variants, but is only waited for when neither the
  // link nor the user's own choice decides (so keeping a choice doesn't remount the screen).
  const policy = useSitePolicy(!!screen && screen.variants.length > 1);
  const decided =
    !!link || !!matchVariant(screen?.variants.filter((v) => !notViewable(v)) ?? [], userPick);
  const choice =
    screen && (policy || decided)
      ? chooseVariant(screen, { link, user: userPick, policy: policy ?? EMPTY_POLICY })
      : null;
  const variant = choice?.variant;

  // loc:// locals are screen-scoped (EDM window-local lifetime): reset when
  // the rendered screen changes so one screen's tab state can't leak into
  // the next.
  useEffect(() => {
    return () => services.locals.clear();
  }, [services, category, id, variant]);

  const macros = useMemo(() => queryMacros(searchParams), [searchParams]);
  // An unrecognised ?render= value falls back to the configured default.
  const renderMode = parseRenderMode(searchParams.get(RENDER_QUERY_PARAM)) ?? defaultRenderMode;

  const linkTo = (v: ScreenVariant | null) => {
    const next = new URLSearchParams(searchParams);
    next.delete(IMPL_QUERY_PARAM);
    next.delete(LOOK_QUERY_PARAM);
    if (v) next.set(IMPL_QUERY_PARAM, v.impl);
    if (v?.look) next.set(LOOK_QUERY_PARAM, v.look);
    setSearchParams(next);
  };
  // Keeping or forgetting a choice makes it (or the site default) what opens,
  // so the link's own choice is dropped.
  const keep = (pick: VariantPick | null) => {
    setUserPick(pick);
    if (link) linkTo(null);
  };

  const title = variant?.entry.title ?? screen?.variants[0]?.entry.title ?? 'Canopy Screens';
  // The tab shows the manifest title; an EDM variant then names its own window
  // (its effect runs once the .edl has loaded).
  useEffect(() => {
    document.title = title;
  }, [title, variant]);
  const blocked = variant ? notViewable(variant) : null;

  let body;
  if (state.status === 'error') body = <ErrorPanel title={state.title} detail={state.detail} />;
  else if (!screen || !choice) body = <p className="viewer-loading">Loading screen…</p>;
  else if (!variant)
    body = (
      <ErrorPanel
        title={`No '${link?.impl}${link?.look ? ` · ${link.look}` : ''}' variant of '${screen.key}'`}
        detail={`This screen has: ${screen.variants.map(variantLabel).join(', ')}.`}
      />
    );
  else if (blocked) body = <ErrorPanel title={blocked.title} detail={blocked.detail} />;
  else if (variant.impl === 'edm')
    body = <EdlView path={variant.entry.path} macros={macros} edmBaseUrl={edmBaseUrl} />;
  else
    body = (
      <IrView
        entry={variant.entry}
        screensBaseUrl={screensBaseUrl}
        macros={macros}
        renderMode={renderMode}
      />
    );

  return (
    <div className="viewer-page">
      <AppHeader
        title={title}
        toolbar={
          screen && choice && screen.variants.length > 1 ? (
            <VariantSwitcher
              screen={screen}
              current={variant}
              source={choice.source}
              userPick={userPick}
              onSelect={linkTo}
              onKeep={(v) => keep(v.look ? { impl: v.impl, look: v.look } : { impl: v.impl })}
              onForget={() => keep(null)}
            />
          ) : undefined
        }
      >
        <Link className="viewer-back" to="/">
          All screens
        </Link>
      </AppHeader>
      <main className="viewer-content viewer-content--screen">{body}</main>
    </div>
  );
}
