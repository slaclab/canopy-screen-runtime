// Embeds the viewer in a stand-in host for the host-stylesheet specs, the way
// canopy_mcp does behind an embedding host: the entry pages gain data-canopy-host on
// <html> and the marked <link>s of the shell's links.html as the last <head>
// children. The harness is request-routed (page.route), so e2e/server.mjs stays
// untouched. Call installHost before page.goto.
//
// Fixture only, a <script type="module"> after the links records in
// window.__hostSheetLoadedAtModule whether every marked sheet was usable when
// the first module ran; the sheet routes answer after ~500 ms so a tiny
// document cannot hide a missing wait.

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import type { Page, Route, WebSocketRoute } from '@playwright/test';

const PREFIX = '/x/y';
const SHEET_DELAY_MS = 500;

const require = createRequire(import.meta.url);
const shellFixture = (file: string): string =>
  readFileSync(require.resolve(`@slaclab/canopy-shell/fixtures/host/${file}`), 'utf8');

/** 'synthetic' serves the shell's host.css; 'directories' serves dsDir and fontsDir. */
export type HostSheets = 'synthetic' | 'directories';
/** One sheet (canopy-host.css) answers 404, an empty 200, or declares contract 2. */
export type HostScenario = '404' | 'empty-200' | 'wrong-major';

export interface HostOptions {
  sheets: HostSheets;
  dsDir?: string;
  fontsDir?: string;
  scenario?: HostScenario;
  /** Run the page against installHareMock (the write-dialog and target-badge rows). */
  hare?: boolean;
}

const SCENARIO_SHEET = '/design-system/css/canopy-host.css';
const MARKER =
  '<script type="module">window.__hostSheetLoadedAtModule = ' +
  "[...document.querySelectorAll('link[data-canopy-host-sheet]')].every((l) => " +
  '{ try { return l.sheet !== null && l.sheet.cssRules.length > 0; } catch { return false; } });' +
  '</script>';

const TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.html': 'text/html',
  '.json': 'application/json',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
};

const isEntryPage = (path: string): boolean =>
  path === `${PREFIX}/` || path.startsWith(`${PREFIX}/s/`) || path.startsWith(`${PREFIX}/embed/`);

/** The body a sheet URL serves, or null for a 404. `rest` is the path after the mount. */
function sheetBody(opts: HostOptions, mount: 'ds' | 'fonts', rest: string): string | Buffer | null {
  if (opts.sheets === 'synthetic') {
    if (mount === 'ds' && rest === 'css/tokens.css') return shellFixture('host.css');
    // host.css already declares every --canopy-host-* name; the other two sheets
    // only need a rule, because a sheet with none counts as failed.
    if (rest === 'fonts.css' || rest === 'css/canopy-host.css') return ':root {}\n';
    return null;
  }
  const root = mount === 'ds' ? opts.dsDir : opts.fontsDir;
  if (!root) throw new Error(`installHost: sheets 'directories' needs dsDir and fontsDir`);
  const file = resolve(root, rest);
  if (!file.startsWith(resolve(root) + sep)) return null;
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}

async function serveSheet(route: Route, opts: HostOptions, mount: 'ds' | 'fonts'): Promise<void> {
  const path = new URL(route.request().url()).pathname;
  const marker = mount === 'ds' ? '/design-system/' : '/static/fonts/';
  const rest = decodeURIComponent(path.slice(path.indexOf(marker) + marker.length));
  const type = TYPES[extname(rest)] ?? 'application/octet-stream';
  if (type === 'text/css') await new Promise((r) => setTimeout(r, SHEET_DELAY_MS));
  let body = sheetBody(opts, mount, rest);
  if (path.endsWith(SCENARIO_SHEET) && opts.scenario) {
    if (opts.scenario === '404') body = null;
    else if (opts.scenario === 'empty-200') body = '';
    else
      body = `${body ?? ''}\nhtml [data-canopy-host-root][data-canopy-host-root] { --canopy-host-contract: 2; }\n`;
  }
  if (body === null)
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  else await route.fulfill({ status: 200, contentType: type, body });
}

export async function installHost(page: Page, opts: HostOptions): Promise<void> {
  if (opts.hare) await installHareMock(page);
  // The danger menu-item rows need a saved view; the server answers 200 on a repeat.
  const seeded = await page.request.put(`${PREFIX}/views/host-probe-view`, {
    data: { name: 'Host probe view', query: '', kind: 'trace' },
  });
  if (!seeded.ok()) throw new Error(`installHost: seeding the saved view: ${seeded.status()}`);

  const links = shellFixture('links.html').replaceAll('{prefix}', PREFIX).trim();
  await page.route(
    (url) => isEntryPage(url.pathname),
    async (route) => {
      if (route.request().resourceType() !== 'document') return route.fallback();
      const response = await route.fetch();
      const html = (await response.text())
        .replace(/<html\b([^>]*)>/i, '<html$1 data-canopy-host>')
        .replace('</head>', `${links}\n${MARKER}\n</head>`);
      await route.fulfill({ response, body: html });
    }
  );
  await page.route('**/design-system/**', (route) => serveSheet(route, opts, 'ds'));
  await page.route('**/static/fonts/**', (route) => serveSheet(route, opts, 'fonts'));
}

/** PVs answered by installHareMock; only PROBE:WRITE is writable. */
export const WRITABLE_PV = 'PROBE:WRITE';

function pvValue(pv: string) {
  return {
    pv,
    value: 1,
    valueKind: 'scalar',
    severity: 'NO_ALARM',
    tsNs: Date.now() * 1e6,
    connected: true,
    error: null,
  };
}

function pvMeta(pv: string) {
  const nil = { units: null, precision: 2, description: null, enumChoices: null };
  const limits = { displayLow: null, displayHigh: null, controlLow: null, controlHigh: null };
  const alarms = { warningLow: null, warningHigh: null, alarmLow: null, alarmHigh: null };
  return {
    pv,
    valueKind: 'scalar',
    ...nil,
    ...limits,
    ...alarms,
    writable: pv === WRITABLE_PV,
    form: null,
  };
}

/** The heartbeat installHareMock sends when a socket opens unless told otherwise: a legacy frame. */
export function probeHeartbeat(): object {
  return {
    type: 'heartbeat',
    timestamp: Date.now() / 1000,
    backend: 'probe',
    label: 'Probe',
    notice: null,
    binding: 'probe@1',
  };
}

/** What a socket sends on open: a frame, a builder of one, or null for nothing. */
export type OpenFrame = object | (() => object) | null;

export interface HareMockOptions {
  /** The frame each new socket gets first; defaults to probeHeartbeat. */
  onOpen?: OpenFrame;
}

/**
 * The mocked PV socket as a spec drives it. The client reconnects on its own
 * after a close, and every new socket becomes `current`.
 */
export interface MachineSocket {
  /** Sockets the page has opened so far (a reconnect opens another). */
  readonly opened: number;
  /** Sockets that have closed so far, from either side. */
  readonly closed: number;
  /** Client frames seen on every socket, counted by `type` (e.g. ping, subscribe, put). */
  readonly received: Readonly<Record<string, number>>;
  /** The frame the next socket gets first; assign to change what a reopen announces. */
  onOpen: OpenFrame;
  /** Sends a frame (JSON-encoded) on the newest open socket. */
  send(frame: object): Promise<void>;
  /** Closes the newest open socket from the server side. */
  close(code?: number, reason?: string): Promise<void>;
  /** Resolves once `count` sockets have opened in total. */
  waitForOpen(count: number, timeoutMs?: number): Promise<void>;
}

/**
 * Puts the page in hare mode (config.json with pvMode 'hare', confirmWrites
 * true) against a mocked PV socket: a heartbeat on open (by default a legacy
 * frame with a constant binding), a pong per ping, and an `initial` frame
 * (connected) per subscribe. Returns the socket handle: spec-sent frames,
 * server-side closes, and counts of opens, closes and client frames.
 */
export async function installHareMock(
  page: Page,
  opts: HareMockOptions = {}
): Promise<MachineSocket> {
  await page.route('**/config.json', async (route) => {
    const response = await route.fetch();
    const config = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...config, pvMode: 'hare', confirmWrites: true } });
  });

  let current: WebSocketRoute | null = null;
  let opened = 0;
  const closedSockets = new Set<WebSocketRoute>();
  const received: Record<string, number> = {};
  const waiters: { count: number; resolve: () => void }[] = [];

  const newest = (): WebSocketRoute => {
    if (!current) throw new Error('installHareMock: no open PV socket');
    return current;
  };

  const socket: MachineSocket = {
    get opened() {
      return opened;
    },
    get closed() {
      return closedSockets.size;
    },
    get received() {
      return received;
    },
    onOpen: opts.onOpen === undefined ? probeHeartbeat : opts.onOpen,
    async send(frame) {
      await newest().send(JSON.stringify(frame));
    },
    async close(code = 1000, reason = '') {
      const ws = newest();
      current = null;
      closedSockets.add(ws);
      await ws.close({ code, reason });
    },
    waitForOpen(count, timeoutMs = 10_000) {
      if (opened >= count) return Promise.resolve();
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`installHareMock: ${opened} of ${count} sockets opened`)),
          timeoutMs
        );
        waiters.push({
          count,
          resolve: () => {
            clearTimeout(timer);
            resolve();
          },
        });
      });
    },
  };

  await page.routeWebSocket(/\/hare\//, (ws) => {
    current = ws;
    opened += 1;
    const first = typeof socket.onOpen === 'function' ? socket.onOpen() : socket.onOpen;
    if (first) ws.send(JSON.stringify(first));
    ws.onClose(() => {
      closedSockets.add(ws);
      if (current === ws) current = null;
    });
    ws.onMessage((message) => {
      const frame = JSON.parse(String(message)) as { type?: string; pvNames?: string[] };
      const type = frame.type ?? '';
      received[type] = (received[type] ?? 0) + 1;
      if (type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() / 1000 }));
      } else if (type === 'subscribe' && frame.pvNames?.length) {
        const pvs = frame.pvNames;
        ws.send(
          JSON.stringify({
            type: 'initial',
            data: Object.fromEntries(pvs.map((pv) => [pv, pvValue(pv)])),
            meta: Object.fromEntries(pvs.map((pv) => [pv, pvMeta(pv)])),
            count: pvs.length,
          })
        );
      }
    });
    for (const waiter of waiters.filter((w) => opened >= w.count)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve();
    }
  });
  return socket;
}

/** What installPvWriteRoute saw: one entry per PV write (PUT), in order. */
export interface PvWrites {
  /** The number of PUT requests answered. */
  count: number;
  /** Each write's PV name (decoded from the path) and request body. */
  writes: { pv: string; body: unknown }[];
}

/**
 * Answers every PV write (`PUT …/hare/v1/pvs/{pv}`, the hare REST route the
 * client derives from its socket URL) with a confirmed outcome: 200 JSON whose
 * body names the PV. Other methods on that path fall through.
 * Returns a live counter; pair it with installHareMock (or installHost with
 * `hare: true`) so the write gate asks before any PUT is sent.
 */
export async function installPvWriteRoute(page: Page): Promise<PvWrites> {
  const seen: PvWrites = { count: 0, writes: [] };
  await page.route(/\/hare\/v1\/pvs\/[^?#]+/, async (route) => {
    const request = route.request();
    if (request.method() !== 'PUT') return route.fallback();
    const path = new URL(request.url()).pathname;
    const pv = decodeURIComponent(path.slice(path.lastIndexOf('/pvs/') + '/pvs/'.length));
    let body: unknown;
    try {
      body = request.postDataJSON();
    } catch {
      body = request.postData();
    }
    seen.count += 1;
    seen.writes.push({ pv, body });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ pv }),
    });
  });
  return seen;
}
