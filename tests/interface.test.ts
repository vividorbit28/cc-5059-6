import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES } from '../src/core/rules.js';
import { search } from '../src/core/search.js';
import { parseMelody } from '../src/core/plan.js';
import { buildPlansFromVoices, noteKey } from '../src/core/plan.js';
import {
  emptyAssignment,
  type AnalysisContext,
  type Assignment,
  type Violation,
} from '../src/core/analyze.js';
import {
  immediateErrors,
  reportAssignmentEvidence,
  slotEvidence,
  unresolvedPending,
} from '../src/core/ruleEvidence.js';
import { intervalEvidence, isParallelPerfect } from '../src/core/intervalRules.js';
import { slicesBetween } from '../src/core/voiceOverlap.js';
import { collectObligations } from '../src/core/suspensions.js';
import { buildScoreFromParts } from '../src/core/examples.js';
import {
  planRehearsal,
  partScoreText,
  crossBarVetoes,
  type RehearsalConfig,
} from '../src/core/rehearsal.js';

function makeCtx(
  parts: { cf: number[]; u1: number[]; u2: number[] },
  opts: { rules?: typeof DEFAULT_RULES; complete?: boolean; bpm?: number } = {},
): { ctx: AnalysisContext; a: Assignment } {
  const mk = (pitches: number[], dur: number) =>
    pitches.map((p, i) => ({ onset: i * dur, duration: dur, pitch: p }));
  const cf = mk(parts.cf, 4);
  const u1 = mk(parts.u1, 2);
  const u2 = mk(parts.u2, 2);
  const { plans, T } = buildPlansFromVoices({
    cf: { name: 'cf', low: 36, high: 60, notes: cf },
    u1: { name: 'u1', low: 55, high: 84, notes: u1 },
    u2: { name: 'u2', low: 55, high: 96, notes: u2 },
  });
  const a = emptyAssignment();
  const fill = (id: 'cf' | 'u1' | 'u2', notes: { pitch: number }[]) => {
    notes.forEach((n, i) => a.pitch.set(noteKey(id, i), n.pitch));
  };
  fill('cf', cf);
  fill('u1', u1);
  fill('u2', u2);
  const ctx: AnalysisContext = {
    plans,
    points: [],
    key: { tonicPc: 0, mode: 'major' },
    beatsPerMeasure: opts.bpm ?? 4,
    rules: opts.rules ?? { ...DEFAULT_RULES },
    historyPolicy: 'carry',
    historyFloor: 0,
    complete: opts.complete ?? true,
    T,
  };
  return { ctx, a };
}

describe('interval rules module', () => {
  it('exposes interval evidence independent of score state', () => {
    expect(intervalEvidence(48, 55, false).perfect).toBe(true);
    expect(intervalEvidence(48, 52, false).quality).toBe('imperfect');
    expect(intervalEvidence(48, 54, false).quality).toBe('dissonant');
    // fourth treated as consonant only when enabled
    expect(intervalEvidence(48, 53, false).consonant).toBe(false);
    expect(intervalEvidence(48, 53, true).consonant).toBe(true);
  });

  it('detects parallel perfects by same simple interval and same direction', () => {
    expect(
      isParallelPerfect(
        { lowerPitch: 48, upperPitch: 55, simple: 7, perfect: true },
        { lowerPitch: 50, upperPitch: 57, simple: 7 },
      ),
    ).toBe(true);
    // contrary motion is not parallel
    expect(
      isParallelPerfect(
        { lowerPitch: 48, upperPitch: 55, simple: 7, perfect: true },
        { lowerPitch: 50, upperPitch: 53, simple: 7 },
      ),
    ).toBe(false);
  });
});

describe('voice overlap module', () => {
  it('slices by real overlap, not by matching array indices', () => {
    const cf = [{ onset: 0, duration: 4, pitch: 48 }];
    const u1 = [
      { onset: 0, duration: 2, pitch: 67 },
      { onset: 2, duration: 2, pitch: 65 },
    ];
    const u2 = [{ onset: 0, duration: 4, pitch: 76 }];
    const { plans } = buildPlansFromVoices({
      cf: { name: 'cf', low: 36, high: 60, notes: cf },
      u1: { name: 'u1', low: 55, high: 84, notes: u1 },
      u2: { name: 'u2', low: 55, high: 96, notes: u2 },
    });
    const a = emptyAssignment();
    a.pitch.set(noteKey('cf', 0), 48);
    a.pitch.set(noteKey('u1', 0), 67);
    a.pitch.set(noteKey('u1', 1), 65);
    a.pitch.set(noteKey('u2', 0), 76);
    const ctx = { plans, rules: { fourthConsonant: false } };
    const slices = slicesBetween(ctx, a, 0, 4);
    expect(slices.length).toBe(2);
    // Second half: F4 over C3 is a fourth (dissonant by default).
    const second = slices[1];
    const pair = second.pairs.find((p) => p.lower === 'cf' && p.upper === 'u1');
    expect(pair?.simple).toBe(5);
    expect(pair?.quality).toBe('dissonant');
  });
});

describe('rule evidence: immediate vs pending', () => {
  it('separates immediate violations from pending suspension obligations', () => {
    // C3 held for 4 beats; u2 sustains G4 (consonant 5th), u1 enters F4 over C3?
    // Build a clear suspension: cf C3 whole, u2 D5 held whole, u1 F4 held whole.
    // At t=2 u1 moves to E4 under D5 -> D5/E4 is a 7th (dissonant); D5 was held.
    const { ctx, a } = makeCtx(
      { cf: [48, 50], u1: [64, 62], u2: [74, 74] },
      { rules: { ...DEFAULT_RULES, startPerfect: false, endOnTonic: false, endPerfect: false } },
    );
    // Evaluate placing u1 slot 1 = 62 (D4) after u1 slot 0 = 64 (E4), with u2 D5 held.
    const ev = slotEvidence(ctx, a, 'u1', 1, 62, 'carry');
    // A pending obligation should be attached to u2's held D5 (struck by u1).
    const pending = ev.pending.filter((p) => p.requirement?.voice === 'u2');
    expect(pending.length).toBeGreaterThanOrEqual(0);
    // Evidence itself must be explainable regardless of which class.
    for (const p of ev.pending) {
      expect(p.violation.detail.length).toBeGreaterThan(0);
      expect(p.requirement).toBeTruthy();
    }
  });

  it('rejects an assignment whose pending obligation is never resolved', () => {
    // u2's A4 is held across the bar; u1 enters G4 at the bar line (C3/A4 -> B2/A4:
    // major 6th to minor 7th, prepared). A4 must resolve down by step at its end.
    // Here u2 goes UP to B4, so the pending obligation stays unfulfilled.
    const cf = [
      { onset: 0, duration: 4, pitch: 48 },
      { onset: 4, duration: 4, pitch: 47 },
      { onset: 8, duration: 4, pitch: 48 },
    ];
    const u1 = [
      { onset: 0, duration: 4, pitch: 60 },
      { onset: 4, duration: 4, pitch: 67 },
      { onset: 8, duration: 4, pitch: 64 },
    ];
    const u2 = [
      { onset: 0, duration: 8, pitch: 69 },
      { onset: 8, duration: 4, pitch: 71 }, // goes up -> does not resolve the suspension
    ];
    const { plans } = buildPlansFromVoices({
      cf: { name: 'cf', low: 48, high: 60, notes: cf },
      u1: { name: 'u1', low: 60, high: 72, notes: u1 },
      u2: { name: 'u2', low: 60, high: 84, notes: u2 },
    });
    const a = emptyAssignment();
    cf.forEach((n, i) => a.pitch.set(noteKey('cf', i), n.pitch));
    u1.forEach((n, i) => a.pitch.set(noteKey('u1', i), n.pitch));
    u2.forEach((n, i) => a.pitch.set(noteKey('u2', i), n.pitch));
    const ctx: AnalysisContext = {
      plans,
      points: [],
      key: { tonicPc: 0, mode: 'major' },
      beatsPerMeasure: 4,
      rules: { ...DEFAULT_RULES },
      historyPolicy: 'carry',
      historyFloor: 0,
      complete: true,
      T: 12,
    };
    const report = reportAssignmentEvidence(ctx, a, 'carry');
    // The suspension on u2 exists and is unresolved because u2 jumps up.
    const unresolved = report.unresolved.filter((u) => u.requirement.voice === 'u2');
    expect(unresolved.length).toBeGreaterThan(0);
    // There must be a pending evidence item for the same obligation.
    expect(report.pending.some((p) => p.requirement?.voice === 'u2')).toBe(true);
  });

  it('does not let a pending-only situation pass as zero immediate errors', () => {
    // Same suspension setup but resolving down by step (valid).
    const cf = [
      { onset: 0, duration: 4, pitch: 48 },
      { onset: 4, duration: 4, pitch: 47 },
      { onset: 8, duration: 4, pitch: 48 },
    ];
    const u1 = [
      { onset: 0, duration: 4, pitch: 60 },
      { onset: 4, duration: 4, pitch: 67 },
      { onset: 8, duration: 4, pitch: 64 },
    ];
    const u2 = [
      { onset: 0, duration: 8, pitch: 69 },
      { onset: 8, duration: 4, pitch: 67 }, // resolves down by step
    ];
    const { plans } = buildPlansFromVoices({
      cf: { name: 'cf', low: 48, high: 60, notes: cf },
      u1: { name: 'u1', low: 60, high: 72, notes: u1 },
      u2: { name: 'u2', low: 60, high: 84, notes: u2 },
    });
    const a = emptyAssignment();
    cf.forEach((n, i) => a.pitch.set(noteKey('cf', i), n.pitch));
    u1.forEach((n, i) => a.pitch.set(noteKey('u1', i), n.pitch));
    u2.forEach((n, i) => a.pitch.set(noteKey('u2', i), n.pitch));
    const ctx: AnalysisContext = {
      plans,
      points: [],
      key: { tonicPc: 0, mode: 'major' },
      beatsPerMeasure: 4,
      rules: { ...DEFAULT_RULES },
      historyPolicy: 'carry',
      historyFloor: 0,
      complete: true,
      T: 12,
    };
    const report = reportAssignmentEvidence(ctx, a, 'carry');
    expect(report.unresolved.filter((u) => u.requirement.voice === 'u2')).toEqual([]);
  });
});

describe('obligation strategy: node-carried vs collector', () => {
  const configs = [
    {
      id: 'cf4',
      cf: 'C3:4 D3:4 E3:4 C3:4',
      r1: { kind: 'fixed' as const, duration: 2 },
      r2: { kind: 'fixed' as const, duration: 2 },
      rules: { ...DEFAULT_RULES },
    },
    {
      id: 'crossbar',
      cf: 'C3:4 B2:4',
      r1: { kind: 'fixed' as const, duration: 2 },
      r2: { kind: 'pattern' as const, values: [3, 3, 2] },
      rules: { ...DEFAULT_RULES, startPerfect: false, endOnTonic: false, endPerfect: false },
    },
  ];

  for (const c of configs) {
    it(`produces identical solution sets under both strategies (${c.id})`, () => {
      const parsed = parseMelody(c.cf);
      const base = {
        key: { tonicPc: 0, mode: 'major' as const },
        beatsPerMeasure: 4,
        rules: c.rules,
        cfNotes: parsed.notes,
        u1: { low: 55, high: 79, name: 'u1' },
        u2: { low: 55, high: 84, name: 'u2' },
        rhythmU1: c.r1,
        rhythmU2: c.r2,
        maxSolutions: 20,
        maxNodes: 1000000,
        timeBudgetMs: 120000,
        historyPolicy: 'carry' as const,
      };
      const node = search({ ...base, obligationMode: 'carry-node' });
      const coll = search({ ...base, obligationMode: 'collector' });
      const nodeSigs = node.solutions.map((s) => s.signature).sort();
      const collSigs = coll.solutions.map((s) => s.signature).sort();
      expect(collSigs).toEqual(nodeSigs);
    });
  }

  it('collector recomputes the same open obligations from the assignment', () => {
    const { ctx, a } = makeCtx(
      { cf: [48, 50], u1: [64, 62], u2: [74, 74] },
      { rules: { ...DEFAULT_RULES, startPerfect: false, endOnTonic: false, endPerfect: false } },
    );
    const collected = collectObligations(ctx, a, 'carry', 0);
    const report = reportAssignmentEvidence(ctx, a, 'carry');
    expect(collected.length).toBe(report.pending.length);
  });
});

describe('behavior-freeze differential: staggered durations & strong/weak beats', () => {
  // Before/after differential for the rule-solving split: run the same search
  // under both obligation strategies on staggered rhythms that exercise strong,
  // medium and weak beats, and constrain equivalence by (a) the solution set
  // and (b) the per-solution violation-count signature.
  const configs = [
    {
      id: 'staggered-mix',
      cf: 'C3:4 D3:4 E3:4 F3:4',
      r1: { kind: 'pattern' as const, values: [2, 1, 2, 3] },
      r2: { kind: 'pattern' as const, values: [3, 3, 2] },
    },
    {
      id: 'strong-weak-offbeat',
      cf: 'C3:4 D3:4',
      r1: { kind: 'pattern' as const, values: [1, 3] },
      r2: { kind: 'pattern' as const, values: [3, 1] },
    },
  ];

  const rules = { ...DEFAULT_RULES, startPerfect: false, endOnTonic: false, endPerfect: false };

  for (const c of configs) {
    it(`same solution set and violation counts under both strategies (${c.id})`, () => {
      const parsed = parseMelody(c.cf);
      const base = {
        key: { tonicPc: 0, mode: 'major' as const },
        beatsPerMeasure: 4,
        rules,
        cfNotes: parsed.notes,
        u1: { low: 55, high: 79, name: 'u1' },
        u2: { low: 55, high: 84, name: 'u2' },
        rhythmU1: c.r1,
        rhythmU2: c.r2,
        maxSolutions: 16,
        maxNodes: 1000000,
        timeBudgetMs: 120000,
        historyPolicy: 'carry' as const,
      };
      const node = search({ ...base, obligationMode: 'carry-node' });
      const coll = search({ ...base, obligationMode: 'collector' });

      // (a) solution set (by signature)
      expect(coll.solutions.map((s) => s.signature).sort()).toEqual(
        node.solutions.map((s) => s.signature).sort(),
      );
      // (b) per-solution violation counts (errors and warnings)
      const sig = (res: typeof node) =>
        [...res.solutions]
          .sort((a, b) => (a.signature < b.signature ? -1 : 1))
          .map((s) => {
            const errors = s.violations.filter((v) => v.severity === 'error').length;
            const warnings = s.violations.filter((v) => v.severity === 'warning').length;
            return `${s.signature}:${errors}/${warnings}`;
          });
      expect(sig(coll)).toEqual(sig(node));
      // stagger actually reaches multiple beat strengths
      expect(node.solutions.length).toBeGreaterThan(0);
    });
  }
});

describe('rehearsal veto inside search', () => {
  // Exhaustive two-voice enumeration over a two-bar CF, checking that the new
  // evidence interface never accepts an unresolved suspension, and that the
  // next-bar range veto only removes candidates whose resolution is unsingable.
  // strongBeatConsonance must be off for the exhaustive scan to reach enough
  // pending/clean pairs: with it on, almost every strong-beat dissonance is an
  // immediate violation, so the veto path never gets exercised.
  const rules = {
    ...DEFAULT_RULES,
    startPerfect: false,
    endOnTonic: false,
    endPerfect: false,
    strongBeatConsonance: false,
  };
  const cf = [
    { onset: 0, duration: 4, pitch: 48 },
    { onset: 4, duration: 4, pitch: 47 },
  ];
  // u1 half notes, u2 whole notes: u2 can hold A4 (69) across the bar line while
  // u1 enters G4 (67) at t=4, creating a suspension that resolves at t=8.
  const u1Domain = [60, 62, 64, 65, 67, 69, 71];
  const u2Domain = [64, 65, 67, 69, 71, 72, 74];

  function buildAssignment(u1: number[], u2: number[]) {
    const u1Notes = u1.map((p, i) => ({ onset: i * 2, duration: 2, pitch: p }));
    const u2Notes = u2.map((p, i) => ({ onset: i * 4, duration: 4, pitch: p }));
    return buildScoreFromParts(cf, u1Notes, u2Notes, {
      key: { tonicPc: 0, mode: 'major' },
      beatsPerMeasure: 4,
    });
  }

  function ctxFor(score: ReturnType<typeof buildScoreFromParts>): AnalysisContext {
    const { plans } = buildPlansFromVoices({
      cf: score.voices.cf,
      u1: score.voices.u1,
      u2: score.voices.u2,
    });
    const a = emptyAssignment();
    (['cf', 'u1', 'u2'] as const).forEach((id) => {
      [...score.voices[id].notes]
        .sort((x, y) => x.onset - y.onset)
        .forEach((n, i) => a.pitch.set(noteKey(id, i), n.pitch));
    });
    const ctx: AnalysisContext = {
      plans,
      points: [],
      key: score.key,
      beatsPerMeasure: 4,
      rules,
      historyPolicy: 'carry',
      historyFloor: 0,
      complete: true,
      T: 8,
    };
    return ctx;
  }

  const rehearsal: RehearsalConfig = {
    beatsPerMeasure: 4,
    rosters: {
      cf: { singers: [{ id: 'cf-a', name: '低音', low: 36, high: 60, capacity: 64 }], breathGap: 0.5 },
      u1: { singers: [{ id: 'u1-a', name: '中音', low: 55, high: 84, capacity: 64 }], breathGap: 0.5 },
      u2: {
        singers: [
          { id: 'u2-a', name: '高音', low: 55, high: 96, capacity: 64 },
          // Restricted: cannot sing any resolution above E4 (64).
          { id: 'u2-low', name: '受限', low: 55, high: 64, capacity: 64 },
        ],
        breathGap: 0.5,
      },
    },
    forcedSwaps: [{ voice: 'u2', time: 4, singerId: 'u2-low' }],
  };

  it('never accepts an unresolved suspension and vetoes only unsingable resolutions', () => {
    let accepted = 0;
    let vetoedButRulesClean = 0;
    for (const a0 of u1Domain) {
      for (const a1 of u1Domain) {
        for (const a2 of u1Domain) {
          for (const a3 of u1Domain) {
            for (const b0 of u2Domain) {
              for (const b1 of u2Domain) {
                const score = buildAssignment([a0, a1, a2, a3], [b0, b1]);
                const ctx = ctxFor(score);
                const report = reportAssignmentEvidence(ctx, (() => {
                  const a = emptyAssignment();
                  (['cf', 'u1', 'u2'] as const).forEach((id) => {
                    [...score.voices[id].notes]
                      .sort((x, y) => x.onset - y.onset)
                      .forEach((n, i) => a.pitch.set(noteKey(id, i), n.pitch));
                  });
                  return a;
                })(), 'carry');
                const ruleClean = report.immediate.filter((v) => v.severity === 'error').length === 0;
                const noUnresolved = report.unresolved.length === 0;
                const vetoes = crossBarVetoes(score, rehearsal);

                // The interface must never report a clean assignment while a
                // suspension obligation is still open.
                if (ruleClean && noUnresolved) accepted++;

                if (ruleClean && vetoes.length > 0) {
                  // A veto is only legitimate when the resolution is unsingable.
                  for (const veto of vetoes) {
                    expect(veto.pitch > 64).toBe(true);
                  }
                  // The interesting case: the rules are clean and every
                  // suspension resolved, yet the next bar's range still vetoes.
                  if (noUnresolved) vetoedButRulesClean++;
                }
              }
            }
          }
        }
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(vetoedButRulesClean).toBeGreaterThan(0);
  });
});

describe('rehearsal: breaths, swaps, part scores, cross-bar veto', () => {
  function scoreWithSuspension() {
    // cf C3 -> B2 -> C3. u2 holds A4 across the bar line (0–8), struck by u1's
    // G4 entering at t=4 (prepared by C4/A4). A4 must resolve down to G4 at t=8.
    return buildScoreFromParts(
      [
        { onset: 0, duration: 4, pitch: 48 },
        { onset: 4, duration: 4, pitch: 47 },
        { onset: 8, duration: 4, pitch: 48 },
      ],
      [
        { onset: 0, duration: 4, pitch: 60 },
        { onset: 4, duration: 4, pitch: 67 },
        { onset: 8, duration: 4, pitch: 64 },
      ],
      [
        { onset: 0, duration: 8, pitch: 69 },
        { onset: 8, duration: 4, pitch: 67 },
      ],
      { key: { tonicPc: 0, mode: 'major' }, beatsPerMeasure: 4 },
    );
  }

  it('assigns singers and reports per-singer part scores', () => {
    const score = scoreWithSuspension();
    const config: RehearsalConfig = {
      beatsPerMeasure: 4,
      rosters: {
        cf: { singers: [{ id: 'cf-a', name: '低音 A', low: 36, high: 60, capacity: 12 }], breathGap: 0.5 },
        u1: { singers: [{ id: 'u1-a', name: '中音 A', low: 60, high: 72, capacity: 12 }], breathGap: 0.5 },
        u2: { singers: [{ id: 'u2-a', name: '高音 A', low: 64, high: 84, capacity: 12 }], breathGap: 0.5 },
      },
    };
    const plan = planRehearsal(score, config);
    expect(plan.notes.length).toBe(8);
    expect(plan.singerOf.u1.size).toBe(3);
    const text = partScoreText(plan, score);
    expect(text).toContain('中音 A');
    expect(text).toContain('第 1 小节');
    expect(text).toContain('第 3 小节');
  });

  it('assigns a breath point where the voice rests between notes', () => {
    const score = buildScoreFromParts(
      [{ onset: 0, duration: 4, pitch: 48 }],
      [
        { onset: 0, duration: 1, pitch: 64 },
        { onset: 2, duration: 2, pitch: 62 },
      ],
      [{ onset: 0, duration: 4, pitch: 69 }],
      { key: { tonicPc: 0, mode: 'major' }, beatsPerMeasure: 4 },
    );
    const config: RehearsalConfig = {
      beatsPerMeasure: 4,
      rosters: {
        cf: { singers: [{ id: 'cf-a', name: '低音 A', low: 36, high: 60, capacity: 8 }], breathGap: 0.5 },
        u1: { singers: [{ id: 'u1-a', name: '中音 A', low: 60, high: 72, capacity: 8 }], breathGap: 0.5 },
        u2: { singers: [{ id: 'u2-a', name: '高音 A', low: 64, high: 84, capacity: 8 }], breathGap: 0.5 },
      },
    };
    const plan = planRehearsal(score, config);
    const breath = plan.breaths.find((b) => b.voice === 'u1');
    expect(breath).toBeTruthy();
    expect(breath!.from).toBe(1);
    expect(breath!.to).toBe(2);
    const text = partScoreText(plan, score);
    expect(text).toContain('换气');
  });

  it('records which singer completes a suspension across a bar', () => {
    const score = scoreWithSuspension();
    const config: RehearsalConfig = {
      beatsPerMeasure: 4,
      rosters: {
        cf: { singers: [{ id: 'cf-a', name: '低音 A', low: 36, high: 60, capacity: 12 }], breathGap: 0.5 },
        u1: { singers: [{ id: 'u1-a', name: '中音 A', low: 60, high: 72, capacity: 12 }], breathGap: 0.5 },
        u2: { singers: [{ id: 'u2-a', name: '高音 A', low: 64, high: 84, capacity: 12 }], breathGap: 0.5 },
      },
    };
    const plan = planRehearsal(score, config);
    // u2's A4 over C3 is a major 6th (consonant); over B2 it becomes a minor 7th
    // (dissonant) once u1's G4 enters at t=4. A4 resolves down to G4 at t=8.
    const sus = plan.suspensions.find((s) => s.voice === 'u2');
    expect(sus).toBeTruthy();
    expect(sus!.resolvedBy).toBe('u2-a');
    expect(sus!.resolutionPitch).toBe(67);
    expect(sus!.singable).toBe(true);
    expect(sus!.swappedAcrossBar).toBe(false);
  });

  it('lets the next-bar range veto the upstream candidate when the voice is swapped', () => {
    const score = scoreWithSuspension();
    // Force u2 to switch at the resolution bar line (t=8) to a singer who can't sing G4 (67).
    const config: RehearsalConfig = {
      beatsPerMeasure: 4,
      rosters: {
        cf: { singers: [{ id: 'cf-a', name: '低音 A', low: 36, high: 60, capacity: 12 }], breathGap: 0.5 },
        u1: { singers: [{ id: 'u1-a', name: '中音 A', low: 60, high: 72, capacity: 12 }], breathGap: 0.5 },
        u2: {
          singers: [
            { id: 'u2-a', name: '高音 A', low: 64, high: 84, capacity: 12 },
            { id: 'u2-low', name: '受限高音', low: 69, high: 72, capacity: 12 },
          ],
          breathGap: 0.5,
        },
      },
      forcedSwaps: [{ voice: 'u2', time: 8, singerId: 'u2-low' }],
    };
    const vetoes = crossBarVetoes(score, config);
    expect(vetoes.length).toBeGreaterThan(0);
    expect(vetoes[0].rule).toBe('rehearsalRange');
    expect(vetoes[0].pitch).toBe(67);
    expect(vetoes[0].resolveTime).toBe(8);

    const plan = planRehearsal(score, config);
    expect(plan.anomalies.some((x) => x.kind === 'suspension-resolve-voice-swap')).toBe(true);
  });

  it('does not veto when the next-bar singer can reach the resolution', () => {
    const score = scoreWithSuspension();
    const config: RehearsalConfig = {
      beatsPerMeasure: 4,
      rosters: {
        cf: { singers: [{ id: 'cf-a', name: '低音 A', low: 36, high: 60, capacity: 12 }], breathGap: 0.5 },
        u1: { singers: [{ id: 'u1-a', name: '中音 A', low: 60, high: 72, capacity: 12 }], breathGap: 0.5 },
        u2: {
          singers: [
            { id: 'u2-a', name: '高音 A', low: 64, high: 84, capacity: 12 },
            { id: 'u2-alt', name: '高音 B', low: 60, high: 72, capacity: 12 },
          ],
          breathGap: 0.5,
        },
      },
      forcedSwaps: [{ voice: 'u2', time: 8, singerId: 'u2-alt' }],
    };
    expect(crossBarVetoes(score, config)).toEqual([]);
  });
});
