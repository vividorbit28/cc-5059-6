import { beatStrength, intervalInfo, isInScale, measureOf, midiToName, type Key } from './pitch.js';

export type VoiceId = 'cf' | 'u1' | 'u2';

export interface Note {
  /** 起始拍，以全音符 = 4 拍计（4/4 中每小节 4 拍）。 */
  onset: number;
  /** 时值，以拍计，可含小数。 */
  duration: number;
  /** MIDI 音高。 */
  pitch: number;
  /** 延留音：该音的结束被连接到下一音的起始，表示悬挂义务。 */
  tie?: boolean;
  /** 该音符是否自由（未通过搜索、由编辑者手动加入）。 */
  manual?: boolean;
}

export interface Voice {
  id: VoiceId;
  name: string;
  low: number;
  high: number;
  notes: Note[];
}

export interface Score {
  key: Key;
  beatsPerMeasure: number;
  tempo: number;
  voices: Record<VoiceId, Voice>;
}

export interface TimedNote extends Note {
  voice: VoiceId;
  index: number;
  end: number;
  measure: number;
  beat: number;
  strength: 'strong' | 'medium' | 'weak';
}

export interface VerticalState {
  time: number;
  /** 各声部在该时刻的实际发声（把把延音展开后的结果），不按数组下标对齐。 */
  active: Partial<Record<VoiceId, TimedNote>>;
  /** 每个声部在该时刻所属音符的下标（-1 表示静默）。 */
  activeIndex: Partial<Record<VoiceId, number>>;
  measure: number;
  beat: number;
  strength: 'strong' | 'medium' | 'weak';
}

export function makeVoice(id: VoiceId, name: string, low: number, high: number): Voice {
  return { id, name, low, high, notes: [] };
}

export function noteEnd(n: Note): number {
  return n.onset + n.duration;
}

export function sortNotes(notes: Note[]): Note[] {
  return [...notes].sort((a, b) => a.onset - b.onset);
}

/** 把声部展开为带绝对时间与拍点强弱的音符，便于逐时刻检查。 */
export function timedNotes(voice: Voice, beatsPerMeasure: number): TimedNote[] {
  return sortNotes(voice.notes).map((n, index) => ({
    ...n,
    voice: voice.id,
    index,
    end: noteEnd(n),
    measure: measureOf(n.onset, beatsPerMeasure),
    beat: ((n.onset % beatsPerMeasure) + beatsPerMeasure) % beatsPerMeasure,
    strength: beatStrength(n.onset, beatsPerMeasure),
  }));
}

export function voiceEnd(voice: Voice): number {
  return voice.notes.reduce((m, n) => Math.max(m, noteEnd(n)), 0);
}

export function scoreEnd(score: Score): number {
  return Math.max(
    voiceEnd(score.voices.cf),
    voiceEnd(score.voices.u1),
    voiceEnd(score.voices.u2),
  );
}

/**
 * 构建完整时间轴：每个发声事件（起始/结束）都产生一个状态点，
 * 并且把两个音之间的“静默/持音”区间也纳入，因此纵向关系按
 * 实际重叠区间检查，而不是按音符数组相同下标比较。
 */
export function timeline(score: Score): VerticalState[] {
  const bpm = score.beatsPerMeasure;
  const voices = (['cf', 'u1', 'u2'] as VoiceId[]).map((id) => timedNotes(score.voices[id], bpm));
  const points = new Set<number>();
  for (const list of voices) {
    for (const n of list) {
      points.add(n.onset);
      points.add(n.end);
    }
  }
  const sorted = [...points].sort((a, b) => a - b);
  const states: VerticalState[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const t = sorted[i];
    const next = sorted[i + 1];
    const active: Partial<Record<VoiceId, TimedNote>> = {};
    const activeIndex: Partial<Record<VoiceId, number>> = {};
    const ids: VoiceId[] = ['cf', 'u1', 'u2'];
    for (let v = 0; v < ids.length; v++) {
      const list = voices[v];
      const hit = list.find((n) => n.onset <= t + 1e-9 && n.end > t + 1e-9);
      if (hit) {
        active[ids[v]] = hit;
        activeIndex[ids[v]] = hit.index;
      }
    }
    states.push({
      time: t,
      active,
      activeIndex,
      measure: measureOf(t, bpm),
      beat: ((t % bpm) + bpm) % bpm,
      strength: beatStrength(t, bpm),
    });
    // 若下一事件点等于 t（浮点容差），避免重复；sorted 天然去重。
    void next;
  }
  return states;
}

export interface VoicePairCheck {
  time: number;
  lower: VoiceId;
  upper: VoiceId;
  lowerPitch: number;
  upperPitch: number;
  semitones: number;
  intervalLabel: string;
  quality: 'perfect' | 'imperfect' | 'dissonant';
}

/** 每个时刻所有发声声部两两之间的音程。 */
export function verticalIntervals(state: VerticalState, fourthConsonant = false): VoicePairCheck[] {
  const ids = (Object.keys(state.active) as VoiceId[]).sort(
    (a, b) => state.active[a]!.pitch - state.active[b]!.pitch,
  );
  const out: VoicePairCheck[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const lo = state.active[ids[i]]!;
      const hi = state.active[ids[j]]!;
      const info = intervalInfo(lo.pitch, hi.pitch, fourthConsonant);
      out.push({
        time: state.time,
        lower: ids[i],
        upper: ids[j],
        lowerPitch: lo.pitch,
        upperPitch: hi.pitch,
        semitones: info.semitones,
        intervalLabel: info.label,
        quality: info.quality,
      });
    }
  }
  return out;
}

/** 逐时刻检查表：用于 UI “逐时刻检查”面板与解释文本。 */
export interface MomentReport {
  time: number;
  measure: number;
  beat: number;
  strength: 'strong' | 'medium' | 'weak';
  entries: {
    voice: VoiceId;
    noteName: string;
    pitch: number;
    onset: number;
    duration: number;
    index: number;
  }[];
  pairs: VoicePairCheck[];
}

export function momentReports(score: Score, fourthConsonant = false): MomentReport[] {
  return timeline(score).map((st) => ({
    time: st.time,
    measure: st.measure,
    beat: st.beat,
    strength: st.strength,
    entries: (Object.keys(st.active) as VoiceId[])
      .sort((a, b) => st.active[a]!.pitch - st.active[b]!.pitch)
      .map((v) => {
        const n = st.active[v]!;
        return {
          voice: v,
          noteName: midiToName(n.pitch),
          pitch: n.pitch,
          onset: n.onset,
          duration: n.duration,
          index: n.index,
        };
      }),
    pairs: verticalIntervals(st, fourthConsonant),
  }));
}

export function soundingAt(score: Score, time: number): Partial<Record<VoiceId, Note>> {
  const out: Partial<Record<VoiceId, Note>> = {};
  for (const id of ['cf', 'u1', 'u2'] as VoiceId[]) {
    const hit = score.voices[id].notes.find((n) => n.onset <= time + 1e-9 && noteEnd(n) > time + 1e-9);
    if (hit) out[id] = hit;
  }
  return out;
}

export function normalizePitchToRange(pitch: number, low: number, high: number): number {
  let p = pitch;
  while (p < low) p += 12;
  while (p > high) p -= 12;
  return p;
}

export function diatonicView(score: Score): string {
  return score.voices.cf.notes.map((n) => midiToName(n.pitch)).join(' ');
}

export function allVoiceIds(): VoiceId[] {
  return ['cf', 'u1', 'u2'];
}

export function scaleConformance(score: Score): { voice: VoiceId; nonScale: number[] }[] {
  return allVoiceIds().map((id) => ({
    voice: id,
    nonScale: score.voices[id].notes
      .filter((n) => !isInScale(n.pitch, score.key))
      .map((n) => n.onset),
  }));
}
