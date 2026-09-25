/**
 * The build target, fixed at compile time.
 *
 *   web       the normal app (GitHub Pages, `npm run dev`) and the extension
 *   artifact  a single-page build that runs inside a claude.ai Artifact frame
 *             (`npm run build:artifact`): no camera, no MediaPipe, no
 *             cross-origin fetches, no dialogs or downloads
 *
 * Code branches on IS_ARTIFACT so the unused side tree-shakes away: the web
 * bundle carries no artifact-only code and the artifact bundle no MediaPipe.
 * Tests (no define) see 'web'.
 */
export type BuildTarget = 'web' | 'artifact';

export const IS_ARTIFACT: boolean = typeof __GR_TARGET__ !== 'undefined' && __GR_TARGET__ === 'artifact';

export const BUILD_TARGET: BuildTarget = IS_ARTIFACT ? 'artifact' : 'web';

/** The full app, with webcam eye tracking. */
export const FULL_APP_URL = 'https://lance-lii.github.io/gaze-reader/';

/** The source code. */
export const REPO_URL = 'https://github.com/lance-lii/gaze-reader';
