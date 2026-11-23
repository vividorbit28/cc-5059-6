export type Mode = 'major' | 'minor';

export interface Key {
  tonicPc: number;
  mode: Mode;
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];

export function midiToName(midi: number): string {
  const names = midi < 0 ? FLAT_NAMES : SHARP_NAMES;
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function midiToNameLatin(midi: number): string {
  return midiToName(midi).replace('#', '♯').replace('b', '♭');
}

export function parsePitch(text: string): number | null {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(text.trim());
  if (!m) return null;
  const base: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  let pc = base[m[1].toUpperCase()];
  if (m[2] === '#') pc += 1;
  if (m[2] === 'b') pc -= 1;
  return (parseInt(m[3], 10) + 1) * 12 + pc;
}

export function keyName(key: Key): string {
  const names = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  return `${names[((key.tonicPc % 12) + 12) % 12]} ${key.mode === 'major' ? '大调' : '小调'}`;
}

const MAJOR_STEPS = [0, 2, 4, 5, 7, 9, 11];
// 和声小调：升七级，便于导音与终止式；文档中明确说明这是本工具的规则选择。
const MINOR_STEPS = [0, 2, 3, 5, 7, 8, 11];

export function scalePitchClasses(key: Key): number[] {
  const steps = key.mode === 'major' ? MAJOR_STEPS : MINOR_STEPS;
  return steps.map((s) => (s + key.tonicPc) % 12);
}

export function isInScale(midi: number, key: Key): boolean {
  return scalePitchClasses(key).includes(((midi % 12) + 12) % 12);
}

export function scalePitchesInRange(low: number, high: number, key: Key): number[] {
  const out: number[] = [];
  for (let p = low; p <= high; p++) if (isInScale(p, key)) out.push(p);
  return out;
}

/** 音阶级数（0-6），用于比较上行/下行与计算级进。 */
export function scaleDegree(midi: number, key: Key): number | null {
  const pcs = scalePitchClasses(key);
  const pc = ((midi % 12) + 12) % 12;
  const idx = pcs.indexOf(pc);
  if (idx < 0) return null;
  return Math.floor(midi / 12) * 7 + idx;
}

export function isDiatonicStep(a: number, b: number, key: Key): boolean {
  if (!isInScale(a, key) || !isInScale(b, key)) return false;
  const da = scaleDegree(a, key);
  const db = scaleDegree(b, key);
  if (da === null || db === null) return false;
  return Math.abs(da - db) === 1;
}

export function diatonicDirection(a: number, b: number): -1 | 0 | 1 {
  return b > a ? 1 : b < a ? -1 : 0;
}

/** 从 from 向 direction 方向取下一个音阶音；direction 也允许 0。 */
export function nextScalePitch(from: number, direction: -1 | 1, key: Key): number {
  let p = from + direction;
  while (p > 0 && p < 127 && !isInScale(p, key)) p += direction;
  return p;
}

export function scaleStepFrom(from: number, steps: number, key: Key): number {
  let p = from;
  const dir = steps >= 0 ? 1 : -1;
  for (let i = 0; i < Math.abs(steps); i++) {
    p = nextScalePitch(p, dir, key);
  }
  return p;
}

export type IntervalQuality = 'perfect' | 'imperfect' | 'dissonant';

export interface IntervalInfo {
  semitones: number;
  simple: number;
  quality: IntervalQuality;
  label: string;
}

const INTERVAL_LABELS: Record<number, string> = {
  0: '纯一度',
  1: '小二度',
  2: '大二度',
  3: '小三度',
  4: '大三度',
  5: '纯四度',
  6: '三全音',
  7: '纯五度',
  8: '小六度',
  9: '大六度',
  10: '小七度',
  11: '大七度',
};

/** 默认纯四度按不协和处理（作为低音上方的四度）；规则可覆写。 */
export function intervalInfo(a: number, b: number, fourthConsonant = false): IntervalInfo {
  const semitones = Math.abs(b - a);
  const simple = semitones % 12;
  let quality: IntervalQuality;
  if (simple === 0 || simple === 7) quality = 'perfect';
  else if (simple === 5) quality = fourthConsonant ? 'imperfect' : 'dissonant';
  else if (simple === 3 || simple === 4 || simple === 8 || simple === 9) quality = 'imperfect';
  else quality = 'dissonant';
  return {
    semitones,
    simple,
    quality,
    label: INTERVAL_LABELS[simple] + (semitones >= 12 ? `（复音程 ${semitones} 半音）` : ''),
  };
}

export function isPerfectInterval(a: number, b: number, fourthConsonant = false): boolean {
  const simple = Math.abs(b - a) % 12;
  if (simple === 0 || simple === 7) return true;
  return fourthConsonant && simple === 5;
}

export function intervalClass(a: number, b: number): number {
  return Math.abs(b - a) % 12;
}

export function beatStrength(onset: number, beatsPerMeasure: number): 'strong' | 'medium' | 'weak' {
  const pos = ((onset % beatsPerMeasure) + beatsPerMeasure) % beatsPerMeasure;
  if (Math.abs(pos) < 1e-9) return 'strong';
  if (beatsPerMeasure >= 4 && Math.abs(pos - 2) < 1e-9) return 'medium';
  return 'weak';
}

export function beatStrengthRank(s: 'strong' | 'medium' | 'weak'): number {
  return s === 'strong' ? 2 : s === 'medium' ? 1 : 0;
}

export function measureOf(t: number, beatsPerMeasure: number): number {
  return Math.floor((t + 1e-9) / beatsPerMeasure);
}

export function inSameMeasure(a: number, b: number, beatsPerMeasure: number): boolean {
  return measureOf(a, beatsPerMeasure) === measureOf(b, beatsPerMeasure);
}

export function clampPitch(midi: number): number {
  return Math.max(0, Math.min(127, Math.round(midi)));
}
