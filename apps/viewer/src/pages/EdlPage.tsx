// /edl/<path>?MACRO=value — a legacy EDM screen rendered directly from its
// .edl file (the faithful look, no conversion). The path is relative to the
// display root the EDM endpoint serves (EDMDATAFILES-style search).
//
// Reserved query parameters (never macros): render, impl, look.

import { useEffect, useMemo, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { EdmDocument, EdmOpenDisplayRequest } from '@slaclab/canopy-edm';
import {
  EdmPalette,
  EdmPvLayer,
  EdmScreen,
  httpDisplaySource,
  localConnection,
  parseDisplay,
  propStr,
  pvServiceConnection,
  screenFonts,
} from '@slaclab/canopy-edm';
import { ErrorPanel } from '../ErrorPanel.js';
import { useServices } from '../services.js';

export const EDL_RESERVED_PARAMS = new Set(['render', 'impl', 'look']);

let paletteCache: { base: string; palette: Promise<EdmPalette> } | null = null;

function loadPalette(base: string): Promise<EdmPalette> {
  if (paletteCache?.base !== base) {
    const source = httpDisplaySource(base);
    paletteCache = { base, palette: source.config('colors.list').then((t) => EdmPalette.parse(t)) };
    paletteCache.palette.catch(() => {
      paletteCache = null;
    });
  }
  return paletteCache.palette;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; title: string; detail?: string }
  | { status: 'ready'; path: string; doc: EdmDocument; palette: EdmPalette };

function useEdmDocument(base: string, path: string): LoadState {
  const key = `${base}|${path}`;
  const [loaded, setLoaded] = useState<{ key: string; state: LoadState } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const source = httpDisplaySource(base);
    (async (): Promise<LoadState> => {
      const [palette, file] = await Promise.all([loadPalette(base), source.load(path)]);
      const doc = parseDisplay(file.path, file.text);
      if (typeof document !== 'undefined' && document.fonts) {
        // Load the fonts this screen draws with before it appears, so neither a
        // screenshot nor an operator sees the fallback font first.
        const fonts = [...screenFonts(doc), '9px Arimo'];
        await Promise.all(fonts.map((f) => document.fonts.load(f).catch(() => [])));
      }
      return { status: 'ready', path: file.path, doc, palette };
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

  // One PV layer per displayed screen: EPICS through Hare (with its channel
  // metadata) or the viewer's PV service, LOC\ locals scoped to this window.
  const layer = useMemo(() => {
    void path;
    return new EdmPvLayer()
      .register('epics', pvServiceConnection(services.hare ?? services.pv))
      .register('loc', localConnection());
  }, [services, path]);

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

  const openDisplay = useMemo(() => {
    const source = httpDisplaySource(edmBaseUrl);
    return (req: EdmOpenDisplayRequest) => {
      // Resolve like EDM (relative to the referring screen), then open the
      // canonical /edl/<path> URL in a new tab.
      const win = window.open('', '_blank');
      const name = /\.[a-z]+$/i.test(req.file) ? req.file : `${req.file}.edl`;
      source.load(name, req.fromPath).then(
        (found) => {
          const q = new URLSearchParams();
          for (const [k, v] of Object.entries(req.macros)) if (!k.startsWith('!')) q.set(k, v);
          const url = `/edl/${found.path}${q.size ? `?${q}` : ''}`;
          if (win) win.location.href = url;
          else window.location.href = url;
        },
        (err: unknown) => {
          win?.close();
          console.error(`related display ${req.file}:`, err);
        }
      );
    };
  }, [edmBaseUrl]);

  if (state.status === 'loading')
    return <div className="edl-page edl-loading">Loading {path}…</div>;
  if (state.status === 'error') return <ErrorPanel title={state.title} detail={state.detail} />;
  return (
    <div className="edl-page">
      <EdmScreen
        doc={state.doc}
        palette={state.palette}
        pv={layer}
        macros={macros}
        path={state.path}
        openDisplay={openDisplay}
      />
    </div>
  );
}
