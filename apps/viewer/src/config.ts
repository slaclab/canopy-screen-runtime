// Viewer configuration — read at runtime from `config.json` next to the app
// (resolved against document.baseURI), so one build serves any mount path.
// Nothing is baked in at build time.
//
//   pvMode       'mock' | 'hare'. A served config with a missing or unknown
//                value is a live deployment, so it means 'hare'.
//   renderMode   'edm' | 'carbon': how rendered screens present alarms and
//                text metrics (the widget set's RENDER_PROFILES). Missing or
//                unknown -> 'edm'. A screen URL's ?render= overrides it per
//                page.
//   screensPath  where the canopy-screens content (manifest.json +
//                screens/**) lives, relative to the app. Default '.'.
//   themes       screen id -> 'light' | 'dark'; other values are dropped.
//   trace        optional { path, query } for the workspace's Trace tab. Kept
//                only when `path` is a non-empty string (canopy_mcp serves it
//                only when a Trace build is installed); `query` is the default
//                Trace query, a string of at most 4 KB (UTF-8), else ''.
//                Absent -> the key is omitted and the @trace tab is disabled.
//   correlation  optional { path, query } for the correlation plot tool
//                (canopy_mcp: 'trace/correlation.html', present iff that page
//                is installed), parsed exactly like `trace`. Absent -> the
//                @correlation tabs are disabled.
//   waveform     optional { path, query } for the waveform plot tool
//                (canopy_mcp: 'trace/waveform.html', present iff that page is
//                installed), parsed exactly like `correlation`. Absent -> the
//                @waveform tabs are disabled.
//   views        optional { path } where the server keeps saved data browser
//                views (canopy_mcp: 'views'), relative to the app. Kept only
//                when `path` is a non-empty string; absent -> no saved views.
//   collections  optional { path } where the server keeps collections
//                (canopy_mcp: 'collections'); the selection/Pinned/Recent
//                state lives at '<path>-state'. Parsed exactly like `views`;
//                absent -> no popover, Pin, Recent or collection entries.
//   colorScheme  optional flattened color scheme (screen-ir FlatScheme), as
//                canopy_mcp serves it. Checked with parseFlatScheme; a value
//                that fails any check is replaced by the bundled canopy-default
//                scheme (one console.warn). A scheme the server served as a
//                fallback (meta.errors non-empty) is used as served, with one
//                console.warn naming the errors. Absent -> the key is omitted
//                and the viewer uses the bundled default.
//   backend      hare mode only: the data backend's identity { name, label,
//                notice } (notice 'fallback' | 'unservable' | null), or null
//                when the server that serves the viewer (canopy_mcp) could not
//                reach the data backend. A field of the wrong type reads as
//                null; a non-object backend reads as null. Absent (mock mode,
//                an older server) -> the key is omitted.
//   binding      hare mode only: the data backend's binding id
//                ('<target>@<generation>' or the state name), or null; a
//                non-string reads as null. Absent -> the key is omitted. Both
//                seed the backend badge.
//   confirmWrites hare mode: whether a machine write opens a confirmation
//                dialog first. Anything but a literal false means true (an
//                older server, a malformed value: ask). Mock mode and the
//                fallback config: false (no machine writes there). Re-read on
//                every Hare reconnect (createConfirmWritesSource); while a
//                re-read is pending or after it failed it reads as true.
//   workspace    optional { path, protocol } where the serving server keeps
//                the shared workspace routes (canopy_mcp: { path: 'workspace',
//                protocol: 1 }), present only when a single-operator server
//                opts in. Kept only with a non-empty string path and a
//                protocol major this viewer knows (WORKSPACE_PROTOCOL); absent
//                or unknown -> the key is omitted and the viewer makes no
//                workspace request at all.
//   home         optional { screen } naming the library screen that a
//                workspace embedded in a host page opens on its first visit
//                (canopy_mcp: present only when CANOPY_HOME_SCREEN is set).
//                Kept only when `screen` is a non-empty string; the id is
//                resolved against the manifest (category 'library') at first
//                open, and an unknown id falls back like an absent key.
//                Absent or malformed -> omitted.
//
// No Canopy base URL and no API key: the viewer talks to the origin it is
// served from. When config.json is absent or unparseable (vite dev server,
// no canopy_mcp) the viewer runs on mock PVs.

import { canopyDefaultFlat, parseFlatScheme } from '@slaclab/canopy-screen-ir';
import type { FlatScheme } from '@slaclab/canopy-screen-ir';
import { DEFAULT_RENDER_MODE, parseRenderMode } from '@slaclab/canopy-screen-runtime';
import type { RenderMode } from '@slaclab/canopy-screen-runtime';

export type ThemeName = 'light' | 'dark';

export interface ViewerConfig {
  pvMode: 'mock' | 'hare';
  renderMode: RenderMode;
  screensPath: string;
  themes: Record<string, ThemeName>;
  trace?: TraceConfig;
  correlation?: ToolConfig;
  waveform?: ToolConfig;
  views?: ViewsConfig;
  collections?: CollectionsConfig;
  colorScheme?: FlatScheme;
  backend?: ConfigBackend | null;
  binding?: string | null;
  /** Hare mode: ask before every machine write (see the header). False in mock mode. */
  confirmWrites: boolean;
  workspace?: WorkspaceConfig;
  home?: HomeConfig;
}

/** The first-open home of a workspace embedded in a host page: a library screen id. */
export interface HomeConfig {
  screen: string;
}

/** The workspace protocol major this viewer speaks. */
export const WORKSPACE_PROTOCOL = 1;

/** The server's workspace advertisement: the workspace routes live under `path`. */
export interface WorkspaceConfig {
  /** The workspace routes' base path, relative to the viewer (e.g. 'workspace'). */
  path: string;
  /** The protocol major; always WORKSPACE_PROTOCOL once parsed. */
  protocol: typeof WORKSPACE_PROTOCOL;
}

/** The data backend's identity as config.json serves it (canopy_mcp, hare mode). */
export interface ConfigBackend {
  name: string | null;
  label: string | null;
  notice: 'fallback' | 'unservable' | null;
}

export interface ViewsConfig {
  /** The saved-views collection, relative to the viewer (e.g. 'views'). */
  path: string;
}

export interface CollectionsConfig {
  /** The collections store, relative to the viewer (e.g. 'collections'). */
  path: string;
}

/** A workspace tool's entry (workspace/tools.ts): where its page is served. */
export interface ToolConfig {
  /** Where the tool's page is served, relative to the viewer (e.g. 'trace/'). */
  path: string;
  /** Default query (no leading '?'); '' means the tool's own default view. */
  query: string;
}

/** The data browser's entry. */
export type TraceConfig = ToolConfig;

/** Upper bound for a Trace query, in UTF-8 bytes. */
export const TRACE_QUERY_MAX_BYTES = 4096;

/** True for a string that fits the Trace query size limit. */
export function isTraceQuery(value: unknown): value is string {
  return (
    typeof value === 'string' && new TextEncoder().encode(value).length <= TRACE_QUERY_MAX_BYTES
  );
}

function fallback(): ViewerConfig {
  return {
    pvMode: 'mock',
    renderMode: DEFAULT_RENDER_MODE,
    themes: {},
    screensPath: '.',
    confirmWrites: false,
  };
}

/** What loadConfig returns when no usable config.json is served. */
export const FALLBACK_CONFIG: Readonly<ViewerConfig> = Object.freeze(fallback());

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseThemes(raw: unknown): Record<string, ThemeName> {
  const themes: Record<string, ThemeName> = {};
  if (!isRecord(raw)) return themes;
  for (const [id, theme] of Object.entries(raw)) {
    if (theme === 'light' || theme === 'dark') themes[id] = theme;
  }
  return themes;
}

function parseTool(raw: unknown): ToolConfig | undefined {
  if (!isRecord(raw)) return undefined;
  if (typeof raw.path !== 'string' || raw.path === '') return undefined;
  return { path: raw.path, query: isTraceQuery(raw.query) ? raw.query : '' };
}

function parseViews(raw: unknown): ViewsConfig | undefined {
  if (!isRecord(raw) || typeof raw.path !== 'string' || raw.path === '') return undefined;
  return { path: raw.path };
}

/** `collections` of a served config: kept only with a non-empty string path. */
export function parseCollections(raw: unknown): CollectionsConfig | undefined {
  if (!isRecord(raw) || typeof raw.path !== 'string' || raw.path === '') return undefined;
  return { path: raw.path };
}

/**
 * `workspace` of a served config: kept only with a non-empty string path and a
 * protocol major this viewer knows. Anything else means: no workspace requests.
 */
export function parseWorkspace(raw: unknown): WorkspaceConfig | undefined {
  if (!isRecord(raw) || typeof raw.path !== 'string' || raw.path === '') return undefined;
  if (raw.protocol !== WORKSPACE_PROTOCOL) return undefined;
  return { path: raw.path, protocol: WORKSPACE_PROTOCOL };
}

/** `home` of a served config: kept only with a non-empty string screen id. */
export function parseHome(raw: unknown): HomeConfig | undefined {
  if (!isRecord(raw) || typeof raw.screen !== 'string' || raw.screen.trim() === '') {
    return undefined;
  }
  return { screen: raw.screen };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parseBackend(raw: unknown): ConfigBackend | null {
  if (!isRecord(raw)) return null;
  return {
    name: stringOrNull(raw.name),
    label: stringOrNull(raw.label),
    notice: raw.notice === 'fallback' || raw.notice === 'unservable' ? raw.notice : null,
  };
}

/**
 * The color scheme a served `colorScheme` value stands for. A missing value
 * (an older canopy_mcp) is the bundled default, silently; a value that fails
 * any parseFlatScheme check is the bundled default with one warning; a valid
 * scheme whose `meta.errors` is non-empty (the server fell back) is used, with
 * one warning listing the server's errors.
 */
export function parseColorScheme(raw: unknown): FlatScheme {
  if (raw === undefined) return canopyDefaultFlat;
  const parsed = parseFlatScheme(raw);
  if ('error' in parsed) {
    console.warn(
      `canopy viewer: config.json colorScheme is invalid (${parsed.error}); using the bundled canopy-default scheme`
    );
    return canopyDefaultFlat;
  }
  if (parsed.meta.errors.length > 0) {
    const detail = parsed.meta.errors.map((e) => `${e.path}: ${e.message}`).join('; ');
    console.warn(
      `canopy viewer: the server could not load its color scheme and serves ${parsed.meta.served} (${detail})`
    );
  }
  return parsed;
}

/** The parsed config.json object, or null when none is usable. */
async function fetchRawConfig(
  baseURI: string,
  init?: RequestInit
): Promise<Record<string, unknown> | null> {
  let raw: unknown;
  try {
    const url = new URL('config.json', baseURI);
    const response = await (init ? fetch(url, init) : fetch(url));
    if (!response.ok) return null;
    raw = JSON.parse(await response.text());
  } catch {
    // Network failure or a non-JSON body (the dev server answers with index.html).
    return null;
  }
  return isRecord(raw) ? raw : null;
}

function parsePvMode(raw: Record<string, unknown>): ViewerConfig['pvMode'] {
  return raw.pvMode === 'mock' ? 'mock' : 'hare';
}

/** `confirmWrites` of a served config: hare mode asks unless it is literally false. */
export function parseConfirmWrites(raw: Record<string, unknown>): boolean {
  return parsePvMode(raw) === 'hare' && raw.confirmWrites !== false;
}

export async function loadConfig(baseURI: string = document.baseURI): Promise<ViewerConfig> {
  const raw = await fetchRawConfig(baseURI);
  if (raw === null) return fallback();
  const config: ViewerConfig = {
    pvMode: parsePvMode(raw),
    renderMode: parseRenderMode(raw.renderMode) ?? DEFAULT_RENDER_MODE,
    screensPath:
      typeof raw.screensPath === 'string' && raw.screensPath !== '' ? raw.screensPath : '.',
    themes: parseThemes(raw.themes),
    confirmWrites: parseConfirmWrites(raw),
  };
  // Omit the key (rather than trace: undefined) so the config's shape only
  // grows when Trace is actually served.
  const trace = parseTool(raw.trace);
  if (trace) config.trace = trace;
  const correlation = parseTool(raw.correlation);
  if (correlation) config.correlation = correlation;
  const waveform = parseTool(raw.waveform);
  if (waveform) config.waveform = waveform;
  const views = parseViews(raw.views);
  if (views) config.views = views;
  const collections = parseCollections(raw.collections);
  if (collections) config.collections = collections;
  if (raw.colorScheme !== undefined) config.colorScheme = parseColorScheme(raw.colorScheme);
  if ('backend' in raw) config.backend = parseBackend(raw.backend);
  if ('binding' in raw) config.binding = stringOrNull(raw.binding);
  const workspace = parseWorkspace(raw.workspace);
  if (workspace) config.workspace = workspace;
  const home = parseHome(raw.home);
  if (home) config.home = home;
  return config;
}

/** What a fresh read of config.json says about the workspace advertisement. */
export type WorkspaceAdvertisement =
  | { status: 'unreachable' }
  | { status: 'absent' }
  | { status: 'advertised'; workspace: WorkspaceConfig };

/**
 * Re-read the workspace advertisement from the served config.json, past the
 * HTTP cache. 'unreachable' when no usable config was served (network failure,
 * an error status, a non-JSON body); 'absent' when it no longer advertises a
 * workspace this viewer can speak to.
 */
export async function readWorkspaceAdvertisement(
  baseURI: string = document.baseURI
): Promise<WorkspaceAdvertisement> {
  const raw = await fetchRawConfig(baseURI, { cache: 'no-store' });
  if (raw === null) return { status: 'unreachable' };
  const workspace = parseWorkspace(raw.workspace);
  return workspace ? { status: 'advertised', workspace } : { status: 'absent' };
}

/**
 * Re-read `confirmWrites` from the served config.json, past the HTTP cache.
 * Null when no usable config was served (the caller then fails toward asking).
 */
export async function readConfirmWrites(
  baseURI: string = document.baseURI
): Promise<boolean | null> {
  const raw = await fetchRawConfig(baseURI, { cache: 'no-store' });
  return raw === null ? null : parseConfirmWrites(raw);
}

/** Where the live `confirmWrites` value stands. */
export type ConfirmWritesState = 'ready' | 'pending' | 'failed';

/** The live `confirmWrites` value of a hare page. */
export interface ConfirmWritesSource {
  /** The value a write reads now: true while a re-read is pending or after one failed. */
  current(): boolean;
  state(): ConfirmWritesState;
  /** Re-read the served value (on a Hare reconnect); never rejects. */
  reread(): Promise<void>;
}

/**
 * The live `confirmWrites` value: `initial` (from loadConfig) until the first
 * re-read, then the last re-read's value. A re-read in flight, or one that
 * failed, reads as true (ask). Overlapping re-reads: the latest one wins.
 */
export function createConfirmWritesSource(
  initial: boolean,
  read: () => Promise<boolean | null>
): ConfirmWritesSource {
  let value = initial;
  let state: ConfirmWritesState = 'ready';
  let seq = 0;
  return {
    current: () => (state === 'ready' ? value : true),
    state: () => state,
    async reread() {
      const mine = ++seq;
      state = 'pending';
      let next: boolean | null;
      try {
        next = await read();
      } catch {
        next = null;
      }
      if (mine !== seq) return;
      if (next === null) {
        state = 'failed';
      } else {
        value = next;
        state = 'ready';
      }
    },
  };
}
