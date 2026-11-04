// Installs a ScreenPVService for one rendered screen (see ../screenPV.ts):
// the subtree's widgets read `fox://` channels from this screen's formulas
// and macros, everything else from the enclosing PVService.

import { useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import type { FormulaDeclaration, MacroValues } from '@slaclab/canopy-screen-ir';
import { PVServiceContext } from '@slaclab/canopy-screen-widgets';
import { useFormulaSubscriber } from '../formula.js';
import { ScreenPVService } from '../screenPV.js';

export function ScreenPVScope({
  formulas,
  macros,
  children,
}: {
  formulas: readonly FormulaDeclaration[] | undefined;
  /** The screen's effective macros; must be identity-stable (memoized). */
  macros: MacroValues;
  children: ReactNode;
}) {
  const parent = useContext(PVServiceContext);
  const subscriber = useFormulaSubscriber();
  const scoped = useMemo(
    () => (parent ? new ScreenPVService(parent, formulas, macros, subscriber) : null),
    [parent, formulas, macros, subscriber]
  );

  // No enclosing PVService (static-only trees, some tests): nothing to route
  // to, and PV widgets would fail exactly as they do without this scope.
  if (!scoped) return <>{children}</>;
  return <PVServiceContext.Provider value={scoped}>{children}</PVServiceContext.Provider>;
}
