import {
  analyzeAssignment,
  assignmentToNotes,
  emptyAssignment,
  explainedDissonances,
  historyAt,
  slicesBetween,
  strengthOf,
  suspensionObligations,
  checkSuspensionResolutions,
  type AnalysisContext,
  type Assignment,
  type DissonanceKind,
  type ExplainedDissonance,
  type HistoryBoundary,
  type Violation,
} from './analyze.js';
import { buildPlansFromVoices, buildSearchPlans, noteKey, parseMelody, type Slot } from './plan.js';
import {
  DEFAULT_RULES,
  DEFAULT_VOICES,
  EXAMPLES,
  type ExampleSpec,
  type CounterpointRules,
  type HistoryPolicy,
  type RhythmSpec,
} from './rules.js';
import {
  allVoiceIds,
  makeVoice,
  momentReports,
  scoreEnd,
  timeline,
  type MomentReport,
  type Note,
  type Score,
  type VoiceId,
} from './score.js';
import { intervalInfo, midiToName } from './pitch.js';
import { search, type SearchResult, type SearchSolution } from './search.js';

export interface BuiltExample {
  spec: ExampleSpec;
  score: Score;
  search?: SearchResult;
  violations: Violation[];
  moments: MomentReport[];
  policy: HistoryPolicy;
  notes: string[];
}

function parseCf(spec: ExampleSpec): Note[] {
  const parsed = parseMelody(spec.cfText);
  if (parsed.errors.length) throw new Error(parsed.errors.join('；'));
  return parsed.notes;
}

export function buildScoreFromParts(
  cfNotes: Note[],
  u1Notes: Note[],
  u2Notes: Note[],
  spec: { key: ExampleSpec['key']; beatsPerMeasure: number; tempo?: number },
): Score {
  const cfLow = Math.min(...cfNotes.map((n) => n.pitch), 48);
  const cfHigh = Math.max(...cfNotes.map((n) => n.pitch), 60);
  return {
    key: spec.key,
    beatsPerMeasure: spec.beatsPerMeasure,
    tempo: spec.tempo ?? 84,
    voices: {
      cf: { id: 'cf', name: '定旋律', low: cfLow, high: cfHigh, notes: cfNotes },
      u1: {
        id: 'u1',
        name: DEFAULT_VOICES.u1.name,
        low: Math.min(...u1Notes.map((n) => n.pitch), 48),
        high: Math.max(...u1Notes.map((n) => n.pitch), 72),
        notes: u1Notes,
      },
      u2: {
        id: 'u2',
        name: DEFAULT_VOICES.u2.name,
        low: Math.min(...u2Notes.map((n) => n.pitch), 60),
        high: Math.max(...u2Notes.map((n) => n.pitch), 84),
        notes: u2Notes,
      },
    },
  };
}

/** 把 Score 转成分析上下文与分配。 */
export function contextFromScore(
  score: Score,
  rules: CounterpointRules,
  policy: HistoryPolicy,
): { ctx: AnalysisContext; assignment: Assignment } {
  const { plans, T } = buildPlansFromVoices({
    cf: score.voices.cf,
    u1: score.voices.u1,
    u2: score.voices.u2,
  });
  const assignment = emptyAssignment();
  for (const id of allVoiceIds()) {
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
    rules,
    historyPolicy: policy,
    historyFloor: 0,
    complete: true,
    T,
  };
  return { ctx, assignment };
}

export interface IndexAlignmentRow {
  index: number;
  entries: { voice: VoiceId; note: Note }[];
  pairs: { voices: string; semitones: number; label: string; consonant: boolean }[];
  complete: boolean;
}

export interface ActualDissonance {
  from: number;
  to: number;
  vertices: { voice: VoiceId; pitch: number }[];
  pair: string;
  label: string;
  strength: string;
}

/** 真正的“同下标”对齐：把各声部第 i 个音强行配在一起。 */
export function indexAlignment(score: Score): IndexAlignmentRow[] {
  const ids = allVoiceIds();
  const sorted: Record<string, Note[]> = {};
  for (const id of ids) sorted[id] = [...score.voices[id].notes].sort((a, b) => a.onset - b.onset);
  const maxLen = Math.max(...ids.map((id) => sorted[id].length), 0);
  const rows: IndexAlignmentRow[] = [];
  for (let i = 0; i < maxLen; i++) {
    const entries = ids
      .filter((id) => sorted[id][i])
      .map((id) => ({ voice: id, note: sorted[id][i] }));
    const pairs: IndexAlignmentRow['pairs'] = [];
    const byPitch = [...entries].sort((a, b) => a.note.pitch - b.note.pitch);
    for (let x = 0; x < byPitch.length; x++) {
      for (let y = x + 1; y < byPitch.length; y++) {
        const info = intervalInfo(byPitch[x].note.pitch, byPitch[y].note.pitch);
        pairs.push({
          voices: `${byPitch[x].voice}/${byPitch[y].voice}`,
          semitones: info.semitones,
          label: info.label,
          consonant: info.quality !== 'dissonant',
        });
      }
    }
    rows.push({ index: i, entries, pairs, complete: entries.length === ids.length });
  }
  return rows;
}

/** 实际重叠区间里的不协和（不做经过/辅助解释，纯音程层面）。 */
export function actualDissonances(score: Score): ActualDissonance[] {
  const out: ActualDissonance[] = [];
  const { ctx, assignment } = contextFromScore(score, { ...DEFAULT_RULES }, 'carry');
  for (const slice of slicesBetween(ctx, assignment, 0, ctx.T)) {
    for (const p of slice.pairs) {
      if (p.quality !== 'dissonant') continue;
      out.push({
        from: slice.from,
        to: slice.to,
        vertices: [p.lower, p.upper].map((v) => ({
          voice: v,
          pitch: v === p.lower ? p.lowerPitch : p.upperPitch,
        })),
        pair: `${p.lower}/${p.upper}`,
        label: p.intervalLabel,
        strength: strengthOf(ctx, slice.from),
      });
    }
  }
  return out;
}

export interface OverlapTrap {
  actual: ActualDissonance[];
  indexRows: IndexAlignmentRow[];
  indexDissonances: number;
  explanation: string;
}

/**
 * 演示按相同下标配对会漏掉什么：实际重叠区间有 N 处不协和，
 * 但同下标配对只有 M 处，且两处对应的声部/音高未必相同。
 */
export function overlapTrap(score: Score): OverlapTrap {
  const actual = actualDissonances(score);
  const rows = indexAlignment(score);
  const indexDissonances = rows.reduce(
    (n, r) => n + r.pairs.filter((p) => !p.consonant).length,
    0,
  );
  const explanation =
    `按实际重叠区间检查，发现 ${actual.length} 处不协和；` +
    `若按各声部数组的相同下标配对，只看到 ${indexDissonances} 处。` +
    (actual.length > indexDissonances
      ? ' 下标配对漏掉了不同时值造成的错位不协和。'
      : '');
  return { actual, indexRows: rows, indexDissonances, explanation };
}

export function momentPairsAt(score: Score, t: number): { lo: VoiceId; hi: VoiceId; a: number; b: number }[] {
  const active: { voice: VoiceId; pitch: number }[] = [];
  for (const id of allVoiceIds()) {
    const n = score.voices[id].notes.find(
      (x) => x.onset <= t + 1e-9 && x.onset + x.duration > t + 1e-9,
    );
    if (n) active.push({ voice: id, pitch: n.pitch });
  }
  active.sort((x, y) => x.pitch - y.pitch);
  const out: { lo: VoiceId; hi: VoiceId; a: number; b: number }[] = [];
  for (let i = 0; i < active.length; i++)
    for (let j = i + 1; j < active.length; j++)
      out.push({ lo: active[i].voice, hi: active[j].voice, a: active[i].pitch, b: active[j].pitch });
  return out;
}

export interface ExampleDiagnosis {
  score: Score;
  violations: Violation[];
  moments: MomentReport[];
  trap: OverlapTrap;
  obligations: ReturnType<typeof suspensionObligations>;
  history: HistoryBoundary;
  /** 从实际重叠切片枚举的所有不协和音程（含被规则允许的）。 */
  dissonances: ExplainedDissonance[];
}

export function diagnoseScore(
  score: Score,
  rules: CounterpointRules,
  policy: HistoryPolicy,
): ExampleDiagnosis {
  const { ctx, assignment } = contextFromScore(score, rules, policy);
  const violations = analyzeAssignment(ctx, assignment);
  const obligations = suspensionObligations(ctx, assignment, ctx.T);
  const resolutionViolations = checkSuspensionResolutions(ctx, assignment, obligations);
  for (const v of resolutionViolations) violations.push(v);
  return {
    score,
    violations: dedupeViolations(violations),
    moments: momentReports(score, rules.fourthConsonant),
    trap: overlapTrap(score),
    obligations,
    history: historyAt(ctx, assignment, ctx.T, policy, obligations),
    dissonances: explainedDissonances(ctx, assignment),
  };
}

function dedupeViolations(vs: Violation[]): Violation[] {
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

export function parseExampleNotes(spec: ExampleSpec): {
  cf: Note[];
  u1: Note[];
  u2: Note[];
} {
  const cf = parseCf(spec);
  const u1 = spec.u1Text ? parseMelody(spec.u1Text).notes : [];
  const u2 = spec.u2Text ? parseMelody(spec.u2Text).notes : [];
  return { cf, u1, u2 };
}

/**
 * 构建可运行的示例。对于“可行短例”会真正调用搜索；
 * 对于矛盾谱例则直接对给定音符做规则诊断。
 */
export function buildExample(spec: ExampleSpec, rules?: Partial<CounterpointRules>): BuiltExample {
  const mergedRules: CounterpointRules = {
    ...defaultRulesForExample(),
    ...(spec.ruleOverrides ?? {}),
    ...rules,
  };
  const policy = spec.historyPolicy ?? 'carry';
  const parsed = parseExampleNotes(spec);

  if (spec.id === 'feasible') {
    const result = search({
      key: spec.key,
      beatsPerMeasure: spec.beatsPerMeasure,
      rules: mergedRules,
      historyPolicy: policy,
      cfNotes: parsed.cf,
      u1: DEFAULT_VOICES.u1,
      u2: DEFAULT_VOICES.u2,
      rhythmU1: spec.rhythmU1 ?? { kind: 'fixed', duration: 2 },
      rhythmU2: spec.rhythmU2 ?? { kind: 'fixed', duration: 2 },
      maxSolutions: 8,
      maxNodes: 90000,
      timeBudgetMs: 4000,
    });
    const sol = result.solutions[0];
    if (!sol) {
      const score = buildScoreFromParts(parsed.cf, [], [], spec);
      return {
        spec,
        score,
        search: result,
        violations: [],
        moments: [],
        policy,
        notes: [result.message],
      };
    }
    const score = buildScoreFromParts(parsed.cf, sol.u1, sol.u2, spec);
    const diag = diagnoseScore(score, mergedRules, policy);
    return {
      spec,
      score,
      search: result,
      violations: diag.violations,
      moments: diag.moments,
      policy,
      notes: [result.message],
    };
  }

  const score = buildScoreFromParts(parsed.cf, parsed.u1, parsed.u2, spec);
  const diag = diagnoseScore(score, mergedRules, policy);
  return {
    spec,
    score,
    violations: diag.violations,
    moments: diag.moments,
    policy,
    notes: [spec.focus ?? ''],
  };
}

export function defaultRulesForExample(): CounterpointRules {
  return { ...DEFAULT_RULES };
}

export function exampleById(id: string): ExampleSpec | undefined {
  return EXAMPLES.find((e) => e.id === id);
}

/** 从搜索结果构建 Score（供界面“采用该解”使用）。 */
export function scoreFromSolution(
  cfNotes: Note[],
  solution: SearchSolution,
  opts: {
    key: ExampleSpec['key'];
    beatsPerMeasure: number;
    u1Name: string;
    u2Name: string;
    u1Range: { low: number; high: number };
    u2Range: { low: number; high: number };
    tempo?: number;
  },
): Score {
  const score = buildScoreFromParts(cfNotes, solution.u1, solution.u2, {
    key: opts.key,
    beatsPerMeasure: opts.beatsPerMeasure,
    tempo: opts.tempo,
  });
  score.voices.u1.name = opts.u1Name;
  score.voices.u1.low = opts.u1Range.low;
  score.voices.u1.high = opts.u1Range.high;
  score.voices.u2.name = opts.u2Name;
  score.voices.u2.low = opts.u2Range.low;
  score.voices.u2.high = opts.u2Range.high;
  return score;
}

/** 展示每个对位声部与其可替换的其它解：用于“可选解差别”。 */
export function solutionDifferences(solutions: SearchSolution[]): {
  pair: [string, string];
  differingSlots: number;
  u1Diff: number[];
  u2Diff: number[];
}[] {
  const out: { pair: [string, string]; differingSlots: number; u1Diff: number[]; u2Diff: number[] }[] = [];
  for (let i = 0; i < solutions.length; i++) {
    for (let j = i + 1; j < solutions.length; j++) {
      const a = solutions[i];
      const b = solutions[j];
      const u1Diff: number[] = [];
      const u2Diff: number[] = [];
      for (let k = 0; k < a.u1.length; k++) if (a.u1[k].pitch !== b.u1[k]?.pitch) u1Diff.push(k);
      for (let k = 0; k < a.u2.length; k++) if (a.u2[k].pitch !== b.u2[k]?.pitch) u2Diff.push(k);
      out.push({ pair: [a.id, b.id], differingSlots: u1Diff.length + u2Diff.length, u1Diff, u2Diff });
    }
  }
  return out;
}

export function kindLabel(k: DissonanceKind): string {
  switch (k) {
    case 'consonant':
      return '协和';
    case 'passing':
      return '经过音';
    case 'neighbor':
      return '辅助音';
    case 'suspension':
      return '延留音';
    case 'prepared-suspension':
      return '未解决延留';
    case 'pending':
      return '待定';
    default:
      return '无法解释';
  }
}

export interface SemanticRow {
  signature: string;
  source: 'carry' | 'truncate' | 'both';
  u1: Note[];
  u2: Note[];
  validCarry: boolean;
  validTruncate: boolean;
  carryErrors: string[];
  truncateErrors: string[];
}

export interface SemanticComparison {
  carry: SearchResult;
  truncate: SearchResult;
  rows: SemanticRow[];
  validOnlyCarry: SemanticRow[];
  validOnlyTruncate: SemanticRow[];
  validBoth: SemanticRow[];
  invalidBoth: SemanticRow[];
  note: string;
  summary: string;
}

/**
 * 真正的“解集”比较：把两种搜索找到的解取并集，再用两种历史策略
 * 各自完整复核同一份乐谱。差异只来自跨小节历史判决，而不是枚举顺序。
 */
export function compareHistorySemantics(
  carry: SearchResult,
  truncate: SearchResult,
  rules: CounterpointRules,
  key: ExampleSpec['key'],
  beatsPerMeasure: number,
): SemanticComparison {
  const map = new Map<string, { row: SemanticRow; sol: SearchSolution }>();
  const add = (sol: SearchSolution, source: 'carry' | 'truncate') => {
    const existing = map.get(sol.signature);
    if (existing) {
      existing.row.source = 'both';
      return;
    }
    map.set(sol.signature, {
      row: {
        signature: sol.signature,
        source,
        u1: sol.u1,
        u2: sol.u2,
        validCarry: false,
        validTruncate: false,
        carryErrors: [],
        truncateErrors: [],
      },
      sol,
    });
  };
  for (const s of carry.solutions) add(s, 'carry');
  for (const s of truncate.solutions) add(s, 'truncate');

  const rows: SemanticRow[] = [];
  for (const { row } of map.values()) {
    const score = buildScoreFromParts(carry.cfNotes, row.u1, row.u2, { key, beatsPerMeasure });
    const carryDiag = diagnoseScore(score, rules, 'carry');
    const truncDiag = diagnoseScore(score, rules, 'truncate');
    const carryErrors = carryDiag.violations
      .filter((v) => v.severity === 'error')
      .map((v) => `${v.ruleLabel}@${v.time}`);
    const truncErrors = truncDiag.violations
      .filter((v) => v.severity === 'error')
      .map((v) => `${v.ruleLabel}@${v.time}`);
    row.validCarry = carryErrors.length === 0;
    row.validTruncate = truncErrors.length === 0;
    row.carryErrors = carryErrors;
    row.truncateErrors = truncErrors;
    rows.push(row);
  }

  const validOnlyCarry = rows.filter((r) => r.validCarry && !r.validTruncate);
  const validOnlyTruncate = rows.filter((r) => !r.validCarry && r.validTruncate);
  const validBoth = rows.filter((r) => r.validCarry && r.validTruncate);
  const invalidBoth = rows.filter((r) => !r.validCarry && !r.validTruncate);
  const note =
    '同一份乐谱在两种历史策略下重新复核。“仅另一种策略成立”表示该解在一种历史下满足全部规则，' +
    '在另一种历史下被判违规——差异来自跨小节预备/悬挂义务，而不只是搜索顺序。';
  const summary =
    `两种策略共找到 ${rows.length} 条不同候选；` +
    `两种历史下都成立 ${validBoth.length} 条，仅保留悬挂义务成立 ${validOnlyCarry.length} 条，` +
    `仅截短历史成立 ${validOnlyTruncate.length} 条，两者都不成立 ${invalidBoth.length} 条。`;
  return {
    carry,
    truncate,
    rows,
    validOnlyCarry,
    validOnlyTruncate,
    validBoth,
    invalidBoth,
    note,
    summary,
  };
}

export { buildPlansFromVoices, buildSearchPlans, parseMelody, scoreEnd, timeline, momentReports, assignmentToNotes };
