import { DEFAULT_SETTINGS } from '../core/settings';
import { IS_ARTIFACT } from '../core/target';
import type { AppSettings, EventBus, Mountable } from '../types';
import { SETTINGS_GROUPS, resetPatch, type SettingControl } from '../app/logic';
import { fullAppLinkHtml, WEBCAM_UNAVAILABLE_SHORT, WEBCAM_UNAVAILABLE_TEXT } from './fullApp';
import { ModalLayer, dialogHeader } from './helpDialog';
import { icon } from './topbar';

export interface SettingsPanelOptions {
  bus: EventBus;
  getSettings: () => AppSettings;
  hasSavedCalibration: () => boolean;
  onForgetCalibration: () => void;
  onRecalibrate: () => void;
  /** "Check accuracy": a few dots measured against the calibration in use (omit to hide the button). */
  onCheckAccuracy?: () => void;
  onShowHelp: () => void;
  onReplayIntro: () => void;
  onClose?: () => void;
  /** The tracking-diagnostics recorder (Advanced). Omitted where downloads don't exist (the Artifact build). */
  diagnostics?: DiagnosticsControls;
}

export interface DiagnosticsStatus {
  recording: boolean;
  elapsedMs: number;
  limitMs: number;
  /** A recording (finished or running) can be downloaded. */
  hasData: boolean;
}

export interface DiagnosticsControls {
  status(): DiagnosticsStatus;
  start(): void;
  /** Stops and downloads. */
  stop(): void;
  download(): void;
}

/**
 * What the diagnostics recorder keeps, in plain words. The same list is in README ("Tracking
 * diagnostics") and PRIVACY.md ("Tracking diagnostics"); src/app/diagnostics.ts is the truth.
 */
export const DIAGNOSTICS_PRIVACY_TEXT =
  'Records numbers only, for up to 10 minutes: eye measurements, gaze estimates, lighting readings, ' +
  'line positions and page turns, plus your settings, your browser, and your camera’s settings and name (usually its model). ' +
  'No video, no images, no book text. It stays on this device until you download it, and nothing is uploaded.';

/** "3:07" */
export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

type Updater = (s: AppSettings) => void;

/** Artifact build: stands in for the calibration buttons and says where eye tracking lives. */
function artifactTrackingNote(): HTMLElement {
  const note = document.createElement('p');
  note.className = 'gr-artifact-note';
  note.innerHTML = `${WEBCAM_UNAVAILABLE_TEXT} ${fullAppLinkHtml()}`;
  return note;
}

const CONFIRM_WINDOW_MS = 4000;

let panelSeq = 0;

function patchOf<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Partial<AppSettings> {
  const p: Partial<AppSettings> = {};
  p[key] = value;
  return p;
}

/**
 * Slide-over settings drawer. Every control writes through `settings-patch`
 * (the settings store validates, persists and re-broadcasts), and the drawer
 * re-syncs from `settings-changed`, so changes made elsewhere (Dewey's drag,
 * keyboard shortcuts) show up live.
 */
export class SettingsPanel implements Mountable {
  private readonly opts: SettingsPanelOptions;
  private readonly layer: ModalLayer;
  private readonly updaters: Updater[] = [];
  /** Null in the Artifact build, which has no calibration to forget. */
  private readonly forgetBtn: HTMLButtonElement | null;
  private readonly offSettings: () => void;
  private readonly confirmTimers = new Map<HTMLButtonElement, ReturnType<typeof setTimeout>>();
  private readonly statusTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  /** Null in the Artifact build (no calibration) or when the host offers no check. */
  private readonly checkBtn: HTMLButtonElement | null;
  private diag: { record: HTMLButtonElement; download: HTMLButtonElement; status: HTMLElement } | null = null;
  private diagTimer: ReturnType<typeof setInterval> | null = null;

  constructor(opts: SettingsPanelOptions) {
    this.opts = opts;
    const uid = `gr-settings-${++panelSeq}`;
    this.layer = new ModalLayer({ variant: 'gr-modal--drawer gr-settings', labelledBy: `${uid}-title`, onClose: opts.onClose });
    const surface = this.layer.surface;
    dialogHeader(surface, `${uid}-title`, 'Settings', () => this.close());

    const body = document.createElement('div');
    body.className = 'gr-modal__body gr-settings__body';
    const privacy = document.createElement('p');
    privacy.className = 'gr-privacy-note gr-privacy-note--banner';
    privacy.innerHTML = `${icon('shield')}<span>Everything runs on this device. Video never leaves your browser.</span>`;
    body.appendChild(privacy);

    for (const group of SETTINGS_GROUPS) {
      const section = document.createElement('section');
      section.className = 'gr-set-group';
      section.setAttribute('aria-labelledby', `${uid}-${group.id}`);
      const h = document.createElement('h3');
      h.className = 'gr-set-group__title';
      h.id = `${uid}-${group.id}`;
      h.textContent = group.title;
      section.appendChild(h);
      for (const control of group.controls) {
        // No camera in the Artifact build, so no camera preview either.
        if (IS_ARTIFACT && control.key === 'showCameraPreview') continue;
        section.appendChild(this.renderControl(control, uid));
      }
      if (group.id === 'tracking') section.appendChild(IS_ARTIFACT ? artifactTrackingNote() : this.renderCalibrationActions());
      if (group.id === 'advanced' && opts.diagnostics && !IS_ARTIFACT) section.appendChild(this.renderDiagnostics(opts.diagnostics, uid));
      body.appendChild(section);
    }

    const footer = document.createElement('div');
    footer.className = 'gr-settings__footer';
    const footerStatus = this.statusElement();
    const reset = this.button('Reset to defaults', 'gr-btn--soft', () => {
      opts.bus.emit('settings-patch', resetPatch(DEFAULT_SETTINGS, opts.getSettings()));
      this.flash(footerStatus, 'Settings reset. Your gaze source was kept.');
    });
    this.confirmable(reset, 'Click again to reset');
    footer.append(
      reset,
      this.button('Keyboard shortcuts', 'gr-btn--ghost', () => opts.onShowHelp(), 'keyboard'),
      this.button('Replay intro', 'gr-btn--ghost', () => opts.onReplayIntro(), 'glasses'),
      footerStatus,
    );
    body.appendChild(footer);
    surface.appendChild(body);

    this.forgetBtn = surface.querySelector<HTMLButtonElement>('.gr-settings__forget');
    this.checkBtn = surface.querySelector<HTMLButtonElement>('.gr-settings__check');
    this.offSettings = opts.bus.on('settings-changed', ({ settings }) => this.update(settings));
    this.update(opts.getSettings());
  }

  get isOpen(): boolean {
    return this.layer.isOpen;
  }

  mount(parent: HTMLElement | ShadowRoot): void {
    this.layer.mount(parent);
  }

  open(): void {
    this.update(this.opts.getSettings());
    this.layer.open();
    this.syncDiagTimer();
  }

  close(): void {
    this.layer.close();
    this.syncDiagTimer();
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  /** Re-sync every control from settings (does not emit events). */
  update(s: AppSettings): void {
    for (const u of this.updaters) u(s);
    const saved = this.opts.hasSavedCalibration();
    if (this.forgetBtn) this.forgetBtn.disabled = !saved;
    if (this.checkBtn) this.checkBtn.disabled = !saved;
    this.refreshDiagnostics();
  }

  /** Re-reads the diagnostics recorder's state (the host calls this when it starts or stops). */
  refreshDiagnostics(): void {
    if (IS_ARTIFACT) return;
    const d = this.diag;
    const controls = this.opts.diagnostics;
    if (!d || !controls) return;
    const st = controls.status();
    const label = d.record.querySelector('span');
    if (label) label.textContent = st.recording ? `Stop and download (${formatClock(st.elapsedMs)} of ${formatClock(st.limitMs)})` : 'Record tracking diagnostics (no video)';
    d.record.dataset.recording = String(st.recording);
    d.record.setAttribute('aria-pressed', String(st.recording));
    d.download.hidden = st.recording || !st.hasData;
    this.syncDiagTimer();
  }

  destroy(): void {
    if (this.diagTimer !== null) clearInterval(this.diagTimer);
    this.diagTimer = null;
    this.offSettings();
    for (const t of this.confirmTimers.values()) clearTimeout(t);
    this.confirmTimers.clear();
    for (const t of this.statusTimers.values()) clearTimeout(t);
    this.statusTimers.clear();
    this.layer.destroy();
  }

  // ───────────────────────────── rendering ─────────────────────────────

  private renderControl(c: SettingControl, uid: string): HTMLElement {
    const id = `${uid}-${c.key}`;
    const bus = this.opts.bus;
    const hint = (row: HTMLElement) => {
      if (!c.hint) return;
      const small = document.createElement('small');
      small.className = 'gr-set-row__hint';
      small.id = `${id}-hint`;
      small.textContent = c.hint;
      row.appendChild(small);
    };

    switch (c.kind) {
      case 'toggle': {
        const row = document.createElement('div');
        row.className = 'gr-set-row gr-set-row--toggle';
        const label = document.createElement('label');
        label.className = 'gr-set-row__label';
        label.htmlFor = id;
        label.textContent = c.label;
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.id = id;
        input.className = 'gr-switch';
        input.setAttribute('role', 'switch');
        if (c.hint) input.setAttribute('aria-describedby', `${id}-hint`);
        input.addEventListener('change', () => bus.emit('settings-patch', patchOf(c.key, input.checked)));
        row.append(label, input);
        hint(row);
        this.updaters.push((s) => {
          input.checked = s[c.key];
        });
        return row;
      }

      case 'range': {
        const row = document.createElement('div');
        row.className = 'gr-set-row gr-set-row--range';
        const label = document.createElement('label');
        label.className = 'gr-set-row__label';
        label.htmlFor = id;
        label.textContent = c.label;
        const out = document.createElement('output');
        out.className = 'gr-set-row__value';
        out.htmlFor.add(id);
        const input = document.createElement('input');
        input.type = 'range';
        input.id = id;
        input.className = 'gr-range';
        input.min = String(c.min);
        input.max = String(c.max);
        input.step = String(c.step);
        if (c.hint) input.setAttribute('aria-describedby', `${id}-hint`);
        const show = (v: number) => {
          const text = c.format(v);
          out.textContent = text;
          input.setAttribute('aria-valuetext', text);
          // Paint the filled part of the track.
          const pct = ((Math.min(c.max, Math.max(c.min, v)) - c.min) / (c.max - c.min)) * 100;
          input.style.setProperty('--gr-fill', `${pct}%`);
        };
        input.addEventListener('input', () => {
          const v = Number(input.value);
          if (!Number.isFinite(v)) return;
          show(v);
          bus.emit('settings-patch', patchOf(c.key, v));
        });
        row.append(label, out, input);
        hint(row);
        this.updaters.push((s) => {
          const v = s[c.key];
          input.value = String(v);
          show(v);
        });
        return row;
      }

      case 'choice': {
        if (c.display === 'select') {
          const row = document.createElement('div');
          row.className = 'gr-set-row gr-set-row--select';
          const label = document.createElement('label');
          label.className = 'gr-set-row__label';
          label.htmlFor = id;
          label.textContent = c.label;
          const select = document.createElement('select');
          select.id = id;
          select.className = 'gr-select';
          for (const o of c.options) {
            const opt = document.createElement('option');
            opt.value = String(o.value);
            opt.textContent = o.label;
            select.appendChild(opt);
          }
          select.addEventListener('change', () => {
            const o = c.options.find((x) => String(x.value) === select.value);
            if (o) bus.emit('settings-patch', patchOf(c.key, o.value));
          });
          row.append(label, select);
          hint(row);
          this.updaters.push((s) => {
            select.value = String(s[c.key]);
          });
          return row;
        }

        const row = document.createElement('fieldset');
        row.className = 'gr-set-row gr-set-row--choice';
        const legend = document.createElement('legend');
        legend.className = 'gr-set-row__label';
        legend.textContent = c.label;
        const seg = document.createElement('div');
        seg.className = 'gr-seg gr-seg--full';
        const inputs: HTMLInputElement[] = [];
        for (const o of c.options) {
          const opt = document.createElement('label');
          opt.className = 'gr-seg__opt';
          const input = document.createElement('input');
          input.type = 'radio';
          input.name = id;
          input.value = String(o.value);
          input.className = 'gr-sr-only';
          if (IS_ARTIFACT && c.key === 'gazeSource' && o.value === 'webcam') {
            input.disabled = true;
            opt.dataset.unavailable = '';
            opt.title = WEBCAM_UNAVAILABLE_SHORT;
          }
          input.addEventListener('change', () => {
            if (input.checked) bus.emit('settings-patch', patchOf(c.key, o.value));
          });
          const face = document.createElement('span');
          face.className = 'gr-seg__face';
          if (c.key === 'theme') {
            const sw = document.createElement('span');
            sw.className = 'gr-swatch';
            sw.dataset.swatch = String(o.value);
            sw.setAttribute('aria-hidden', 'true');
            face.appendChild(sw);
          }
          face.append(o.label);
          opt.append(input, face);
          seg.appendChild(opt);
          inputs.push(input);
        }
        row.append(legend, seg);
        if (c.hint) {
          row.setAttribute('aria-describedby', `${id}-hint`);
          hint(row);
        }
        this.updaters.push((s) => {
          const v = String(s[c.key]);
          for (const input of inputs) input.checked = input.value === v;
        });
        return row;
      }
    }
  }

  private renderCalibrationActions(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'gr-set-actions';
    const recal = this.button('Calibrate eye tracking', 'gr-btn--soft', () => {
      this.close();
      this.opts.onRecalibrate();
    }, 'target');
    const status = this.statusElement();
    const forget = this.button('Forget calibration', 'gr-btn--ghost gr-settings__forget', () => {
      this.opts.onForgetCalibration();
      this.update(this.opts.getSettings());
      // The button just disabled itself; a disabled element drops focus to <body>,
      // outside the drawer's focus trap. Hand it to the natural next step instead.
      if (forget.disabled) recal.focus({ preventScroll: true });
      this.flash(status, 'Calibration forgotten. You’ll calibrate again next time you use your eyes.');
    }, 'trash');
    this.confirmable(forget, 'Click again to forget');
    const onCheck = this.opts.onCheckAccuracy;
    if (onCheck) {
      const check = this.button('Check accuracy', 'gr-btn--ghost gr-settings__check', () => {
        this.close();
        onCheck();
      }, 'sun');
      check.title = 'A few dots show how far off the tracking is now, e.g. after the light changed (A)';
      wrap.append(recal, check, forget, status);
    } else {
      wrap.append(recal, forget, status);
    }
    return wrap;
  }

  private renderDiagnostics(controls: DiagnosticsControls, uid: string): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'gr-set-row gr-set-diag';
    const title = document.createElement('p');
    title.className = 'gr-set-row__label';
    title.id = `${uid}-diag`;
    title.textContent = 'Tracking diagnostics';
    title.style.margin = '0';
    const hint = document.createElement('small');
    hint.className = 'gr-set-row__hint';
    hint.id = `${uid}-diag-hint`;
    hint.textContent = DIAGNOSTICS_PRIVACY_TEXT;
    const actions = document.createElement('div');
    actions.className = 'gr-set-actions';
    actions.style.gridColumn = '1 / -1';
    const status = this.statusElement();
    const record = this.button('Record tracking diagnostics (no video)', 'gr-btn--soft gr-settings__record', () => {
      if (controls.status().recording) {
        controls.stop();
        this.flash(status, 'Recording stopped and saved as a JSON file.');
      } else {
        controls.start();
        this.flash(status, 'Recording. Read as usual; stop here within 10 minutes (it stops by itself then).');
      }
      this.refreshDiagnostics();
    }, 'record');
    record.setAttribute('aria-describedby', hint.id);
    const download = this.button('Download the last recording', 'gr-btn--ghost gr-settings__diag-download', () => controls.download(), 'download');
    download.hidden = true;
    actions.append(record, download, status);
    wrap.append(title, hint, actions);
    this.diag = { record, download, status };
    return wrap;
  }

  /** Ticks the recording clock on the button while the drawer is open and recording. */
  private syncDiagTimer(): void {
    const want = this.isOpen && this.opts.diagnostics?.status().recording === true;
    if (want && this.diagTimer === null) this.diagTimer = setInterval(() => this.refreshDiagnostics(), 1000);
    else if (!want && this.diagTimer !== null) {
      clearInterval(this.diagTimer);
      this.diagTimer = null;
    }
  }

  private statusElement(): HTMLElement {
    const status = document.createElement('p');
    status.className = 'gr-settings__status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    return status;
  }

  private button(label: string, variant: string, onClick: () => void, iconName?: Parameters<typeof icon>[0]): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `gr-btn ${variant}`;
    b.innerHTML = iconName ? icon(iconName) : '';
    const span = document.createElement('span');
    span.textContent = label;
    b.appendChild(span);
    b.dataset.label = label;
    b.addEventListener('click', (e) => {
      // Two-step buttons intercept the first click (see confirmable()).
      if (e.defaultPrevented) return;
      onClick();
    });
    return b;
  }

  /** First click arms the button ("Click again to …"); a second click within a few seconds confirms. */
  private confirmable(b: HTMLButtonElement, armedLabel: string): void {
    const span = b.querySelector('span')!;
    const disarm = () => {
      const t = this.confirmTimers.get(b);
      if (t !== undefined) clearTimeout(t);
      this.confirmTimers.delete(b);
      delete b.dataset.armed;
      span.textContent = b.dataset.label ?? '';
    };
    // Capture phase so we run before the button's own click handler.
    b.addEventListener(
      'click',
      (e) => {
        if (b.dataset.armed === 'true') {
          disarm();
          return;
        }
        e.preventDefault();
        b.dataset.armed = 'true';
        span.textContent = armedLabel;
        this.confirmTimers.set(b, setTimeout(disarm, CONFIRM_WINDOW_MS));
      },
      { capture: true },
    );
    b.addEventListener('blur', disarm);
  }

  private flash(target: HTMLElement, text: string): void {
    target.textContent = text;
    const previous = this.statusTimers.get(target);
    if (previous !== undefined) clearTimeout(previous);
    this.statusTimers.set(
      target,
      setTimeout(() => {
        this.statusTimers.delete(target);
        target.textContent = '';
      }, 6000),
    );
  }
}
