import type { Note, Score, VoiceId } from '../core/score.js';

export interface VoiceTimbre {
  id: VoiceId;
  name: string;
  /** 基频波形类型。 */
  wave: OscillatorType;
  /** 谐波叠加增益，模拟不同声部音色。 */
  harmonics: { ratio: number; gain: number }[];
  gain: number;
  attack: number;
  release: number;
  pan: number;
}

export const TIMBRES: Record<VoiceId, VoiceTimbre> = {
  cf: {
    id: 'cf',
    name: '定旋律 · 大提琴',
    wave: 'triangle',
    harmonics: [
      { ratio: 1, gain: 1 },
      { ratio: 2, gain: 0.28 },
      { ratio: 3, gain: 0.12 },
    ],
    gain: 0.16,
    attack: 0.02,
    release: 0.09,
    pan: -0.25,
  },
  u1: {
    id: 'u1',
    name: '对位 I · 中提琴',
    wave: 'sawtooth',
    harmonics: [
      { ratio: 1, gain: 0.75 },
      { ratio: 2, gain: 0.22 },
      { ratio: 3, gain: 0.1 },
      { ratio: 4, gain: 0.05 },
    ],
    gain: 0.12,
    attack: 0.015,
    release: 0.07,
    pan: 0.15,
  },
  u2: {
    id: 'u2',
    name: '对位 II · 长笛',
    wave: 'sine',
    harmonics: [
      { ratio: 1, gain: 1 },
      { ratio: 3, gain: 0.18 },
      { ratio: 5, gain: 0.06 },
    ],
    gain: 0.1,
    attack: 0.03,
    release: 0.1,
    pan: 0.38,
  },
};

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export interface PlayHandle {
  stop: () => void;
  /** 当前播放位置（秒），用于界面同步。 */
  position: () => number;
  duration: number;
  voices: VoiceId[];
}

export interface PlayOptions {
  solo?: VoiceId[];
  mute?: VoiceId[];
  metronome?: boolean;
  onEnded?: () => void;
  /** 起始偏移（拍）。 */
  fromBeat?: number;
  masterGain?: number;
}

/**
 * 用 WebAudio 实时合成。音符直接从 Score 读取，不播放任何预置音频，
 * 因此试听内容必然与搜索结果一致。
 */
export function playScore(
  audio: AudioContext,
  score: Score,
  opts: PlayOptions = {},
): PlayHandle {
  const secondsPerBeat = 60 / (score.tempo || 84);
  const fromBeat = opts.fromBeat ?? 0;
  const startAt = audio.currentTime + 0.06;
  const master = audio.createGain();
  master.gain.value = opts.masterGain ?? 0.9;
  const compressor = audio.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 18;
  compressor.ratio.value = 3;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.18;
  master.connect(compressor);
  compressor.connect(audio.destination);

  const active: { osc: OscillatorNode[]; gain: GainNode }[] = [];
  const ids = (['cf', 'u1', 'u2'] as VoiceId[]).filter(
    (id) => !(opts.mute ?? []).includes(id) && (!opts.solo || opts.solo.length === 0 || opts.solo.includes(id)),
  );

  let duration = 0;
  for (const id of ids) {
    const timbre = TIMBRES[id];
    for (const n of score.voices[id].notes) {
      const onsetSec = (n.onset - fromBeat) * secondsPerBeat;
      if (n.onset + n.duration <= fromBeat) continue;
      const noteStart = Math.max(0, onsetSec);
      const noteEnd = Math.max(noteStart, (n.onset + n.duration - fromBeat) * secondsPerBeat);
      const playDur = noteEnd - noteStart;
      if (playDur <= 0.01) continue;
      duration = Math.max(duration, noteEnd);

      const noteGain = audio.createGain();
      const panner = audio.createStereoPanner();
      panner.pan.value = timbre.pan;
      const t0 = startAt + noteStart;
      const t1 = t0 + playDur;
      const atk = Math.min(timbre.attack, playDur * 0.3);
      const rel = Math.min(timbre.release, playDur * 0.5);
      noteGain.gain.setValueAtTime(0.0001, t0);
      noteGain.gain.exponentialRampToValueAtTime(timbre.gain, t0 + atk);
      noteGain.gain.setValueAtTime(timbre.gain, Math.max(t0 + atk, t1 - rel));
      noteGain.gain.exponentialRampToValueAtTime(0.0001, t1);
      noteGain.connect(panner);
      panner.connect(master);

      const oscs: OscillatorNode[] = [];
      for (const h of timbre.harmonics) {
        const osc = audio.createOscillator();
        osc.type = timbre.wave;
        osc.frequency.value = midiToHz(n.pitch) * h.ratio;
        const hg = audio.createGain();
        hg.gain.value = h.gain;
        osc.connect(hg);
        hg.connect(noteGain);
        osc.start(t0);
        osc.stop(t1 + 0.02);
        oscs.push(osc);
      }
      active.push({ osc: oscs, gain: noteGain });
    }
  }

  if (opts.metronome) {
    for (let b = Math.ceil(fromBeat); b <= fromBeat + duration / secondsPerBeat + 0.001; b++) {
      const t = startAt + (b - fromBeat) * secondsPerBeat;
      if (t > startAt + duration) break;
      const beatInBar = ((b % score.beatsPerMeasure) + score.beatsPerMeasure) % score.beatsPerMeasure;
      const click = audio.createOscillator();
      click.type = 'square';
      click.frequency.value = beatInBar === 0 ? 1600 : 1000;
      const g = audio.createGain();
      g.gain.setValueAtTime(beatInBar === 0 ? 0.09 : 0.05, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.04);
      click.connect(g);
      g.connect(master);
      click.start(t);
      click.stop(t + 0.05);
    }
  }

  let stopped = false;
  const timer = window.setTimeout(() => {
    if (!stopped) opts.onEnded?.();
  }, Math.max(0, (startAt + duration - audio.currentTime) * 1000) + 80);

  return {
    duration,
    voices: ids,
    position: () => Math.max(0, audio.currentTime - startAt) / secondsPerBeat + fromBeat,
    stop: () => {
      if (stopped) return;
      stopped = true;
      window.clearTimeout(timer);
      const now = audio.currentTime;
      for (const a of active) {
        try {
          a.gain.gain.cancelScheduledValues(now);
          a.gain.gain.setTargetAtTime(0.0001, now, 0.02);
        } catch {
          /* 已停止 */
        }
        for (const o of a.osc) {
          try {
            o.stop(now + 0.06);
          } catch {
            /* 已停止 */
          }
        }
      }
    },
  };
}

/** 渲染为 WAV，用于导出或离线检查（不依赖实时播放）。 */
export async function renderScoreToWav(
  score: Score,
  sampleRate = 44100,
  opts: PlayOptions = {},
): Promise<Blob> {
  const secondsPerBeat = 60 / (score.tempo || 84);
  const beats = Math.max(0, ...(['cf', 'u1', 'u2'] as VoiceId[]).map((id) => maxEnd(score.voices[id].notes)));
  const total = beats * secondsPerBeat + 0.4;
  const length = Math.ceil(total * sampleRate);
  const buffers: Record<string, Float32Array> = {};
  const ids = (['cf', 'u1', 'u2'] as VoiceId[]).filter(
    (id) => !(opts.mute ?? []).includes(id) && (!opts.solo || opts.solo.length === 0 || opts.solo.includes(id)),
  );
  for (const id of ids) {
    buffers[id] = new Float32Array(length);
    const t = TIMBRES[id];
    for (const n of score.voices[id].notes) {
      const start = Math.floor(n.onset * secondsPerBeat * sampleRate);
      const dur = Math.max(1, Math.floor(n.duration * secondsPerBeat * sampleRate));
      const atk = Math.max(1, Math.floor(t.attack * sampleRate));
      const rel = Math.max(1, Math.floor(t.release * sampleRate));
      const freq = midiToHz(n.pitch);
      for (let i = 0; i < dur && start + i < length; i++) {
        let env: number;
        if (i < atk) env = i / atk;
        else if (i > dur - rel) env = (dur - i) / rel;
        else env = 1;
        let sample = 0;
        for (const h of t.harmonics) {
          sample += Math.sin((2 * Math.PI * freq * h.ratio * i) / sampleRate) * h.gain;
        }
        buffers[id][start + i] += sample * env * t.gain;
      }
    }
  }
  const left = new Float32Array(length);
  const right = new Float32Array(length);
  for (const id of ids) {
    const pan = TIMBRES[id].pan;
    const lg = Math.cos(((pan + 1) * Math.PI) / 4);
    const rg = Math.sin(((pan + 1) * Math.PI) / 4);
    for (let i = 0; i < length; i++) {
      left[i] += buffers[id][i] * lg;
      right[i] += buffers[id][i] * rg;
    }
  }
  let peak = 0;
  for (let i = 0; i < length; i++) peak = Math.max(peak, Math.abs(left[i]), Math.abs(right[i]));
  const norm = peak > 0 ? 0.88 / peak : 1;
  const channels = 2;
  const bytesPerSample = 2;
  const dataSize = length * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < length; i++) {
    const l = Math.max(-1, Math.min(1, left[i] * norm));
    const r = Math.max(-1, Math.min(1, right[i] * norm));
    view.setInt16(off, l < 0 ? l * 0x8000 : l * 0x7fff, true);
    view.setInt16(off + 2, r < 0 ? r * 0x8000 : r * 0x7fff, true);
    off += 4;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

function maxEnd(notes: Note[]): number {
  return notes.reduce((m, n) => Math.max(m, n.onset + n.duration), 0);
}

/** 供 UI 显示每条声部的音量表（按音符数量估算，仅用于视觉反馈）。 */
export function voiceActivity(score: Score, time: number): Record<VoiceId, number> {
  const out: Record<VoiceId, number> = { cf: 0, u1: 0, u2: 0 };
  for (const id of ['cf', 'u1', 'u2'] as VoiceId[]) {
    const n = score.voices[id].notes.find(
      (x) => x.onset <= time + 1e-6 && x.onset + x.duration > time + 1e-6,
    );
    if (n) out[id] = Math.min(1, 0.25 + n.duration / 8);
  }
  return out;
}
