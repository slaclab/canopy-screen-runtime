import { createContext, useContext, useMemo, useSyncExternalStore } from 'react';
import type { EdmPalette } from '../config/colors.js';
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
  readonly openDisplay?: (req: EdmOpenDisplayRequest) => void;
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
    () => new PvStore(env.pv, raw?.trim() ?? '', expanded, by),
    [env.pv, raw, expanded, by]
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

  constructor(layer: EdmPvLayer, raw: string, expanded: string, by: string) {
    this.layer = layer;
    this.raw = raw;
    this.expanded = expanded;
    this.by = by;
  }

  subscribe = (onChange: () => void) => {
    if (!this.expanded) return () => {};
    return this.layer.subscribe(this.raw, this.expanded, this.by, (d) => {
      this.data = d;
      onChange();
    });
  };

  get = () => this.data;
}
