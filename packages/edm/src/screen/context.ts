import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { EdmPalette } from '../config/colors.js';
import type { EdmDisplaySource } from '../loader/source.js';
import type { EdmDocument } from '../model.js';
import { expandMacros } from '../macros.js';
import type { EdmMacros } from '../macros.js';
import type { EdmPvLayer } from '../pv/layer.js';
import type { EdmPvData } from '../pv/types.js';

/** A related display (or other navigation) the screen asks its host to open. */
export interface EdmOpenDisplayRequest {
  /** displayFileName as written (macros expanded). */
  readonly file: string;
  /** Path of the screen the request comes from (for EDM's relative lookup). */
  readonly fromPath: string;
  readonly macros: EdmMacros;
  /** closeAction / "replace current" hint. */
  readonly replace: boolean;
}

export interface EdmScreenEnv {
  readonly palette: EdmPalette;
  readonly pv: EdmPvLayer;
  readonly macros: EdmMacros;
  /** Path of the displayed file under the display root, e.g. misc/sdr_fb.edl. */
  readonly path: string;
  /** Display background (screen bgColor), for widgets that use it. */
  readonly displayBg: string;
  /** Display foreground (screen fgColor): EDM's hover rectangle colour. */
  readonly displayFg: string;
  readonly openDisplay?: (req: EdmOpenDisplayRequest) => void;
  /** Close this display (exit button, closeAction); the host decides how. */
  readonly closeDisplay?: () => void;
  /** Where embedded displays, symbol files and images come from. */
  readonly source?: EdmDisplaySource;
  /** The page's parsed-file cache (shared by every embedded display). */
  readonly docs?: EdmDocCache;
  /**
   * '' for the displayed screen; inside an embedded display or symbol file,
   * the chain of files it came through (recorded with its PV subscriptions).
   */
  readonly scope: string;
  /** Paths of the displays this one is embedded in, outermost first (recursion guard). */
  readonly ancestors: readonly string[];
}

/** Parsed display files of one page, loaded once each. */
export interface EdmDocCache {
  /** `relativeTo` is the referring file's path; resolves to the file found and its document. */
  load(file: string, relativeTo: string): Promise<EdmLoadedDoc>;
}

export interface EdmLoadedDoc {
  readonly path: string;
  readonly doc: EdmDocument;
}

export const EdmScreenContext = createContext<EdmScreenEnv | null>(null);

export function useEdmScreen(): EdmScreenEnv {
  const env = useContext(EdmScreenContext);
  if (!env) throw new Error('EDM widgets must render inside <EdmScreen>');
  return env;
}

export function useExpanded(s: string | undefined): string | undefined {
  const { macros } = useEdmScreen();
  return s === undefined ? undefined : expandMacros(s, macros);
}

/**
 * Live data of one EDM PV string (macros expanded here). `by` names the
 * subscriber ("<class>.<prop>") for the PV-parity record. Undefined when the
 * property is empty or before the first update arrives.
 */
export function useEdmPv(raw: string | undefined, by: string): EdmPvData | undefined {
  const env = useEdmScreen();
  const expanded = raw?.trim() ? expandMacros(raw.trim(), env.macros) : '';
  const store = useMemo(
    () => new PvStore(env.pv, raw?.trim() ?? '', expanded, by, env.scope),
    [env.pv, raw, expanded, by, env.scope]
  );
  return useSyncExternalStore(store.subscribe, store.get, store.get);
}

/** One widget property's PV as a useSyncExternalStore source. */
class PvStore {
  private data: EdmPvData | undefined;
  private readonly layer: EdmPvLayer;
  private readonly raw: string;
  private readonly expanded: string;
  private readonly by: string;
  private readonly scope: string;

  constructor(layer: EdmPvLayer, raw: string, expanded: string, by: string, scope: string) {
    this.layer = layer;
    this.raw = raw;
    this.expanded = expanded;
    this.by = by;
    this.scope = scope;
  }

  subscribe = (onChange: () => void) => {
    if (!this.expanded) return () => {};
    return this.layer.subscribe(
      this.raw,
      this.expanded,
      this.by,
      (d) => {
        this.data = d;
        onChange();
      },
      this.scope
    );
  };

  get = () => this.data;
}

/** Write to an EDM PV string (macros expanded here), e.g. from a button press. */
export function useEdmPut(): (raw: string | undefined, value: number | string) => void {
  const env = useEdmScreen();
  return (raw, value) => {
    const name = raw?.trim();
    if (name) env.pv.put(expandMacros(name, env.macros), value);
  };
}

/** EDM's unconnectedTimer: how long an object waits before drawing its unconnected look. */
export const UNCONNECTED_MS = 2000;

/**
 * An object's connection phase, as EDM's init flag and unconnected timer
 * give it. `pvs` holds the data of every PV the object defines:
 *   waiting      not all connected yet, under 2 s since activation: EDM draws nothing
 *   unconnected  still not all connected after 2 s: the unconnected placeholder
 *   init         every PV has connected at least once. This latches: a later
 *                disconnect keeps the normal shape, in the disconnected colour.
 */
export type EdmPhase = 'waiting' | 'unconnected' | 'init';

export function usePhase(pvs: readonly (EdmPvData | undefined)[]): EdmPhase {
  const all = pvs.every((d) => d?.connected);
  const [latched, setLatched] = useState(all);
  const [timedOut, setTimedOut] = useState(false);
  if (all && !latched) setLatched(true);
  useEffect(() => {
    const t = setTimeout(() => setTimedOut(true), UNCONNECTED_MS);
    return () => clearTimeout(t);
  }, []);
  return latched || all ? 'init' : timedOut ? 'unconnected' : 'waiting';
}
