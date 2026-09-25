import { Z } from '../core/constants';
import { readJSON, writeJSON } from '../core/storage';
import { IS_ARTIFACT } from '../core/target';
import type { BuddyMood, EventBus, GazeSourceKind, Mountable } from '../types';
import { fullAppLinkHtml, WEBCAM_UNAVAILABLE_SHORT } from './fullApp';
import { ModalLayer } from './helpDialog';
import { icon, type IconName } from './topbar';

const STORAGE_KEY = 'onboarding.v1';

export function hasCompletedOnboarding(): boolean {
  const v = readJSON<unknown>(STORAGE_KEY, null);
  return typeof v === 'object' && v !== null && (v as { done?: unknown }).done === true;
}

export function markOnboardingComplete(): void {
  writeJSON(STORAGE_KEY, { done: true, at: Date.now() });
}

interface Step {
  title: string;
  art: string;
  body: string;
  dewey: { text: string; mood: BuddyMood };
}

// Illustrations use theme tokens through classes (see app.css → "Onboarding art").
const ART_READING = `
<svg class="gr-onb__art" viewBox="0 0 240 140" aria-hidden="true" focusable="false">
  <path class="gr-art-page" d="M120 20C96 10 56 8 20 14v108c36-6 76-4 100 6z"/>
  <path class="gr-art-page" d="M120 20c24-10 64-12 100-6v108c-36-6-76-4-100 6z"/>
  <path class="gr-art-lines" d="M32 34h74M32 46h70M32 58h74M32 70h66M32 82h74M32 94h70M32 106h44M134 34h74M134 46h72M134 58h74M134 70h68M134 82h74M134 94h70M134 106h74"/>
  <path class="gr-art-path" d="M142 106l18 0 18 0 18 0"/>
  <circle class="gr-art-fix" cx="142" cy="106" r="3"/>
  <circle class="gr-art-fix" cx="160" cy="106" r="3.4"/>
  <circle class="gr-art-fix" cx="178" cy="106" r="3.8"/>
  <circle class="gr-art-fix gr-art-fix--now" cx="199" cy="106" r="4.4"/>
  <path class="gr-art-turn" d="M212 118c10 6 14 14 10 22M216 136l6 4 3-7"/>
</svg>`;

const ART_PRIVACY = `
<svg class="gr-onb__art" viewBox="0 0 240 140" aria-hidden="true" focusable="false">
  <rect class="gr-art-page" x="52" y="14" width="136" height="88" rx="8"/>
  <path class="gr-art-page" d="M36 108h168l-10 14H46z"/>
  <circle class="gr-art-cam" cx="120" cy="22" r="3.2"/>
  <path class="gr-art-shield" d="M120 38l26 10v18c0 16-11 28-26 33-15-5-26-17-26-33V48z"/>
  <path class="gr-art-check" d="M108 66l8 8 15-16"/>
</svg>`;

const PRIVACY_STEP: Step = {
  title: 'Your camera stays yours',
  art: ART_PRIVACY,
  body: `<ul class="gr-onb__list">
           <li>${icon('check')}<span>Face tracking runs right here in your browser.</span></li>
           <li>${icon('check')}<span>Video is never recorded, uploaded or shared.</span></li>
           <li>${icon('check')}<span>The camera runs only while a book is open, and a status pill always says so.</span></li>
           <li>${icon('check')}<span>Books and reading progress stay on this device.</span></li>
         </ul>`,
  dewey: { text: "Your video never leaves this device. Librarian's honor!", mood: 'happy' },
};

/** The Artifact build has no camera; say so up front and point to the full app. */
const artifactStep = (): Step => ({
  title: 'No camera needed here',
  art: ART_PRIVACY,
  body: `<ul class="gr-onb__list">
           <li>${icon('check')}<span>This embedded version runs without your camera: a demo reader or your mouse stands in for your eyes.</span></li>
           <li>${icon('check')}<span>For hands-free reading with your webcam, ${fullAppLinkHtml('open the full Gaze Reader')}.</span></li>
           <li>${icon('check')}<span>Books and reading progress stay in this browser.</span></li>
         </ul>`,
  dewey: { text: 'No camera in this version, so I brought a demo reader instead!', mood: 'happy' },
});

const STEPS: readonly Step[] = [
  {
    title: 'Read without lifting a finger',
    art: ART_READING,
    body: `<p>Gaze Reader notices where your eyes are on the page and turns it for you when you reach the bottom.</p>
           <p>Dewey, your reading buddy, reads along from the corner.</p>`,
    dewey: { text: "Hi, I'm Dewey! I'll read along with you.", mood: 'happy' },
  },
  IS_ARTIFACT ? artifactStep() : PRIVACY_STEP,
  {
    title: 'How would you like to start?',
    art: '',
    body: '<p class="gr-onb__lead">You can switch any time in Settings.</p>',
    dewey: { text: 'Pick whichever you like. We can always switch later.', mood: 'excited' },
  },
];

interface Choice {
  kind: GazeSourceKind;
  icon: IconName;
  title: string;
  text: string;
  badge?: string;
}

const WEB_CHOICES: readonly Choice[] = [
  { kind: 'webcam', icon: 'eye', title: 'Use my webcam', text: 'Hands-free reading, after a one-minute calibration.', badge: 'Recommended' },
  { kind: 'mouse', icon: 'mouse', title: 'Try with my mouse', text: 'Point where you are reading; no camera needed.' },
  { kind: 'simulated', icon: 'sparkle', title: 'Watch a demo', text: 'A simulated reader reads a sample book so you can see a page turn.' },
];

/** The Artifact build can't use the camera: the demo leads, and the webcam card says where to find it. */
const ARTIFACT_CHOICES: readonly Choice[] = [
  { kind: 'simulated', icon: 'sparkle', title: 'Watch a demo', text: 'A simulated reader reads a sample book so you can see a page turn.', badge: 'Recommended' },
  { kind: 'mouse', icon: 'mouse', title: 'Try with my mouse', text: 'Point where you are reading; the page turns at the bottom.' },
];

const CHOICES: readonly Choice[] = IS_ARTIFACT ? ARTIFACT_CHOICES : WEB_CHOICES;

let onbSeq = 0;

/** First-run introduction: what it does, the privacy promise, and how to start. */
export class Onboarding implements Mountable {
  private readonly bus: EventBus;
  private readonly layer: ModalLayer;
  private readonly steps: HTMLElement[] = [];
  private readonly dots: HTMLElement[] = [];
  private readonly back: HTMLButtonElement;
  private readonly next: HTMLButtonElement;
  private step = 0;
  private resolve: ((choice: GazeSourceKind | null) => void) | null = null;
  private pending: Promise<GazeSourceKind | null> | null = null;

  constructor(opts: { bus: EventBus; onClose?: () => void }) {
    this.bus = opts.bus;
    const uid = `gr-onb-${++onbSeq}`;
    this.layer = new ModalLayer({
      variant: 'gr-modal--center gr-onboarding',
      labelledBy: `${uid}-title-0`,
      // Just under Dewey, so he can talk the reader through it.
      zIndex: Z.buddy - 1,
      onClose: () => {
        this.finish(null);
        opts.onClose?.();
      },
    });
    const surface = this.layer.surface;

    const stage = document.createElement('div');
    stage.className = 'gr-onb__stage';
    STEPS.forEach((s, i) => {
      const el = document.createElement('div');
      el.className = 'gr-onb__step';
      el.hidden = i !== 0;
      el.innerHTML = `
        ${s.art}
        <p class="gr-onb__kicker">Step ${i + 1} of ${STEPS.length}</p>
        <h2 class="gr-onb__title" id="${uid}-title-${i}" tabindex="-1">${s.title}</h2>
        <div class="gr-onb__body">${s.body}</div>`;
      if (i === STEPS.length - 1) el.appendChild(this.renderChoices());
      stage.appendChild(el);
      this.steps.push(el);
    });

    const nav = document.createElement('div');
    nav.className = 'gr-onb__nav';
    const skip = document.createElement('button');
    skip.type = 'button';
    skip.className = 'gr-btn gr-btn--ghost';
    skip.textContent = 'Skip intro';
    skip.addEventListener('click', () => this.finish(null));
    const dots = document.createElement('div');
    dots.className = 'gr-onb__dots';
    dots.setAttribute('aria-hidden', 'true');
    for (let i = 0; i < STEPS.length; i++) {
      const d = document.createElement('span');
      d.className = 'gr-onb__dot';
      dots.appendChild(d);
      this.dots.push(d);
    }
    this.back = document.createElement('button');
    this.back.type = 'button';
    this.back.className = 'gr-btn gr-btn--soft';
    this.back.textContent = 'Back';
    this.back.addEventListener('click', () => this.goTo(this.step - 1));
    this.next = document.createElement('button');
    this.next.type = 'button';
    this.next.className = 'gr-btn gr-btn--primary';
    this.next.textContent = 'Next';
    this.next.addEventListener('click', () => this.goTo(this.step + 1));
    const buttons = document.createElement('div');
    buttons.className = 'gr-onb__buttons';
    buttons.append(this.back, this.next);
    nav.append(skip, dots, buttons);

    surface.append(stage, nav);
  }

  get isOpen(): boolean {
    return this.layer.isOpen;
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    this.layer.mount(parent);
  }

  /** Opens the intro; resolves with the chosen source, or null when skipped. */
  run(): Promise<GazeSourceKind | null> {
    if (this.pending) return this.pending;
    this.pending = new Promise((resolve) => {
      this.resolve = resolve;
    });
    // Reset to the first step before opening, so the initial focus target is visible.
    this.goTo(0, false);
    this.layer.open(this.next);
    return this.pending;
  }

  close(): void {
    this.finish(null);
  }

  destroy(): void {
    const resolve = this.resolve;
    this.resolve = null;
    this.pending = null;
    this.layer.destroy();
    resolve?.(null);
  }

  private renderChoices(): HTMLElement {
    const list = document.createElement('div');
    list.className = 'gr-onb__choices';
    for (const c of CHOICES) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'gr-choice';
      b.dataset.choice = c.kind;
      b.innerHTML = `
        <span class="gr-choice__icon">${icon(c.icon)}</span>
        <span class="gr-choice__text">
          <strong>${c.title}${c.badge ? ` <em class="gr-choice__badge">${c.badge}</em>` : ''}</strong>
          <small>${c.text}</small>
        </span>
        ${icon('chevronRight', 'gr-choice__chevron')}`;
      b.addEventListener('click', () => this.finish(c.kind));
      list.appendChild(b);
    }
    if (IS_ARTIFACT) {
      const card = document.createElement('div');
      card.className = 'gr-choice gr-choice--unavailable';
      card.dataset.choice = 'webcam';
      card.innerHTML = `
        <span class="gr-choice__icon">${icon('eye')}</span>
        <span class="gr-choice__text">
          <strong>Use my webcam</strong>
          <small>${WEBCAM_UNAVAILABLE_SHORT} ${fullAppLinkHtml()}</small>
        </span>`;
      list.appendChild(card);
    }
    return list;
  }

  private goTo(index: number, moveFocus = true): void {
    const i = Math.max(0, Math.min(STEPS.length - 1, index));
    this.step = i;
    this.steps.forEach((el, k) => {
      el.hidden = k !== i;
    });
    this.dots.forEach((d, k) => {
      d.dataset.active = String(k === i);
    });
    this.layer.surface.setAttribute('aria-labelledby', this.steps[i]!.querySelector('h2')!.id);
    this.back.hidden = i === 0;
    const last = i === STEPS.length - 1;
    this.next.hidden = last;
    const s = STEPS[i]!;
    // Dewey sizes the bubble's duration to the text, so his lines keep pace with the steps.
    this.bus.emit('buddy-say', { text: s.dewey.text, priority: 'high', mood: s.dewey.mood });
    if (!moveFocus) return;
    // Focus the new step's heading so screen readers announce it; on the last step, the first choice.
    const target = last ? this.steps[i]!.querySelector<HTMLElement>('.gr-choice') : this.steps[i]!.querySelector<HTMLElement>('h2');
    target?.focus({ preventScroll: true });
  }

  private finish(choice: GazeSourceKind | null): void {
    const resolve = this.resolve;
    if (!resolve) return;
    this.resolve = null;
    this.pending = null;
    markOnboardingComplete();
    this.layer.close();
    resolve(choice);
  }
}
