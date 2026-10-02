// Display files loaded at run time: embedded displays (activePipClass) and
// symbol files (activeSymbolClass). Each file is fetched and parsed once per
// page, and the fonts it draws with are loaded before it is shown, as for
// the displayed screen itself.

import { useEffect, useState } from 'react';
import { parseDisplay } from '../loader/source.js';
import type { EdmDisplaySource } from '../loader/source.js';
import { screenFonts } from './fonts.js';
import type { EdmDocCache, EdmLoadedDoc } from './context.js';
import { useEdmScreen } from './context.js';

/** EDM appends `.edl` to a display name without an extension. */
export function edlName(file: string): string {
  return /\.[a-z0-9]+$/i.test(file) ? file : `${file}.edl`;
}

export function docCache(source: EdmDisplaySource): EdmDocCache {
  const cache = new Map<string, Promise<EdmLoadedDoc>>();
  return {
    load(file, relativeTo) {
      const key = `${relativeTo}\u0000${file}`;
      let p = cache.get(key);
      if (!p) {
        p = source.load(edlName(file), relativeTo).then(async ({ path, text }) => {
          const doc = parseDisplay(path, text);
          if (typeof document !== 'undefined' && document.fonts) {
            await Promise.all(screenFonts(doc).map((f) => document.fonts.load(f).catch(() => [])));
          }
          return { path, doc };
        });
        cache.set(key, p);
      }
      return p;
    },
  };
}

export type EdmDocState =
  | { readonly status: 'none' }
  | { readonly status: 'loading' }
  | { readonly status: 'missing'; readonly error: string }
  | ({ readonly status: 'ready' } & EdmLoadedDoc);

/**
 * A display file named by an object of this screen (macros already expanded),
 * found relative to this screen as EDM does. `none` without a name or loader.
 */
export function useEdmDoc(file: string | undefined): EdmDocState {
  const { docs, path } = useEdmScreen();
  const name = file?.trim() ?? '';
  const key = docs && name ? `${path}\u0000${name}` : '';
  const [loaded, setLoaded] = useState<{ key: string; state: EdmDocState } | null>(null);
  useEffect(() => {
    if (!key || !docs) return;
    let cancelled = false;
    docs.load(name, path).then(
      (d) => !cancelled && setLoaded({ key, state: { status: 'ready', ...d } }),
      (err: unknown) =>
        !cancelled &&
        setLoaded({
          key,
          state: { status: 'missing', error: err instanceof Error ? err.message : String(err) },
        })
    );
    return () => {
      cancelled = true;
    };
  }, [key, docs, name, path]);
  if (!key) return { status: 'none' };
  return loaded && loaded.key === key ? loaded.state : { status: 'loading' };
}
