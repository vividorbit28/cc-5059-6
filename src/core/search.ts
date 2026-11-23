import { midiToName, scalePitchesInRange, isPerfectInterval, intervalInfo, isInScale } from './pitch.js';
import type { Note, VoiceId } from './score.js';
import {
  analyzeAssignment,
  assignmentToNotes,
  checkSlot,
  classifyDissonance,
  effectiveContext,
  emptyAssignment,
  intervalIsDissonant,
  slicesBetween,
  strengthOf,
  type AnalysisContext,
  type Assignment,
  type DissonanceKind,
  type RuleKey,
  type SuspensionObligation,
  type Violation,
  historyAt,
  suspensionObligations,
  checkSuspensionResolutions,
  type HistoryBoundary,
} from './analyze.js';
import {
  buildSearchPlans,
  EPS,
  feq,
  noteKey,
  quant,
  type VoicePlan,
} from './plan.js';
import type { CounterpointRules, HistoryPolicy, RhythmSpec, VoiceRangeConfig } from './rules.js';

export interface SearchInput {
  key: AnalysisContext['key'];
  beatsPerMeasure: number;
  rules: CounterpointRules;
  historyPolicy: HistoryPolicy;
  cfNotes: Note[];
  u1: VoiceRangeConfig;
  u2: VoiceRangeConfig;
  rhythmU1: RhythmSpec;
  rhythmU2: RhythmSpec;
  maxSolutions?: number;
  maxNodes?: number;
  timeBudgetMs?: number;
}

export interface PruneEvent {
  voice: VoiceId;
  slot: number;
  onset: number;
  pitch: number;
  rule: RuleKey | 'obligation' | 'duplicate' | 'domain';
  message: string;
  detail: string;
  time: number;
}

export interface SearchStats {
  nodes: number;
  candidatesTested: number;
  pruned: Partial<Record<string, number>>;
  solutionsFound: number;
  elapsedMs: number;
  truncated: boolean;
  stopReason: 'solutions' | 'nodes' | 'time' | 'exhausted';
  maxDepth: number;
  traces: PruneEvent[];
  distinctSignatures: number;
}

export interface SolutionUnresolved {
  voice: VoiceId;
  slot: number;
  pitch: number;
  reason: string;
}

export interface SearchSolution {
  id: string;
  signature: string;
  u1: Note[];
  u2: Note[];
  assignment: Assignment;
  violations: Violation[];
  score: number;
  suspensionCount: number;
  passingCount: number;
  neighborCount: number;
  history: HistoryBoundary | null;
  /** 每个搜索事件边界上携带的历史，用于界面展示“带入下一步的判决”。 */
  historyTrail: HistoryBoundary[];
  obligationsCrossingBars: SuspensionObligation[];
  dissonanceKinds: DissonanceKind[];
}

export interface SearchResult {
  ok: boolean;
  T: number;
  plans: Record<'cf' | 'u1' | 'u2', VoicePlan>;
  /** 本次搜索实际使用的定旋律与规则，供“同一份乐谱切换历史策略复核”使用。 */
  cfNotes: Note[];
  rules: CounterpointRules;
  solutions: SearchSolution[];
  stats: SearchStats;
  message: string;
}

export function makeContext(
  plans: Record<'cf' | 'u1' | 'u2', VoicePlan>,
  T: number,
  input: Pick<SearchInput, 'key' | 'beatsPerMeasure' | 'rules' | 'historyPolicy'>,
  complete = false,
): AnalysisContext {
  return {
    plans,
    points: [],
    key: input.key,
    beatsPerMeasure: input.beatsPerMeasure,
    rules: input.rules,
    historyPolicy: input.historyPolicy,
    historyFloor: 0,
    complete,
    T,
  };
}

function domainOf(
  plan: VoicePlan,
  rules: CounterpointRules,
  key: AnalysisContext['key'],
): number[] {
  if (rules.diatonicOnly) return scalePitchesInRange(plan.low, plan.high, key);
  const out: number[] = [];
  for (let p = plan.low; p <= plan.high; p++) out.push(p);
  return out;
}

/** 候选排序：优先级进、优先与定旋律协和，保证前几个解具有可听性。 */
function candidateCost(
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
  // 与定旋律的开放音程偏好
  const cf = a.pitch.get(noteKey('cf', activeSlot(ctx, a, 'cf', s.onset)));
  if (cf !== undefined) {
    const info = intervalInfo(cf, pitch, ctx.rules.fourthConsonant);
    if (info.quality === 'imperfect') cost -= 2;
    if (info.quality === 'perfect') cost -= 1;
    if (info.quality === 'dissonant') cost += 6;
  }
  return cost;
}

function activeSlot(
  ctx: AnalysisContext,
  a: Assignment,
  voice: VoiceId,
  time: number,
): number {
  const slots = ctx.plans[voice].slots;
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    if (s.onset <= time + EPS && s.end > time + EPS && a.pitch.has(noteKey(voice, i))) return i;
  }
  return 0;
}

interface Task {
  voice: VoiceId;
  slot: number;
}

function buildTasks(plans: Record<'cf' | 'u1' | 'u2', VoicePlan>): Task[] {
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

interface DfsState {
  assignment: Assignment;
  obligations: SuspensionObligation[];
  historyTrail: HistoryBoundary[];
}

/**
 * 在事件边界推进历史。carry 保留跨小节开放义务与最后音程；
 * truncate 在小节线丢弃此前义务，只保留本小节内的音程。
 */
function advanceHistory(
  ctx: AnalysisContext,
  a: Assignment,
  state: DfsState,
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
  let pairs = slices.flatMap((s) => s.pairs).slice(-4);
  const h: HistoryBoundary = { pairs, obligations: kept.map((o) => ({ ...o })), time };
  return h;
}

export function search(input: SearchInput): SearchResult {
  const started = Date.now();
  const maxSolutions = input.maxSolutions ?? 12;
  const maxNodes = input.maxNodes ?? 120000;
  const timeBudget = input.timeBudgetMs ?? 2500;
  const { plans, T } = buildSearchPlans(input.cfNotes, input.u1, input.u2, input.rhythmU1, input.rhythmU2);
  const ctx = makeContext(plans, T, input, false);

  if (T <= EPS) {
    return {
      ok: false,
      T,
      plans,
      cfNotes: input.cfNotes,
      rules: input.rules,
      solutions: [],
      stats: emptyStats(),
      message: '定旋律为空或时值为零，无法搜索。',
    };
  }

  const cfAssignment = emptyAssignment();
  const cfPlan = plans.cf;
  for (let i = 0; i < cfPlan.slots.length; i++) {
    const n = [...input.cfNotes].sort((x, y) => x.onset - y.onset)[i];
    if (!n) continue;
    cfAssignment.pitch.set(noteKey('cf', i), n.pitch);
  }

  // 定旋律本身也先做一次横向检查（音域/调内），不可行则直接返回。
  const cfProblems: Violation[] = [];
  for (let i = 0; i < cfPlan.slots.length; i++) {
    const p = cfAssignment.pitch.get(noteKey('cf', i));
    if (p === undefined) continue;
    for (const v of checkSlot(ctx, cfAssignment, 'cf', i, p)) {
      if (v.rule === 'range' || v.rule === 'diatonicOnly') cfProblems.push(v);
    }
  }

  const tasks = buildTasks(plans);
  const domains: Record<VoiceId, number[]> = {
    cf: [],
    u1: domainOf(plans.u1, input.rules, input.key),
    u2: domainOf(plans.u2, input.rules, input.key),
  };

  const stats = emptyStats();
  const solutions: SearchSolution[] = [];
  const seen = new Set<string>();
  const deadline = started + timeBudget;

  const state: DfsState = {
    assignment: cfAssignment,
    obligations: [],
    historyTrail: [],
  };

  let stop: SearchStats['stopReason'] = 'exhausted';

  function finalize(): void {
    const finalCtx: AnalysisContext = { ...ctx, complete: true };
    const violations = analyzeAssignment(finalCtx, state.assignment);
    // 延留解决在搜索中是“义务驱动”的，这里用最终乐谱再核对一次，
    // 确保“搜索通过 == 界面诊断通过”，而不是两套标准。
    const obligations = suspensionObligations(finalCtx, state.assignment, finalCtx.T);
    violations.push(...checkSuspensionResolutions(finalCtx, state.assignment, obligations));
    const blocking = violations.filter((v) => v.severity === 'error');
    if (blocking.length > 0) {
      stats.pruned[blocking[0].rule] = (stats.pruned[blocking[0].rule] ?? 0) + 1;
      recordTrace(blocking[0], 'final');
      return;
    }
    const sig = signatureOf(plans, state.assignment);
    if (seen.has(sig)) {
      stats.pruned.duplicate = (stats.pruned.duplicate ?? 0) + 1;
      return;
    }
    seen.add(sig);
    const u1 = assignmentToNotes(finalCtx, state.assignment, 'u1', plans.u1.name);
    const u2 = assignmentToNotes(finalCtx, state.assignment, 'u2', plans.u2.name);
    const u1Score = melodyScore(u1);
    const u2Score = melodyScore(u2);
    const kinds = new Set<DissonanceKind>();
    let suspensions = 0;
    let passing = 0;
    let neighbor = 0;
    // 统计完整对位中的不协和分类，而不是只看“违规”。协和的经过/辅助音
    // 本就不会产生 Violation，所以必须显式扫描所有重叠片段。
    for (const slice of slicesBetween(finalCtx, state.assignment, 0, finalCtx.T)) {
      for (const pair of slice.pairs) {
        if (pair.quality !== 'dissonant') continue;
        const dc = classifyDissonance(finalCtx, state.assignment, pair, slice);
        kinds.add(dc.kind);
        if (dc.kind === 'suspension' || dc.kind === 'prepared-suspension') suspensions++;
        if (dc.kind === 'passing') passing++;
        if (dc.kind === 'neighbor') neighbor++;
      }
    }
    const obligationsCrossing = state.historyTrail.flatMap((h) =>
      h.obligations.filter(
        (o) => o.onset < Math.floor((o.struckBy.time + EPS) / input.beatsPerMeasure) * input.beatsPerMeasure,
      ),
    );
    solutions.push({
      id: `sol-${solutions.length + 1}`,
      signature: sig,
      u1,
      u2,
      assignment: { pitch: new Map(state.assignment.pitch) },
      violations,
      score: u1Score + u2Score,
      suspensionCount: suspensions,
      passingCount: passing,
      neighborCount: neighbor,
      history: state.historyTrail[state.historyTrail.length - 1] ?? null,
      historyTrail: state.historyTrail.map((h) => ({
        ...h,
        pairs: h.pairs.map((p) => ({ ...p })),
        obligations: h.obligations.map((o) => ({ ...o })),
      })),
      obligationsCrossingBars: obligationsCrossing,
      dissonanceKinds: [...kinds],
    });
    stats.solutionsFound = solutions.length;
    stats.distinctSignatures = solutions.length;
  }

  function recordTrace(v: Violation, phase: 'search' | 'final'): void {
    if (stats.traces.length >= 80) return;
    stats.traces.push({
      voice: (v.voices[0] ?? 'u1') as VoiceId,
      slot: v.notes[0]?.index ?? 0,
      onset: v.time,
      pitch: 0,
      rule: v.rule,
      message: v.message,
      detail: `${phase === 'final' ? '完整校验' : '搜索剪枝'}：${v.detail}`,
      time: v.time,
    });
  }

  function dfs(index: number): void {
    if (solutions.length >= maxSolutions) {
      stop = 'solutions';
      return;
    }
    if (stats.nodes >= maxNodes) {
      stop = 'nodes';
      return;
    }
    if ((stats.nodes & 255) === 0 && Date.now() > deadline) {
      stop = 'time';
      return;
    }
    if (index >= tasks.length) {
      finalize();
      return;
    }
    const task = tasks[index];
    const plan = plans[task.voice];
    const slot = task.slot;
    const s = plan.slots[slot];
    const prevPitch = slot > 0 ? state.assignment.pitch.get(noteKey(task.voice, slot - 1)) : undefined;
    stats.maxDepth = Math.max(stats.maxDepth, index);

    let domain = domains[task.voice];
    if (stats.nodes === 0) {
      // 首次进入时计算，后续复用。
    }
    // 起止硬过滤（只影响候选集，判定仍由 checkSlot 完成）
    if (slot === 0 && input.rules.startPerfect) {
      const cfP = state.assignment.pitch.get(noteKey('cf', activeSlot(ctx, state.assignment, 'cf', s.onset)));
      if (cfP !== undefined) {
        const base = domain;
        domain = base.filter((p) => isPerfectInterval(p, cfP, input.rules.fourthConsonant));
        if (domain.length === 0) domain = base;
      }
    }
    if (slot === plan.slots.length - 1 && input.rules.endOnTonic) {
      const tonic = ((input.key.tonicPc % 12) + 12) % 12;
      const restricted = domain.filter((p) => ((p % 12) + 12) % 12 === tonic);
      if (restricted.length > 0) domain = restricted;
    }

    const ordered = domain
      .map((p) => ({ p, cost: candidateCost(ctx, state.assignment, task.voice, slot, p, prevPitch) }))
      .sort((x, y) => x.cost - y.cost || x.p - y.p);

    for (const { p } of ordered) {
      if (solutions.length >= maxSolutions) {
        stop = 'solutions';
        return;
      }
      stats.nodes++;
      stats.candidatesTested++;
      if (stats.nodes >= maxNodes) {
        stop = 'nodes';
        return;
      }

      const assigned = new Map(state.assignment.pitch);
      assigned.set(noteKey(task.voice, slot), p);
      const trial: Assignment = { pitch: assigned };
      const trialCtx = { ...ctx, complete: false };
      const violations = checkSlot(trialCtx, trial, task.voice, slot, p);
      const errors = violations.filter((v) => v.severity === 'error');
      if (errors.length > 0) {
        for (const v of errors) {
          stats.pruned[v.rule] = (stats.pruned[v.rule] ?? 0) + 1;
          recordTrace(v, 'search');
        }
        continue;
      }

      // 延留义务：本音必须解决此前的悬挂；同时检测本音造成的新的撞击。
      const obErrors = obligationErrors(ctx, trial, task.voice, slot, p, input.historyPolicy);
      if (obErrors.length > 0) {
        for (const v of obErrors) {
          stats.pruned.obligation = (stats.pruned.obligation ?? 0) + 1;
          recordTrace(v, 'search');
        }
        continue;
      }
      const newObligations = detectStrikes(ctx, trial, task.voice, slot, p, input.historyPolicy);
      // 悬挂若在曲末仍未解决，则不可行。
      if (newObligations.some((o) => o.end >= ctx.T - EPS)) {
        stats.pruned.suspensionResolveDown =
          (stats.pruned.suspensionResolveDown ?? 0) + 1;
        stats.traces.length < 80 &&
          stats.traces.push({
            voice: task.voice,
            slot,
            onset: s.onset,
            pitch: p,
            rule: 'suspensionResolveDown',
            message: `${task.voice} 在 ${midiToName(p)} 造成延留，但没有后续解决位置。`,
            detail: '搜索剪枝：延留音必须在本地结束时下行级进解决。',
            time: s.onset,
          });
        continue;
      }

      // 推进历史（跨小节时刻）
      const prevTrail = state.historyTrail;
      const prevObs = state.obligations;
      const trialState: DfsState = {
        assignment: trial,
        obligations: [...prevObs, ...newObligations],
        historyTrail: prevTrail,
      };
      const boundaryTime = s.end;
      const isBoundary = isEventBoundary(ctx, boundaryTime, tasks, index);
      if (isBoundary) {
        const h = advanceHistory(ctx, trial, trialState, boundaryTime, input.historyPolicy);
        trialState.historyTrail = [...prevTrail, h];
      }

      const saved = state.assignment;
      const savedObs = state.obligations;
      const savedTrail = state.historyTrail;
      state.assignment = trialState.assignment;
      state.obligations = trialState.obligations;
      state.historyTrail = trialState.historyTrail;
      dfs(index + 1);
      state.assignment = saved;
      state.obligations = savedObs;
      state.historyTrail = savedTrail;

      if (stop === 'solutions' || stop === 'nodes' || stop === 'time') {
        if (solutions.length >= maxSolutions) stop = 'solutions';
        if (stats.nodes >= maxNodes) stop = 'nodes';
        return;
      }
    }
  }

  dfs(0);

  function readStop(): SearchStats['stopReason'] {
    return stop;
  }
  const finalStop = readStop();
  stats.elapsedMs = Date.now() - started;
  stats.truncated = finalStop === 'nodes' || finalStop === 'time';
  stats.stopReason = finalStop;

  // 多样的展示子集：优先保证前段旋律差异。
  const diverse = pickDiverse(solutions, Math.min(solutions.length, maxSolutions));
  const ordered = diverse;

  let message: string;
  if (solutions.length === 0) {
    message = cfProblems.length
      ? `定旋律本身不可行：${cfProblems[0].message}`
      : finalStop === 'nodes' || finalStop === 'time'
        ? `在 ${stats.elapsedMs}ms / ${stats.nodes} 个节点内没有找到解（搜索被截断，不代表无解）。`
        : `穷尽 ${stats.nodes} 个节点后无解：现有规则组合对这段定旋律与节奏过强或互相矛盾。`;
  } else if (finalStop === 'solutions') {
    message = `找到 ${solutions.length} 条不同解（达到展示上限后停止，仍有未探索分支）。`;
  } else {
    message = `穷尽搜索后找到 ${solutions.length} 条不同解。`;
  }

  return {
    ok: solutions.length > 0,
    T,
    plans,
    cfNotes: input.cfNotes,
    rules: input.rules,
    solutions: ordered,
    stats,
    message,
  };
}

function emptyStats(): SearchStats {
  return {
    nodes: 0,
    candidatesTested: 0,
    pruned: {},
    solutionsFound: 0,
    elapsedMs: 0,
    truncated: false,
    stopReason: 'exhausted',
    maxDepth: 0,
    traces: [],
    distinctSignatures: 0,
  };
}

function isEventBoundary(
  ctx: AnalysisContext,
  time: number,
  tasks: Task[],
  index: number,
): boolean {
  if (index + 1 >= tasks.length) return false; // 曲末不是“下一步”，无需携带历史
  const next = tasks[index + 1];
  const nextOnset = ctx.plans[next.voice].slots[next.slot].onset;
  return nextOnset > time + EPS;
}

function signatureOf(
  plans: Record<'cf' | 'u1' | 'u2', VoicePlan>,
  a: Assignment,
): string {
  const parts: string[] = [];
  for (const v of ['u1', 'u2'] as VoiceId[]) {
    for (let i = 0; i < plans[v].slots.length; i++) {
      parts.push(`${a.pitch.get(noteKey(v, i)) ?? 'x'}`);
    }
    parts.push('/');
  }
  return parts.join(',');
}

function melodyScore(notes: Note[]): number {
  let score = 0;
  for (let i = 1; i < notes.length; i++) {
    const d = Math.abs(notes[i].pitch - notes[i - 1].pitch);
    if (d === 0) score += 6;
    else if (d <= 2) score += 0;
    else if (d <= 4) score += d;
    else score += d * 2;
  }
  return score;
}

/**
 * 延留义务：若本音在某个持续音上造成新的不协和，且该持续音此前
 * 与移动声部协和（有准备），则为持续音建立“必须下行级进解决”的义务。
 * 仅对 u1/u2 的上方持续音建立，范围明确。
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

/**
 * 判断某声部的某个已给音在其时值内是否被其他声部撞成不协和。
 * 用于搜索中检查上一个音是否成了延留音。
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

function pickDiverse(solutions: SearchSolution[], k: number): SearchSolution[] {
  if (solutions.length <= k) return solutions;
  const picked: SearchSolution[] = [solutions[0]];
  const remaining = solutions.slice(1);
  while (picked.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = -1;
    for (let i = 0; i < remaining.length; i++) {
      let dist = 0;
      for (const p of picked) {
        dist += hamming(remaining[i].signature, p.signature);
      }
      if (dist > bestDist) {
        bestDist = dist;
        bestIdx = i;
      }
    }
    picked.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return picked;
}

function hamming(a: string, b: string): number {
  const x = a.split(',');
  const y = b.split(',');
  let n = 0;
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) n++;
  return n;
}

export interface HistoryComparison {
  carry: SearchResult;
  truncate: SearchResult;
  onlyInCarry: SearchSolution[];
  onlyInTruncate: SearchSolution[];
  sharedCount: number;
  summary: string;
}

/** 比较“保留跨小节历史/悬挂义务”与“截短到当前小节”的解集。 */
export async function compareHistoryPolicies(
  input: Omit<SearchInput, 'historyPolicy'>,
): Promise<HistoryComparison> {
  const carry = search({ ...input, historyPolicy: 'carry' });
  const truncate = search({ ...input, historyPolicy: 'truncate' });
  return compareResults(carry, truncate);
}

export function compareResults(carry: SearchResult, truncate: SearchResult): HistoryComparison {
  const carrySigs = new Set(carry.solutions.map((s) => s.signature));
  const truncSigs = new Set(truncate.solutions.map((s) => s.signature));
  const onlyInCarry = carry.solutions.filter((s) => !truncSigs.has(s.signature));
  const onlyInTruncate = truncate.solutions.filter((s) => !carrySigs.has(s.signature));
  const shared = carry.solutions.filter((s) => truncSigs.has(s.signature)).length;
  const summary =
    `保留悬挂义务：${carry.solutions.length} 条解（${carry.stats.nodes} 节点，剪枝 ${sumPruned(carry.stats)} 次）；` +
    `截短到本小节：${truncate.solutions.length} 条解（${truncate.stats.nodes} 节点，剪枝 ${sumPruned(truncate.stats)} 次）；` +
    `共有 ${shared} 条，仅保留历史可得 ${onlyInCarry.length} 条，仅截短历史可得 ${onlyInTruncate.length} 条。`;
  return { carry, truncate, onlyInCarry, onlyInTruncate, sharedCount: shared, summary };
}

export function sumPruned(stats: SearchStats): number {
  return Object.values(stats.pruned).reduce<number>((a, b) => a + (b ?? 0), 0);
}

export function violationSummary(violations: Violation[]): string {
  if (violations.length === 0) return '未发现规则违反。';
  const byRule = new Map<string, number>();
  for (const v of violations) byRule.set(v.ruleLabel, (byRule.get(v.ruleLabel) ?? 0) + 1);
  return [...byRule].map(([label, n]) => `${label} ×${n}`).join('；');
}

export function statsTable(stats: SearchStats): { rule: string; count: number }[] {
  return Object.entries(stats.pruned)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([rule, n]) => ({ rule, count: n! }))
    .sort((a, b) => b.count - a.count);
}

export function isValidPitchForVoice(
  pitch: number,
  low: number,
  high: number,
  key: AnalysisContext['key'],
  diatonicOnly: boolean,
): boolean {
  if (pitch < low || pitch > high) return false;
  return diatonicOnly ? isInScale(pitch, key) : true;
}
