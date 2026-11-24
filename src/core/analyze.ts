import {
  beatStrengthRank,
  diatonicDirection,
  intervalInfo,
  isDiatonicStep,
  isInScale,
  isPerfectInterval,
  midiToName,
  type Key,
} from './pitch.js';
import type { Note, VoiceId } from './score.js';
import type { CounterpointRules, HistoryPolicy } from './rules.js';
import { EPS, noteKey, type EventPoint, type VoicePlan } from './plan.js';
import {
  activeSlotIn,
  lastPairBefore,
  neighbourInVoice,
  slicesBetween,
  type PairSnapshot,
  type Slice,
} from './voiceOverlap.js';
import { isDirectPerfect, isParallelPerfect } from './intervalRules.js';

export { activeSlotIn, lastPairBefore, neighbourInVoice, slicesBetween };
export type { PairSnapshot, Slice };

export type Severity = 'error' | 'warning' | 'info';
export type DissonanceKind =
  | 'consonant'
  | 'passing'
  | 'neighbor'
  | 'suspension'
  | 'prepared-suspension'
  | 'pending'
  | 'unexplained';

export interface DissonanceContext {
  kind: DissonanceKind;
  explanation: string;
  /** 判定依据所涉及的音；用于界面高亮。 */
  evidence: { voice: VoiceId; slot: number; pitch: number; role: string }[];
  /** 该不协和是否产生“必须在结束时下行级进”的悬挂义务。 */
  createsObligation?: boolean;
}

export interface Violation {
  rule: RuleKey;
  ruleLabel: string;
  severity: Severity;
  time: number;
  measure: number;
  beat: number;
  strength: 'strong' | 'medium' | 'weak';
  voices: VoiceId[];
  message: string;
  detail: string;
  notes: { voice: VoiceId; index: number }[];
  dissonance?: DissonanceContext;
}

export type RuleKey =
  | 'strongBeatConsonance'
  | 'allowPassingTones'
  | 'allowNeighborTones'
  | 'allowSuspensions'
  | 'suspensionResolveDown'
  | 'fourthConsonant'
  | 'forbidParallelPerfects'
  | 'forbidDirectPerfects'
  | 'forbidVoiceCrossing'
  | 'maxLeap'
  | 'forbidTritoneLeap'
  | 'requireLeapRecovery'
  | 'forbidRepeatedNotes'
  | 'diatonicOnly'
  | 'startPerfect'
  | 'endOnTonic'
  | 'endPerfect'
  | 'range'
  | 'rehearsalRange'
  | 'rehearsalBreath'
  | 'rehearsalSwap';

export interface Assignment {
  /** voice:slot -> pitch */
  pitch: Map<string, number>;
}

export interface AnalysisContext {
  plans: Record<'cf' | 'u1' | 'u2', VoicePlan>;
  points: EventPoint[];
  key: Key;
  beatsPerMeasure: number;
  rules: CounterpointRules;
  historyPolicy: HistoryPolicy;
  /** 早于该时刻的纵向预备/义务视为被截断；carry 时为 0。 */
  historyFloor: number;
  /** 完整分配时为 true：此时“待定”会升级为无法解释。 */
  complete: boolean;
  T: number;
}

/**
 * 按历史策略为某一时刻计算有效上下文：
 * truncate 只保留当前小节内的纵向历史，carry 保留全部。
 */
export function effectiveContext(ctx: AnalysisContext, time: number): AnalysisContext {
  if (ctx.historyPolicy === 'carry') return ctx;
  const floor = Math.floor((time + 1e-9) / ctx.beatsPerMeasure) * ctx.beatsPerMeasure;
  if (ctx.historyFloor === floor) return ctx;
  return { ...ctx, historyFloor: floor };
}

export function emptyAssignment(): Assignment {
  return { pitch: new Map() };
}

export function cloneAssignment(a: Assignment): Assignment {
  return { pitch: new Map(a.pitch) };
}

/**
 * 判定一个不协和片段的上下文。这里不会把全部非和弦音一律排除，
 * 而是区分经过音、辅助音、延留音（含待解决）与真正无法解释的不协和。
 */
export function classifyDissonance(
  ctx: AnalysisContext,
  a: Assignment,
  pair: PairSnapshot,
  slice: Slice,
): DissonanceContext {
  const rules = ctx.rules;
  const key = ctx.key;
  const info = intervalInfo(pair.lowerPitch, pair.upperPitch, rules.fourthConsonant);
  const pairVoices: [VoiceId, VoiceId] = [pair.lower, pair.upper];
  const slotOf: Record<string, number> = {
    [pair.lower]: pair.lowerSlot,
    [pair.upper]: pair.upperSlot,
  };

  // 1) 延留音：不协和声部的音在片段开始时已经在响（其 onset 早于片段起点）。
  //    定旋律由用户给定，不作为待解决的延留声部。
  for (const v of pairVoices) {
    if (v === 'cf') continue;
    const slot = slotOf[v];
    const s = ctx.plans[v].slots[slot];
    if (!s) continue;
    if (s.onset < slice.from - EPS) {
      // 截短历史：跨小节的延留预备不进入判决，无法承认为有准备的延留音。
      if (ctx.historyPolicy === 'truncate' && s.onset < ctx.historyFloor - EPS) continue;
      const other = v === pair.lower ? pair.upper : pair.lower;
      const otherSlot = slotOf[other];
      const os = ctx.plans[other].slots[otherSlot];
      // 另一声部恰在片段起点进入，才构成“被延留音撞上”的局面。
      const struck = os && Math.abs(os.onset - slice.from) < EPS;
      if (!struck) continue;
      const next = a.pitch.get(noteKey(v, slot + 1));
      const nextSlot = ctx.plans[v].slots[slot + 1];
      const nextKnown = next !== undefined && nextSlot !== undefined;
      const heldPitch = v === pair.lower ? pair.lowerPitch : pair.upperPitch;
      const resolvesCleanly =
        nextKnown &&
        Math.abs(nextSlot!.onset - s.end) < EPS &&
        Math.sign(next! - heldPitch) < 0 &&
        Math.abs(next! - heldPitch) <= 2;
      const pitchName = midiToName(v === pair.lower ? pair.lowerPitch : pair.upperPitch);
      const otherName = midiToName(other === pair.lower ? pair.lowerPitch : pair.upperPitch);
      if (!nextKnown && !ctx.complete) {
        return {
          kind: 'pending',
          explanation: `${v} 的 ${pitchName} 在 ${other} 的 ${otherName} 进入时被撞成不协和，形成延留音；其下行解决尚未搜索到。`,
          evidence: [
            { voice: v, slot, pitch: v === pair.lower ? pair.lowerPitch : pair.upperPitch, role: '延留音' },
            { voice: other, slot: otherSlot, pitch: other === pair.lower ? pair.lowerPitch : pair.upperPitch, role: '撞入声部' },
          ],
          createsObligation: true,
        };
      }
      return {
        kind: resolvesCleanly ? 'suspension' : 'prepared-suspension',
        createsObligation: true,
        explanation: resolvesCleanly
          ? `${v} 的 ${pitchName} 在 ${other} 的 ${otherName} 进入时被撞成不协和，随后在 ${midiToName(next!)} 下行级进解决，属延留音。`
          : `${v} 的 ${pitchName} 在 ${other} 的 ${otherName} 进入时被撞成不协和；该音需要在结束时下行级进解决（当前尚未满足或未定）。`,
        evidence: [
          { voice: v, slot, pitch: v === pair.lower ? pair.lowerPitch : pair.upperPitch, role: '延留音' },
          { voice: other, slot: otherSlot, pitch: other === pair.lower ? pair.lowerPitch : pair.upperPitch, role: '撞入声部' },
        ],
      };
    }
  }

  // 2) 经过音 / 辅助音：关注恰在片段起点进入的声部。
  for (const v of pairVoices) {
    const slot = slotOf[v];
    const s = ctx.plans[v].slots[slot];
    if (!s || Math.abs(s.onset - slice.from) > EPS) continue;
    const pitch = v === pair.lower ? pair.lowerPitch : pair.upperPitch;
    const prev = neighbourInVoice(ctx, a, v, slot, -1);
    const next = neighbourInVoice(ctx, a, v, slot, 1);
    const other = v === pair.lower ? pair.upper : pair.lower;
    const otherPitch = other === pair.lower ? pair.lowerPitch : pair.upperPitch;
    const otherSlot = slotOf[other];
    const otherNote = ctx.plans[other].slots[otherSlot];
    const otherSustains = otherNote && Math.abs(otherNote.onset - s.onset) > EPS;
    if (!prev || !next) continue;
    const entryStep = isDiatonicStep(prev.pitch, pitch, key) || Math.abs(prev.pitch - pitch) <= 2;
    const exitStep = isDiatonicStep(pitch, next.pitch, key) || Math.abs(next.pitch - pitch) <= 2;
    if (!entryStep || !exitStep) continue;
    const entryDir = diatonicDirection(prev.pitch, pitch);
    const exitDir = diatonicDirection(pitch, next.pitch);
    if (entryDir !== 0 && entryDir === exitDir) {
      return {
        kind: 'passing',
        explanation: `${v} 的 ${midiToName(prev.pitch)}→${midiToName(pitch)}→${midiToName(next.pitch)} 为同向级进的经过音；不协和位于片段 ${fmtTime(slice.from)}–${fmtTime(slice.to)}，而 ${other} 持续 ${midiToName(otherPitch)}。`,
        evidence: [
          { voice: v, slot: prev.slot, pitch: prev.pitch, role: '经过前音' },
          { voice: v, slot, pitch, role: '经过音' },
          { voice: v, slot: next.slot, pitch: next.pitch, role: '经过后音' },
          { voice: other, slot: otherSlot, pitch: otherPitch, role: '持续声部' },
        ],
      };
    }
    if (entryDir !== 0 && exitDir === -entryDir && Math.abs(next.pitch - prev.pitch) <= 2) {
      return {
        kind: 'neighbor',
        explanation: `${v} 的 ${midiToName(prev.pitch)}→${midiToName(pitch)}→${midiToName(next.pitch)} 为级进辅助音（围绕 ${midiToName(prev.pitch)}）。`,
        evidence: [
          { voice: v, slot: prev.slot, pitch: prev.pitch, role: '本音' },
          { voice: v, slot, pitch, role: '辅助音' },
          { voice: v, slot: next.slot, pitch: next.pitch, role: '返回音' },
          { voice: other, slot: otherSlot, pitch: otherPitch, role: '持续声部' },
        ],
      };
    }
    void otherSustains;
  }

  // 3) 弱位上的不协和若后续音尚未确定，允许留待搜索判定；这不是“默认排除”。
  const st = strengthOf(ctx, slice.from);
  if (!ctx.complete && st === 'weak') {
    return {
      kind: 'pending',
      explanation: `弱位不协和（${info.label}）尚缺后续音，待搜索继续判定是否为经过/辅助音。`,
      evidence: [
        { voice: pair.lower, slot: pair.lowerSlot, pitch: pair.lowerPitch, role: '低音' },
        { voice: pair.upper, slot: pair.upperSlot, pitch: pair.upperPitch, role: '上方音' },
      ],
    };
  }
  return {
    kind: 'unexplained',
    explanation: `${info.label}（${midiToName(pair.lowerPitch)} / ${midiToName(pair.upperPitch)}）既非经过音、辅助音，也不是有准备的延留音。`,
    evidence: [
      { voice: pair.lower, slot: pair.lowerSlot, pitch: pair.lowerPitch, role: '不协和低音' },
      { voice: pair.upper, slot: pair.upperSlot, pitch: pair.upperPitch, role: '不协和上方' },
    ],
  };
}

export function fmtTime(t: number): string {
  const m = Math.floor(t / 4 + 1e-9) + 1;
  const b = Math.round((t - (m - 1) * 4) * 100) / 100 + 1;
  return `${m} 小节第 ${b} 拍`;
}

export interface VoiceRangeCheck {
  voice: VoiceId;
  slot: number;
  pitch: number;
  low: number;
  high: number;
}

function makeViolation(
  ctx: AnalysisContext,
  rule: RuleKey,
  ruleLabel: string,
  severity: Severity,
  time: number,
  voices: VoiceId[],
  message: string,
  detail: string,
  notes: { voice: VoiceId; index: number }[],
  dissonance?: DissonanceContext,
): Violation {
  const bpm = ctx.beatsPerMeasure;
  return {
    rule,
    ruleLabel,
    severity,
    time,
    measure: Math.floor(time / bpm + 1e-9),
    beat: ((time % bpm) + bpm) % bpm,
    strength: strengthOf(ctx, time),
    voices,
    message,
    detail,
    notes,
    dissonance,
  };
}

export function strengthOf(ctx: AnalysisContext, time: number): 'strong' | 'medium' | 'weak' {
  const pos = ((time % ctx.beatsPerMeasure) + ctx.beatsPerMeasure) % ctx.beatsPerMeasure;
  if (Math.abs(pos) < EPS) return 'strong';
  if (ctx.beatsPerMeasure >= 4 && Math.abs(pos - 2) < EPS) return 'medium';
  return 'weak';
}

export function isBarLine(ctx: AnalysisContext, time: number): boolean {
  return time > EPS && Math.abs(time % ctx.beatsPerMeasure) < EPS;
}

/**
 * 检查单个声部在单个槽位上的所有规则。搜索时用于剪枝，
 * 展示时用于生成完整解释；两者共用，避免“搜索能过、解释不过”。
 * 依赖的分配必须已存在：cf 全部、u1/u2 在此之前及本槽位。
 */
export function checkSlot(
  ctx: AnalysisContext,
  a: Assignment,
  voice: VoiceId,
  slot: number,
  pitch: number,
): Violation[] {
  const planRef = ctx.plans[voice];
  const slotRef = planRef.slots[slot];
  if (slotRef) ctx = effectiveContext(ctx, slotRef.onset);
  const out: Violation[] = [];
  const plan = ctx.plans[voice];
  const s = plan.slots[slot];
  const rules = ctx.rules;
  const key = ctx.key;
  const slots = plan.slots;

  const push = (
    rule: RuleKey,
    label: string,
    sev: Severity,
    time: number,
    voices: VoiceId[],
    message: string,
    detail: string,
    notes: { voice: VoiceId; index: number }[],
    dissonance?: DissonanceContext,
  ) => out.push(makeViolation(ctx, rule, label, sev, time, voices, message, detail, notes, dissonance));

  // 音域
  if (pitch < plan.low || pitch > plan.high) {
    push(
      'range',
      '声部音域',
      'error',
      s.onset,
      [voice],
      `${voice} 的 ${midiToName(pitch)} 超出音域 ${midiToName(plan.low)}–${midiToName(plan.high)}。`,
      '每条旋律必须落在其声部音域内。',
      [{ voice, index: slot }],
    );
  }

  if (rules.diatonicOnly && !isInScale(pitch, key)) {
    push(
      'diatonicOnly',
      '只使用调内音',
      'error',
      s.onset,
      [voice],
      `${midiToName(pitch)} 不在所选调式音阶内。`,
      '本工具按所选调式音阶过滤候选音；该检查用于诊断导入或手动编辑。',
      [{ voice, index: slot }],
    );
  }

  const prevPitch = slot > 0 ? a.pitch.get(noteKey(voice, slot - 1)) : undefined;
  const prev = slot > 0 ? slots[slot - 1] : null;
  const nextPitch =
    slot + 1 < slots.length ? a.pitch.get(noteKey(voice, slot + 1)) : undefined;

  if (prevPitch !== undefined && prev) {
    const semis = Math.abs(pitch - prevPitch);
    const sameOnset = Math.abs(prev.onset - s.onset) < EPS;
    if (!sameOnset) {
      if (semis > rules.maxLeap) {
        push(
          'maxLeap',
          '最大旋律跳进',
          'error',
          s.onset,
          [voice],
          `${voice} ${midiToName(prevPitch)}→${midiToName(pitch)} 为 ${semis} 半音，超过上限 ${rules.maxLeap}。`,
          '限制单个相邻音程的跨度。',
          [{ voice, index: slot - 1 }, { voice, index: slot }],
        );
      }
      if (rules.forbidTritoneLeap && semis === 6) {
        push(
          'forbidTritoneLeap',
          '禁止三全音跳进',
          'error',
          s.onset,
          [voice],
          `${voice} 出现 ${midiToName(prevPitch)}→${midiToName(pitch)} 三全音跳进。`,
          '三全音跳进在严格对位中通常避免。',
          [{ voice, index: slot - 1 }, { voice, index: slot }],
        );
      }
      if (rules.forbidRepeatedNotes && semis === 0) {
        push(
          'forbidRepeatedNotes',
          '禁止同音重复',
          'error',
          s.onset,
          [voice],
          `${voice} 在 ${midiToName(pitch)} 上重复了相邻音符。`,
          '独立相邻音不得直接重复；跨时值的持续音不触发。',
          [{ voice, index: slot - 1 }, { voice, index: slot }],
        );
      }
    }
    if (rules.requireLeapRecovery && !sameOnset) {
      // 本槽位是否为前一个跳进的反向级进恢复。
      if (slot >= 2) {
        const pp = a.pitch.get(noteKey(voice, slot - 2));
        if (pp !== undefined) {
          const leap = Math.abs(prevPitch - pp);
          if (leap >= 5) {
            const leapDir = diatonicDirection(pp, prevPitch);
            const recDir = diatonicDirection(prevPitch, pitch);
            if (!(recDir === -leapDir && Math.abs(pitch - prevPitch) <= 2)) {
              push(
                'requireLeapRecovery',
                '跳进后反向级进恢复',
                'error',
                s.onset,
                [voice],
                `${voice} ${midiToName(pp)}→${midiToName(prevPitch)} 跳进后，到 ${midiToName(pitch)} 未反向级进。`,
                '≥5 半音的跳进后要求下一音反向级进（≤2 半音）。',
                [{ voice, index: slot - 2 }, { voice, index: slot - 1 }, { voice, index: slot }],
              );
            }
          }
        }
      }
      // 末音仍处于跳进之后，说明没有恢复的余地。
      if (slot === slots.length - 1) {
        const leap = Math.abs(prevPitch - pitch);
        if (leap >= 5) {
          push(
            'requireLeapRecovery',
            '跳进后反向级进恢复',
            'error',
            s.onset,
            [voice],
            `${voice} 以 ${midiToName(prevPitch)}→${midiToName(pitch)} 的跳进结束，未获得反向级进恢复。`,
            '≥5 半音的跳进后要求下一音反向级进（≤2 半音）。',
            [{ voice, index: slot - 1 }, { voice, index: slot }],
          );
        }
      }
    }
  }

  // 起始与终止只约束生成的对位声部，定旋律由用户给定。
  const isCounterpoint = voice !== 'cf';

  // 起始
  if (isCounterpoint && slot === 0 && rules.startPerfect) {
    for (const other of ['cf', 'u1', 'u2'] as VoiceId[]) {
      if (other === voice) continue;
      const oi = activeSlotIn(ctx, a, other, s.onset);
      const op = a.pitch.get(noteKey(other, oi));
      if (op === undefined) continue;
      if (!isPerfectInterval(pitch, op, rules.fourthConsonant)) {
        push(
          'startPerfect',
          '起始用纯音程',
          'error',
          s.onset,
          [voice, other],
          `起始处 ${voice} 与 ${other} 不是纯音程。`,
          `${midiToName(op)} / ${midiToName(pitch)}。`,
          [{ voice, index: slot }, { voice: other, index: oi }],
        );
      }
    }
  }

  // 终止
  if (isCounterpoint && slot === slots.length - 1 && rules.endOnTonic) {
    if (((pitch % 12) + 12) % 12 !== ((key.tonicPc % 12) + 12) % 12) {
      push(
        'endOnTonic',
        '终止于主音',
        'error',
        s.onset,
        [voice],
        `${voice} 末音 ${midiToName(pitch)} 不是主音。`,
        `终止音必须落在主音音级 ${midiToName(((key.tonicPc % 12) + 12) % 12 + 60)} 的某个八度。`,
        [{ voice, index: slot }],
      );
    }
  }

  // 纵向：本槽位的实际重叠区间
  const slices = slicesBetween(ctx, a, s.onset, s.end);
  for (const slice of slices) {
    for (const pair of slice.pairs) {
      const info = intervalInfo(pair.lowerPitch, pair.upperPitch, rules.fourthConsonant);
      const pairNotes = [
        { voice: pair.lower, index: pair.lowerSlot },
        { voice: pair.upper, index: pair.upperSlot },
      ];
      const who = `${pair.lower} ${midiToName(pair.lowerPitch)} / ${pair.upper} ${midiToName(pair.upperPitch)}`;
      const strength = strengthOf(ctx, slice.from);
      const bar = isBarLine(ctx, slice.from);

      if (info.quality === 'dissonant' && rules.strongBeatConsonance) {
        const dc = classifyDissonance(ctx, a, pair, slice);
        const strong = strength === 'strong' || strength === 'medium' || bar;
        if ((dc.kind === 'passing' || dc.kind === 'neighbor') && strong) {
          push(
            'strongBeatConsonance',
            '强拍纵向协和',
            'error',
            slice.from,
            [pair.lower, pair.upper],
            `${who} 在${strength === 'strong' ? '强拍' : strength === 'medium' ? '次强拍' : '小节线'}出现${dc.kind === 'passing' ? '经过音' : '辅助音'}式不协和（${info.label}）。`,
            `经过音与辅助音只允许在弱位使用；此处需改用协和音或延留音。${dc.explanation}`,
            pairNotes,
            dc,
          );
        } else if (dc.kind === 'pending') {
          // 待定：搜索阶段允许；完整分析时不应出现（ctx.complete 会升级为 unexplained）。
          if (ctx.complete) {
            push(
              'strongBeatConsonance',
              '强拍纵向协和',
              'warning',
              slice.from,
              [pair.lower, pair.upper],
              `${who} 的不协和无法解释（${info.label}）。`,
              dc.explanation,
              pairNotes,
              dc,
            );
          }
        } else if (dc.kind === 'unexplained') {
          push(
            'strongBeatConsonance',
            '强拍纵向协和',
            strong ? 'error' : 'warning',
            slice.from,
            [pair.lower, pair.upper],
            `${who} 在${strength === 'strong' ? '强拍' : strength === 'medium' ? '次强拍' : bar ? '小节线' : '弱拍'}构成不协和（${info.label}），无经过/辅助/延留解释。`,
            dc.explanation,
            pairNotes,
            dc,
          );
        } else if (dc.kind === 'passing' && !rules.allowPassingTones) {
          push(
            'allowPassingTones',
            '允许经过音',
            'error',
            slice.from,
            [pair.lower, pair.upper],
            `${who} 的不协和属于经过音，但经过音规则已关闭。`,
            dc.explanation,
            pairNotes,
            dc,
          );
        } else if (dc.kind === 'neighbor' && !rules.allowNeighborTones) {
          push(
            'allowNeighborTones',
            '允许辅助音',
            'error',
            slice.from,
            [pair.lower, pair.upper],
            `${who} 的不协和属于辅助音，但辅助音规则已关闭。`,
            dc.explanation,
            pairNotes,
            dc,
          );
        } else if ((dc.kind === 'suspension' || dc.kind === 'prepared-suspension') && !rules.allowSuspensions) {
          push(
            'allowSuspensions',
            '允许延留音',
            'error',
            slice.from,
            [pair.lower, pair.upper],
            `${who} 的不协和属于延留音，但延留音规则已关闭。`,
            dc.explanation,
            pairNotes,
            dc,
          );
        } else if (dc.kind === 'suspension' && rules.suspensionResolveDown) {
          // 解决的合法性在 checkResolution 中完成；此处只标记必须在强拍被解释。
          if (!(strength === 'strong' || strength === 'medium' || bar)) {
            // 弱位延留音仍然允许，不额外报错
          }
        }
      }

      // 平行纯音程：比较前一个实际重叠段
      if (rules.forbidParallelPerfects && info.quality === 'perfect') {
        const prevPair = previousPair(ctx, a, pair, slice.from);
        if (prevPair && isParallelPerfect(prevPair, pair)) {
          push(
            'forbidParallelPerfects',
            '禁止平行五/八度',
            'error',
            slice.from,
            [pair.lower, pair.upper],
            `${who} 与前一重叠段 ${midiToName(prevPair.lowerPitch)} / ${midiToName(prevPair.upperPitch)} 构成平行${pair.simple === 7 ? '五度' : '八度/同度'}。`,
            `两声部同向从${intervalInfo(prevPair.lowerPitch, prevPair.upperPitch, rules.fourthConsonant).label}进入${info.label}。`,
            [
              ...pairNotes,
              { voice: prevPair.lower, index: prevPair.lowerSlot },
              { voice: prevPair.upper, index: prevPair.upperSlot },
            ],
          );
        }
      }

      if (rules.forbidDirectPerfects && info.quality === 'perfect') {
        const prevPair = previousPair(ctx, a, pair, slice.from);
        if (prevPair && isDirectPerfect(prevPair, pair)) {
          push(
            'forbidDirectPerfects',
            '禁止直接五/八度',
            'error',
            slice.from,
            [pair.lower, pair.upper],
            `${who} 由同向跳进进入纯音程（直接${pair.simple === 7 ? '五度' : '八度'}）。`,
            '上方声部跳进且两声部同向进入纯音程。',
            pairNotes,
          );
        }
      }

      if (rules.forbidVoiceCrossing) {
        const cf = slice.active.cf?.pitch;
        const u1 = slice.active.u1?.pitch;
        const u2 = slice.active.u2?.pitch;
        if (cf !== undefined && u1 !== undefined && u1 < cf) {
          push(
            'forbidVoiceCrossing',
            '禁止声部交错',
            'error',
            slice.from,
            ['cf', 'u1'],
            `对位 I ${midiToName(u1)} 低于定旋律 ${midiToName(cf)}。`,
            '约定定旋律为最低声部，对位 I 必须在其上方。',
            [
              { voice: 'cf', index: slice.active.cf!.slot },
              { voice: 'u1', index: slice.active.u1!.slot },
            ],
          );
        }
        if (u1 !== undefined && u2 !== undefined && u2 < u1) {
          push(
            'forbidVoiceCrossing',
            '禁止声部交错',
            'error',
            slice.from,
            ['u1', 'u2'],
            `对位 II ${midiToName(u2)} 低于对位 I ${midiToName(u1)}。`,
            '约定 定旋律 ≤ 对位 I ≤ 对位 II。',
            [
              { voice: 'u1', index: slice.active.u1!.slot },
              { voice: 'u2', index: slice.active.u2!.slot },
            ],
          );
        }
      }
    }
  }

  return dedupe(out);
}

/** 找到与给定 pair 同一对声部、在 from 之前最近的纵向片段。 */
export function previousPair(
  ctx: AnalysisContext,
  a: Assignment,
  pair: PairSnapshot,
  from: number,
): PairSnapshot | null {
  const found = lastPairBefore(ctx, a, pair.lower, pair.upper, from);
  if (!found) return null;
  if (ctx.historyPolicy === 'truncate' && found.to <= ctx.historyFloor + EPS) return null;
  return found;
}

export function dedupe(vs: Violation[]): Violation[] {
  const seen = new Set<string>();
  const out: Violation[] = [];
  for (const v of vs) {
    const sig = `${v.rule}|${v.time.toFixed(3)}|${v.voices.join(',')}|${v.message}`;
    if (seen.has(sig)) continue;
    seen.add(sig);
    out.push(v);
  }
  return out;
}

/** 基于完整分配重新扫描，产生逐时刻解释。 */
export function analyzeAssignment(ctx: AnalysisContext, a: Assignment): Violation[] {
  const out: Violation[] = [];
  for (const id of ['cf', 'u1', 'u2'] as VoiceId[]) {
    const slots = ctx.plans[id].slots;
    for (let i = 0; i < slots.length; i++) {
      const p = a.pitch.get(noteKey(id, i));
      if (p === undefined) continue;
      out.push(...checkSlot(ctx, a, id, i, p));
    }
  }
  // 终音纯音程
  if (ctx.rules.endPerfect) {
    const end = Math.max(
      ...[
        ...ctx.plans.cf.slots.map((s) => s.end),
        ...ctx.plans.u1.slots.map((s) => s.end),
        ...ctx.plans.u2.slots.map((s) => s.end),
      ],
      0,
    );
    const slices = slicesBetween(ctx, a, end - 0.0001, end);
    for (const slice of slices) {
      for (const pair of slice.pairs) {
        if (!isPerfectInterval(pair.lowerPitch, pair.upperPitch, ctx.rules.fourthConsonant)) {
          out.push(
            makeViolation(
              ctx,
              'endPerfect',
              '终止纵向纯音程',
              'error',
              slice.from,
              [pair.lower, pair.upper],
              `终止处 ${pair.lower} / ${pair.upper} 为${pair.intervalLabel}，不是纯音程。`,
              `${midiToName(pair.lowerPitch)} / ${midiToName(pair.upperPitch)}。`,
              [
                { voice: pair.lower, index: pair.lowerSlot },
                { voice: pair.upper, index: pair.upperSlot },
              ],
            ),
          );
        }
      }
    }
  }
  return dedupe(out);
}

export interface ExplainedDissonance {
  from: number;
  to: number;
  pair: PairSnapshot;
  context: DissonanceContext;
}

/**
 * 扫描实际重叠切片，枚举每个不协和纵向音程并给出上下文解释。
 * 与违例列表不同，这里包含被规则允许的经过音、辅助音与延留音，
 * 因此不会因为规则关闭或放宽就“看不到”不协和。
 */
export function explainedDissonances(
  ctx: AnalysisContext,
  a: Assignment,
): ExplainedDissonance[] {
  const out: ExplainedDissonance[] = [];
  const seen = new Set<string>();
  for (const slice of slicesBetween(ctx, a, 0, ctx.T)) {
    for (const pair of slice.pairs) {
      if (pair.quality !== 'dissonant') continue;
      const sig = `${pair.lower}:${pair.lowerSlot}-${pair.upper}:${pair.upperSlot}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      out.push({
        from: pair.from,
        to: pair.to,
        pair,
        context: classifyDissonance(ctx, a, pair, slice),
      });
    }
  }
  return out.sort((x, y) => x.from - y.from);
}

/**
 * 延留义务表：把一个“在强位开始协和、随后被撞成不协和”的音
 * 标为必须在结束时下行级进解决。跨小节也保留。
 */
export interface SuspensionObligation {
  voice: VoiceId;
  slot: number;
  onset: number;
  end: number;
  pitch: number;
  /** 撞入声部及时间。 */
  struckBy: { voice: VoiceId; slot: number; time: number; pitch: number };
}

export function suspensionObligations(
  ctx: AnalysisContext,
  a: Assignment,
  upTo: number,
): SuspensionObligation[] {
  const out: SuspensionObligation[] = [];
  const slices = slicesBetween(ctx, a, 0, Math.min(upTo, ctx.T));
  for (const slice of slices) {
    for (const pair of slice.pairs) {
      const info = intervalInfo(pair.lowerPitch, pair.upperPitch, ctx.rules.fourthConsonant);
      if (info.quality !== 'dissonant') continue;
      const dc = classifyDissonance(ctx, a, pair, slice);
      if (dc.kind !== 'suspension' && dc.kind !== 'prepared-suspension') continue;
      for (const ev of dc.evidence) {
        if (ev.role !== '延留音') continue;
        if (ev.voice === 'cf') continue;
        const s = ctx.plans[ev.voice].slots[ev.slot];
        if (!s) continue;
        const other = dc.evidence.find((x) => x.role === '撞入声部');
        out.push({
          voice: ev.voice,
          slot: ev.slot,
          onset: s.onset,
          end: s.end,
          pitch: ev.pitch,
          struckBy: other
            ? { voice: other.voice, slot: other.slot, time: slice.from, pitch: other.pitch }
            : { voice: pair.upper, slot: pair.upperSlot, time: slice.from, pitch: pair.upperPitch },
        });
      }
    }
  }
  return dedupeObligations(out);
}

function dedupeObligations(list: SuspensionObligation[]): SuspensionObligation[] {
  const seen = new Set<string>();
  const out: SuspensionObligation[] = [];
  for (const o of list) {
    const k = `${o.voice}:${o.slot}:${o.struckBy.time}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

/** 检查延留解决：义务音结束后必须下行级进。 */
export function checkSuspensionResolutions(
  ctx: AnalysisContext,
  a: Assignment,
  obligations: SuspensionObligation[],
): Violation[] {
  if (!ctx.rules.allowSuspensions) return [];
  const out: Violation[] = [];
  for (const ob of obligations) {
    if (ob.end >= ctx.T - EPS) continue;
    if (ob.voice === 'cf') continue;
    const next = a.pitch.get(noteKey(ob.voice, ob.slot + 1));
    if (next === undefined) continue;
    const nextSlot = ctx.plans[ob.voice].slots[ob.slot + 1];
    if (!nextSlot || Math.abs(nextSlot.onset - ob.end) > EPS) continue;
    const down = Math.sign(next - ob.pitch) < 0;
    const step = Math.abs(next - ob.pitch) <= 2;
    if (ctx.rules.suspensionResolveDown && !(down && step)) {
      out.push(
        makeViolation(
          ctx,
          'suspensionResolveDown',
          '延留音下行解决',
          'error',
          nextSlot.onset,
          [ob.voice],
          `${ob.voice} 的延留音 ${midiToName(ob.pitch)}（${fmtTime(ob.onset)}）应下行级进解决，却进行到 ${midiToName(next)}。`,
          `延留音在 ${fmtTime(ob.struckBy.time)} 被 ${ob.struckBy.voice} 的 ${midiToName(ob.struckBy.pitch)} 撞成不协和。`,
          [
            { voice: ob.voice, index: ob.slot },
            { voice: ob.struckBy.voice, index: ob.struckBy.slot },
            { voice: ob.voice, index: ob.slot + 1 },
          ],
          {
            kind: 'prepared-suspension',
            explanation: `${ob.voice} 的 ${midiToName(ob.pitch)} 是延留音，但解决音 ${midiToName(next)} 不满足下行 ≤2 半音。`,
            evidence: [],
          },
        ),
      );
    }
  }
  return out;
}

export interface HistoryBoundary {
  /** 事件边界处保留的纵向音程，供下一事件判断平行/直接。 */
  pairs: PairSnapshot[];
  /** 仍开放的延留义务。 */
  obligations: SuspensionObligation[];
  time: number;
}

/**
 * 在事件边界构建“历史”。carry 保留全部仍有意义的开放义务与最后音程；
 * truncate 只保留上一个事件内的音程（跨小节义务被丢弃），用于比较解集。
 */
export function historyAt(
  ctx: AnalysisContext,
  a: Assignment,
  time: number,
  policy: HistoryPolicy,
  obligations: SuspensionObligation[],
): HistoryBoundary {
  const obligationsLeft =
    policy === 'carry'
      ? obligations.filter((o) => o.end > time - EPS)
      : obligations.filter((o) => o.end > time - EPS && o.struckBy.time >= time - ctx.beatsPerMeasure - EPS);
  const lookback = policy === 'carry' ? time : Math.max(0, time - ctx.beatsPerMeasure);
  const slices = slicesBetween(ctx, a, lookback, time);
  let last: PairSnapshot[] = [];
  for (const sl of slices) {
    if (sl.pairs.length > 0) last = sl.pairs;
  }
  return { pairs: last.map((p) => ({ ...p })), obligations: obligationsLeft, time };
}

export function historySummary(h: HistoryBoundary | null): string {
  if (!h) return '无历史（搜索起点）';
  const pairs = h.pairs
    .map((p) => `${p.lower}/${p.upper}: ${midiToName(p.lowerPitch)}-${midiToName(p.upperPitch)}`)
    .join('；');
  return `${fmtTime(h.time)}：${pairs || '无纵向音程'}；开放延留义务 ${h.obligations.length} 个`;
}

export function assignmentToNotes(
  ctx: AnalysisContext,
  a: Assignment,
  voice: VoiceId,
  name: string,
): Note[] {
  const plan = ctx.plans[voice];
  const out: Note[] = [];
  for (let i = 0; i < plan.slots.length; i++) {
    const p = a.pitch.get(noteKey(voice, i));
    if (p === undefined) continue;
    out.push({
      onset: plan.slots[i].onset,
      duration: plan.slots[i].duration,
      pitch: p,
    });
  }
  return out;
}

export function beatRank(s: 'strong' | 'medium' | 'weak'): number {
  return beatStrengthRank(s);
}

export function samePitchClass(a: number, b: number): boolean {
  return ((a - b) % 12 + 12) % 12 === 0;
}

export function intervalIsDissonant(a: number, b: number, fourthConsonant: boolean): boolean {
  return intervalInfo(a, b, fourthConsonant).quality === 'dissonant';
}
