import { intervalInfo, isPerfectInterval, type Key } from './pitch.js';
import type { CounterpointRules } from './rules.js';

/**
 * 音程规则：只依赖音高对与规则开关，不依赖乐谱或搜索状态，
 * 因此可以独立检查。纵向检查、平行/直接音程判定都从这里取证。
 */
export interface IntervalEvidence {
  semitones: number;
  /** 去掉八度后的简单音程（0–11）。 */
  simple: number;
  quality: 'perfect' | 'imperfect' | 'dissonant';
  perfect: boolean;
  label: string;
  consonant: boolean;
}

export function intervalEvidence(
  lower: number,
  upper: number,
  fourthConsonant: boolean,
): IntervalEvidence {
  const info = intervalInfo(lower, upper, fourthConsonant);
  return {
    semitones: info.semitones,
    simple: info.simple,
    quality: info.quality,
    perfect: isPerfectInterval(lower, upper, fourthConsonant),
    label: info.label,
    consonant: info.quality !== 'dissonant',
  };
}

export function isConsonantPair(lower: number, upper: number, fourthConsonant: boolean): boolean {
  return intervalEvidence(lower, upper, fourthConsonant).consonant;
}

export function isPerfectPair(lower: number, upper: number, fourthConsonant: boolean): boolean {
  return intervalEvidence(lower, upper, fourthConsonant).perfect;
}

/** 平行五/八度：前一纵向音程为纯音程，进入同类纯音程，且两声部同向运动。 */
export function isParallelPerfect(
  prev: { lowerPitch: number; upperPitch: number; simple: number; perfect: boolean },
  curr: { lowerPitch: number; upperPitch: number; simple: number },
): boolean {
  if (!prev.perfect) return false;
  const sameKind = curr.simple === prev.simple;
  const dLo = Math.sign(curr.lowerPitch - prev.lowerPitch);
  const dHi = Math.sign(curr.upperPitch - prev.upperPitch);
  return sameKind && dLo !== 0 && dLo === dHi;
}

/** 直接（隐蔽）五/八度：两声部同向进入纯音程，且上方声部为跳进（≥3 半音）。 */
export function isDirectPerfect(
  prev: { lowerPitch: number; upperPitch: number },
  curr: { lowerPitch: number; upperPitch: number },
): boolean {
  const dLo = Math.sign(curr.lowerPitch - prev.lowerPitch);
  const dHi = Math.sign(curr.upperPitch - prev.upperPitch);
  const upperLeap = Math.abs(curr.upperPitch - prev.upperPitch) >= 3;
  return dLo !== 0 && dLo === dHi && upperLeap;
}

export function allowsPerfectFourth(rules: Pick<CounterpointRules, 'fourthConsonant'>): boolean {
  return rules.fourthConsonant;
}

/** 供 UI/解释使用的拍点与音级相关小工具（不改变判定）。 */
export function describeInterval(
  lower: number,
  upper: number,
  rules: Pick<CounterpointRules, 'fourthConsonant'>,
  key?: Key,
): string {
  const ev = intervalEvidence(lower, upper, rules.fourthConsonant);
  return key ? `${ev.label}` : ev.label;
}
