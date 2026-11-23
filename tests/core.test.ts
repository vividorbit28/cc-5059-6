import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/core/rules.js';
import { search, compareResults, detectStrikes } from '../src/core/search.js';
import { buildExample, diagnoseScore, overlapTrap, contextFromScore } from '../src/core/examples.js';
import {
  analyzeAssignment,
  emptyAssignment,
  slicesBetween,
  suspensionObligations,
} from '../src/core/analyze.js';
import { buildPlansFromVoices, noteKey } from '../src/core/plan.js';
import { momentReports } from '../src/core/score.js';
import { midiToName } from '../src/core/pitch.js';

const CF4 = [
  { onset: 0, duration: 4, pitch: 48 },
  { onset: 4, duration: 4, pitch: 50 },
  { onset: 8, duration: 4, pitch: 52 },
  { onset: 12, duration: 4, pitch: 53 },
];

describe('pitch & intervals', () => {
  it('parses and names pitches', async () => {
    const { parsePitch, midiToName, isPerfectInterval, intervalInfo } = await import('../src/core/pitch.js');
    expect(midiToName(60)).toBe('C4');
    expect(midiToName(61)).toBe('C#4');
    expect(parsePitch('C4')).toBe(60);
    expect(parsePitch('Bb3')).toBe(58);
    expect(isPerfectInterval(48, 55)).toBe(true);
    expect(isPerfectInterval(48, 52)).toBe(false);
    expect(intervalInfo(48, 56).quality).toBe('imperfect');
    expect(intervalInfo(48, 54).quality).toBe('dissonant');
  });
});

describe('vertical checking by actual overlap', () => {
  it('detects a dissonance that index-aligned comparison misses', () => {
    const spec = {
      id: 'overlap-misalignment' as const,
      label: '',
      description: '',
      kind: 'demo' as const,
      key: { tonicPc: 0, mode: 'major' as const },
      beatsPerMeasure: 4,
      cfText: 'C3:4',
      u1Text: 'G4:2 F4:2',
      u2Text: 'E5:4',
    };
    const b = buildExample(spec);
    const trap = overlapTrap(b.score);
    // F4 over C3 = perfect fourth (dissonant by default) and F4/E5 = major seventh
    expect(trap.actual.length).toBeGreaterThanOrEqual(2);
    expect(trap.indexDissonances).toBe(0);
    expect(trap.explanation).toContain('漏掉');
  });

  it('builds a timeline whose segments come from overlapping intervals', () => {
    const b = buildExample({
      id: 'overlap-misalignment',
      label: '',
      description: '',
      kind: 'demo',
      key: { tonicPc: 0, mode: 'major' },
      beatsPerMeasure: 4,
      cfText: 'C3:4',
      u1Text: 'G4:2 F4:2',
      u2Text: 'E5:4',
    });
    const moments = momentReports(b.score);
    expect(moments.length).toBeGreaterThan(1);
    const t2 = moments.find((m) => Math.abs(m.time - 2) < 1e-6);
    expect(t2).toBeTruthy();
    expect(t2!.entries.length).toBe(3);
    const labels = t2!.pairs.map((p) => p.intervalLabel);
    expect(labels.some((l) => l.includes('四度'))).toBe(true);
  });
});

describe('contextual dissonance classification', () => {
  it('passing tone is explained, not rejected', () => {
    // C3 held; u1 E4 (consonant) -> F4 (passing over C3) -> G4 on weak beats.
    const cf = [{ onset: 0, duration: 4, pitch: 48 }];
    const u1 = [
      { onset: 0, duration: 1, pitch: 64 },
      { onset: 1, duration: 1, pitch: 65 },
      { onset: 2, duration: 1, pitch: 67 },
      { onset: 3, duration: 1, pitch: 65 },
    ];
    const u2 = [{ onset: 0, duration: 4, pitch: 72 }];
    const b = buildExample({
      id: 'overlap-misalignment',
      label: '',
      description: '',
      kind: 'demo',
      key: { tonicPc: 0, mode: 'major' },
      beatsPerMeasure: 4,
      cfText: 'C3:4',
      u1Text: 'E4:1 F4:1 G4:1 F4:1',
      u2Text: 'C5:4',
    });
    const errs = b.violations.filter((v) => v.rule === 'strongBeatConsonance' && v.severity === 'error');
    // With passing/neighbor allowed, no hard error on the weak-beat F4 against C3.
    expect(errs.length).toBe(0);
    void cf;
    void u1;
    void u2;
  });
});

describe('search', () => {
  it('returns multiple distinct valid solutions', () => {
    const res = search({
      key: { tonicPc: 0, mode: 'major' },
      beatsPerMeasure: 4,
      rules: DEFAULT_RULES,
      historyPolicy: 'carry',
      cfNotes: CF4,
      u1: { low: 60, high: 72, name: 'u1' },
      u2: { low: 72, high: 84, name: 'u2' },
      rhythmU1: { kind: 'fixed', duration: 2 },
      rhythmU2: { kind: 'fixed', duration: 2 },
      maxSolutions: 6,
      maxNodes: 120000,
      timeBudgetMs: 5000,
    });
    expect(res.solutions.length).toBeGreaterThanOrEqual(3);
    const sigs = new Set(res.solutions.map((s) => s.signature));
    expect(sigs.size).toBe(res.solutions.length);
    for (const s of res.solutions) {
      expect(s.violations.filter((v) => v.severity === 'error')).toEqual([]);
      expect(s.u1.length).toBeGreaterThan(0);
      expect(s.u2.length).toBeGreaterThan(0);
    }
    expect(res.stats.nodes).toBeGreaterThan(0);
    expect(Object.keys(res.stats.pruned).length).toBeGreaterThan(0);
  });

  it('is not a transposition of the cantus firmus', () => {
    const res = search({
      key: { tonicPc: 0, mode: 'major' },
      beatsPerMeasure: 4,
      rules: DEFAULT_RULES,
      historyPolicy: 'carry',
      cfNotes: CF4,
      u1: { low: 60, high: 72, name: 'u1' },
      u2: { low: 72, high: 84, name: 'u2' },
      rhythmU1: { kind: 'fixed', duration: 2 },
      rhythmU2: { kind: 'fixed', duration: 2 },
      maxSolutions: 4,
      maxNodes: 90000,
      timeBudgetMs: 5000,
    });
    const cfPitches = CF4.map((n) => n.pitch);
    for (const s of res.solutions) {
      const u1 = s.u1.map((n) => n.pitch);
      const offsets = new Set<number>();
      for (let i = 0; i < u1.length; i++) offsets.add(u1[i] - cfPitches[Math.min(i, cfPitches.length - 1)]);
      // A pure transposition would have a single repeated offset; real counterpoint varies.
      expect(offsets.size).toBeGreaterThan(1);
    }
  });

  it('reports no solution instead of fabricating one when rules conflict', () => {
    const res = search({
      key: { tonicPc: 0, mode: 'major' },
      beatsPerMeasure: 4,
      rules: {
        ...DEFAULT_RULES,
        startPerfect: true,
        endOnTonic: true,
        endPerfect: true,
      },
      historyPolicy: 'carry',
      // The only allowed pitch for both voices is D4, which is neither a perfect
      // interval against C3 nor the tonic — so every candidate must be pruned.
      cfNotes: [{ onset: 0, duration: 4, pitch: 48 }],
      u1: { low: 62, high: 62, name: 'u1' },
      u2: { low: 62, high: 62, name: 'u2' },
      rhythmU1: { kind: 'fixed', duration: 4 },
      rhythmU2: { kind: 'fixed', duration: 4 },
      maxSolutions: 5,
      maxNodes: 50000,
      timeBudgetMs: 3000,
    });
    expect(res.ok).toBe(false);
    expect(res.solutions.length).toBe(0);
    expect(res.message.length).toBeGreaterThan(0);
  });
});

describe('cross-bar history policy', () => {
  it('carry and truncate produce different solution sets', () => {
    const rules = { ...DEFAULT_RULES, startPerfect: false, endOnTonic: false, endPerfect: false };
    const common = {
      key: { tonicPc: 0, mode: 'major' as const },
      beatsPerMeasure: 4,
      rules,
      cfNotes: [
        { onset: 0, duration: 4, pitch: 60 },
        { onset: 4, duration: 4, pitch: 59 },
      ],
      u1: { low: 64, high: 72, name: 'u1' },
      u2: { low: 72, high: 84, name: 'u2' },
      rhythmU1: { kind: 'fixed' as const, duration: 2 },
      rhythmU2: { kind: 'pattern' as const, values: [3, 3, 2] },
      maxSolutions: 12,
      maxNodes: 150000,
      timeBudgetMs: 6000,
    };
    const carry = search({ ...common, historyPolicy: 'carry' });
    const truncate = search({ ...common, historyPolicy: 'truncate' });
    const cmp = compareResults(carry, truncate);
    expect(carry.solutions.length).toBeGreaterThan(0);
    expect(cmp.summary).toContain('保留悬挂义务');
    expect(cmp.summary).toContain('截短到本小节');
    // Some solution available under one policy is not available under the other.
    expect(cmp.onlyInCarry.length + cmp.onlyInTruncate.length).toBeGreaterThan(0);
  });

  it('detects a suspension created by a held note crossed by another voice', () => {
    const cf = [{ onset: 0, duration: 4, pitch: 60 }];
    const u1 = [
      { onset: 0, duration: 2, pitch: 67 },
      { onset: 2, duration: 2, pitch: 65 },
    ];
    const u2 = [{ onset: 0, duration: 4, pitch: 71 }];
    const { plans } = buildPlansFromVoices({
      cf: { name: 'cf', low: 48, high: 60, notes: cf },
      u1: { name: 'u1', low: 60, high: 72, notes: u1 },
      u2: { name: 'u2', low: 60, high: 84, notes: u2 },
    });
    const a = emptyAssignment();
    a.pitch.set(noteKey('cf', 0), 60);
    a.pitch.set(noteKey('u1', 0), 67);
    a.pitch.set(noteKey('u1', 1), 65);
    a.pitch.set(noteKey('u2', 0), 71);
    const ctx = {
      plans,
      points: [],
      key: { tonicPc: 0, mode: 'major' as const },
      beatsPerMeasure: 4,
      rules: DEFAULT_RULES,
      historyPolicy: 'carry' as const,
      historyFloor: 0,
      complete: true,
      T: 4,
    };
    const strikes = detectStrikes(ctx, a, 'u1', 1, 65, 'carry');
    // B4 (71) held over G4->F4: G4/B4 is a major third (consonant); F4/B4 is a tritone.
    expect(strikes.length).toBe(1);
    expect(strikes[0].voice).toBe('u2');
    expect(strikes[0].pitch).toBe(71);
  });
});

describe('explained dissonances from slices', () => {
  it('lists dissonances even when the strong-beat rule is disabled', () => {
    const b = buildExample({
      id: 'overlap-misalignment',
      label: '',
      description: '',
      kind: 'demo',
      key: { tonicPc: 0, mode: 'major' },
      beatsPerMeasure: 4,
      cfText: 'C3:4',
      u1Text: 'G4:2 F4:2',
      u2Text: 'E5:4',
      ruleOverrides: { strongBeatConsonance: false },
    });
    // The trap shows 2 actual dissonances; the explanation list must not rely on violations.
    const diag = diagnoseScore(b.score, { ...DEFAULT_RULES, strongBeatConsonance: false }, 'carry');
    expect(diag.dissonances.length).toBeGreaterThanOrEqual(2);
    expect(overlapTrap(b.score).actual.length).toBeGreaterThanOrEqual(2);
    expect(diag.dissonances.every((d) => d.context.explanation.length > 0)).toBe(true);
    // The explanation list does not depend on a strong-beat rule firing.
    expect(diag.violations.filter((v) => v.rule === 'strongBeatConsonance')).toEqual([]);
  });
});

describe('example diagnostics', () => {
  it('flags the unresolved suspension example', async () => {
    const { EXAMPLES } = await import('../src/core/rules.js');
    const spec = EXAMPLES.find((e) => e.id === 'unresolved-suspension')!;
    const b = buildExample(spec);
    const rules = b.violations.filter((v) => v.rule === 'suspensionResolveDown');
    expect(rules.length).toBeGreaterThan(0);
    expect(rules[0].message).toContain('下行');
  });

  it('flags parallel fifths', async () => {
    const { EXAMPLES } = await import('../src/core/rules.js');
    const spec = EXAMPLES.find((e) => e.id === 'parallel-fifth')!;
    const b = buildExample(spec);
    expect(b.violations.some((v) => v.rule === 'forbidParallelPerfects')).toBe(true);
  });

  it('flags leap without recovery', async () => {
    const { EXAMPLES } = await import('../src/core/rules.js');
    const spec = EXAMPLES.find((e) => e.id === 'leap-recovery')!;
    const b = buildExample(spec);
    expect(b.violations.some((v) => v.rule === 'requireLeapRecovery')).toBe(true);
  });

  it('flags voice crossing', async () => {
    const { EXAMPLES } = await import('../src/core/rules.js');
    const spec = EXAMPLES.find((e) => e.id === 'voice-crossing')!;
    const b = buildExample(spec);
    expect(b.violations.some((v) => v.rule === 'forbidVoiceCrossing')).toBe(true);
  });

  it('feasible example stays clean', async () => {
    const { EXAMPLES } = await import('../src/core/rules.js');
    const spec = EXAMPLES.find((e) => e.id === 'feasible')!;
    const b = buildExample(spec);
    expect(b.search).toBeTruthy();
    expect(b.search!.ok).toBe(true);
    expect(b.search!.solutions.length).toBeGreaterThan(1);
  });
});

describe('semantic history comparison', () => {
  it('finds solutions whose validity depends on carrying cross-bar obligations', async () => {
    const { EXAMPLES, DEFAULT_RULES } = await import('../src/core/rules.js');
    const { compareHistorySemantics, buildExample } = await import('../src/core/examples.js');
    const spec = EXAMPLES.find((e) => e.id === 'cross-bar-suspension')!;
    const built = buildExample(spec);
    const rules = { ...DEFAULT_RULES, ...(spec.ruleOverrides ?? {}) };
    const base = {
      key: spec.key,
      beatsPerMeasure: 4,
      rules,
      cfNotes: built.score.voices.cf.notes,
      u1: { low: 60, high: 72, name: 'u1' },
      u2: { low: 72, high: 84, name: 'u2' },
      rhythmU1: spec.rhythmU1!,
      rhythmU2: spec.rhythmU2!,
      maxSolutions: 10,
      maxNodes: 150000,
      timeBudgetMs: 6000,
    };
    const carry = search({ ...base, historyPolicy: 'carry' });
    const truncate = search({ ...base, historyPolicy: 'truncate' });
    const cmp = compareHistorySemantics(carry, truncate, rules, spec.key, 4);
    expect(cmp.rows.length).toBeGreaterThan(0);
    // The core claim: at least one solution is accepted under carry but rejected under truncate.
    expect(cmp.validOnlyCarry.length).toBeGreaterThan(0);
    expect(cmp.summary).toContain('仅保留悬挂义务成立');
  });
});
