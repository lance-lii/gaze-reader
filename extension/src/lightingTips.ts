/**
 * What to tell the reader about the lighting flags (LightingMonitor, measured
 * from the camera frames). Kept apart from the measuring code so the popup can
 * word them without bundling it.
 */
import type { LightingFlag } from '../../src/types';

interface Tip {
  /** For a status line ("Shaky: …"), about 20 characters. */
  short: string;
  /** A sentence with what to do. */
  advice: string;
}

/** Most important first: the first flag present is the one worth fixing. */
export const LIGHTING_TIPS: readonly (readonly [LightingFlag, Tip])[] = Object.freeze([
  ['dark', { short: 'too dark', advice: 'It’s too dark for the camera to see your eyes well. Add light in front of you.' }],
  [
    'backlit',
    {
      short: 'bright light behind you',
      advice: 'There’s bright light behind you, so your face is in shadow. Face the light, or close the blind behind you.',
    },
  ],
  ['overexposed', { short: 'too much light', advice: 'The picture is washed out. A little less light on your face helps.' }],
  [
    'glare',
    { short: 'reflections on glasses', advice: 'There are reflections on your glasses or eyes. Tilt the screen or move the lamp a little.' },
  ],
  ['side-lit', { short: 'light from one side', advice: 'Most of the light comes from one side. Even light on your face tracks best.' }],
  ['unstable', { short: 'light keeps changing', advice: 'The light keeps changing. Steady light tracks best.' }],
]);

function firstTip(flags: readonly LightingFlag[]): Tip | null {
  for (const [flag, tip] of LIGHTING_TIPS) if (flags.includes(flag)) return tip;
  return null;
}

/** A few words for the most important flag, or null when the light is fine. */
export function lightingTip(flags: readonly LightingFlag[]): string | null {
  return firstTip(flags)?.short ?? null;
}

/** A sentence of advice for the most important flag, or null when the light is fine. */
export function lightingAdvice(flags: readonly LightingFlag[]): string | null {
  return firstTip(flags)?.advice ?? null;
}
