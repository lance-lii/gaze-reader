/**
 * Popup → content script requests beyond messages.ts's PageRequest: the
 * accuracy check, the quick refresh, and what the page knows about the light.
 * Sent with chrome.tabs.sendMessage like PageRequest and validated the same
 * way; a content script that predates them simply doesn't answer.
 */
import type { LightingComponent, LightingFlag } from '../../src/types';

export type PageExtraCommand = 'check-accuracy' | 'touch-up';

export type PageExtraRequest = { type: 'page-extra-query' } | { type: 'page-extra-command'; command: PageExtraCommand };

/** What the popup shows about the reader's conditions in a tab. */
export interface PageExtraState {
  /** The latest 'lighting-state' while the camera runs, else null. */
  lighting: { flags: LightingFlag[]; changedSinceCalibration: boolean; dominant: LightingComponent | null } | null;
  /** The accuracy check (and the quick refresh) can start: webcam, calibrated, not already calibrating. */
  canCheck: boolean;
}

const PAGE_EXTRA_COMMANDS: readonly PageExtraCommand[] = ['check-accuracy', 'touch-up'];
const FLAGS: readonly LightingFlag[] = ['dark', 'overexposed', 'glare', 'backlit', 'side-lit', 'unstable'];
const COMPONENTS: readonly LightingComponent[] = ['sclera', 'backlight', 'side', 'shade', 'glare', 'range'];

type Obj = Record<string, unknown>;
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
const oneOf =
  <T extends string>(values: readonly T[]) =>
  (x: unknown): x is T =>
    typeof x === 'string' && (values as readonly string[]).includes(x);

export const isPageExtraCommand = oneOf(PAGE_EXTRA_COMMANDS);
const isFlag = oneOf(FLAGS);
const isComponent = oneOf(COMPONENTS);

export function isPageExtraRequest(x: unknown): x is PageExtraRequest {
  if (!isObj(x)) return false;
  if (x.type === 'page-extra-query') return true;
  return x.type === 'page-extra-command' && isPageExtraCommand(x.command);
}

export function isPageExtraState(x: unknown): x is PageExtraState {
  if (!isObj(x) || typeof x.canCheck !== 'boolean') return false;
  const l = x.lighting;
  if (l === null) return true;
  return (
    isObj(l) &&
    Array.isArray(l.flags) &&
    l.flags.length <= FLAGS.length &&
    l.flags.every(isFlag) &&
    typeof l.changedSinceCalibration === 'boolean' &&
    (l.dominant === null || isComponent(l.dominant))
  );
}

/** What a tab without Gaze Reader (or with an older content script) reports. */
export const PAGE_EXTRA_NONE: Readonly<PageExtraState> = Object.freeze({ lighting: null, canCheck: false });
