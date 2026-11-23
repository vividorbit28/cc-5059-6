import { useCallback, useEffect, useRef, useState } from 'react';
import { playScore, renderScoreToWav, TIMBRES, type PlayHandle } from '../audio/synth.js';
import { scoreEnd, type Score, type VoiceId } from '../core/score.js';

export interface PlayerProps {
  score: Score;
  onPlayhead: (beat: number | null) => void;
}

export function Player({ score, onPlayhead }: PlayerProps) {
  const ctxRef = useRef<AudioContext | null>(null);
  const handleRef = useRef<PlayHandle | null>(null);
  const rafRef = useRef<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [mute, setMute] = useState<Record<VoiceId, boolean>>({ cf: false, u1: false, u2: false });
  const [solo, setSolo] = useState<Record<VoiceId, boolean>>({ cf: false, u1: false, u2: false });
  const [metronome, setMetronome] = useState(false);
  const [tempo, setTempo] = useState(score.tempo);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setTempo(score.tempo);
  }, [score.tempo]);

  const stop = useCallback(() => {
    handleRef.current?.stop();
    handleRef.current = null;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
    setPlaying(false);
    onPlayhead(null);
  }, [onPlayhead]);

  useEffect(() => () => stop(), [stop]);

  const ensureCtx = () => {
    if (!ctxRef.current) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      ctxRef.current = new Ctor();
    }
    if (ctxRef.current.state === 'suspended') void ctxRef.current.resume();
    return ctxRef.current;
  };

  const play = () => {
    stop();
    const audio = ensureCtx();
    const withTempo = { ...score, tempo };
    const handle = playScore(audio, withTempo, {
      mute: (Object.keys(mute) as VoiceId[]).filter((k) => mute[k]),
      solo: (Object.keys(solo) as VoiceId[]).filter((k) => solo[k]),
      metronome,
      onEnded: () => {
        setPlaying(false);
        onPlayhead(null);
      },
    });
    handleRef.current = handle;
    setPlaying(true);
    const tick = () => {
      if (!handleRef.current) return;
      onPlayhead(handleRef.current.position());
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  const totalBeats = Math.max(scoreEnd(score), 1);

  return (
    <div className="player" aria-label="多轨试听">
      <div className="transport">
        <button className="primary" onClick={playing ? stop : play}>
          {playing ? '停止' : '播放合奏'}
        </button>
        <label className="tempo">
          速度 {tempo} BPM
          <input
            type="range"
            min={40}
            max={160}
            value={tempo}
            onChange={(e) => setTempo(Number(e.target.value))}
            disabled={playing}
          />
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={metronome} onChange={(e) => setMetronome(e.target.checked)} />
          节拍器
        </label>
        <button
          className="secondary"
          disabled={exporting}
          onClick={async () => {
            setExporting(true);
            try {
              const blob = await renderScoreToWav({ ...score, tempo }, 44100, {
                mute: (Object.keys(mute) as VoiceId[]).filter((k) => mute[k]),
                solo: (Object.keys(solo) as VoiceId[]).filter((k) => solo[k]),
              });
              const url = URL.createObjectURL(blob);
              const a = document.createElement('a');
              a.href = url;
              a.download = 'counterpoint.wav';
              a.click();
              URL.revokeObjectURL(url);
            } finally {
              setExporting(false);
            }
          }}
        >
          {exporting ? '渲染中…' : '导出 WAV'}
        </button>
        <span className="muted small">总长 {totalBeats} 拍</span>
      </div>
      <div className="tracks">
        {(['cf', 'u1', 'u2'] as VoiceId[]).map((id) => (
          <div key={id} className={`track ${mute[id] ? 'muted' : ''} ${solo[id] ? 'solo' : ''}`}>
            <div className="track-name">
              <span className={`dot ${id}`} />
              {TIMBRES[id].name}
            </div>
            <div className="track-buttons">
              <button
                className={mute[id] ? 'chip active' : 'chip'}
                onClick={() => setMute((m) => ({ ...m, [id]: !m[id] }))}
                aria-label={`静音 ${id}`}
              >
                M
              </button>
              <button
                className={solo[id] ? 'chip active' : 'chip'}
                onClick={() => setSolo((s) => ({ ...s, [id]: !s[id] }))}
                aria-label={`独奏 ${id}`}
              >
                S
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
