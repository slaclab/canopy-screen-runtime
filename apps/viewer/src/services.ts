// Composition root — the ONLY place concrete PV / formula services appear.
// Everything below App consumes them through context.

import { createContext, useContext } from 'react';
import type { PVService } from '@slaclab/canopy-client';
import {
  FoxFormulaService,
  HarePVService,
  LocalPVService,
  MockPVService,
  RoutedPVService,
} from '@slaclab/canopy-client';
import type { FormulaSubscriber } from '@slaclab/canopy-screen-runtime';
import {
  createFoxFormulaSubscriber,
  createLocalAwareFormulaSubscriber,
} from '@slaclab/canopy-screen-runtime';
import type { ViewerConfig } from './config.js';
import { screenPolicyLoader } from './policy.js';
import type { VariantPreferences } from './preferences.js';
import { browserPreferences } from './preferences.js';
import type { ScreenPolicy } from './variants.js';
import { EMPTY_POLICY } from './variants.js';

export interface ViewerServices {
  pv: PVService;
  /** null in mock mode: rules stay inert (base props render unchanged). */
  formulas: FormulaSubscriber | null;
  /** loc:// locals (EDM LOC parity); ScreenPage clears it per screen. */
  locals: LocalPVService;
  /**
   * The Hare service itself (hare mode), for consumers that need its channel
   * metadata (the EDM renderer tells integer from double records by PREC).
   */
  hare: HarePVService | null;
  /**
   * A fresh, unconnected Hare service (hare mode): the EDM renderer opens its
   * own sockets so one subscribe message carries a whole screen's channels.
   */
  createHare: (() => HarePVService) | null;
  /** The site's screen variant policy (default: none). Never rejects. */
  screenPolicy?: () => Promise<ScreenPolicy>;
  /** This user's own variant choices (default: this browser's localStorage). */
  preferences?: VariantPreferences;
}

const noPolicy = () => Promise.resolve(EMPTY_POLICY);

export function createServices(config: ViewerConfig): ViewerServices {
  const screenPolicy =
    config.screenPolicy === 'magpie'
      ? screenPolicyLoader({
          canopyBaseUrl: config.canopyBaseUrl,
          apiKey: config.canopyApiKey,
          slug: config.screenPolicySlug,
        })
      : noPolicy;
  const preferences = browserPreferences;
  // loc:// locals are page-side state (EDM LOC semantics): widgets write and
  // rules read them without a gateway, in every pv mode.
  const locals = new LocalPVService();
  locals.connect();

  if (config.pvMode === 'hare') {
    const createHare = () =>
      new HarePVService({
        url: `${config.canopyBaseUrl.replace(/^http/i, 'ws')}/hare/v1/ws/pvs`,
        apiKey: config.canopyApiKey,
      });
    const hare = createHare();
    const pv = new RoutedPVService({ 'loc://': locals }, hare);
    pv.connect();
    const fox = new FoxFormulaService({
      baseUrl: config.canopyBaseUrl,
      apiKey: config.canopyApiKey,
    });
    fox.connect();
    return {
      pv,
      formulas: createLocalAwareFormulaSubscriber(locals, createFoxFormulaSubscriber(fox)),
      locals,
      hare,
      createHare,
      screenPolicy,
      preferences,
    };
  }

  const pv = new RoutedPVService({ 'loc://': locals }, new MockPVService());
  pv.connect();
  return {
    pv,
    formulas: createLocalAwareFormulaSubscriber(locals, null),
    locals,
    hare: null,
    createHare: null,
    screenPolicy,
    preferences,
  };
}

export const ServicesContext = createContext<ViewerServices | null>(null);

export function useServices(): ViewerServices {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices must be used inside <ServicesContext.Provider>');
  return services;
}
