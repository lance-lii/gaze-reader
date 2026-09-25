/**
 * Everything Dewey can say, grouped by situation.
 *
 * House style: warm, nerdy, never snarky (and never about reading speed).
 * Every line fits the 90-character speech bubble once templates are filled.
 * Fun facts are deliberately conservative: well-established findings from
 * reading research (Rayner's reviews of eye movements in reading are the main
 * source for the numbers) and uncontroversial book / library history.
 *
 * Templates: `{title}` (book title, pre-shortened by the caller) and `{pages}`.
 */
const QUIP_TABLE = {
  greeting: [
    'Ooh, a new book! I’ve got my reading glasses on.',
    '“{title}”! Excellent choice. I’ll handle the page turns.',
    'Hi, I’m Dewey! Read away, I’ll turn the page when you reach the bottom.',
    'Fresh pages! Settle in, the page-turning is covered.',
    'A new book! My favorite smell, even if it’s made of pixels.',
    'Let’s read “{title}” together. I’ll follow along quietly.',
  ],
  welcomeBack: [
    'Welcome back! I kept your place.',
    'Back to “{title}”! Right where you left off.',
    'Hello again! Your bookmark is exactly where you left it.',
    'Ah, you’re back. The story waited for you.',
  ],
  pageTurn: [
    'Page turned!',
    'Onward!',
    'Flip! Next page.',
    'Another page, coming right up.',
    'Turned it for you.',
    'Next page. Nice rhythm!',
    'Whoosh, new page.',
    'Fresh page, fresh words.',
  ],
  milestone25: [
    'A quarter of the way through! Nice going.',
    '25% read! You’ve found your stride.',
    'One quarter down! Your eyes are doing great work.',
  ],
  milestone50: [
    'Halfway there! Time flies when you’re fixating.',
    '50%! Officially past the middle.',
    'Halfway! I love the middle of a good book.',
  ],
  milestone75: [
    'Three quarters done! The end is in sight.',
    '75%! Just the home stretch now.',
    'Only a quarter left. Savor it!',
  ],
  tenPages: [
    '{pages} pages turned! You’re on a roll.',
    'That’s {pages} pages. Your saccades are in top form.',
    '{pages} pages already! I’m keeping count for you.',
    '{pages} pages! I love a good reading streak.',
  ],
  trackingLost: [
    'I can’t see you… are you still there?',
    'I lost sight of your eyes. A bit more light might help!',
    'Hmm, I can’t find your face. Is the camera covered?',
    'Where’d you go? I’ll wait right here.',
  ],
  trackingBack: [
    'There you are!',
    'Found you! Back to reading.',
    'Welcome back! I’ve got you again.',
    'Phew, I can see you again.',
  ],
  wakeUp: [
    'Oh! I’m up! Totally wasn’t napping.',
    'Hm? Oh, hello! Just resting my eyes.',
    'Awake! Where were we?',
  ],
  unhide: [
    'I’m back! Happy to keep you company.',
    'Hello again! Did you miss me? I missed the books.',
  ],
  calibrationStart: [
    'Let’s calibrate! I’ll learn how your eyes look at the screen.',
    'Calibration time! Sit the way you usually read.',
  ],
  calibrationPositioning: [
    'Center your face in the oval, about an arm’s length away.',
    'Good, even light on your face helps me a lot.',
    'Keep your head still-ish. Let your eyes do the moving.',
  ],
  calibrationPoint: [
    'Follow each dot with your eyes until it shrinks away.',
    'Look right at the center of each dot. Nice and steady.',
  ],
  calibrationTraining: [
    'Crunching numbers… a little ridge regression never hurt anyone.',
    'Learning how your eyes move… one moment!',
  ],
  calibrationValidating: [
    'Quick check: look at a few more dots for me.',
    'Now let’s see how well I learned.',
  ],
  calibrationGood: [
    'Great calibration! I can follow your eyes nicely.',
    'Calibrated! I’ve got a good read on you now.',
    'That went really well. Happy reading!',
  ],
  calibrationFair: [
    'Calibration’s okay. Bigger text or more light helps me.',
    'Not bad! If pages turn at odd times, try recalibrating.',
  ],
  calibrationPoor: [
    'Tricky one. More light on your face and less glare might help.',
    'I’m struggling a bit. Want to try again with brighter light?',
    'That was rough. Try sitting a little closer and redo it?',
  ],
  calibrationCancelled: [
    'No problem. We can calibrate whenever you like.',
    'Calibration cancelled. I’ll be right here.',
  ],
  calibrationFailed: [
    'Hmm, calibration didn’t work. Let’s try again?',
    'Something went wrong there. One more try?',
  ],
  break: [
    'Eye break! Look at something about 20 feet (6 m) away for 20 seconds.',
    '20-20-20 time: gaze at something ~6 m (20 ft) away for 20 seconds.',
    'Rest your eyes: find something about 6 m (20 ft) away and watch it for 20 s.',
    'Mini break! Look ~6 m (20 ft) away for 20 seconds, and blink a few times.',
  ],
  bookFinished: [
    'You finished it! What a book. What a reader!',
    'The end! Time to find the next one?',
    'Finished! That deserves a little celebration.',
    'Done! Another book for your mental library.',
  ],
  poke: [
    'Hi! Need something?',
    'Hello! What can I do for you?',
    'Oh! Hi there.',
    'At your service!',
    'You rang?',
    'Reading buddy, reporting for duty!',
  ],
  funFacts: [
    // Eye movements
    'Your eyes don’t glide along a line. They hop in quick jumps called saccades.',
    'Fixations in reading average about 200–250 milliseconds each.',
    'A typical reading saccade jumps about 7–9 letters.',
    'A reading saccade is quick: it takes only about 20–40 milliseconds.',
    'Roughly 90% of reading time is spent fixating. Saccades fill the rest.',
    'You see very little during a saccade. It’s called saccadic suppression.',
    'In a big saccade, your eyes can rotate several hundred degrees per second.',
    'Even during a “still” fixation, your eyes make tiny movements called microsaccades.',
    'Your sharpest vision spans only about 2°, roughly a thumb’s width at arm’s length.',
    // Perceptual span & word processing
    'English readers take in about 3–4 letters left of where they look, 14–15 to the right.',
    'Readers of Hebrew, written right to left, have a perceptual span skewed to the left.',
    'You start processing the next word before you look at it: parafoveal preview.',
    'Your eyes tend to land just left of a word’s middle: the preferred viewing location.',
    'Short, common words like “the” are often skipped. Your brain previews them.',
    'Predictable words get skipped more often. Your brain quietly guesses ahead.',
    'Rare words earn longer fixations than common ones: the word-frequency effect.',
    'Long words often get two fixations. Short ones sometimes get none!',
    'About 10–15% of saccades in reading go backward. They’re called regressions.',
    'Regressions help: when researchers blocked re-reading, comprehension dropped.',
    'At a line’s end, your eyes make a return sweep: one long jump to the next line.',
    'Return sweeps often land a little short, then a small saccade corrects them.',
    'Take the spaces out of a text and people read it noticeably slower.',
    'Silent reading is usually faster than reading aloud. Your voice is the bottleneck.',
    'Your pupils widen slightly when you think hard. Psychologists use that to gauge effort.',
    'People tend to blink less while reading screens. Remember to blink!',
    // History of reading science
    'In the 1870s, Louis Émile Javal’s lab noticed that reading eyes jump, not glide.',
    'Edmund Huey’s classic “The Psychology and Pedagogy of Reading” came out in 1908.',
    'Early eye trackers, around 1900, attached a tiny cup to the eye. Webcams are kinder!',
    // Books, printing & writing
    'Around 1450, Johannes Gutenberg was printing with movable metal type in Mainz.',
    'Fewer than 50 copies of the Gutenberg Bible survive, and some are incomplete.',
    'Bi Sheng made movable type from baked clay in China in the 1040s.',
    'The Diamond Sutra, from 868 CE, is the oldest known dated printed book.',
    'Aldus Manutius’s press printed the first book set entirely in italic type, in 1501.',
    'Ancient Latin was often written with no spaces between words: scriptio continua.',
    'Irish scribes helped spread spaces between words in the early Middle Ages.',
    'In late antiquity the codex, pages bound at one edge, won out over the scroll.',
    'Louis Braille published his raised-dot system in 1829. Each cell has six dots.',
    'Penguin’s first paperbacks, in 1935, cost just sixpence each.',
    'ISBNs date from 1970. Since 2007 they have 13 digits.',
    // Libraries & the Dewey Decimal system
    'Melvil Dewey first published his Decimal Classification in 1876.',
    'In the Dewey Decimal system, the 500s are science and math. My favorite shelf!',
    'Hungry? Cookbooks live around 641.5 in the Dewey Decimal system.',
    'Dewey narrows by digit: 500 is science, 590 is animals, 595 is arthropods.',
    'Dewey files American poetry at 811 and English poetry at 821.',
    '“Library” comes from Latin liber: the inner bark of a tree, and later “book.”',
    'Andrew Carnegie funded over 2,500 public libraries between 1883 and 1929.',
  ],
} as const satisfies Record<string, readonly string[]>;

export type QuipKey = keyof typeof QUIP_TABLE;

/** Public, loosely typed view of the table (the contract in docs/ARCHITECTURE.md). */
export const QUIPS: Readonly<Record<string, readonly string[]>> = QUIP_TABLE;

export const QUIP_KEYS = Object.keys(QUIP_TABLE) as QuipKey[];

export interface QuipVars {
  title?: string;
  pages?: number;
}

const TEMPLATE_RE = /\{(title|pages)\}/g;

/** True when the line needs variables to make sense. */
export function hasTemplate(line: string): boolean {
  return line.includes('{title}') || line.includes('{pages}');
}

/**
 * Fills `{title}` / `{pages}`. Returns null when a needed variable is missing,
 * so the caller can fall back to a line that doesn't need it.
 */
export function fillTemplate(line: string, vars: QuipVars): string | null {
  let missing = false;
  const out = line.replace(TEMPLATE_RE, (_m, name: string) => {
    const v = name === 'title' ? vars.title : vars.pages;
    if (v === undefined || v === null || (typeof v === 'number' && !Number.isFinite(v)) || String(v).trim() === '') {
      missing = true;
      return '';
    }
    return String(v);
  });
  return missing ? null : out;
}

/** Shortens a book title so templated lines still fit the bubble. */
export function shortTitle(title: string, max = 28): string {
  const t = title.replace(/\s+/g, ' ').trim();
  const chars = Array.from(t);
  if (chars.length <= max) return t;
  const cut = chars.slice(0, max - 1).join('');
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.5 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/u, '')}…`;
}

/**
 * Picks lines like a shuffled deck per situation, so Dewey cycles through his
 * repertoire instead of repeating himself; `avoid` lets the speech system veto
 * lines it said recently.
 */
export class QuipPicker {
  private readonly decks = new Map<QuipKey, number[]>();
  private readonly lastPicked = new Map<QuipKey, number>();

  constructor(private readonly random: () => number = Math.random) {}

  pick(key: QuipKey, vars: QuipVars = {}, avoid: (line: string) => boolean = () => false): string | null {
    const lines: readonly string[] = QUIP_TABLE[key];
    const n = lines.length;
    if (n === 0) return null;
    // A partly dealt deck can run out mid-search and be reshuffled, so count
    // distinct lines tried, not draws: the rest of this deck plus one fresh
    // deck (≤ 2n draws) is guaranteed to show every line at least once.
    const tried = new Set<number>();
    for (let draws = 0; tried.size < n && draws < 2 * n; draws++) {
      const idx = this.draw(key, n);
      if (tried.has(idx)) continue;
      tried.add(idx);
      const filled = fillTemplate(lines[idx] ?? '', vars);
      if (filled !== null && !avoid(filled)) {
        this.lastPicked.set(key, idx);
        return filled;
      }
    }
    return null;
  }

  private draw(key: QuipKey, n: number): number {
    let deck = this.decks.get(key);
    if (!deck || deck.length === 0) {
      deck = shuffled(n, this.random);
      // Never start a fresh deck with the line we just said.
      const last = this.lastPicked.get(key);
      if (n > 1 && deck[deck.length - 1] === last) {
        const swap = Math.floor(this.random() * (n - 1));
        [deck[deck.length - 1], deck[swap]] = [deck[swap] as number, deck[deck.length - 1] as number];
      }
      this.decks.set(key, deck);
    }
    return deck.pop() ?? 0;
  }
}

function shuffled(n: number, random: () => number): number[] {
  const a = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    const r = random();
    const j = Math.min(i, Math.floor((Number.isFinite(r) ? Math.abs(r) % 1 : 0) * (i + 1)));
    [a[i], a[j]] = [a[j] as number, a[i] as number];
  }
  return a;
}
