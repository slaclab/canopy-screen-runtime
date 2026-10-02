// /edl/<path>?MACRO=value — a legacy EDM screen rendered directly from its
// .edl file (the faithful look, no conversion). The path is relative to the
// display root the EDM endpoint serves (EDMDATAFILES-style search).
//
// Reserved query parameters (never macros): render, impl, look.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { EdmDocument, EdmOpenDisplayRequest } from '@slaclab/canopy-edm';
import {
  EdmPalette,
  EdmPvLayer,
  EdmScreen,
  batchedPvServiceConnection,
  calcConnection,
  edlName,
  httpDisplaySource,
  localConnection,
  parseCalcList,
  parseDisplay,
  propStr,
  pvServiceConnection,
  screenFonts,
} from '@slaclab/canopy-edm';
import { ErrorPanel } from '../ErrorPanel.js';
import { useServices } from '../services.js';

export const EDL_RESERVED_PARAMS = new Set(['render', 'impl', 'look']);

interface SiteConfig {
  palette: EdmPalette;
  /** calc.list: named CALC\\ expressions. */
  calcs: Map<string, string>;
}

let siteCache: { base: string; config: Promise<SiteConfig> } | null = null;

function loadSite(base: string): Promise<SiteConfig> {
  if (siteCache?.base !== base) {
    const source = httpDisplaySource(base);
    const config = Promise.all([
      source.config('colors.list').then((t) => EdmPalette.parse(t)),
      // A site without a calc.list simply has no named calcs.
      source.config('calc.list').then(parseCalcList, () => new Map<string, string>()),
    ]).then(([palette, calcs]) => ({ palette, calcs }));
    siteCache = { base, config };
    config.catch(() => {
      siteCache = null;
    });
  }
  return siteCache.config;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; title: string; detail?: string }
  | { status: 'ready'; path: string; doc: EdmDocument; site: SiteConfig };

function useEdmDocument(base: string, path: string): LoadState {
  const key = `${base}|${path}`;
  const [loaded, setLoaded] = useState<{ key: string; state: LoadState } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const source = httpDisplaySource(base);
    (async (): Promise<LoadState> => {
      const [site, file] = await Promise.all([loadSite(base), source.load(path)]);
      const doc = parseDisplay(file.path, file.text);
      if (typeof document !== 'undefined' && document.fonts) {
        // Load the fonts this screen draws with before it appears, so neither a
        // screenshot nor an operator sees the fallback font first.
        const fonts = [...screenFonts(doc), '9px Arimo'];
        await Promise.all(fonts.map((f) => document.fonts.load(f).catch(() => [])));
      }
      return { status: 'ready', path: file.path, doc, site };
    })().then(
      (state) => !cancelled && setLoaded({ key, state }),
      (err: unknown) =>
        !cancelled &&
        setLoaded({
          key,
          state: {
            status: 'error',
            title: `Could not load ${path}`,
            detail: err instanceof Error ? err.message : String(err),
          },
        })
    );
    return () => {
      cancelled = true;
    };
  }, [base, path, key]);
  return loaded && loaded.key === key ? loaded.state : { status: 'loading' };
}

declare global {
  interface Window {
    /** Debug/harness hook: what the current EDM screen subscribed. */
    __canopyEdm?: { path: string; layer: EdmPvLayer };
  }
}

export function EdlPage({ edmBaseUrl }: { edmBaseUrl: string }) {
  const path = useParams()['*'] ?? '';
  const [searchParams] = useSearchParams();
  const services = useServices();
  const state = useEdmDocument(edmBaseUrl, path);
  const [windowId] = useState(() => `w${Math.random().toString(36).slice(2, 8)}`);

  const macros = useMemo(() => {
    const out: Record<string, string> = {};
    for (const [name, value] of searchParams.entries()) {
      if (!EDL_RESERVED_PARAMS.has(name)) out[name] = value;
    }
    // EDM's window- and application-unique macros.
    out['!W'] ??= windowId;
    out['!A'] ??= 'canopy';
    return out;
  }, [searchParams, windowId]);

  // One PV layer per displayed screen: EPICS through Hare (its own sockets,
  // with channel metadata) or the viewer's PV service, LOC\ locals scoped to
  // this window, CALC\ expressions (calc.list names) evaluated in the page
  // over the layer.
  const calcs = state.status === 'ready' ? state.site.calcs : undefined;
  const layer = useMemo(() => {
    void path;
    const epics = services.createHare
      ? batchedPvServiceConnection(services.createHare)
      : pvServiceConnection(services.hare ?? services.pv);
    const l = new EdmPvLayer().register('epics', epics).register('loc', localConnection());
    return l.register('calc', calcConnection(l, calcs ?? new Map()));
  }, [services, path, calcs]);

  useEffect(() => {
    window.__canopyEdm = { path, layer };
    return () => {
      if (window.__canopyEdm?.layer === layer) delete window.__canopyEdm;
    };
  }, [path, layer]);

  const title = state.status === 'ready' ? propStr(state.doc.screen, 'title') || path : path;
  useEffect(() => {
    document.title = title;
  }, [title]);

  // Exit buttons and closeAction: a script may only close a tab it opened
  // (related displays are), otherwise go back.
  const closeDisplay = useCallback(() => {
    window.close();
    if (!window.closed && window.history.length > 1) window.history.back();
  }, []);

  const source = useMemo(() => httpDisplaySource(edmBaseUrl), [edmBaseUrl]);
  const openDisplay = useMemo(() => {
    return (req: EdmOpenDisplayRequest) => {
      // Resolve like EDM (relative to the referring screen), then open the
      // canonical /edl/<path> URL in a new tab.
      const win = window.open('', '_blank');
      const name = edlName(req.file);
      source.load(name, req.fromPath).then(
        (found) => {
          const q = new URLSearchParams();
          for (const [k, v] of Object.entries(req.macros)) if (!k.startsWith('!')) q.set(k, v);
          const url = `/edl/${found.path}${q.size ? `?${q}` : ''}`;
          if (win) win.location.href = url;
          else window.location.href = url;
          // closeAction: EDM closes the referring display once the new one is up.
          if (win && req.replace) closeDisplay();
        },
        (err: unknown) => {
          win?.close();
          console.error(`related display ${req.file}:`, err);
        }
      );
    };
  }, [source, closeDisplay]);

  if (state.status === 'loading')
    return <div className="edl-page edl-loading">Loading {path}…</div>;
  if (state.status === 'error') return <ErrorPanel title={state.title} detail={state.detail} />;
  return (
    <div className="edl-page">
      <EdmScreen
        doc={state.doc}
        palette={state.site.palette}
        pv={layer}
        macros={macros}
        path={state.path}
        openDisplay={openDisplay}
        closeDisplay={closeDisplay}
        source={source}
      />
    </div>
  );
}
