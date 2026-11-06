// Fixture-mode FormulaSubscriber: every FormulaSpec evaluates in the page.
//
// In fixture mode there is no Formula Engine. Rule ladders, formula-arm rules and
// `formula://` widget channels (ScreenPVService subscribes through the
// ambient FormulaSubscriber) all evaluate with `evaluatePyExpr` over the
// fixture snapshot instead. The loc:// routing is today's, unchanged:
// loc-only specs evaluate against the screen's locals, gateway-only specs
// against the fixture, and a mixed spec is still a subscription error.

import type { FormulaSpec, FormulaSubscriber } from '../formula.js';
import { createLocalAwareFormulaSubscriber, type LocalPVLike } from './localFormula.js';

const LOC = 'loc://';

/**
 * A subscriber that evaluates gateway-only specs over `fixture`.
 *
 * It reuses the local evaluator — so connection gating, scalar coercion,
 * null/duplicate dropping and PyExprError handling are identical to loc://
 * formulas — by presenting each gateway address under a `loc://` alias that
 * resolves back to the fixture PV.
 */
function fixtureEvaluator(fixture: LocalPVLike): FormulaSubscriber {
  const aliased: LocalPVLike = {
    subscribe: (address, listener) => fixture.subscribe(address.slice(LOC.length), listener),
  };
  const evaluator = createLocalAwareFormulaSubscriber(aliased, null);
  return {
    subscribe(spec: FormulaSpec, options) {
      const bindings: Record<string, string> = {};
      for (const [token, address] of Object.entries(spec.bindings)) {
        bindings[token] = LOC + address;
      }
      return evaluator.subscribe({ ...spec, bindings }, options);
    },
  };
}

/**
 * The fixture-mode FormulaSubscriber for one screen scope: `local` is that
 * scope's loc:// service, `fixture` the page's FixturePVService.
 */
export function createFixtureFormulaSubscriber(
  local: LocalPVLike,
  fixture: LocalPVLike
): FormulaSubscriber {
  return createLocalAwareFormulaSubscriber(local, fixtureEvaluator(fixture));
}
