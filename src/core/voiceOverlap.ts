import { intervalInfo, isPerfectInterval } from './pitch.js';
import type { VoiceId } from './score.js';
import { EPS, noteKey, quant, type VoicePlan } from './plan.js';

/**
 * 声部时间重叠：把时间轴按“任一声部开始/结束发声”的边界切成若干区间，
 * 每个区间内取各声部实际在响的音，再两两计算音程。
 *
 * 这是纵向判定的唯一时间基准：它不假设各声部音符数组长度或下标一致，
 * 因此错位时值、切分与跨小节持续音都能被正确配对。
 */
export interface PairSnapshot {
  lower: VoiceId;
  upper: VoiceId;
  lowerSlot: number;
  upperSlot: number;
  lowerPitch: number;
  upperPitch: number;
  simple: number;
  perfect: boolean;
  quality: 'perfect' | 'imperfect' | 'dissonant';
  intervalLabel: string;
  /** 该纵向关系的实际重叠区间。 */
  from: number;
  to: number;
}

export interface Slice {
  from: number;
  to: number;
  active: Partial<Record<VoiceId, { slot: number; pitch: number }>>;
  pairs: PairSnapshot[];
}

/** 只依赖“声部计划 + 已有音高”的最小输入，避免与 analyze 形成循环依赖。 */
export interface OverlapContext {
  plans: Record<'cf' | 'u1' | 'u2', VoicePlan>;
  rules: { fourthConsonant: boolean };
}

export interface OverlapAssignment {
  pitch: Map<string, number>;
}

export const VOICE_IDS: VoiceId[] = ['cf', 'u1', 'u2'];

/** 返回 [t, next) 内的全部实际发声与两两音程。 */
export function slicesBetween(
  ctx: OverlapContext,
  a: OverlapAssignment,
  from: number,
  to: number,
): Slice[] {
  const breaks = new Set<number>([from, to]);
  for (const id of VOICE_IDS) {
    for (const s of ctx.plans[id].slots) {
      if (s.end <= from + EPS || s.onset >= to - EPS) continue;
      breaks.add(quant(Math.max(s.onset, from)));
      breaks.add(quant(Math.min(s.end, to)));
    }
  }
  const sorted = [...breaks].sort((x, y) => x - y);
  const out: Slice[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const segFrom = sorted[i];
    const segTo = sorted[i + 1];
    if (segTo - segFrom <= EPS) continue;
    const mid = (segFrom + segTo) / 2;
    const active: Partial<Record<VoiceId, { slot: number; pitch: number }>> = {};
    for (const id of VOICE_IDS) {
      const slots = ctx.plans[id].slots;
      for (let k = 0; k < slots.length; k++) {
        const sl = slots[k];
        if (sl.onset > mid + EPS || sl.end <= mid + EPS) continue;
        const p = a.pitch.get(noteKey(id, k));
        if (p === undefined) continue;
        active[id] = { slot: k, pitch: p };
        break;
      }
    }
    if (Object.keys(active).length < 2) {
      out.push({ from: segFrom, to: segTo, active, pairs: [] });
      continue;
    }
    const ids = (Object.keys(active) as VoiceId[]).sort(
      (x, y) => active[x]!.pitch - active[y]!.pitch,
    );
    const pairs: PairSnapshot[] = [];
    for (let x = 0; x < ids.length; x++) {
      for (let y = x + 1; y < ids.length; y++) {
        const lo = active[ids[x]]!;
        const hi = active[ids[y]]!;
        const info = intervalInfo(lo.pitch, hi.pitch, ctx.rules.fourthConsonant);
        pairs.push({
          lower: ids[x],
          upper: ids[y],
          lowerSlot: lo.slot,
          upperSlot: hi.slot,
          lowerPitch: lo.pitch,
          upperPitch: hi.pitch,
          simple: info.simple,
          perfect: isPerfectInterval(lo.pitch, hi.pitch, ctx.rules.fourthConsonant),
          quality: info.quality,
          intervalLabel: info.label,
          from: segFrom,
          to: segTo,
        });
      }
    }
    out.push({ from: segFrom, to: segTo, active, pairs });
  }
  return out;
}

/** 找到一个声部在 slot 的前/后相邻槽位及其音高。 */
export function neighbourInVoice(
  ctx: OverlapContext,
  a: OverlapAssignment,
  voice: VoiceId,
  slot: number,
  dir: -1 | 1,
): { slot: number; pitch: number; onset: number; end: number } | null {
  const target = slot + dir;
  const slots = ctx.plans[voice].slots;
  if (target < 0 || target >= slots.length) return null;
  const p = a.pitch.get(noteKey(voice, target));
  if (p === undefined) return null;
  return { slot: target, pitch: p, onset: slots[target].onset, end: slots[target].end };
}

/** 某声部在 time 实际发声的槽位下标；没有发声时返回 null。 */
export function slotAt(
  ctx: OverlapContext,
  a: OverlapAssignment,
  voice: VoiceId,
  time: number,
): number | null {
  const slots = ctx.plans[voice].slots;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.onset <= time + EPS && s.end > time + EPS && a.pitch.has(noteKey(voice, i))) return i;
  }
  return null;
}

/** 某声部在 time 实际发声的槽位下标；用于“起始/终止”检查，静默时退回 0。 */
export function activeSlotIn(
  ctx: OverlapContext,
  a: OverlapAssignment,
  voice: VoiceId,
  time: number,
): number {
  return slotAt(ctx, a, voice, time) ?? 0;
}

/**
 * 找到与给定声部对在 before 之前最近的纵向片段。
 * 这是平行/直接音程判定的时间基础，不含历史策略。
 */
export function lastPairBefore(
  ctx: OverlapContext,
  a: OverlapAssignment,
  lo: VoiceId,
  hi: VoiceId,
  before: number,
): PairSnapshot | null {
  if (before <= EPS) return null;
  const breakpoints = new Set<number>([0, before]);
  for (const id of [lo, hi]) {
    for (const s of ctx.plans[id].slots) {
      if (s.onset > -EPS && s.onset < before + EPS) breakpoints.add(quant(s.onset));
      if (s.end > -EPS && s.end < before + EPS) breakpoints.add(quant(s.end));
    }
  }
  const pts = [...breakpoints].sort((x, y) => x - y);
  for (let i = pts.length - 1; i >= 1; i--) {
    const end = pts[i];
    const start = pts[i - 1];
    if (end - start <= EPS) continue;
    if (end > before + EPS) continue;
    const mid = (start + end) / 2;
    const loSlot = slotAt(ctx, a, lo, mid);
    const hiSlot = slotAt(ctx, a, hi, mid);
    if (loSlot === null || hiSlot === null) continue;
    const lp = a.pitch.get(noteKey(lo, loSlot))!;
    const hp = a.pitch.get(noteKey(hi, hiSlot))!;
    const info = intervalInfo(lp, hp, ctx.rules.fourthConsonant);
    return {
      lower: lo,
      upper: hi,
      lowerSlot: loSlot,
      upperSlot: hiSlot,
      lowerPitch: lp,
      upperPitch: hp,
      simple: info.simple,
      perfect: isPerfectInterval(lp, hp, ctx.rules.fourthConsonant),
      quality: info.quality,
      intervalLabel: info.label,
      from: start,
      to: end,
    };
  }
  return null;
}
