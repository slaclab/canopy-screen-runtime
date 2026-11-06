// Action dispatch: every Action variant routed to the injected callbacks, in
// declaration order, with no viewer in the loop.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from '@slaclab/canopy-screen-ir';
import type {
  WriteGateService,
  WriteOutcome,
  WriteOutcomeKind,
  WriteRequest,
} from '@slaclab/canopy-screen-widgets';
import {
  dispatchActions,
  isOpenableUrl,
  resetActionWarnings,
  type ActionContext,
} from './dispatch.js';

const EXECUTE_NOT_AVAILABLE = "'execute' actions are not available here";

function makeCtx(overrides: Partial<ActionContext> = {}): ActionContext & {
  calls: string[];
} {
  const calls: string[] = [];
  const ctx: ActionContext & { calls: string[] } = {
    calls,
    macros: { P: 'LI21', DEV: 'M1' },
    pvService: {
      put: vi.fn((pv: string, value: string | number) => {
        calls.push(`put ${pv}=${value}`);
      }),
    },
    resolveManifest: vi.fn((file: string) => `/screens/${file.replace(/\.bob$/, '')}`),
    navigate: vi.fn((url: string) => {
      calls.push(`navigate ${url}`);
    }),
    openWindow: vi.fn((url: string) => {
      calls.push(`openWindow ${url}`);
    }),
    close: vi.fn(() => {
      calls.push('close');
    }),
    showError: vi.fn((msg: string) => {
      calls.push(`error ${msg}`);
    }),
    ...overrides,
  };
  return ctx;
}

describe('dispatchActions', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetActionWarnings();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
  });

  it('writes two write_pv entries in order with macro-substituted PV names', async () => {
    const ctx = makeCtx();
    const actions: Action[] = [
      { type: 'write_pv', pvName: '${P}:A', value: 1 },
      { type: 'write_pv', pvName: '$(P):B', value: 'on' },
    ];
    await dispatchActions(actions, ctx);
    expect(ctx.calls).toEqual(['put LI21:A=1', 'put LI21:B=on']);
  });

  it('awaits an async put before the next action', async () => {
    const order: string[] = [];
    const ctx = makeCtx({
      pvService: {
        put: async (pv: string) => {
          await new Promise((r) => setTimeout(r, pv.endsWith('A') ? 5 : 0));
          order.push(pv);
        },
      },
    });
    await dispatchActions(
      [
        { type: 'write_pv', pvName: 'X:A', value: 1 },
        { type: 'write_pv', pvName: 'X:B', value: 2 },
      ],
      ctx
    );
    expect(order).toEqual(['X:A', 'X:B']);
  });

  it('open_display target replace navigates', async () => {
    const ctx = makeCtx();
    await dispatchActions([{ type: 'open_display', file: 'main.bob', target: 'replace' }], ctx);
    expect(ctx.resolveManifest).toHaveBeenCalledWith('main.bob');
    expect(ctx.calls).toEqual(['navigate /screens/main']);
  });

  it('open_display target tab opens a window', async () => {
    const ctx = makeCtx();
    await dispatchActions([{ type: 'open_display', file: 'main.bob', target: 'tab' }], ctx);
    expect(ctx.calls).toEqual(['openWindow /screens/main']);
  });

  it('open_display target window opens a window', async () => {
    const ctx = makeCtx();
    await dispatchActions([{ type: 'open_display', file: 'main.bob', target: 'window' }], ctx);
    expect(ctx.calls).toEqual(['openWindow /screens/main']);
  });

  it('open_display with an unknown target falls back to replace', async () => {
    const ctx = makeCtx();
    const action = { type: 'open_display', file: 'main.bob', target: 'popup' } as unknown as Action;
    await dispatchActions([action], ctx);
    expect(ctx.calls).toEqual(['navigate /screens/main']);
  });

  it('open_display with a missing target falls back to replace', async () => {
    const ctx = makeCtx();
    const action = { type: 'open_display', file: 'main.bob' } as unknown as Action;
    await dispatchActions([action], ctx);
    expect(ctx.calls).toEqual(['navigate /screens/main']);
  });

  it('open_display manifest miss shows an error and does not navigate', async () => {
    const ctx = makeCtx({ resolveManifest: vi.fn(() => undefined) });
    await dispatchActions([{ type: 'open_display', file: 'gone.bob', target: 'replace' }], ctx);
    expect(ctx.calls).toEqual(['error No screen for gone.bob']);
    expect(ctx.navigate).not.toHaveBeenCalled();
  });

  it('supports an async resolveManifest', async () => {
    const ctx = makeCtx({ resolveManifest: vi.fn(async () => '/screens/x') });
    await dispatchActions([{ type: 'open_display', file: 'x.bob', target: 'tab' }], ctx);
    expect(ctx.calls).toEqual(['openWindow /screens/x']);
  });

  it('passes resolved open_display macros as query params', async () => {
    const ctx = makeCtx();
    await dispatchActions(
      [
        {
          type: 'open_display',
          file: '${DEV}.bob',
          target: 'replace',
          macros: { MOTOR: '${P}:M1', LABEL: 'a b&c' },
        },
      ],
      ctx
    );
    expect(ctx.resolveManifest).toHaveBeenCalledWith('M1.bob');
    expect(ctx.calls).toEqual(['navigate /screens/M1?MOTOR=LI21%3AM1&LABEL=a+b%26c']);
  });

  it('appends macro params to a URL that already has a query', async () => {
    const ctx = makeCtx({ resolveManifest: () => '/view?id=7' });
    await dispatchActions(
      [{ type: 'open_display', file: 'a.bob', target: 'replace', macros: { A: '1' } }],
      ctx
    );
    expect(ctx.calls).toEqual(['navigate /view?id=7&A=1']);
  });

  it('close_display closes', async () => {
    const ctx = makeCtx();
    await dispatchActions([{ type: 'close_display' }], ctx);
    expect(ctx.calls).toEqual(['close']);
  });

  it('open_webpage opens a window with the URL', async () => {
    const ctx = makeCtx();
    await dispatchActions([{ type: 'open_webpage', url: 'https://example.org/${P}' }], ctx);
    expect(ctx.calls).toEqual(['openWindow https://example.org/LI21']);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    'file:///etc/passwd',
    '//evil.example/x',
    '/\\evil.example/x',
    '\\\\evil.example/x',
  ])('open_webpage refuses %j with an error and opens nothing', async (url) => {
    const ctx = makeCtx();
    await dispatchActions([{ type: 'open_webpage', url }], ctx);
    expect(ctx.openWindow).not.toHaveBeenCalled();
    expect(ctx.calls).toHaveLength(1);
    expect(ctx.calls[0]).toMatch(/^error Refused to open .*only http, https and relative URLs/);
  });

  it('open_webpage refuses a macro that expands to a javascript: URL', async () => {
    const ctx = makeCtx({ macros: { U: 'javascript:alert(document.cookie)' } });
    await dispatchActions([{ type: 'open_webpage', url: '${U}' }], ctx);
    expect(ctx.openWindow).not.toHaveBeenCalled();
    expect(ctx.showError).toHaveBeenCalledTimes(1);
  });

  it('open_display refuses a non-http(s) screen URL and does not navigate', async () => {
    const ctx = makeCtx({ resolveManifest: vi.fn(() => 'javascript:alert(1)') });
    await dispatchActions([{ type: 'open_display', file: 'main.bob', target: 'tab' }], ctx);
    await dispatchActions([{ type: 'open_display', file: 'main.bob', target: 'replace' }], ctx);
    expect(ctx.openWindow).not.toHaveBeenCalled();
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(ctx.showError).toHaveBeenCalledTimes(2);
  });

  it('isOpenableUrl accepts http(s) and relative URLs', () => {
    for (const url of [
      'https://example.org/a',
      'HTTP://example.org',
      '/screens/main',
      'screens/main?P=1',
      '../up',
      '?q=1',
      '#frag',
      '',
    ]) {
      expect(isOpenableUrl(url), url).toBe(true);
    }
  });

  it('open_file only warns, once', async () => {
    const ctx = makeCtx();
    const actions: Action[] = [
      { type: 'open_file', file: 'a.txt' },
      { type: 'open_file', file: 'b.txt' },
    ];
    await dispatchActions(actions, ctx);
    await dispatchActions(actions, ctx);
    expect(ctx.calls).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('execute shows "not available here" and sends nothing', async () => {
    const ctx = makeCtx();
    await dispatchActions(
      [
        { type: 'execute', command: 'rm -rf /' },
        { type: 'execute', command: 'ls' },
      ],
      ctx
    );
    expect(ctx.calls).toEqual([`error ${EXECUTE_NOT_AVAILABLE}`, `error ${EXECUTE_NOT_AVAILABLE}`]);
  });

  it('runs mixed actions in declaration order', async () => {
    const ctx = makeCtx();
    await dispatchActions(
      [
        { type: 'write_pv', pvName: 'X', value: 0 },
        { type: 'open_display', file: 'a.bob', target: 'tab' },
        { type: 'close_display' },
      ],
      ctx
    );
    expect(ctx.calls).toEqual(['put X=0', 'openWindow /screens/a', 'close']);
  });

  it('does nothing for an empty list', async () => {
    const ctx = makeCtx();
    await dispatchActions([], ctx);
    expect(ctx.calls).toEqual([]);
  });
});

function outcome(kind: WriteOutcomeKind, coalesced = false): WriteOutcome {
  return { outcome: kind, code: null, status: null, detail: kind, coalesced };
}

/**
 * A gate recording each run into `calls` and answering it with `answer`:
 * 'declined', or the first writes.length of `answer` (the outcomes the
 * gate resolved: a shorter list is a run that stopped).
 */
function fakeGate(calls: string[], answer: 'declined' | WriteOutcome[]) {
  const runs: WriteRequest[][] = [];
  const gate: WriteGateService = {
    confirmWrites: () => true,
    run: async (writes) => {
      runs.push([...writes]);
      calls.push(`run ${writes.map((w) => `${w.pv}=${w.value}`).join(',')}`);
      if (answer === 'declined') return 'declined';
      return answer.slice(0, writes.length);
    },
  };
  return { gate, runs };
}

describe('dispatchActions with a write gate', () => {
  beforeEach(() => {
    resetActionWarnings();
  });

  it("gathers a click's machine write_pv actions into one gate run, never put", async () => {
    const ctx = makeCtx();
    const { gate, runs } = fakeGate(ctx.calls, [outcome('confirmed'), outcome('confirmed')]);
    await dispatchActions(
      [
        { type: 'write_pv', pvName: '${P}:A', value: 1 },
        { type: 'open_webpage', url: 'https://x/' },
        { type: 'write_pv', pvName: '${P}:B', value: 'on' },
        { type: 'close_display' },
      ],
      { ...ctx, gate }
    );
    expect(runs).toEqual([
      [
        { pv: 'LI21:A', value: 1 },
        { pv: 'LI21:B', value: 'on' },
      ],
    ]);
    expect(ctx.calls).toEqual(['run LI21:A=1,LI21:B=on', 'openWindow https://x/', 'close']);
    expect(ctx.pvService.put).not.toHaveBeenCalled();
  });

  it('skips the rest of the list after a decline', async () => {
    const ctx = makeCtx();
    const { gate } = fakeGate(ctx.calls, 'declined');
    await dispatchActions(
      [
        { type: 'open_webpage', url: 'https://before/' },
        { type: 'write_pv', pvName: 'X', value: 1 },
        { type: 'write_pv', pvName: 'loc://after', value: 1 },
        { type: 'open_display', file: 'a.bob', target: 'replace' },
        { type: 'close_display' },
      ],
      { ...ctx, gate }
    );
    expect(ctx.calls).toEqual(['openWindow https://before/', 'run X=1']);
  });

  it('skips the rest of the list after a run that stopped', async () => {
    for (const answer of [
      [outcome('confirmed'), outcome('refused')],
      [outcome('refused')],
      [outcome('confirmed'), outcome('confirmed', true)],
      [outcome('unknown')],
      [],
    ]) {
      const ctx = makeCtx();
      const { gate } = fakeGate(ctx.calls, answer);
      await dispatchActions(
        [
          { type: 'write_pv', pvName: 'A', value: 1 },
          { type: 'write_pv', pvName: 'B', value: 2 },
          { type: 'close_display' },
        ],
        { ...ctx, gate }
      );
      expect(ctx.calls, JSON.stringify(answer)).toEqual(['run A=1,B=2']);
    }
  });

  it('continues after mismatch and unconfirmed (the run completed)', async () => {
    const ctx = makeCtx();
    const { gate } = fakeGate(ctx.calls, [outcome('mismatch'), outcome('unconfirmed')]);
    await dispatchActions(
      [
        { type: 'write_pv', pvName: 'A', value: 1 },
        { type: 'write_pv', pvName: 'B', value: 2 },
        { type: 'close_display' },
      ],
      { ...ctx, gate }
    );
    expect(ctx.calls).toEqual(['run A=1,B=2', 'close']);
  });

  it('keeps loc:// and formula:// writes on the instance router, at their place', async () => {
    const ctx = makeCtx();
    const { gate, runs } = fakeGate(ctx.calls, [outcome('confirmed')]);
    await dispatchActions(
      [
        { type: 'write_pv', pvName: 'loc://$(DEV)', value: 3 },
        { type: 'write_pv', pvName: 'M', value: 1 },
        { type: 'write_pv', pvName: 'formula://calc', value: 4 },
      ],
      { ...ctx, gate }
    );
    expect(runs).toEqual([[{ pv: 'M', value: 1 }]]);
    expect(ctx.calls).toEqual(['put loc://M1=3', 'run M=1', 'put formula://calc=4']);
  });

  it('sends upper-case LOC:// and FOX:// names to the gate (the router routes them to the machine)', async () => {
    const ctx = makeCtx();
    const { gate, runs } = fakeGate(ctx.calls, [outcome('confirmed'), outcome('confirmed')]);
    await dispatchActions(
      [
        { type: 'write_pv', pvName: 'LOC://a', value: 1 },
        { type: 'write_pv', pvName: 'FOX://b', value: 2 },
      ],
      { ...ctx, gate }
    );
    expect(runs).toEqual([
      [
        { pv: 'LOC://a', value: 1 },
        { pv: 'FOX://b', value: 2 },
      ],
    ]);
    expect(ctx.calls.filter((c) => c.startsWith('put'))).toEqual([]);
  });

  it('runs no gate for a list without machine writes', async () => {
    const ctx = makeCtx();
    const { gate, runs } = fakeGate(ctx.calls, 'declined');
    await dispatchActions(
      [{ type: 'write_pv', pvName: 'loc://a', value: 1 }, { type: 'close_display' }],
      { ...ctx, gate }
    );
    expect(runs).toEqual([]);
    expect(ctx.calls).toEqual(['put loc://a=1', 'close']);
  });

  it('treats a rejecting gate as nothing written and stops', async () => {
    const ctx = makeCtx();
    const gate: WriteGateService = {
      confirmWrites: () => false,
      run: () => Promise.reject(new Error('boom')),
    };
    await dispatchActions(
      [{ type: 'write_pv', pvName: 'A', value: 1 }, { type: 'close_display' }],
      { ...ctx, gate }
    );
    expect(ctx.calls).toEqual([]);
    expect(ctx.pvService.put).not.toHaveBeenCalled();
  });

  it('with a null gate writes straight through, as before', async () => {
    const ctx = makeCtx();
    await dispatchActions([{ type: 'write_pv', pvName: 'A', value: 1 }], { ...ctx, gate: null });
    expect(ctx.calls).toEqual(['put A=1']);
  });
});
