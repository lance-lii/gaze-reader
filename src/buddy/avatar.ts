import type { Point } from '../types';
import { BUDDY_CLASS as B } from './styles';

/**
 * Dewey, drawn by hand as an inline SVG (viewBox 120 × 150).
 *
 * The DOM is built with createElementNS rather than innerHTML so it also works
 * on host pages that enforce Trusted Types (the extension mounts Dewey on
 * arbitrary sites). Moods never rebuild the SVG: styles.ts toggles the parts
 * created here (brows, mouths, lids, happy-eyes, Zzz, sparkles) with classes.
 */

export const AVATAR_WIDTH = 120;
export const AVATAR_HEIGHT = 150;
/** Maximum pupil travel from the eye center, in SVG units (≈ CSS px at 1×). */
export const PUPIL_MAX_TRAVEL = 3;

export interface EyeParts {
  /** The white of the eye; its on-screen rect gives the eye center. */
  readonly sclera: SVGEllipseElement;
  /** Pupil group; position it with setPupil(). */
  readonly pupil: SVGGElement;
  /** Eye center in SVG units. */
  readonly center: Point;
}

export interface AvatarParts {
  readonly svg: SVGSVGElement;
  /** Viewer's left eye, then viewer's right eye. */
  readonly eyes: readonly [EyeParts, EyeParts];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

const INK = '#3b2a26';
const C = {
  ink: INK,
  skinShade: '#e8b08c',
  lid: '#f1c4a2',
  earInner: '#d9946f',
  nose: '#cf8b67',
  blush: '#f28b82',
  freckle: '#b8704f',
  hair: '#6b4430',
  hairDark: '#4a2c1e',
  hairLight: '#a06a4a',
  frame: '#2b2e3a',
  iris: '#2f2522',
  pupil: '#15100e',
  mouth: '#7b2d2d',
  tongue: '#e8747c',
  shirt: '#f3f6fb',
  collar: '#ffffff',
  bow: '#d9534f',
  bowKnot: '#b43c3c',
  bowDot: '#f6c1bf',
  vestTrim: '#2a4266',
  penBlue: '#3a6fd8',
  penRed: '#e0503f',
  pencil: '#f2c230',
  eraser: '#f29aa3',
  protector: '#edf2f8',
  protectorEdge: '#6f7f96',
  pageEdge: '#b9a98f',
  pageLine: '#b3a58d',
  spine: '#a8977b',
  ribbon: '#e0503f',
  shoe: '#5a3b2a',
  zzz: '#8a97c4',
  star: '#ffcf4d',
  starEdge: '#e0a526',
} as const;

/** Argyle vest outline: V-neck front, rounded hem. */
const VEST =
  'M33.5 138 C33.5 116 40.5 104.5 50.5 100.5 L60 117 L69.5 100.5 C79.5 104.5 86.5 116 86.5 138 ' +
  'C86.5 143.5 80 145.5 60 145.5 C40 145.5 33.5 143.5 33.5 138 Z';

type Attrs = Readonly<Record<string, string | number>>;

/**
 * Builds Dewey. `uid` must be unique per document/shadow root: it prefixes the
 * gradient, pattern and clip-path ids.
 */
export function createAvatar(doc: Document, uid: string): AvatarParts {
  const s = <K extends keyof SVGElementTagNameMap>(
    tag: K,
    attrs: Attrs = {},
    children: readonly SVGElement[] = [],
  ): SVGElementTagNameMap[K] => {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
    for (const child of children) el.appendChild(child);
    return el;
  };
  const id = (name: string) => `${uid}-${name}`;
  const url = (name: string) => `url(#${id(name)})`;
  const stop = (offset: number, color: string, opacity = 1) =>
    s('stop', { offset, 'stop-color': color, 'stop-opacity': opacity });
  const inked = (d: string, fill: string, width = 1.6, extra: Attrs = {}) =>
    s('path', { d, fill, stroke: C.ink, 'stroke-width': width, 'stroke-linejoin': 'round', ...extra });
  const line = (d: string, stroke: string, width: number, extra: Attrs = {}) =>
    s('path', { d, fill: 'none', stroke, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...extra });

  // ── defs: soft shading, the argyle knit, eye clips ─────────────────────────
  const defs = s('defs', {}, [
    s('radialGradient', { id: id('skin'), cx: 0.42, cy: 0.36, r: 0.75 }, [
      stop(0, '#fde5d0'),
      stop(0.62, '#f6cfae'),
      stop(1, '#e9b38e'),
    ]),
    s('linearGradient', { id: id('hair'), x1: 0, y1: 0, x2: 0, y2: 1 }, [stop(0, '#7d5038'), stop(1, '#553423')]),
    s('radialGradient', { id: id('lens'), cx: 0.34, cy: 0.3, r: 0.9 }, [
      stop(0, '#ffffff', 0.3),
      stop(1, '#bcd4f0', 0.16),
    ]),
    s('linearGradient', { id: id('shirt'), x1: 0, y1: 0, x2: 0, y2: 1 }, [stop(0, '#ffffff'), stop(1, '#dfe6f1')]),
    s('linearGradient', { id: id('vestShade'), x1: 0, y1: 0, x2: 1, y2: 0 }, [
      stop(0, '#ffffff', 0.14),
      stop(0.5, '#ffffff', 0),
      stop(1, '#000000', 0.2),
    ]),
    s('linearGradient', { id: id('cover'), x1: 0, y1: 0, x2: 0, y2: 1 }, [stop(0, '#a3434f'), stop(1, '#772e3a')]),
    s('linearGradient', { id: id('pageL'), x1: 0, y1: 0, x2: 1, y2: 0 }, [stop(0, '#fffdf7'), stop(1, '#ebdfc9')]),
    s('linearGradient', { id: id('pageR'), x1: 1, y1: 0, x2: 0, y2: 0 }, [stop(0, '#fffdf7'), stop(1, '#ebdfc9')]),
    // The turning page is darker at the spine so the flip reads even at 120 px.
    s('linearGradient', { id: id('pageFlip'), x1: 0, y1: 0, x2: 1, y2: 0 }, [stop(0, '#e6d8bb'), stop(0.55, '#f8f0de'), stop(1, '#fffaf0')]),
    // One tile = one colored diamond; the gaps between tiles form the second
    // diamond color, and the tile diagonals are the classic overcheck lines.
    s(
      'pattern',
      { id: id('argyle'), patternUnits: 'userSpaceOnUse', width: 14, height: 18, patternTransform: 'translate(53 100)' },
      [
        s('rect', { width: 14, height: 18, fill: '#34547e' }),
        s('path', { d: 'M7 0 L14 9 L7 18 L0 9 Z', fill: '#4a6f9f' }),
        line('M0 0 L14 18 M14 0 L0 18', '#f0c75e', 0.6, { 'stroke-dasharray': '1.5 1.3', opacity: 0.85 }),
      ],
    ),
    s('clipPath', { id: id('eyeL') }, [s('ellipse', { cx: 46, cy: 61, rx: 6.8, ry: 7.3 })]),
    s('clipPath', { id: id('eyeR') }, [s('ellipse', { cx: 74, cy: 61, rx: 6.8, ry: 7.3 })]),
  ]);

  // ── body: shoes, shirt, argyle vest, pocket protector, bow tie, arms, book ─
  const pageLines = (side: 'L' | 'R', count: number, lastShort: boolean): SVGPathElement[] => {
    const out: SVGPathElement[] = [];
    for (let k = 0; k < count; k++) {
      const d = 2.4 + 2.8 * k;
      const short = lastShort && k === count - 1;
      const path =
        side === 'L'
          ? `M40 ${r1(120.9 + d)} Q${short ? 45.5 : 48.8} ${r1(116.9 + d)} ${short ? 51.5 : 57.6} ${r1(120.3 + d)}`
          : `M62.4 ${r1(120.3 + d)} Q${short ? 67.5 : 71.2} ${r1(116.9 + d)} ${short ? 73.5 : 80} ${r1(120.9 + d)}`;
      out.push(line(path, C.pageLine, 0.75, { opacity: 0.9 }));
    }
    return out;
  };
  const RIGHT_PAGE = 'M60 119.8 Q71.2 116 82.4 120.6 L82.4 137.4 Q71.2 133.2 60 137.2 Z';

  const book = s('g', { class: `${B}-book` }, [
    inked('M35.5 121.5 Q47.5 116.2 60 120.2 Q72.5 116.2 84.5 121.5 L84.5 139.6 Q72.5 134.6 60 138.6 Q47.5 134.6 35.5 139.6 Z', url('cover'), 1.5),
    s('path', { d: 'M59.2 137.6 L59.2 142.6 L60.4 141.4 L61.6 142.6 L61.6 137.6 Z', fill: C.ribbon }),
    line('M37 138.4 Q48.6 134.3 60 138.1 Q71.4 134.3 83 138.4', '#d8ccb6', 0.8),
    s('path', { d: 'M37.6 120.6 Q48.8 116 60 119.8 L60 137.2 Q48.8 133.2 37.6 137.4 Z', fill: url('pageL'), stroke: C.pageEdge, 'stroke-width': 0.8, 'stroke-linejoin': 'round' }),
    s('path', { d: RIGHT_PAGE, fill: url('pageR'), stroke: C.pageEdge, 'stroke-width': 0.8, 'stroke-linejoin': 'round' }),
    ...pageLines('L', 5, true),
    ...pageLines('R', 5, false),
    line('M60 119.8 L60 137.2', C.spine, 0.9),
    // The page that flips on every page turn (hidden until animated).
    s('g', { class: `${B}-flip` }, [
      s('path', { d: RIGHT_PAGE, fill: url('pageFlip'), stroke: C.spine, 'stroke-width': 0.9, 'stroke-linejoin': 'round' }),
      ...pageLines('R', 3, false),
      s('path', { class: `${B}-flip-shade`, d: RIGHT_PAGE, fill: '#cdbd9f' }),
    ]),
  ]);

  const arm = (d: string) => [line(d, C.ink, 10), line(d, C.shirt, 7.2)];
  const hand = (cx: number, thumbX: number, thumbAngle: number) => [
    s('circle', { cx, cy: 133.8, r: 4.3, fill: url('skin'), stroke: C.ink, 'stroke-width': 1.4 }),
    s('ellipse', {
      cx: thumbX,
      cy: 130.6,
      rx: 1.9,
      ry: 2.8,
      fill: url('skin'),
      stroke: C.ink,
      'stroke-width': 1.1,
      transform: `rotate(${thumbAngle} ${thumbX} 130.6)`,
    }),
  ];

  const body = s('g', { class: `${B}-body` }, [
    s('ellipse', { cx: 47, cy: 146.2, rx: 9, ry: 2.9, fill: C.shoe, stroke: C.ink, 'stroke-width': 1.2 }),
    s('ellipse', { cx: 73, cy: 146.2, rx: 9, ry: 2.9, fill: C.shoe, stroke: C.ink, 'stroke-width': 1.2 }),
    s('rect', { x: 53, y: 80, width: 14, height: 19, rx: 6, fill: C.skinShade, stroke: C.ink, 'stroke-width': 1.4 }),
    inked('M27 140 C27 112 39 97.5 60 96.5 C81 97.5 93 112 93 140 C93 145.5 86 147.5 60 147.5 C34 147.5 27 145.5 27 140 Z', url('shirt'), 1.8),
    s('circle', { cx: 60, cy: 110.5, r: 0.9, fill: '#c9d2e0' }),
    inked(VEST, url('argyle'), 1.6),
    s('path', { d: VEST, fill: url('vestShade') }),
    line('M50.5 100.5 L60 117 L69.5 100.5', C.vestTrim, 2.4),
    // Pocket protector with two pens and a pencil.
    s('rect', { x: 71.2, y: 99.6, width: 2.3, height: 9, rx: 1.1, fill: C.penBlue, stroke: C.ink, 'stroke-width': 0.9 }),
    s('rect', { x: 74.4, y: 100.6, width: 2.3, height: 8, rx: 1.1, fill: C.penRed, stroke: C.ink, 'stroke-width': 0.9 }),
    s('rect', { x: 77.5, y: 98.6, width: 2.1, height: 9.5, fill: C.pencil, stroke: C.ink, 'stroke-width': 0.9 }),
    s('rect', { x: 77.5, y: 98.2, width: 2.1, height: 1.8, rx: 0.6, fill: C.eraser, stroke: C.ink, 'stroke-width': 0.7 }),
    line('M72.35 100.9 V104.4 M75.55 101.9 V104.6', '#d7dde6', 0.8),
    s('path', { d: 'M69.6 104.5 H80.9 V113 Q80.9 114.4 79.5 114.4 H71 Q69.6 114.4 69.6 113 Z', fill: C.protector, stroke: C.protectorEdge, 'stroke-width': 0.9 }),
    s('rect', { x: 69.2, y: 103.6, width: 12.1, height: 2.6, rx: 1, fill: '#dfe7f1', stroke: C.protectorEdge, 'stroke-width': 0.8 }),
    // Collar and bow tie.
    inked('M60 98.5 L50.2 95.2 L52.6 104.2 Z', C.collar, 1.3),
    inked('M60 98.5 L69.8 95.2 L67.4 104.2 Z', C.collar, 1.3),
    inked('M59 99.5 L51 95.6 Q49.2 99.5 51 103.4 Z', C.bow, 1.3),
    inked('M61 99.5 L69 95.6 Q70.8 99.5 69 103.4 Z', C.bow, 1.3),
    ...[
      [53.4, 98.2],
      [54.6, 101.4],
      [66.6, 98.2],
      [65.4, 101.4],
    ].map(([cx, cy]) => s('circle', { cx: cx ?? 0, cy: cy ?? 0, r: 0.75, fill: C.bowDot })),
    s('rect', { x: 57.4, y: 97.3, width: 5.2, height: 4.4, rx: 1.5, fill: C.bowKnot, stroke: C.ink, 'stroke-width': 1.2 }),
    ...arm('M35.5 106 C30 115 29.5 126 37 133.5'),
    ...arm('M84.5 106 C90 115 90.5 126 83 133.5'),
    book,
    ...hand(37.6, 40.4, -25),
    ...hand(82.4, 79.6, 25),
  ]);

  // ── head ───────────────────────────────────────────────────────────────────
  const eye = (cx: number, clip: string) => {
    const cy = 61;
    const sclera = s('ellipse', { class: `${B}-sclera`, cx, cy, rx: 6.8, ry: 7.3, fill: '#ffffff', stroke: C.ink, 'stroke-width': 1.2 });
    const pupil = s('g', { class: `${B}-pupil`, transform: `translate(${cx} ${cy})` }, [
      s('circle', { r: 3.6, fill: C.iris }),
      s('circle', { r: 2, fill: C.pupil }),
      s('circle', { cx: -1.3, cy: -1.5, r: 1.15, fill: '#ffffff' }),
      s('circle', { cx: 1.2, cy: 1.3, r: 0.5, fill: '#ffffff', opacity: 0.8 }),
    ]);
    const group = s('g', { class: `${B}-eye`, 'clip-path': url(clip) }, [
      sclera,
      pupil,
      s('g', { class: `${B}-lid-low` }, [
        s('path', { d: `M${cx - 8} ${cy + 8} H${cx + 8} V${cy + 3} Q${cx} ${cy - 1} ${cx - 8} ${cy + 3} Z`, fill: C.lid }),
        line(`M${cx - 7.6} ${cy + 3} Q${cx} ${cy - 1} ${cx + 7.6} ${cy + 3}`, C.ink, 1, { opacity: 0.55 }),
      ]),
      s('g', { class: `${B}-lid-up` }, [
        s('path', { d: `M${cx - 8} ${cy - 8} H${cx + 8} V${cy + 5} Q${cx} ${cy + 10} ${cx - 8} ${cy + 5} Z`, fill: C.lid }),
        line(`M${cx - 7.6} ${cy + 5.2} Q${cx} ${cy + 10} ${cx + 7.6} ${cy + 5.2}`, C.ink, 1.3),
      ]),
    ]);
    const parts: EyeParts = { sclera, pupil, center: { x: cx, y: cy } };
    return { group, parts };
  };
  const eyeL = eye(46, 'eyeL');
  const eyeR = eye(74, 'eyeR');

  const mouth = (name: string, children: SVGElement[]) =>
    s('g', { class: `${B}-mouth ${B}-mouth--${name}` }, children);
  const mouths = s('g', { class: `${B}-mouths` }, [
    mouth('smile', [line('M54 76.8 Q60 81.6 66 76.8', C.ink, 1.8)]),
    mouth('soft', [line('M56.5 77.8 Q60 79.6 63.5 77.8', C.ink, 1.6)]),
    mouth('grin', [
      inked('M53.2 76 Q60 77.8 66.8 76 Q65.8 83 60 83 Q54.2 83 53.2 76 Z', C.mouth, 1.5),
      s('ellipse', { cx: 60, cy: 81.4, rx: 3.3, ry: 1.6, fill: C.tongue }),
      s('path', { d: 'M54.4 76.5 Q60 78.1 65.6 76.5 L65.3 77.9 Q60 79.3 54.7 77.9 Z', fill: '#ffffff' }),
    ]),
    mouth('big', [
      inked('M51.8 75.4 Q60 77.6 68.2 75.4 Q67 84.2 60 84.2 Q53 84.2 51.8 75.4 Z', C.mouth, 1.5),
      s('ellipse', { cx: 60, cy: 82.3, rx: 4, ry: 1.8, fill: C.tongue }),
      s('path', { d: 'M53.2 75.9 Q60 77.9 66.8 75.9 L66.4 77.5 Q60 79.1 53.6 77.5 Z', fill: '#ffffff' }),
    ]),
    mouth('hmm', [line('M56 78.4 Q60.5 76.6 65 77.6', C.ink, 1.7)]),
    mouth('wavy', [line('M54.5 78.6 Q57.2 76.4 60 78 Q62.8 79.6 65.5 77.4', C.ink, 1.7)]),
    mouth('o', [s('ellipse', { cx: 60, cy: 78.4, rx: 2.1, ry: 2.5, fill: C.mouth, stroke: C.ink, 'stroke-width': 1.3 })]),
    mouth('talk', [
      s('ellipse', { cx: 60, cy: 77.8, rx: 3.6, ry: 2.9, fill: C.mouth, stroke: C.ink, 'stroke-width': 1.4 }),
      s('ellipse', { cx: 60, cy: 79.5, rx: 2, ry: 1, fill: C.tongue }),
    ]),
  ]);

  const glint = (dx: number) => [
    line(`M${37.8 + dx} 58.8 A8.5 8.5 0 0 1 ${41.75 + dx} 53.6`, '#ffffff', 1.9, { opacity: 0.9 }),
    s('circle', { cx: 52.5 + dx, cy: 66.5, r: 0.9, fill: '#ffffff', opacity: 0.7 }),
  ];
  const glasses = s('g', { class: `${B}-glasses` }, [
    line('M34.5 59 L29 57.5 M85.5 59 L91 57.5', C.frame, 2.2),
    s('circle', { cx: 46, cy: 61, r: 11.5, fill: url('lens'), stroke: C.frame, 'stroke-width': 2.6 }),
    s('circle', { cx: 74, cy: 61, r: 11.5, fill: url('lens'), stroke: C.frame, 'stroke-width': 2.6 }),
    line('M57.5 59.5 Q60 56.8 62.5 59.5', C.frame, 2.4),
    s('g', { class: `${B}-glint` }, [...glint(0), ...glint(28)]),
  ]);

  const head = s('g', { class: `${B}-head` }, [
    // Hair volume behind the head, with side tufts.
    s('ellipse', { cx: 60, cy: 38, rx: 31, ry: 22, fill: url('hair') }),
    // Messy flicks over the ears (one extra on the right: nobody's hair is symmetric).
    inked('M31.5 41.5 C27.5 42 24.8 44.5 23.6 48.6 C26.6 47.4 29.6 47.9 32.6 50.6 Z', url('hair'), 1.4),
    inked('M88.5 41.5 C92.5 42 95.2 44.5 96.4 48.6 C93.4 47.4 90.4 47.9 87.4 50.6 Z', url('hair'), 1.4),
    inked('M88 31.5 C92 29.6 95.2 30.4 97.2 33 C94.2 33.1 91.6 34.2 89.6 36.4 Z', url('hair'), 1.3),
    // Ears.
    s('ellipse', { cx: 29.5, cy: 61, rx: 5, ry: 7, fill: url('skin'), stroke: C.ink, 'stroke-width': 1.5 }),
    s('ellipse', { cx: 90.5, cy: 61, rx: 5, ry: 7, fill: url('skin'), stroke: C.ink, 'stroke-width': 1.5 }),
    line('M30.5 57.5 Q27.5 61 30.5 64.5', C.earInner, 1.2),
    line('M89.5 57.5 Q92.5 61 89.5 64.5', C.earInner, 1.2),
    // Face.
    s('ellipse', { cx: 60, cy: 57, rx: 31, ry: 28.5, fill: url('skin'), stroke: C.ink, 'stroke-width': 1.8 }),
    s('ellipse', { class: `${B}-blush`, cx: 42, cy: 75.5, rx: 4.6, ry: 2.8, fill: C.blush }),
    s('ellipse', { class: `${B}-blush`, cx: 78, cy: 75.5, rx: 4.6, ry: 2.8, fill: C.blush }),
    s(
      'g',
      { fill: C.freckle, opacity: 0.75 },
      [
        [40.6, 74.6, 0.7],
        [43.6, 75.6, 0.65],
        [41.8, 77.2, 0.6],
        [79.4, 74.6, 0.7],
        [76.4, 75.6, 0.65],
        [78.2, 77.2, 0.6],
      ].map(([cx, cy, r]) => s('circle', { cx: cx ?? 0, cy: cy ?? 0, r: r ?? 0.6 })),
    ),
    line('M58.6 68.2 Q60.8 71.6 62.4 69.2', C.nose, 1.5),
    mouths,
    eyeL.group,
    eyeR.group,
    s('g', { class: `${B}-eye-happy` }, [
      line('M41 62.5 Q46 56 51 62.5', C.ink, 2.1),
      line('M69 62.5 Q74 56 79 62.5', C.ink, 2.1),
    ]),
    glasses,
    // Messy mop; the fringe stays above the brows so they can do their job.
    inked(
      'M29.5 50 C27 37 33 25.5 44 20 C51 16.5 57 16 62 16 C75 16.5 86 22.5 90 33.5 C92 39.5 91.5 45 90.5 50 ' +
        'C89 45 87 41.5 84.5 39.5 L83 41.5 C80.5 38 76.5 36 72 35.5 L70 38.5 C66.5 35 61 34 56 35 ' +
        'L53 38.5 C50 36 45 35.5 41 37 L37.5 42 C33.5 44 31 46.5 29.5 50 Z',
      url('hair'),
      1.7,
    ),
    line('M42 25 Q52 19 64 19.5', C.hairLight, 2, { opacity: 0.55 }),
    line('M55.5 22.5 Q59.5 28 57.8 33.5 M72 24.5 Q76 29.5 75 34.5', C.hairDark, 1.1, { opacity: 0.5 }),
    s('g', { class: `${B}-cowlick` }, [
      inked('M57 18 C55 11 58.5 5.5 65.5 4.5 C62.5 7.5 61.5 11 63 17 Z', url('hair'), 1.5),
      inked('M63 17.5 C64 12.5 67.5 10 71 10.5 C68.5 12.5 67 15 67 18 Z', url('hair'), 1.3),
    ]),
    line('M38.5 46.5 Q45 43.2 52.5 45.5', C.hairDark, 2.5, { class: `${B}-brow ${B}-brow--l` }),
    line('M67.5 45.5 Q75 43.2 81.5 46.5', C.hairDark, 2.5, { class: `${B}-brow ${B}-brow--r` }),
  ]);

  // ── effects living inside the SVG ─────────────────────────────────────────
  const z = (x: number, y: number, size: number) =>
    s('g', { transform: `translate(${x} ${y})` }, [
      line(`M0 0 H${size} L0 ${r1(size * 1.15)} H${size}`, C.zzz, 1.5, { class: `${B}-z` }),
    ]);
  const zzz = s('g', { class: `${B}-zzz` }, [z(93, 30, 4), z(99.5, 19, 5.2), z(107, 7, 6.5)]);

  const STAR = 'M0 -5 C.6 -1.2 1.2 -.6 5 0 C1.2 .6 .6 1.2 0 5 C-.6 1.2 -1.2 .6 -5 0 C-1.2 -.6 -.6 -1.2 0 -5 Z';
  const star = (x: number, y: number, scale: number) =>
    s('g', { transform: `translate(${x} ${y}) scale(${scale})` }, [
      s('path', { class: `${B}-star`, d: STAR, fill: C.star, stroke: C.starEdge, 'stroke-width': 0.5 }),
    ]);
  const sparkles = s('g', { class: `${B}-sparkles` }, [
    star(16, 30, 0.9),
    star(104, 40, 1.1),
    star(12, 76, 0.7),
    star(109, 84, 0.8),
    star(26, 10, 0.6),
    star(96, 8, 0.65),
  ]);

  const svg = s(
    'svg',
    {
      class: `${B}-svg`,
      viewBox: `0 0 ${AVATAR_WIDTH} ${AVATAR_HEIGHT}`,
      width: AVATAR_WIDTH,
      height: AVATAR_HEIGHT,
      'aria-hidden': 'true',
      focusable: 'false',
    },
    [defs, s('g', { class: `${B}-char` }, [body, head]), zzz, sparkles],
  );

  return { svg, eyes: [eyeL.parts, eyeR.parts] };
}

function r1(v: number): number {
  return Math.round(v * 10) / 10;
}

/** Positions a pupil at `offset` (SVG units) from its eye center. */
export function setPupil(eye: EyeParts, offset: Point): void {
  eye.pupil.setAttribute('transform', `translate(${r2(eye.center.x + offset.x)} ${r2(eye.center.y + offset.y)})`);
}

function r2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * Pupil offset (SVG units) for an eye centered at `eye` looking at `target`
 * (both viewport px). The magnitude saturates smoothly — `max · d / (d + soft)` —
 * so far-away targets sit near the rim while a target on Dewey's own face
 * gives eye contact instead of a jittery cross-eyed stare.
 */
export function pupilOffset(eye: Point, target: Point, max = PUPIL_MAX_TRAVEL, softRadiusPx = 90): Point {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !(max > 0)) return { x: 0, y: 0 };
  const d = Math.hypot(dx, dy);
  if (d < 1e-6) return { x: 0, y: 0 };
  const soft = Number.isFinite(softRadiusPx) && softRadiusPx > 0 ? softRadiusPx : 0;
  const m = soft > 0 ? (max * d) / (d + soft) : max;
  return { x: (dx / d) * m, y: (dy / d) * m };
}

/** Clamps an offset to a disc of radius `max` (guards NaN too). */
export function clampOffset(p: Point, max = PUPIL_MAX_TRAVEL): Point {
  if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return { x: 0, y: 0 };
  const d = Math.hypot(p.x, p.y);
  if (d <= max || d === 0) return { x: p.x, y: p.y };
  return { x: (p.x / d) * max, y: (p.y / d) * max };
}
