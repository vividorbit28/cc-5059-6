import { beatStrength, isInScale, parsePitch, scalePitchesInRange, type Key } from './pitch.js';
import type { Note, VoiceId } from './score.js';
import type { RhythmSpec, VoiceRangeConfig } from './rules.js';

export const EPS = 1e-6;

export function feq(a: number, b: number, eps = EPS): boolean {
  return Math.abs(a - b) <= eps;
}

export function quant(t: number): number {
  return Math.round(t * 1e6) / 1e6;
}

export interface Slot {
  onset: number;
  duration: number;
  end: number;
}

export interface VoicePlan {
  id: VoiceId;
  name: string;
  low: number;
  high: number;
  slots: Slot[];
}

export function slotsFromNotes(notes: Note[]): Slot[] {
  return [...notes]
    .filter((n) => n.duration > EPS)
    .sort((a, b) => a.onset - b.onset)
    .map((n) => ({ onset: n.onset, duration: n.duration, end: n.onset + n.duration }));
}

export function notesDuration(notes: Note[]): number {
  let end = 0;
  for (const n of notes) end = Math.max(end, n.onset + n.duration);
  return end;
}

export function slotsFromSpec(T: number, spec: RhythmSpec, cfSlots: Slot[]): Slot[] {
  if (spec.kind === 'cf') return cfSlots.map((s) => ({ ...s }));
  const slots: Slot[] = [];
  let t = 0;
  if (spec.kind === 'fixed') {
    const d = Math.max(EPS, spec.duration);
    while (t < T - EPS) {
      const duration = Math.min(d, T - t);
      slots.push({ onset: quant(t), duration: quant(duration), end: quant(t + duration) });
      t += d;
    }
    return slots;
  }
  const values = spec.values.filter((v) => v > EPS);
  if (values.length === 0) return slots;
  let i = 0;
  while (t < T - EPS) {
    const v = values[i % values.length];
    const duration = Math.min(v, T - t);
    slots.push({ onset: quant(t), duration: quant(duration), end: quant(t + duration) });
    t += v;
    i++;
  }
  return slots;
}

export function buildSearchPlans(
  cfNotes: Note[],
  u1: VoiceRangeConfig,
  u2: VoiceRangeConfig,
  specU1: RhythmSpec,
  specU2: RhythmSpec,
): { plans: Record<'cf' | 'u1' | 'u2', VoicePlan>; T: number } {
  const cfSlots = slotsFromNotes(cfNotes);
  const T = cfSlots.reduce((m, s) => Math.max(m, s.end), 0);
  const cf: VoicePlan = { id: 'cf', name: '定旋律', low: 24, high: 84, slots: cfSlots };
  const p1: VoicePlan = {
    id: 'u1',
    name: u1.name,
    low: u1.low,
    high: u1.high,
    slots: slotsFromSpec(T, specU1, cfSlots),
  };
  const p2: VoicePlan = {
    id: 'u2',
    name: u2.name,
    low: u2.low,
    high: u2.high,
    slots: slotsFromSpec(T, specU2, cfSlots),
  };
  return { plans: { cf, u1: p1, u2: p2 }, T };
}

export function buildPlansFromVoices(
  voices: Record<VoiceId, { name: string; low: number; high: number; notes: Note[] }>,
): { plans: Record<'cf' | 'u1' | 'u2', VoicePlan>; T: number } {
  const mk = (id: VoiceId): VoicePlan => ({
    id,
    name: voices[id].name,
    low: voices[id].low,
    high: voices[id].high,
    slots: slotsFromNotes(voices[id].notes),
  });
  const plans = { cf: mk('cf'), u1: mk('u1'), u2: mk('u2') };
  const T = [plans.cf, plans.u1, plans.u2].reduce(
    (m, p) => p.slots.reduce((mm, s) => Math.max(mm, s.end), m),
    0,
  );
  return { plans, T };
}

export interface EventPoint {
  time: number;
  /** 各声部在此刻实际发声的槽位下标；声部静默则不存在。 */
  active: Partial<Record<VoiceId, number>>;
  /** 恰好在此刻开始的槽位下标。 */
  starts: Partial<Record<VoiceId, number>>;
  barStart: boolean;
  strength: 'strong' | 'medium' | 'weak';
}

export function buildPoints(
  plans: Record<'cf' | 'u1' | 'u2', VoicePlan>,
  T: number,
  beatsPerMeasure: number,
): EventPoint[] {
  const times = new Set<number>();
  for (const id of ['cf', 'u1', 'u2'] as VoiceId[]) {
    for (const s of plans[id].slots) {
      times.add(quant(s.onset));
      times.add(quant(s.end));
    }
  }
  for (let b = 0; b <= Math.ceil(T / beatsPerMeasure) * beatsPerMeasure + EPS; b += beatsPerMeasure) {
    if (b <= T + EPS) times.add(quant(b));
  }
  for (let b = 0; b <= T + EPS; b += 1) times.add(quant(b));
  times.add(quant(T));
  const sorted = [...times].filter((t) => t <= T + EPS).sort((a, b) => a - b);
  return sorted.map((t) => {
    const active: Partial<Record<VoiceId, number>> = {};
    const starts: Partial<Record<VoiceId, number>> = {};
    for (const id of ['cf', 'u1', 'u2'] as VoiceId[]) {
      const slots = plans[id].slots;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s.onset <= t + EPS && s.end > t + EPS) active[id] = i;
        if (feq(s.onset, t)) starts[id] = i;
      }
    }
    const barStart = t > EPS && feq(t % beatsPerMeasure, 0);
    return { time: t, active, starts, barStart, strength: beatStrength(t, beatsPerMeasure) };
  });
}

export function noteKey(voice: VoiceId, slotIndex: number): string {
  return `${voice}:${slotIndex}`;
}

export function pairKey(a: VoiceId, ai: number, b: VoiceId, bi: number): string {
  const first = a < b ? `${a}:${ai}` : `${b}:${bi}`;
  const second = a < b ? `${b}:${bi}` : `${a}:${ai}`;
  return `${first}|${second}`;
}

export interface ParsedMelody {
  notes: Note[];
  errors: string[];
}

/** 解析 "C3:4 D3:4" 或 "C3 D3"（默认 1 拍）。休止写作 r:2。 */
export function parseMelody(text: string): ParsedMelody {
  const errors: string[] = [];
  const notes: Note[] = [];
  const tokens = text
    .replace(/[，,;；\n]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  let onset = 0;
  for (const token of tokens) {
    const [pitchText, durText] = token.split(':');
    let duration = 1;
    if (durText !== undefined) {
      duration = Number(durText);
      if (!Number.isFinite(duration) || duration <= 0) {
        errors.push(`时值无效：${token}`);
        continue;
      }
    }
    if (/^[rR]$/.test(pitchText)) {
      onset += duration;
      continue;
    }
    const pitch = parsePitch(pitchText);
    if (pitch === null) {
      errors.push(`音高无效：${token}`);
      continue;
    }
    notes.push({ onset: quant(onset), duration: quant(duration), pitch });
    onset += duration;
  }
  return { notes, errors };
}

export function melodyText(notes: Note[], withDurations = true): string {
  return [...notes]
    .sort((a, b) => a.onset - b.onset)
    .map((n) => {
      const name = pitchName(n.pitch);
      return withDurations ? `${name}:${n.duration}` : name;
    })
    .join(' ');
}

export function pitchName(midi: number): string {
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

export function domainForPlan(plan: VoicePlan, key: Key, diatonicOnly: boolean): number[] {
  if (diatonicOnly) return scalePitchesInRange(plan.low, plan.high, key);
  const out: number[] = [];
  for (let p = plan.low; p <= plan.high; p++) out.push(p);
  return out;
}

export function inScaleSafe(pitch: number, key: Key): boolean {
  return isInScale(pitch, key);
}
