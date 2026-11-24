import { intervalInfo } from './pitch.js';
import type { VoiceId } from './score.js';
import type { HistoryPolicy } from './rules.js';
import type { AnalysisContext, Assignment, SuspensionObligation, HistoryBoundary } from './analyze.js';
import { noteKey } from './plan.js';
import { EPS } from './plan.js';
import { slicesBetween, activeSlotIn } from './voiceOverlap.js';

/**
 * 搜索策略层：任务排序、候选排序、历史推进与“延留义务如何跨节点”。
 * 与具体规则判定分离，因此可以分别检查与替换，而搜索入口保持固定。
 */

export type ObligationMode = 'carry-node' | 'collector';

export interface Task {
  voice: VoiceId;
  slot: number;
}

export function buildTasks(plans: Record<'cf' | 'u1' | 'u2', { slots: { onset: number }[] }>): Task[] {
  const tasks: Task[] = [];
  const order: VoiceId[] = ['u1', 'u2'];
  for (const voice of order) {
    for (let i = 0; i < plans[voice].slots.length; i++) {
      tasks.push({ voice, slot: i });
    }
  }
  tasks.sort((x, y) => {
    const ox = plans[x.voice].slots[x.slot].onset;
    const oy = plans[y.voice].slots[y.slot].onset;
    if (Math.abs(ox - oy) > EPS) return ox - oy;
    return order.indexOf(x.voice) - order.indexOf(y.voice);
  });
  return tasks;
}

/** 候选排序：优先级进、优先与定旋律协和，保证前几个解具有可听性。 */
export function candidateCost(
  ctx: AnalysisContext,
  a: Assignment,
  voice: VoiceId,
  slot: number,
  pitch: number,
  prevPitch: number | undefined,
): number {
  let cost = 0;
  if (prevPitch !== undefined) cost += Math.abs(pitch - prevPitch) * 1.5;
  const s = ctx.plans[voice].slots[slot];
  const slices = slicesBetween(ctx, a, s.onset, Math.min(s.end, s.onset + 0.5));
  for (const sl of slices) {
    for (const p of sl.pairs) {
      if (p.lower === voice || p.upper === voice) {
        if (p.quality === 'imperfect') cost -= 3;
        else if (p.quality === 'perfect') cost -= 2;
        else cost += 8;
      }
    }
  }
  const cf = a.pitch.get(noteKey('cf', activeSlotIn(ctx, a, 'cf', s.onset)));
  if (cf !== undefined) {
    const info = intervalInfo(cf, pitch, ctx.rules.fourthConsonant);
    if (info.quality === 'imperfect') cost -= 2;
    if (info.quality === 'perfect') cost -= 1;
    if (info.quality === 'dissonant') cost += 6;
  }
  return cost;
}

export interface StrategyState {
  assignment: Assignment;
  obligations: SuspensionObligation[];
  historyTrail: HistoryBoundary[];
}

/**
 * 在事件边界推进历史。carry 保留跨小节开放义务与最后音程；
 * truncate 在小节线丢弃此前义务，只保留本小节内的音程。
 */
export function advanceHistory(
  ctx: AnalysisContext,
  a: Assignment,
  state: StrategyState,
  time: number,
  policy: HistoryPolicy,
): HistoryBoundary {
  const barStart = Math.floor((time + EPS) / ctx.beatsPerMeasure) * ctx.beatsPerMeasure;
  const floor = policy === 'carry' ? 0 : barStart;
  const kept =
    policy === 'carry'
      ? state.obligations.filter((o) => o.end > time - EPS)
      : state.obligations.filter((o) => o.end > time - EPS && o.onset >= floor - EPS);
  state.obligations = kept;
  const slices = slicesBetween(ctx, a, Math.max(0, time - 0.0001), time);
  const pairs = slices.flatMap((s) => s.pairs).slice(-4);
  return { pairs, obligations: kept.map((o) => ({ ...o })), time };
}

export function isEventBoundary(
  ctx: AnalysisContext,
  time: number,
  tasks: Task[],
  index: number,
): boolean {
  if (index + 1 >= tasks.length) return false;
  const next = tasks[index + 1];
  const nextOnset = ctx.plans[next.voice].slots[next.slot].onset;
  return nextOnset > time + EPS;
}

/**
 * 策略选择器。两种模式对完整乐谱的接受/拒绝必须一致；差异只允许出现在
 * 剪枝时机与历史展示上。默认值由 `tests/interface.test.ts` 的实测比较决定。
 */
export function obligationModeDefault(): ObligationMode {
  return 'collector';
}
