import { midiToName, type Key } from './pitch.js';
import type { VoiceId } from './score.js';
import type { CounterpointRules, HistoryPolicy } from './rules.js';
import {
  intervalIsDissonant,
  strengthOf,
  type AnalysisContext,
  type Assignment,
  type SuspensionObligation,
  type Violation,
} from './analyze.js';
import { slicesBetween } from './voiceOverlap.js';
import { EPS, feq, noteKey } from './plan.js';

/**
 * 延留义务的纯计算层：只回答“谁在何时被谁撞成不协和、是否必须下行解决”，
 * 既不持有搜索状态，也不依赖 DFS 顺序。搜索策略可以按需重算（约束器收集），
 * 也可以把结果带入下一步（节点携带），两者共用这里的判定。
 */

/**
 * 若本音在某个持续音上造成新的不协和，且该持续音此前与移动声部协和（有准备），
 * 则为持续音建立“必须下行级进解决”的义务。仅对 u1/u2 的上方持续音建立。
 */
export function detectStrikes(
  ctx: AnalysisContext,
  a: Assignment,
  voice: VoiceId,
  slot: number,
  pitch: number,
  policy: HistoryPolicy,
): SuspensionObligation[] {
  const out: SuspensionObligation[] = [];
  const s = ctx.plans[voice].slots[slot];
  const slices = slicesBetween(ctx, a, s.onset, s.end);
  if (slices.length === 0) return out;
  const first = slices[0];
  for (const v of ['u1', 'u2'] as VoiceId[]) {
    if (v === voice) continue;
    const held = first.active[v];
    if (!held) continue;
    const heldSlot = ctx.plans[v].slots[held.slot];
    if (!heldSlot) continue;
    if (!(heldSlot.onset < s.onset - EPS)) continue; // 必须是先前已在响的音
    if (policy === 'truncate') {
      const barStart = Math.floor((s.onset + EPS) / ctx.beatsPerMeasure) * ctx.beatsPerMeasure;
      if (heldSlot.onset < barStart - EPS) continue;
    }
    if (!intervalIsDissonant(pitch, held.pitch, ctx.rules.fourthConsonant)) continue;
    // 有准备：移动声部的前一个音与该持续音协和（或该声部从此开始）。
    const prev = a.pitch.get(noteKey(voice, slot - 1));
    const prepared =
      prev === undefined || !intervalIsDissonant(prev, held.pitch, ctx.rules.fourthConsonant);
    if (!prepared) continue;
    // 持续音必须是纵向上的上方音（学校对位中的上方延留）。
    if (held.pitch <= pitch) continue;
    out.push({
      voice: v,
      slot: held.slot,
      onset: heldSlot.onset,
      end: heldSlot.end,
      pitch: held.pitch,
      struckBy: { voice, slot, time: s.onset, pitch },
    });
  }
  return out;
}

/**
 * 判断某声部的某个已给音在其时值内是否被其他声部撞成不协和。
 * 约束器收集策略用它从当前分配重算跨节挂起项，不依赖搜索状态。
 */
export function detectStrikesOnExisting(
  ctx: AnalysisContext,
  a: Assignment,
  voice: VoiceId,
  slot: number,
  policy: HistoryPolicy,
): { time: number; by: VoiceId }[] {
  const note = ctx.plans[voice].slots[slot];
  if (!note) return [];
  const slices = slicesBetween(ctx, a, note.onset, note.end);
  const out: { time: number; by: VoiceId }[] = [];
  for (const sl of slices) {
    if (sl.from <= note.onset + EPS) continue;
    const self = sl.active[voice];
    if (!self) continue;
    for (const other of ['cf', 'u1', 'u2'] as VoiceId[]) {
      if (other === voice) continue;
      const o = sl.active[other];
      if (!o) continue;
      const os = ctx.plans[other].slots[o.slot];
      if (!os || Math.abs(os.onset - sl.from) > EPS) continue; // 只有他声部进入才构成“撞”
      if (policy === 'truncate') {
        const barStart = Math.floor((sl.from + EPS) / ctx.beatsPerMeasure) * ctx.beatsPerMeasure;
        if (note.onset < barStart - EPS) continue;
      }
      if (intervalIsDissonant(self.pitch, o.pitch, ctx.rules.fourthConsonant)) {
        // 该音必须是上方音
        if (self.pitch > o.pitch) out.push({ time: sl.from, by: other });
      }
    }
  }
  return out;
}

/** 检查本音是否履行了此前延留义务（下行级进解决）。 */
export function obligationErrors(
  ctx: AnalysisContext,
  a: Assignment,
  voice: VoiceId,
  slot: number,
  pitch: number,
  policy: HistoryPolicy,
): Violation[] {
  const out: Violation[] = [];
  const s = ctx.plans[voice].slots[slot];
  if (slot === 0) return out;
  const prevPitch = a.pitch.get(noteKey(voice, slot - 1));
  if (prevPitch === undefined) return out;
  const prevSlot = ctx.plans[voice].slots[slot - 1];
  if (!feq(prevSlot.end, s.onset)) return out;
  if (policy === 'truncate') {
    const barStart = Math.floor((s.onset + EPS) / ctx.beatsPerMeasure) * ctx.beatsPerMeasure;
    if (prevSlot.onset < barStart - EPS) return out;
  }
  // 前一个音是否在它自己的时值内被撞成不协和？
  const strikes = detectStrikesOnExisting(ctx, a, voice, slot - 1, policy);
  if (strikes.length === 0) return out;
  if (ctx.rules.suspensionResolveDown) {
    const down = Math.sign(pitch - prevPitch) < 0;
    const step = Math.abs(pitch - prevPitch) <= 2;
    if (!(down && step)) {
      out.push({
        rule: 'suspensionResolveDown',
        ruleLabel: '延留音下行解决',
        severity: 'error',
        time: s.onset,
        measure: Math.floor(s.onset / ctx.beatsPerMeasure + 1e-9),
        beat: ((s.onset % ctx.beatsPerMeasure) + ctx.beatsPerMeasure) % ctx.beatsPerMeasure,
        strength: strengthOf(ctx, s.onset),
        voices: [voice],
        message: `${voice} 的延留音 ${midiToName(prevPitch)} 未下行级进解决，而是到 ${midiToName(pitch)}。`,
        detail: '延留音必须在结束时下行级进（≤2 半音）解决；该义务跨小节保留。',
        notes: [
          { voice, index: slot - 1 },
          { voice, index: slot },
        ],
      });
    }
  }
  return out;
}

/** 组合输入，便于策略层与测试以纯函数方式复用。 */
export interface ObligationInput {
  ctx: AnalysisContext;
  assignment: Assignment;
  voice: VoiceId;
  slot: number;
  pitch: number;
  policy: HistoryPolicy;
}

export function intervalDissonantBetween(
  a: number,
  b: number,
  rules: Pick<CounterpointRules, 'fourthConsonant'>,
): boolean {
  return intervalIsDissonant(a, b, rules.fourthConsonant);
}

/**
 * 约束器收集策略：不把义务存进搜索节点，而是从当前分配重新收集
 * 仍然开放的跨节挂起项。与节点携带策略对同一分配应得到相同集合；
 * 差异仅在于是否需要维护可变的节点状态。
 */
export function collectObligations(
  ctx: AnalysisContext,
  a: Assignment,
  policy: HistoryPolicy,
  frontier: number,
): SuspensionObligation[] {
  const out: SuspensionObligation[] = [];
  const seen = new Set<string>();
  for (const voice of ['u1', 'u2'] as VoiceId[]) {
    const slots = ctx.plans[voice].slots;
    for (let slot = 0; slot < slots.length; slot++) {
      const pitch = a.pitch.get(noteKey(voice, slot));
      if (pitch === undefined) continue;
      for (const o of detectStrikes(ctx, a, voice, slot, pitch, policy)) {
        if (o.end <= frontier + EPS) continue; // 已到解决位置，不再是挂起项
        const key = `${o.voice}:${o.slot}:${o.struckBy.time}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(o);
      }
    }
  }
  return out;
}

export type { Key };
