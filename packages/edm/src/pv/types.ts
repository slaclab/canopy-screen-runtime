import type { AlarmSeverity } from '@slaclab/canopy-client';

/**
 * EDM's view of a channel's native type (ProcessVariable::specificType), which
 * decides how Text Control and Textupdate print it.
 */
export type EdmPvType = 'double' | 'integer' | 'enum' | 'string' | 'array' | 'unknown';

export interface EdmPvData {
  readonly connected: boolean;
  readonly type: EdmPvType;
  /** get_double(): the numeric value (enum index, 0 for text). */
  readonly num: number;
  /** Text value for string channels, the choice label for enums. */
  readonly text: string;
  readonly severity: AlarmSeverity;
  readonly units: string;
  /** PREC; null when the channel has none (integer records). */
  readonly precision: number | null;
  readonly enumChoices: readonly string[];
  readonly lowerLimit: number;
  readonly upperLimit: number;
  /** False when the channel refuses writes (EDM then shows its "no" cursor). */
  readonly writable: boolean;
}

export type EdmPvListener = (data: EdmPvData) => void;

/**
 * A PV source for one EDM PV-type prefix (EPICS\, LOC\, CALC\, …): the
 * connection plugin the layer routes to. `name` is the channel name with the
 * prefix removed and macros expanded.
 */
export interface EdmPvConnection {
  subscribe(name: string, listener: EdmPvListener): () => void;
  put?(name: string, value: number | string): void;
}
