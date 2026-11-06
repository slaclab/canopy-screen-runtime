// The screen action registry: which actions are available for a context,
// and what each one does, with downloads, the clipboard, print and the
// rasteriser mocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./capture.js', () => ({
  captureElementPng: vi.fn(
    async () =>
      new Blob([new Uint8Array([137, 80, 78, 71])], {
        type: 'image/png',
      })
  ),
}));

import {
  SCREEN_ACTIONS,
  availableActions,
  copyLinkAction,
  downloadAction,
  exportPngAction,
  plotAction,
  printAction,
  reloadAction,
} from './actions.js';
import { captureElementPng } from './capture.js';
import { PRINTING_ATTR, PRINT_SCALE_VAR } from './print.js';
import type { ScreenAction, ScreenActionContext } from './types.js';

function makeCtx(overrides: Partial<ScreenActionContext['screen']> = {}, link?: string) {
  const ctx: ScreenActionContext = {
    screen: {
      category: 'bts',
      id: 'nested/BTSView',
      title: 'BTS',
      macros: { SECTOR: '3' },
      element: document.createElement('div'),
      documentUrl: 'http://h/x/screens/bts/BTSView.screen.json',
      size: { width: 1200, height: 600 },
      reload: vi.fn(),
      collectPVs: vi.fn(async () => []),
      ...overrides,
    },
    zoom: { scale: 0.5, fit: true },
    config: {},
    link: link ?? 'http://h/x/embed/bts/nested/BTSView?SECTOR=3',
    plotInDataBrowser: vi.fn(),
  };
  return ctx;
}

/** Downloads: every <a download> click, with its name and blob. */
function captureDownloads() {
  const saved: { name: string; url: string }[] = [];
  const blobs = new Map<string, Blob>();
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
    const url = `blob:test/${blobs.size}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement
  ) {
    saved.push({ name: this.download, url: this.href });
  });
  return { saved, blobs };
}

/** A Blob's text (jsdom's Blob has no text()). */
function readText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 1, 9, 5, 7));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty(PRINT_SCALE_VAR);
});

describe('the registry', () => {
  it('lists the actions in header order with unique ids', () => {
    expect(SCREEN_ACTIONS.map((a) => a.id)).toEqual([
      'plot-data-browser',
      'reload',
      'download',
      'export-png',
      'print',
      'copy-link',
    ]);
  });

  it('binds ⌘/Ctrl S, I and P to download, PNG and print, and nothing else', () => {
    const bound = Object.fromEntries(
      SCREEN_ACTIONS.filter((a) => a.shortcut).map((a) => [a.shortcut, a.id])
    );
    expect(bound).toEqual({ s: 'download', i: 'export-png', p: 'print' });
  });

  it('offers every action for a fully described screen', () => {
    expect(availableActions(makeCtx()).map((a) => a.id)).toEqual(SCREEN_ACTIONS.map((a) => a.id));
  });

  it('hides an action whose prerequisite is missing', () => {
    const ids = (ctx: ScreenActionContext) => availableActions(ctx).map((a) => a.id);
    expect(ids(makeCtx({ reload: undefined }))).not.toContain('reload');
    expect(ids(makeCtx({ documentUrl: '' }))).not.toContain('download');
    expect(ids(makeCtx({ element: null }))).toEqual([
      'plot-data-browser',
      'reload',
      'download',
      'copy-link',
    ]);
    expect(ids(makeCtx({ collectPVs: undefined }))).not.toContain('plot-data-browser');
    expect(ids({ ...makeCtx(), plotInDataBrowser: undefined })).not.toContain('plot-data-browser');
    expect(ids(makeCtx({}, ''))).not.toContain('copy-link');
  });

  it('treats an availability check that throws as unavailable', () => {
    const broken: ScreenAction = {
      id: 'broken',
      label: 'Broken',
      icon: reloadAction.icon,
      isAvailable: () => {
        throw new Error('boom');
      },
      run: () => {},
    };
    expect(availableActions(makeCtx(), [broken, reloadAction]).map((a) => a.id)).toEqual([
      'reload',
    ]);
  });
});

describe('plot in data browser', () => {
  it("hands the open screen to the host's chooser", () => {
    const ctx = makeCtx();
    plotAction.run(ctx);
    expect(ctx.plotInDataBrowser).toHaveBeenCalledExactlyOnceWith(ctx.screen);
    expect(plotAction.shortcut).toBeUndefined();
  });
});

describe('reload', () => {
  it("calls the screen's reload", async () => {
    const ctx = makeCtx();
    await reloadAction.run(ctx);
    expect(ctx.screen.reload).toHaveBeenCalledTimes(1);
  });
});

describe('download screen', () => {
  it('saves the document as served under <id>.screen.json, past the HTTP cache', async () => {
    const { saved, blobs } = captureDownloads();
    const body = '{"schemaVersion":"0.1",  "id":"x"}\n';
    const fetchMock = vi.fn(
      async () => new Response(body, { headers: { 'content-type': 'application/json' } })
    );
    vi.stubGlobal('fetch', fetchMock);

    await downloadAction.run(makeCtx());

    expect(fetchMock).toHaveBeenCalledWith('http://h/x/screens/bts/BTSView.screen.json', {
      cache: 'no-cache',
    });
    expect(saved).toHaveLength(1);
    expect(saved[0]!.name).toBe('nested_BTSView.screen.json');
    // Byte for byte what the server sent, not a re-serialisation.
    expect(await readText(blobs.get(saved[0]!.url)!)).toBe(body);
  });

  it('fails with the HTTP status and saves nothing on an error response', async () => {
    const { saved } = captureDownloads();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 404, statusText: 'Not Found' }))
    );
    await expect(downloadAction.run(makeCtx())).rejects.toThrow('404 Not Found');
    expect(saved).toHaveLength(0);
  });
});

describe('export PNG', () => {
  it('rasterises the displayed element and saves <id>-<YYYYmmdd-HHMMSS>.png', async () => {
    const { saved, blobs } = captureDownloads();
    const ctx = makeCtx();
    await exportPngAction.run(ctx);
    expect(captureElementPng).toHaveBeenCalledWith(ctx.screen.element);
    expect(saved.map((s) => s.name)).toEqual(['nested_BTSView-20261001-090507.png']);
    expect(blobs.get(saved[0]!.url)!.type).toBe('image/png');
  });
});

describe('print', () => {
  it('fits the page to the screen for the print and clears it afterwards', () => {
    let during: string | undefined;
    const print = vi.fn(() => {
      during = document.documentElement.style.getPropertyValue(PRINT_SCALE_VAR);
    });
    vi.stubGlobal('print', print);
    printAction.run(makeCtx());
    expect(print).toHaveBeenCalledTimes(1);
    // 1200 x 600 on a landscape page of ~980 x 718 px: the width binds.
    expect(1200 * Number(during)).toBeLessThanOrEqual(980.5);
    expect(1200 * Number(during)).toBeGreaterThan(978);
    expect(document.documentElement.style.getPropertyValue(PRINT_SCALE_VAR)).toBe('');
    expect(document.getElementById('canopy-print-page')).toBeNull();
  });

  /** Two docked tiles, the first focused; returns both and the second's screen element. */
  function twoTiles() {
    const layer = document.createElement('div');
    layer.className = 'canopy-dock-overlay';
    const [focused, other] = ['a', 'b'].map((key) => {
      const tile = document.createElement('div');
      tile.className = 'canopy-dock-overlay__item';
      tile.dataset.tabKey = key;
      layer.appendChild(tile);
      return tile;
    }) as [HTMLDivElement, HTMLDivElement];
    focused.dataset.focused = 'true';
    const element = document.createElement('div');
    other.appendChild(document.createElement('div')).appendChild(element);
    document.body.appendChild(layer);
    return { layer, focused, other, element };
  }

  it('marks its own tile data-printing for the print call only', () => {
    const { layer, focused, other, element } = twoTiles();
    const during: (string | null)[] = [];
    vi.stubGlobal(
      'print',
      vi.fn(() => {
        during.push(other.getAttribute(PRINTING_ATTR), focused.getAttribute(PRINTING_ATTR));
      })
    );
    printAction.run(makeCtx({ element }));
    // The invoking (unfocused) tile is marked during the print, the focused one is not.
    expect(during).toEqual(['true', null]);
    expect(other.hasAttribute(PRINTING_ATTR)).toBe(false);
    expect(layer.querySelectorAll(`[${PRINTING_ATTR}]`)).toHaveLength(0);
    layer.remove();
  });

  it('clears the marker and the page layout when the print throws', () => {
    const { layer, other, element } = twoTiles();
    vi.stubGlobal(
      'print',
      vi.fn(() => {
        throw new Error('print blocked');
      })
    );
    expect(() => printAction.run(makeCtx({ element }))).toThrow('print blocked');
    expect(other.hasAttribute(PRINTING_ATTR)).toBe(false);
    expect(document.documentElement.style.getPropertyValue(PRINT_SCALE_VAR)).toBe('');
    layer.remove();
  });

  it('prints unmarked when the screen has no docked tile (the /s/ page)', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    const print = vi.fn();
    vi.stubGlobal('print', print);
    printAction.run(makeCtx({ element }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll(`[${PRINTING_ATTR}]`)).toHaveLength(0);
    element.remove();
  });
});

describe('copy link', () => {
  it('writes the link to the clipboard and reports "Copied"', async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const result = await copyLinkAction.run(makeCtx());
    expect(writeText).toHaveBeenCalledWith('http://h/x/embed/bts/nested/BTSView?SECTOR=3');
    expect(result).toEqual({ message: 'Copied' });
  });

  it('falls back to execCommand when the Clipboard API is refused', async () => {
    const writeText = vi.fn(async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    let copied: string | undefined;
    const execCommand = vi.fn((command: string) => {
      copied = document.querySelector('textarea')?.value;
      return command === 'copy';
    });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: execCommand });
    try {
      const result = await copyLinkAction.run(makeCtx());
      expect(execCommand).toHaveBeenCalledWith('copy');
      expect(copied).toBe('http://h/x/embed/bts/nested/BTSView?SECTOR=3');
      expect(result).toEqual({ message: 'Copied' });
      expect(document.querySelector('textarea')).toBeNull();
    } finally {
      delete (document as { execCommand?: unknown }).execCommand;
    }
  });

  it('fails when neither way can copy', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: undefined });
    Object.defineProperty(document, 'execCommand', { configurable: true, value: () => false });
    try {
      await expect(copyLinkAction.run(makeCtx())).rejects.toThrow('refused to copy');
    } finally {
      delete (document as { execCommand?: unknown }).execCommand;
    }
  });
});
