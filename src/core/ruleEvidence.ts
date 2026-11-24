import type { VoiceId } from './score.js';
import type { HistoryPolicy } from './rules.js';
import {
  checkSlot,
  type AnalysisContext,
  type Assignment,
  type DissonanceContext,
  type RuleKey,
  type Severity,
  type SuspensionObligation,
  type Violation,
} from './analyze.js';
import { detectStrikes, obligationErrors } from './suspensions.js';
import { EPS } from './plan.js';

/**
 * 规则证据：一次候选判定同时给出两类可解释输出。
 *
 * - 即时违例（immediate）：此刻就能判决的违规，搜索可以立即剪枝。
 * - 待解决（pending）：此刻合法、但产生了必须在后续音上兑现的义务
 *   （例如延留音必须下行级进解决）。搜索不能把它当成“已通过”，
 *   完整复核时必须确认义务已兑现，否则整条解不成立。
 *
 * 把两类分开表达，是为了避免“悬挂音在撞击时就被接受”的伪报：
 * 撞击音本身可能不违反任何即时规则，但它携带的 pending 义务若未兑现，
 * 整条分配仍然无效。
 */

export type EvidenceClass = 'immediate' | 'pending';

/** 待解决义务的具体要求；用于搜索前瞻与界面解释。 */
export interface PendingRequirement {
  kind: 'resolve-down-by-step';
  voice: VoiceId;
  /** 承载义务的槽位（被撞成不协和的持续音）。 */
  slot: number;
  pitch: number;
  /** 必须在哪个槽位解决（承载音结束后的下一槽位）。 */
  resolveSlot: number;
  /** 义务截止时间（承载音结束）。 */
  deadline: number;
  struckBy: { voice: VoiceId; slot: number; time: number; pitch: number };
}

export interface RuleEvidence {
  cls: EvidenceClass;
  violation: Violation;
  /** pending 证据携带的待兑现要求。 */
  requirement?: PendingRequirement;
}

export interface SlotEvidence {
  /** 立即判决的违规（含此前义务未兑现）。 */
  immediate: Violation[];
  /** 本音新产生的、必须在后续兑现的义务。 */
  pending: RuleEvidence[];
}

function pendingFromObligation(ctx: AnalysisContext, o: SuspensionObligation): RuleEvidence {
  const resolveSlot = o.slot + 1;
  const next = ctx.plans[o.voice].slots[resolveSlot];
  const deadline = o.end;
  const violation: Violation = {
    rule: 'suspensionResolveDown',
    ruleLabel: '延留音下行解决',
    severity: 'info',
    time: o.struckBy.time,
    measure: Math.floor(o.struckBy.time / ctx.beatsPerMeasure + 1e-9),
    beat: ((o.struckBy.time % ctx.beatsPerMeasure) + ctx.beatsPerMeasure) % ctx.beatsPerMeasure,
    strength: 'weak',
    voices: [o.voice, o.struckBy.voice],
    message: `${o.voice} 的 ${o.pitch} 持续到 ${o.struckBy.voice} 进入时被撞成不协和，形成待解决延留音。`,
    detail: next
      ? `必须在 ${o.voice} 结束时（${deadline} 拍）下行级进解决；解决尚未搜索到。`
      : `该延留音位于曲末，没有后续解决位置。`,
    notes: [
      { voice: o.voice, index: o.slot },
      { voice: o.struckBy.voice, index: o.struckBy.slot },
    ],
    dissonance: {
      kind: 'prepared-suspension',
      explanation: '延留音在撞击时刻是“待解决”状态，不能据此提前接受整条分配。',
      evidence: [
        { voice: o.voice, slot: o.slot, pitch: o.pitch, role: '延留音' },
        {
          voice: o.struckBy.voice,
          slot: o.struckBy.slot,
          pitch: o.struckBy.pitch,
          role: '撞入声部',
        },
      ],
      createsObligation: true,
    },
  };
  const requirement: PendingRequirement = {
    kind: 'resolve-down-by-step',
    voice: o.voice,
    slot: o.slot,
    pitch: o.pitch,
    resolveSlot,
    deadline,
    struckBy: o.struckBy,
  };
  return { cls: 'pending', violation, requirement };
}

/**
 * 判定在 (voice, slot) 放 pitch 之后的全量证据。
 * `immediate` 与搜索剪枝一一对应；`pending` 只是“还需要后续兑现”，
 * 不能单独当作接受理由。
 */
export function slotEvidence(
  ctx: AnalysisContext,
  a: Assignment,
  voice: VoiceId,
  slot: number,
  pitch: number,
  policy: HistoryPolicy,
): SlotEvidence {
  const immediate = [...checkSlot(ctx, a, voice, slot, pitch)];
  // 此前产生的延留义务若在此音未兑现，属于即时违规。
  for (const v of obligationErrors(ctx, a, voice, slot, pitch, policy)) immediate.push(v);
  const pending = detectStrikes(ctx, a, voice, slot, pitch, policy).map((o) =>
    pendingFromObligation(ctx, o),
  );
  return { immediate, pending };
}

/** 即时违例中的错误项；空数组表示可继续搜索。 */
export function immediateErrors(evidence: SlotEvidence): Violation[] {
  return evidence.immediate.filter((v) => v.severity === 'error');
}

/**
 * 一条完整分配是否因“悬挂音未兑现”而被拒绝。用于穷举核对：
 * pending 证据存在但解决音缺失/不合规时，整体必须判为无效。
 */
export function unresolvedPending(
  ctx: AnalysisContext,
  a: Assignment,
  policy: HistoryPolicy,
): { requirement: PendingRequirement; violation: Violation }[] {
  const out: { requirement: PendingRequirement; violation: Violation }[] = [];
  for (const id of ['u1', 'u2'] as VoiceId[]) {
    const slots = ctx.plans[id].slots;
    for (let i = 0; i < slots.length; i++) {
      const p = a.pitch.get(`${id}:${i}`);
      if (p === undefined) continue;
      const ev = slotEvidence(ctx, a, id, i, p, policy);
      for (const pending of ev.pending) {
        const req = pending.requirement!;
        const resolvePitch = a.pitch.get(`${req.voice}:${req.resolveSlot}`);
        const nextSlot = ctx.plans[req.voice].slots[req.resolveSlot];
        const resolved =
          resolvePitch !== undefined &&
          nextSlot !== undefined &&
          Math.abs(nextSlot.onset - req.deadline) < EPS &&
          Math.sign(resolvePitch - req.pitch) < 0 &&
          Math.abs(resolvePitch - req.pitch) <= 2;
        if (!resolved) out.push({ requirement: req, violation: pending.violation });
      }
    }
  }
  return out;
}

/** 供界面/CLI 复用：把证据中的即时违例还原成原有的 Violation 列表。 */
export function evidenceViolations(evidence: SlotEvidence): Violation[] {
  return [...evidence.immediate, ...evidence.pending.map((p) => p.violation)];
}

export interface EvidenceReport {
  immediate: Violation[];
  pending: RuleEvidence[];
  unresolved: { requirement: PendingRequirement; violation: Violation }[];
}

/** 完整分配的证据报告：即时违规 + 仍未兑现的待解决义务。 */
export function reportAssignmentEvidence(
  ctx: AnalysisContext,
  a: Assignment,
  policy: HistoryPolicy,
): EvidenceReport {
  const immediate: Violation[] = [];
  const pending: RuleEvidence[] = [];
  for (const id of ['u1', 'u2'] as VoiceId[]) {
    const slots = ctx.plans[id].slots;
    for (let i = 0; i < slots.length; i++) {
      const p = a.pitch.get(`${id}:${i}`);
      if (p === undefined) continue;
      const ev = slotEvidence(ctx, a, id, i, p, policy);
      immediate.push(...ev.immediate);
      pending.push(...ev.pending);
    }
  }
  return { immediate, pending, unresolved: unresolvedPending(ctx, a, policy) };
}

export type { DissonanceContext, RuleKey, Severity };
