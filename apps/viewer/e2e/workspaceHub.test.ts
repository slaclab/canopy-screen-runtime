// Replays the shared workspace fixture set against the stub hub (e2e/workspaceHub.mjs)
// and the collections-shown vector against the viewer's shownSelection.
//
// e2e/fixtures/workspace/ is a byte copy of canopy's tests/canopy_mcp/fixtures/workspace/:
// the same vectors canopy's pytest replays against FRONT's hub. Every scenario, every
// batch refusal and every route vector runs here; a fixture this file cannot replay is a
// failing test, never a skip.

import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Collection, shownSelection } from '../src/workspace/useCollections.js';
import {
  ADVERTISEMENT,
  advertiseWorkspace,
  commandProblem,
  emptyState,
  enqueueProblem,
  routeWorkspace,
  VERBS,
  WorkspaceHub,
} from './workspaceHub.mjs';

const ROOT = dirname(
  createRequire(import.meta.url).resolve('./fixtures/workspace/state.sample.json')
);

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

function load(rel: string): Obj {
  return JSON.parse(readFileSync(join(ROOT, rel), 'utf8')) as Obj;
}

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir))
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => `${dir}/${name}`);
}

const SAMPLE = load('state.sample.json').state;

/** The fixtures' partial match: objects by the keys expect names, lists by length then element. */
function mismatch(actual: unknown, expected: unknown, at = '$'): string | null {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at}: expected a list, got ${JSON.stringify(actual)}`;
    if (actual.length !== expected.length) {
      return `${at}: expected ${expected.length} items, got ${actual.length}: ${JSON.stringify(actual)}`;
    }
    for (let i = 0; i < expected.length; i += 1) {
      const problem = mismatch(actual[i], expected[i], `${at}[${i}]`);
      if (problem) return problem;
    }
    return null;
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) {
      return `${at}: expected an object, got ${JSON.stringify(actual)}`;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (!Object.hasOwn(actual, key)) return `${at}.${key}: missing`;
      const problem = mismatch((actual as Obj)[key], value, `${at}.${key}`);
      if (problem) return problem;
    }
    return null;
  }
  return Object.is(actual, expected)
    ? null
    : `${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
}

function resolveState(state: Json | undefined): Json | undefined {
  if (state === '$sample') return structuredClone(SAMPLE);
  if (state === '$empty') return emptyState() as unknown as Json;
  return state;
}

interface Event {
  event: string;
  data?: unknown;
}

/** One fresh hub at epoch e1 with its clock at 0, and each window's open stream buffer. */
class Replay {
  clock = 0;
  hub = new WorkspaceHub({ epoch: 'e1', now: () => this.clock });
  /** windowId -> events its current stream got since the last connect or receive. */
  buffers = new Map<string, Event[]>();
  streams = new Map<string, unknown>();

  request(req: { method: string; path: string; headers?: Obj; body?: string }) {
    const window = new URL(req.path, 'http://x/').searchParams.get('window');
    const isEvents = req.path.startsWith('events');
    const buffer: Event[] = [];
    const answer = routeWorkspace(this.hub, {
      ...req,
      sink: { send: (e: Event) => buffer.push(e), end: () => {} },
    });
    if (isEvents && window && answer.status === 200) {
      // Later events land in the same array; receive drains it.
      this.buffers.set(window, buffer);
      this.streams.set(window, answer.stream);
      return { ...answer, events: buffer.splice(0) };
    }
    return answer;
  }

  step(step: Obj): unknown {
    const { actor, do: action } = step as { actor: string; do: string };
    if (actor === 'clock') {
      this.clock += step.ms as number;
      return undefined;
    }
    if (actor === 'agent') {
      if (action === 'get_workspace') return this.hub.getWorkspace();
      if (action === 'set_workspace') {
        const call: Obj = { commands: step.commands };
        for (const field of ['base', 'batch_id', 'wait_s']) {
          if (Object.hasOwn(step, field)) call[field] = step[field];
        }
        return this.hub.setWorkspace(call);
      }
      throw new Error(`unknown agent action ${action}`);
    }
    const id = `w-${actor.slice('window:'.length)}`;
    const json = (body: Obj) => JSON.stringify(body);
    switch (action) {
      case 'claim':
        return this.request({
          method: 'POST',
          path: step.ifVacant ? 'claim?if_vacant=1' : 'claim',
          body: json({
            windowId: id,
            seq: step.seq,
            shown: step.shown,
            state: resolveState(step.state)!,
          }),
        });
      case 'report':
        return this.request({
          method: 'PUT',
          path: 'active',
          body: json({
            windowId: id,
            seq: step.seq,
            shown: step.shown,
            state: resolveState(step.state)!,
          }),
        });
      case 'goodbye':
        return this.request({ method: 'DELETE', path: `active?window=${id}` });
      case 'connect':
        return this.request({ method: 'GET', path: `events?window=${id}` });
      case 'receive':
        // FRONT's clock runs on its own; the e2e server ticks the stub on an interval.
        this.hub.tick();
        return { events: (this.buffers.get(id) ?? []).splice(0) };
      case 'disconnect':
        this.hub.disconnect(this.streams.get(id) as never);
        return undefined;
      case 'result':
        return this.request({
          method: 'POST',
          path: `active/${id}/result`,
          body: json({
            batch: step.batch,
            seq: step.seq,
            state: resolveState(step.state)!,
            results: step.results,
          }),
        });
      default:
        throw new Error(`unknown window action ${action}`);
    }
  }

  run(steps: Obj[], label: string) {
    steps.forEach((step, i) => {
      const actual = this.step(step);
      if (step.expect === undefined) return;
      const problem = mismatch(actual, step.expect);
      if (problem) {
        throw new Error(`${label} step ${i} (${step.actor} ${step.do}): ${problem}`);
      }
    });
  }
}

/** A route vector's request body: placeholders resolved, compact JSON, padded with spaces. */
function requestBody(request: Obj): string | undefined {
  if (!Object.hasOwn(request, 'body')) return undefined;
  let body = request.body as Obj;
  if (typeof body === 'object' && body !== null && typeof body.$file === 'string') {
    body = load(body.$file);
  } else if (typeof body === 'object' && body !== null && Object.hasOwn(body, 'state')) {
    body = { ...body, state: resolveState(body.state)! };
  }
  const text = JSON.stringify(body);
  const padTo = request.padTo as number | undefined;
  return padTo === undefined ? text : text.padEnd(padTo, ' ');
}

describe('the workspace fixture copy', () => {
  const all = ['', 'commands', 'rejections', 'refusals', 'routes', 'scenarios', 'queries'].flatMap(
    (dir) => files(dir)
  );

  it('holds every part of the set', () => {
    for (const dir of ['commands', 'rejections', 'refusals', 'routes', 'scenarios', 'queries']) {
      expect(files(dir).length, dir).toBeGreaterThan(0);
    }
    // One command vector per verb of the hub's table, and no vector for a retired verb.
    expect(files('commands')).toEqual(
      Object.keys(VERBS)
        .sort()
        .map((verb) => `commands/${verb}.json`)
    );
    for (const name of [
      'collections-shown.json',
      'context.json',
      'state.sample.json',
      'state.oversize.json',
      'state.reduced.json',
    ]) {
      expect(all).toContain(`/${name}`);
    }
  });

  it('keeps the byte rules: ASCII only, no trailing whitespace, one final newline', () => {
    for (const rel of all) {
      const bytes = readFileSync(join(ROOT, rel));
      expect(
        bytes.every((b) => b < 0x80),
        rel
      ).toBe(true);
      const text = bytes.toString('ascii');
      expect(text.endsWith('\n') && !text.endsWith('\n\n'), rel).toBe(true);
      expect(/[ \t]$/m.test(text), rel).toBe(false);
    }
  });
});

describe('the stub hub VERBS table', () => {
  for (const rel of files('commands')) {
    const fixture = load(rel);
    const verb = String(fixture.verb);
    const specs = (VERBS as Record<string, Record<string, { required?: boolean }>>)[verb]!;

    it(`${verb}: takes exactly the vector's arguments, required as it says`, () => {
      expect(rel).toBe(`commands/${verb}.json`);
      const args = fixture.args as Record<string, string>;
      expect(Object.keys(specs).sort()).toEqual(Object.keys(args).sort());
      // ', required' unconditionally; 'required exactly with ...' is a commandProblem rule.
      for (const [name, text] of Object.entries(args)) {
        expect(specs[name]!.required === true, `${verb} ${name}`).toBe(
          /, required( \(|$)/.test(text)
        );
      }
    });

    it(`${verb}: every vector command passes the shape check, in a batch with base`, () => {
      for (const c of fixture.cases as Obj[]) {
        const command = c.command as Obj;
        expect(commandProblem(command), String(c.name)).toBeNull();
        const base = { window: 'w-A', seq: 41 };
        expect(enqueueProblem({ commands: [command], base }), String(c.name)).toBeNull();
      }
    });
  }

  it('retires place, remove_tile, close, open mode/key and the boolean collection layout', () => {
    for (const verb of ['place', 'remove_tile', 'close']) {
      expect(Object.hasOwn(VERBS, verb), verb).toBe(false);
    }
    const open = { cmd: 'open', args: { ref: 'library/a/b', mode: 'replace', key: 'library/c/d' } };
    expect(commandProblem(open)).not.toBeNull();
    const collection = { cmd: 'open_collection', args: { ref: 'personal:grid', layout: true } };
    expect(commandProblem(collection)).not.toBeNull();
  });

  it('accepts a reported layout of any depth under the byte cap', () => {
    // Twelve nested two-item splits: past the retired depth cap of six.
    const keys = Array.from({ length: 13 }, (_, n) => `library/deep/s${n}`);
    let layout: Obj = { tile: 't13', tabs: [keys[12]!], showing: keys[12]! };
    for (let n = 11; n >= 0; n -= 1) {
      layout = {
        split: n % 2 === 0 ? 'row' : 'column',
        items: [{ tile: `t${n + 1}`, tabs: [keys[n]!], showing: keys[n]! }, layout],
      };
    }
    const state = {
      ...emptyState(),
      tabs: keys.map((key) => ({ key, kind: 'screen', canBack: false, canForward: false })),
      active: keys[0]!,
      layout,
    };
    const replay = new Replay();
    const answer = replay.request({
      method: 'POST',
      path: 'claim',
      body: JSON.stringify({ windowId: 'w-A', seq: 1, shown: true, state }),
    }) as unknown as Obj;
    expect(answer.status).toBe(200);
  });
});

describe('the stub hub replays every scenario', () => {
  for (const rel of files('scenarios')) {
    const fixture = load(rel);
    it(String(fixture.scenario), () => {
      new Replay().run(fixture.steps as Obj[], rel);
    });
  }
});

describe('the stub hub replays every batch refusal', () => {
  for (const rel of files('refusals')) {
    const fixture = load(rel);
    describe(String(fixture.reason), () => {
      for (const c of fixture.cases as Obj[]) {
        it(String(c.name), () => {
          new Replay().run(c.steps as Obj[], `${rel} ${String(c.name)}`);
        });
      }
    });
  }
});

describe('the stub hub replays every route vector', () => {
  for (const rel of files('routes')) {
    const fixture = load(rel);
    describe(String(fixture.route), () => {
      for (const c of fixture.cases as Obj[]) {
        it(String(c.name), () => {
          const replay = new Replay();
          const label = `${rel} ${String(c.name)}`;
          replay.run((c.setup as Obj[] | undefined) ?? [], `${label} setup`);
          const request = c.request as Obj;
          const expected = c.expect as Obj;
          const method = request.method as string;
          const path = request.path as string;
          let actual: Obj;
          if (path === '/config.json') {
            const config = advertiseWorkspace('{"pvMode":"mock"}', c.optIn === true);
            actual = { status: 200, body: JSON.parse(config) as Obj };
          } else if (Object.hasOwn(c, 'optIn') && c.optIn === false) {
            actual = routeWorkspace(null, { method, path }) as unknown as Obj;
          } else {
            actual = replay.request({
              method,
              path,
              headers: request.headers as Obj | undefined,
              body: requestBody(request),
            }) as unknown as Obj;
          }
          const { absent, ...rest } = expected;
          const problem = mismatch(actual, rest);
          if (problem) throw new Error(`${label}: ${problem}`);
          for (const key of (absent as string[] | undefined) ?? []) {
            expect(Object.hasOwn(actual.body as Obj, key), `${label}: ${key} absent`).toBe(false);
          }
          replay.run((c.then as Obj[] | undefined) ?? [], `${label} then`);
        });
      }
    });
  }

  it('advertises the path and protocol 1', () => {
    expect(ADVERTISEMENT).toEqual({ path: 'workspace', protocol: 1 });
  });
});

describe('the stub hub over time', () => {
  it('delivers a batch queued behind one that lapsed, inside its own ten seconds', () => {
    const replay = new Replay();
    replay.run(
      [
        { actor: 'window:A', do: 'claim', seq: 1, shown: true, state: '$empty' },
        { actor: 'window:A', do: 'connect' },
        {
          actor: 'agent',
          do: 'set_workspace',
          commands: [{ cmd: 'focus', args: { key: '@trace' } }],
          wait_s: 0,
        },
        { actor: 'window:A', do: 'receive' },
        { actor: 'clock', do: 'advance', ms: 4000 },
        {
          actor: 'agent',
          do: 'set_workspace',
          commands: [{ cmd: 'focus', args: { key: '@trace/2' } }],
          wait_s: 0,
          expect: { batch: { id: 'b-e1-2', status: 'pending' } },
        },
        { actor: 'clock', do: 'advance', ms: 6000 },
        {
          actor: 'window:A',
          do: 'receive',
          expect: { events: [{ event: 'batch', data: { batch: 'b-e1-2' } }] },
        },
        {
          actor: 'agent',
          do: 'get_workspace',
          expect: { pending: ['c-e1-2'], results: [{ id: 'c-e1-1', status: 'lost' }] },
        },
      ] as Obj[],
      'queued behind a lapse'
    );
  });

  it('forgets the oldest batch id past 256', () => {
    const replay = new Replay();
    replay.run(
      [
        { actor: 'window:A', do: 'claim', seq: 1, shown: true, state: '$empty' },
        { actor: 'window:A', do: 'connect' },
      ] as Obj[],
      'setup'
    );
    for (let n = 1; n <= 257; n += 1) {
      const batch = replay.hub.setWorkspace({ commands: [{ cmd: 'close_all' }] }).batch;
      expect(batch.id).toBe(`b-e1-${n}`);
      const posted = replay.request({
        method: 'POST',
        path: 'active/w-A/result',
        body: JSON.stringify({
          batch: batch.id,
          seq: n + 1,
          state: emptyState(),
          results: [{ id: `c-e1-${n}`, status: 'applied', changed: false }],
        }),
      });
      expect(posted.status).toBe(204);
    }
    const lookup = (id: string) =>
      replay.hub.setWorkspace({ commands: [{ cmd: 'close_all' }], batch_id: id }).batch;
    expect(lookup('b-e1-1')).toMatchObject({ id: null, reason: 'unknown_batch' });
    expect(lookup('b-e1-2')).toMatchObject({ id: 'b-e1-2', status: 'done' });
  });
});

describe('collections-shown against the viewer', () => {
  const fixture = load('collections-shown.json');
  for (const c of fixture.cases as Obj[]) {
    it(String(c.name), () => {
      const collections = c.collections as unknown as Collection[];
      const state = c.state as { ticked: string[]; unticked: string[] };
      expect(shownSelection(collections, state).map((col) => col.ref)).toEqual(c.expect);
    });
  }
});
