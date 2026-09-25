import { FULL_APP_URL } from '../core/target';

/**
 * Wording and links for the Artifact build, where the webcam can't be used
 * (the frame refuses camera access and blocks MediaPipe's model and runtime).
 * Only reached behind IS_ARTIFACT checks, so it tree-shakes out of the web app.
 */

export const WEBCAM_UNAVAILABLE_TITLE = 'Eye tracking needs the full app';

export const WEBCAM_UNAVAILABLE_TEXT =
  'This embedded version can’t use your camera. Watch the demo or follow your mouse here, or open the full Gaze Reader to turn pages with your eyes.';

/** Short form for tooltips and cards. */
export const WEBCAM_UNAVAILABLE_SHORT = 'Not available here: the camera only works in the full app.';

export const FULL_APP_LABEL = 'Open the full app';

/** Markup for a link to the full app that opens in a new tab. */
export function fullAppLinkHtml(label: string = FULL_APP_LABEL): string {
  return `<a class="gr-artifact-link" href="${FULL_APP_URL}" target="_blank" rel="noopener">${label}</a>`;
}

/** Dewey says this once per visit in the Artifact build. */
export const DEWEY_FULL_APP_LINE = 'Psst! In the full Gaze Reader, your own eyes turn the page. This version can’t use a camera.';
