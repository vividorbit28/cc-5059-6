import { midiToName } from './pitch.js';
import type { Note, Score, VoiceId } from './score.js';
import { buildPlansFromVoices, noteKey, EPS } from './plan.js';
import {
  emptyAssignment,
  suspensionObligations,
  type AnalysisContext,
  type SuspensionObligation,
} from './analyze.js';
import type { CounterpointRules } from './rules.js';

/**
 * 排练器：把已经写好的乐谱派给具体歌手，负责
 *  - 换气：连续演唱超过容量或出现休止时就近换气；
 *  - 换人：小节线/容量/音域需要时由另一位歌手接替；
 *  - 分谱：每位歌手实际唱到的音与换气点；
 *  - 悬挂核对：延留音的解决音由哪位歌手完成，是否可唱。
 *
 * 关键约束（跨小节反向否决）：若在小节线前把承担解决音的声部换了人，
 * 下一小节新歌手的可唱音域可能容纳不了上小节延留音的解决音；
 * 此时下一小节的音域要反过来否决上小节产生的候选。`crossBarVetoes`
 * 输出这种否决，搜索可以在整条分配层面据此拒绝候选。
 */

export interface Singer {
  id: string;
  name: string;
  low: number;
  high: number;
  /** 连续可唱容量（拍）。超过后必须换气或换人。 */
  capacity: number;
}

export interface VoiceRoster {
  singers: Singer[];
  /** 两音之间至少留出多少拍才算可换气。 */
  breathGap: number;
}

export interface ForcedSwap {
  voice: VoiceId;
  /** 换人发生的时刻（通常为小节线）。 */
  time: number;
  singerId: string;
  reason?: string;
}

export interface RehearsalConfig {
  beatsPerMeasure: number;
  rosters: Record<VoiceId, VoiceRoster>;
  forcedSwaps?: ForcedSwap[];
}

export interface SingerNote {
  voice: VoiceId;
  index: number;
  onset: number;
  duration: number;
  pitch: number;
  measure: number;
  beat: number;
  singerId: string;
}

export interface BreathPoint {
  voice: VoiceId;
  singerId: string;
  /** 换气区间 [from, to)。 */
  from: number;
  to: number;
}

export interface SingerSwap {
  voice: VoiceId;
  time: number;
  from: string;
  to: string;
  reason: 'breath' | 'capacity' | 'range' | 'forced';
}

export type RehearsalAnomalyKind =
  | 'unsingable'
  | 'no-breath-opportunity'
  | 'suspension-resolve-voice-swap'
  | 'suspension-unresolved'
  | 'missing-singer';

export interface RehearsalAnomaly {
  kind: RehearsalAnomalyKind;
  voice: VoiceId;
  time: number;
  message: string;
  /** 关联的悬挂义务（若与延留解决有关）。 */
  obligation?: { voice: VoiceId; slot: number; pitch: number; resolveSlot: number };
}

export interface SuspensionSingerCheck {
  voice: VoiceId;
  slot: number;
  pitch: number;
  /** 完成（解决）该延留音的歌手。 */
  resolvedBy: string | null;
  heldBy: string | null;
  resolutionPitch: number | null;
  /** 解决音是否落在解决歌手的可唱音域内。 */
  singable: boolean;
  /** 小节线前后是否发生了换人。 */
  swappedAcrossBar: boolean;
}

export interface CrossBarVeto {
  rule: 'rehearsalRange';
  voice: VoiceId;
  /** 上小节承载延留音的槽位（被否决的候选所属）。 */
  upstreamSlot: number;
  upstreamOnset: number;
  /** 下一小节解决音的槽位/时刻与不可唱的音高。 */
  resolveSlot: number;
  resolveTime: number;
  pitch: number;
  singerId: string;
  message: string;
}

export interface RehearsalPlan {
  config: RehearsalConfig;
  notes: SingerNote[];
  breaths: BreathPoint[];
  swaps: SingerSwap[];
  suspensions: SuspensionSingerCheck[];
  anomalies: RehearsalAnomaly[];
  vetoes: CrossBarVeto[];
  /** 声部 -> 下标 -> 歌手 id，便于按槽位查询。 */
  singerOf: Record<VoiceId, Map<number, string>>;
}

function singerCovers(s: Singer, pitch: number): boolean {
  return pitch >= s.low && pitch <= s.high;
}

function measureOf(t: number, bpm: number): number {
  return Math.floor((t + 1e-9) / bpm);
}

function pickCovering(
  singers: Singer[],
  pitch: number,
  exclude?: string,
): Singer | undefined {
  return singers.find((s) => s.id !== exclude && singerCovers(s, pitch));
}

function forcedSingerAt(
  forced: ForcedSwap[] | undefined,
  voice: VoiceId,
  time: number,
): ForcedSwap | undefined {
  return forced?.find((f) => f.voice === voice && Math.abs(f.time - time) < EPS);
}

function assignVoice(
  voice: VoiceId,
  notes: Note[],
  roster: VoiceRoster,
  bpm: number,
  forced: ForcedSwap[] | undefined,
  anomalies: RehearsalAnomaly[],
): {
  singerNotes: SingerNote[];
  breaths: BreathPoint[];
  swaps: SingerSwap[];
  singerOf: Map<number, string>;
} {
  const singerNotes: SingerNote[] = [];
  const breaths: BreathPoint[] = [];
  const swaps: SingerSwap[] = [];
  const singerOf = new Map<number, string>();
  const singers = roster.singers;
  if (singers.length === 0) {
    anomalies.push({
      kind: 'missing-singer',
      voice,
      time: notes[0]?.onset ?? 0,
      message: `${voice} 没有分配任何歌手，无法排练。`,
    });
    return { singerNotes, breaths, swaps, singerOf };
  }

  const sorted = [...notes].sort((a, b) => a.onset - b.onset);
  let current: Singer = singers[0];
  let continuousSince = sorted[0]?.onset ?? 0;
  let lastEnd = -Infinity;

  for (let i = 0; i < sorted.length; i++) {
    const n = sorted[i];
    const gap = n.onset - lastEnd;
    const breathable = lastEnd > -Infinity && gap >= roster.breathGap - EPS;
    const forcedHere = forcedSingerAt(forced, voice, n.onset);

    let nextSinger = current;
    let reason: SingerSwap['reason'] | null = null;

    if (forcedHere) {
      const s = singers.find((x) => x.id === forcedHere.singerId);
      if (s) {
        nextSinger = s;
        reason = 'forced';
      }
    } else if (breathable) {
      // 可换气：保持当前歌手，记录换气点。
      if (lastEnd > -Infinity) {
        breaths.push({ voice, singerId: current.id, from: lastEnd, to: n.onset });
      }
      continuousSince = n.onset;
    }

    // 容量检查：无换气机会且连续演唱超出容量时换人。
    if (!reason && !breathable && n.onset + n.duration - continuousSince > current.capacity + EPS) {
      const alt = pickCovering(singers, n.pitch, current.id) ?? singers.find((s) => s.id !== current.id);
      if (alt) {
        nextSinger = alt;
        reason = 'capacity';
      } else {
        anomalies.push({
          kind: 'no-breath-opportunity',
          voice,
          time: n.onset,
          message: `${voice} 在 ${midiToName(n.pitch)} 连续演唱超过 ${current.capacity} 拍且无换气/换人机会。`,
        });
      }
    }

    // 音域检查：当前/被迫歌手唱不了时尝试换到能唱的歌手。
    if (!reason && !singerCovers(nextSinger, n.pitch)) {
      const alt = pickCovering(singers, n.pitch, nextSinger.id);
      if (alt) {
        nextSinger = alt;
        reason = breathable ? 'range' : 'range';
      }
    }

    if (nextSinger.id !== current.id) {
      swaps.push({
        voice,
        time: n.onset,
        from: current.id,
        to: nextSinger.id,
        reason: reason ?? 'range',
      });
      current = nextSinger;
      continuousSince = n.onset;
    }

    if (!singerCovers(current, n.pitch)) {
      anomalies.push({
        kind: 'unsingable',
        voice,
        time: n.onset,
        message: `${voice} 的 ${midiToName(n.pitch)}（第 ${measureOf(n.onset, bpm) + 1} 小节）超出歌手 ${current.name} 的音域 ${midiToName(current.low)}–${midiToName(current.high)}。`,
      });
    }

    singerNotes.push({
      voice,
      index: i,
      onset: n.onset,
      duration: n.duration,
      pitch: n.pitch,
      measure: measureOf(n.onset, bpm),
      beat: ((n.onset % bpm) + bpm) % bpm,
      singerId: current.id,
    });
    singerOf.set(i, current.id);
    lastEnd = n.onset + n.duration;
  }

  return { singerNotes, breaths, swaps, singerOf };
}

function contextForScore(
  score: Score,
  rules?: CounterpointRules,
): { ctx: AnalysisContext; assignment: ReturnType<typeof emptyAssignment> } {
  const { plans, T } = buildPlansFromVoices({
    cf: score.voices.cf,
    u1: score.voices.u1,
    u2: score.voices.u2,
  });
  const assignment = emptyAssignment();
  for (const id of ['cf', 'u1', 'u2'] as VoiceId[]) {
    const notes = [...score.voices[id].notes].sort((a, b) => a.onset - b.onset);
    for (let i = 0; i < plans[id].slots.length && i < notes.length; i++) {
      assignment.pitch.set(noteKey(id, i), notes[i].pitch);
    }
  }
  const ctx: AnalysisContext = {
    plans,
    points: [],
    key: score.key,
    beatsPerMeasure: score.beatsPerMeasure,
    rules: rules ?? {
      fourthConsonant: false,
      strongBeatConsonance: true,
      allowPassingTones: true,
      allowNeighborTones: true,
      allowSuspensions: true,
      suspensionResolveDown: true,
      forbidParallelPerfects: true,
      forbidDirectPerfects: false,
      forbidVoiceCrossing: true,
      maxLeap: 12,
      forbidTritoneLeap: true,
      requireLeapRecovery: true,
      forbidRepeatedNotes: true,
      diatonicOnly: true,
      startPerfect: false,
      endOnTonic: false,
      endPerfect: false,
    },
    historyPolicy: 'carry',
    historyFloor: 0,
    complete: true,
    T,
  };
  return { ctx, assignment };
}

function checkSuspensionSingers(
  score: Score,
  bpm: number,
  singerOf: Record<VoiceId, Map<number, string>>,
  allSingers: Record<VoiceId, Singer[]>,
  obligations: SuspensionObligation[],
  anomalies: RehearsalAnomaly[],
): { checks: SuspensionSingerCheck[]; vetoes: CrossBarVeto[] } {
  const checks: SuspensionSingerCheck[] = [];
  const vetoes: CrossBarVeto[] = [];
  for (const ob of obligations) {
    if (ob.voice === 'cf') continue;
    const notes = [...score.voices[ob.voice].notes].sort((a, b) => a.onset - b.onset);
    const heldSinger = singerOf[ob.voice].get(ob.slot) ?? null;
    const resolveSlot = ob.slot + 1;
    const resolution = notes[resolveSlot];
    const resolveSinger = singerOf[ob.voice].get(resolveSlot) ?? null;
    const resolutionPitch = resolution?.pitch ?? null;
    const singer = resolveSinger ? allSingers[ob.voice].find((s) => s.id === resolveSinger) : undefined;
    const singable = resolutionPitch !== null && singer ? singerCovers(singer, resolutionPitch) : false;
    const heldBar = measureOf(ob.onset, bpm);
    const resolveBar = resolution ? measureOf(resolution.onset, bpm) : heldBar;
    const swappedAcrossBar =
      heldSinger !== null && resolveSinger !== null && heldSinger !== resolveSinger && resolveBar > heldBar;
    checks.push({
      voice: ob.voice,
      slot: ob.slot,
      pitch: ob.pitch,
      heldBy: heldSinger,
      resolvedBy: resolveSinger,
      resolutionPitch,
      singable,
      swappedAcrossBar,
    });

    if (resolution && resolveSinger && !singable) {
      const message =
        `${ob.voice} 的延留音 ${midiToName(ob.pitch)} 应在第 ${resolveBar + 1} 小节解决为 ` +
        `${midiToName(resolution.pitch)}，但承担解决音的歌手 ${singer?.name ?? resolveSinger} 唱不到该音；` +
        `下一小节的可唱音域反过来否决上小节产生的候选。`;
      anomalies.push({
        kind: 'suspension-resolve-voice-swap',
        voice: ob.voice,
        time: resolution.onset,
        message,
        obligation: { voice: ob.voice, slot: ob.slot, pitch: ob.pitch, resolveSlot },
      });
      vetoes.push({
        rule: 'rehearsalRange',
        voice: ob.voice,
        upstreamSlot: ob.slot,
        upstreamOnset: ob.onset,
        resolveSlot,
        resolveTime: resolution.onset,
        pitch: resolution.pitch,
        singerId: resolveSinger,
        message,
      });
    }
    if (!resolution && resolveSinger === null) {
      anomalies.push({
        kind: 'suspension-unresolved',
        voice: ob.voice,
        time: ob.end,
        message: `${ob.voice} 的延留音 ${midiToName(ob.pitch)} 没有后续解决音，无法完成分谱。`,
        obligation: { voice: ob.voice, slot: ob.slot, pitch: ob.pitch, resolveSlot },
      });
    }
  }
  return { checks, vetoes };
}

export function planRehearsal(
  score: Score,
  config: RehearsalConfig,
  rules?: CounterpointRules,
): RehearsalPlan {
  const bpm = config.beatsPerMeasure || score.beatsPerMeasure;
  const anomalies: RehearsalAnomaly[] = [];
  const notes: SingerNote[] = [];
  const breaths: BreathPoint[] = [];
  const swaps: SingerSwap[] = [];
  const singerOf: Record<VoiceId, Map<number, string>> = {
    cf: new Map(),
    u1: new Map(),
    u2: new Map(),
  };
  for (const voice of ['cf', 'u1', 'u2'] as VoiceId[]) {
    const roster = config.rosters[voice];
    if (!roster) continue;
    const res = assignVoice(
      voice,
      score.voices[voice].notes,
      roster,
      bpm,
      config.forcedSwaps,
      anomalies,
    );
    notes.push(...res.singerNotes);
    breaths.push(...res.breaths);
    swaps.push(...res.swaps);
    singerOf[voice] = res.singerOf;
  }

  const { ctx, assignment } = contextForScore(score, rules);
  const obligations = suspensionObligations(ctx, assignment, ctx.T);
  const allSingers: Record<VoiceId, Singer[]> = {
    cf: config.rosters.cf?.singers ?? [],
    u1: config.rosters.u1?.singers ?? [],
    u2: config.rosters.u2?.singers ?? [],
  };
  const { checks, vetoes } = checkSuspensionSingers(
    score,
    bpm,
    singerOf,
    allSingers,
    obligations,
    anomalies,
  );

  return { config, notes, breaths, swaps, suspensions: checks, anomalies, vetoes, singerOf };
}

/** 供搜索在整条分配层面检查：跨小节换人是否导致解决音不可唱。 */
export function crossBarVetoes(
  score: Score,
  config: RehearsalConfig,
  rules?: CounterpointRules,
): CrossBarVeto[] {
  return planRehearsal(score, config, rules).vetoes;
}

/** 从搜索结果的三声部音符构造一个最小 Score，避免与 examples 形成循环依赖。 */
export function scoreForRehearsal(
  cf: Note[],
  u1: Note[],
  u2: Note[],
  opts: { key: Score['key']; beatsPerMeasure: number; tempo?: number; ranges: Record<VoiceId, { low: number; high: number; name: string }> },
): Score {
  const mk = (id: VoiceId, notes: Note[]) => ({
    id,
    name: opts.ranges[id].name,
    low: opts.ranges[id].low,
    high: opts.ranges[id].high,
    notes,
  });
  return {
    key: opts.key,
    beatsPerMeasure: opts.beatsPerMeasure,
    tempo: opts.tempo ?? 84,
    voices: {
      cf: mk('cf', cf),
      u1: mk('u1', u1),
      u2: mk('u2', u2),
    },
  };
}

/** 每个歌手的分谱文本：按小节列出音与换气点。 */
export function partScoreText(plan: RehearsalPlan, score: Score): string {
  const bpm = plan.config.beatsPerMeasure || score.beatsPerMeasure;
  const bySinger = new Map<string, SingerNote[]>();
  for (const n of plan.notes) {
    const arr = bySinger.get(n.singerId) ?? [];
    arr.push(n);
    bySinger.set(n.singerId, arr);
  }
  const lines: string[] = [];
  const voices: VoiceId[] = ['cf', 'u1', 'u2'];
  for (const voice of voices) {
    const roster = plan.config.rosters[voice];
    if (!roster) continue;
    for (const singer of roster.singers) {
      const notes = bySinger.get(singer.id);
      if (!notes || notes.length === 0) continue;
      lines.push(`== ${voice} · ${singer.name}（${singer.id}，音域 ${midiToName(singer.low)}–${midiToName(singer.high)}）==`);
      let lastMeasure = -1;
      for (const n of notes.sort((a, b) => a.onset - b.onset)) {
        if (n.measure !== lastMeasure) {
          lines.push(`  第 ${n.measure + 1} 小节`);
          lastMeasure = n.measure;
        }
        const breathsHere = plan.breaths.filter(
          (b) => b.voice === voice && b.singerId === singer.id && Math.abs(b.to - n.onset) < EPS,
        );
        const breathMark = breathsHere.length > 0 ? '  (换气 ∥)' : '';
        lines.push(`    第 ${(n.beat + 1).toFixed(2)} 拍  ${midiToName(n.pitch)}  时值 ${n.duration}${breathMark}`);
      }
      const mySwaps = plan.swaps.filter((s) => s.voice === voice && s.to === singer.id);
      if (mySwaps.length > 0) {
        lines.push(
          `  接替：${mySwaps
            .map((s) => `第 ${measureOf(s.time, bpm) + 1} 小节 ${s.time} 拍（${s.reason}）`)
            .join('；')}`,
        );
      }
      lines.push('');
    }
  }
  return lines.join('\n');
}

/** 延留音由哪位歌手完成：供界面/分谱核对。 */
export function suspensionCompletion(plan: RehearsalPlan): {
  voice: VoiceId;
  heldBy: string | null;
  resolvedBy: string | null;
  singable: boolean;
  swappedAcrossBar: boolean;
}[] {
  return plan.suspensions.map((s) => ({
    voice: s.voice,
    heldBy: s.heldBy,
    resolvedBy: s.resolvedBy,
    singable: s.singable,
    swappedAcrossBar: s.swappedAcrossBar,
  }));
}

/**
 * 按声部音域生成一份“默认合唱编制”：每个声部一位歌手，音域取该声部配置，
 * 容量足够长，使其只在真正需要时才换人。界面据此展示分谱与悬挂核对。
 */
export function defaultRosters(
  ranges: Record<VoiceId, { low: number; high: number; name: string }>,
  beatsPerMeasure: number,
): RehearsalConfig {
  const roster = (id: VoiceId): VoiceRoster => ({
    singers: [
      {
        id: `${id}-1`,
        name: ranges[id].name,
        low: ranges[id].low,
        high: ranges[id].high,
        capacity: beatsPerMeasure * 4,
      },
    ],
    breathGap: 0.5,
  });
  return {
    beatsPerMeasure,
    rosters: { cf: roster('cf'), u1: roster('u1'), u2: roster('u2') },
  };
}

/** 分谱异常按“对位声部/多轨试听”归并，供界面同时标出两类异常。 */
export function rehearsalAnomalyGroups(plan: RehearsalPlan): {
  voiceIssues: RehearsalAnomaly[];
  playbackIssues: RehearsalAnomaly[];
} {
  const voiceIssues = plan.anomalies.filter(
    (a) =>
      a.kind === 'unsingable' ||
      a.kind === 'suspension-resolve-voice-swap' ||
      a.kind === 'suspension-unresolved',
  );
  const playbackIssues = plan.anomalies.filter(
    (a) => a.kind === 'no-breath-opportunity' || a.kind === 'missing-singer',
  );
  return { voiceIssues, playbackIssues };
}
