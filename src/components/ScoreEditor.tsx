import { useEffect, useMemo, useRef, useState } from 'react';
import {
  momentReports,
  scoreEnd,
  timeline,
  type MomentReport,
  type Note,
  type Score,
  type VoiceId,
} from '../core/score.js';
import { midiToName, parsePitch } from '../core/pitch.js';
import type { Violation } from '../core/analyze.js';

export interface ScoreEditorProps {
  score: Score;
  onChange: (score: Score) => void;
  selectedTime: number | null;
  onSelectTime: (t: number | null) => void;
  violations: Violation[];
  playheadBeat: number | null;
  editable?: Partial<Record<VoiceId, boolean>>;
  highlights?: { voice: VoiceId; onset: number; pitch: number; tone: 'error' | 'warning' | 'info' }[];
}

const BEATS_PER_MEASURE = 4;
const PX_PER_BEAT = 96;
const ROW_H = 54;

const VOICE_LABEL: Record<VoiceId, string> = { cf: '定旋律', u1: '对位 I', u2: '对位 II' };
const VOICE_COLOR: Record<VoiceId, string> = {
  cf: '#7dd3fc',
  u1: '#fca5a5',
  u2: '#c4b5fd',
};

export function ScoreEditor(props: ScoreEditorProps) {
  const { score, selectedTime, onSelectTime, violations, playheadBeat, highlights = [] } = props;
  const moments = useMemo(() => momentReports(score), [score]);
  const endBeat = Math.max(scoreEnd(score), score.beatsPerMeasure);
  const measures = Math.ceil(endBeat / score.beatsPerMeasure) || 1;
  const width = measures * score.beatsPerMeasure * PX_PER_BEAT + 120;
  const [drag, setDrag] = useState<{ voice: VoiceId; index: number; startX: number; startY: number } | null>(null);

  const selectedMoment: MomentReport | null = useMemo(() => {
    if (selectedTime === null) return null;
    return (
      moments.find((m) => Math.abs(m.time - selectedTime) < 1e-6) ??
      moments.find((m) => m.time <= selectedTime && m.time + 0.5 > selectedTime) ??
      null
    );
  }, [moments, selectedTime]);

  const gridLines = [];
  for (let m = 0; m < measures; m++) {
    gridLines.push(
      <g key={`m${m}`}>
        <rect
          x={60 + m * score.beatsPerMeasure * PX_PER_BEAT}
          y={0}
          width={score.beatsPerMeasure * PX_PER_BEAT}
          height={ROW_H * 3 + 20}
          fill={m % 2 === 0 ? 'rgba(255,255,255,0.015)' : 'transparent'}
        />
        {Array.from({ length: score.beatsPerMeasure }).map((_, b) => (
          <line
            key={b}
            x1={60 + (m * score.beatsPerMeasure + b) * PX_PER_BEAT}
            y1={0}
            x2={60 + (m * score.beatsPerMeasure + b) * PX_PER_BEAT}
            y2={ROW_H * 3 + 12}
            stroke={b === 0 ? 'rgba(226,232,240,0.35)' : 'rgba(226,232,240,0.12)'}
            strokeWidth={b === 0 ? 1.5 : 1}
          />
        ))}
        <text x={60 + m * score.beatsPerMeasure * PX_PER_BEAT + 6} y={12} fontSize={10} fill="#94a3b8">
          {m + 1}
        </text>
      </g>,
    );
  }

  function setNote(voice: VoiceId, index: number, patch: Partial<Note>) {
    const next: Score = {
      ...score,
      voices: {
        ...score.voices,
        [voice]: {
          ...score.voices[voice],
          notes: score.voices[voice].notes.map((n, i) => (i === index ? { ...n, ...patch } : n)),
        },
      },
    };
    props.onChange(next);
  }

  return (
    <div className="score-editor">
      <div className="score-scroll">
        <svg width={width} height={ROW_H * 3 + 40} className="score-svg">
          {gridLines}
          {playheadBeat !== null && (
            <line
              x1={60 + playheadBeat * PX_PER_BEAT}
              y1={0}
              x2={60 + playheadBeat * PX_PER_BEAT}
              y2={ROW_H * 3 + 12}
              stroke="#fbbf24"
              strokeWidth={2}
              opacity={0.85}
            />
          )}
          {(['cf', 'u1', 'u2'] as VoiceId[]).map((voice, row) => {
            const top = row * ROW_H + 22;
            const canEdit = props.editable?.[voice] ?? false;
            const notes = [...score.voices[voice].notes].sort((a, b) => a.onset - b.onset);
            return (
              <g key={voice}>
                <text x={8} y={top + 18} fontSize={11} fill={VOICE_COLOR[voice]} fontWeight={600}>
                  {VOICE_LABEL[voice]}
                </text>
                {notes.map((n, i) => {
                  const x = 60 + n.onset * PX_PER_BEAT;
                  const w = Math.max(18, n.duration * PX_PER_BEAT - 4);
                  const hl = highlights.find(
                    (h) => h.voice === voice && h.onset === n.onset && h.pitch === n.pitch,
                  );
                  const isSel =
                    selectedMoment?.entries.some(
                      (e) => e.voice === voice && Math.abs(e.onset - n.onset) < 1e-6,
                    ) ?? false;
                  const stroke = hl
                    ? hl.tone === 'error'
                      ? '#f87171'
                      : hl.tone === 'warning'
                        ? '#fbbf24'
                        : '#60a5fa'
                    : isSel
                      ? '#fbbf24'
                      : 'rgba(255,255,255,0.18)';
                  return (
                    <g
                      key={i}
                      className={canEdit ? 'note-editable' : ''}
                      onPointerDown={(ev) => {
                        ev.stopPropagation();
                        onSelectTime(n.onset);
                        if (canEdit) {
                          setDrag({ voice, index: i, startX: ev.clientX, startY: ev.clientY });
                          (ev.target as Element).setPointerCapture?.(ev.pointerId);
                        }
                      }}
                      onPointerMove={(ev) => {
                        if (!drag || drag.voice !== voice || drag.index !== i) return;
                        const dy = ev.clientY - drag.startY;
                        const dx = ev.clientX - drag.startX;
                        if (Math.abs(dy) < 6 && Math.abs(dx) < 12) return;
                        if (Math.abs(dy) >= Math.abs(dx)) {
                          const semis = Math.round(-dy / 14);
                          if (semis !== 0) {
                            setNote(voice, i, { pitch: clamp(n.pitch + semis) });
                            setDrag({ ...drag, startY: ev.clientY });
                          }
                        } else {
                          const beats = Math.round(dx / PX_PER_BEAT);
                          if (beats !== 0) {
                            setNote(voice, i, { onset: Math.max(0, round2(n.onset + beats)) });
                            setDrag({ ...drag, startX: ev.clientX });
                          }
                        }
                      }}
                      onPointerUp={() => setDrag(null)}
                    >
                      <rect
                        x={x}
                        y={top + 4}
                        width={w}
                        height={26}
                        rx={5}
                        fill={hl ? 'rgba(248,113,113,0.14)' : 'rgba(15,23,42,0.85)'}
                        stroke={stroke}
                        strokeWidth={hl || isSel ? 2 : 1}
                      />
                      <text
                        x={x + 5}
                        y={top + 21}
                        fontSize={12}
                        fill="#e2e8f0"
                        style={{ userSelect: 'none', pointerEvents: 'none' }}
                      >
                        {midiToName(n.pitch)}
                      </text>
                    </g>
                  );
                })}
              </g>
            );
          })}
          {[0, 1, 2, 3].map((b) => (
            <text
              key={b}
              x={60 + b * PX_PER_BEAT + 4}
              y={ROW_H * 3 + 34}
              fontSize={9}
              fill="#64748b"
            >
              第{b + 1}拍
            </text>
          ))}
        </svg>
      </div>
      {selectedMoment && (
        <MomentInspector
          moment={selectedMoment}
          violations={violations}
          onClose={() => onSelectTime(null)}
          editable={props}
          score={score}
        />
      )}
    </div>
  );
}

interface MomentInspectorProps {
  moment: MomentReport;
  violations: Violation[];
  onClose: () => void;
  editable: ScoreEditorProps;
  score: Score;
}

function MomentInspector({ moment, violations, onClose, editable, score }: MomentInspectorProps) {
  const relevant = violations.filter((v) => Math.abs(v.time - moment.time) < 1e-6);
  return (
    <div className="moment-inspector" role="region" aria-label="逐时刻检查">
      <div className="moment-head">
        <strong>
          第 {moment.measure + 1} 小节 · 第 {(moment.beat + 1).toFixed(2)} 拍
        </strong>
        <span className={`pill ${moment.strength}`}>
          {moment.strength === 'strong' ? '强拍' : moment.strength === 'medium' ? '次强拍' : '弱拍'}
        </span>
        <button className="ghost small" onClick={onClose}>
          关闭
        </button>
      </div>
      <table className="data-table compact">
        <thead>
          <tr>
            <th>声部</th>
            <th>音</th>
            <th>起始</th>
            <th>时值</th>
            <th>下标</th>
          </tr>
        </thead>
        <tbody>
          {moment.entries.map((e) => (
            <tr key={e.voice}>
              <td style={{ color: VOICE_COLOR[e.voice] }}>{VOICE_LABEL[e.voice]}</td>
              <td>
                <PitchEditor
                  notePitch={e.pitch}
                  enabled={editable.editable?.[e.voice] ?? false}
                  onCommit={(p) => {
                    const voiceNotes = score.voices[e.voice].notes;
                    const sorted = [...voiceNotes].sort((a, b) => a.onset - b.onset);
                    const idx = sorted.findIndex((n) => Math.abs(n.onset - e.onset) < 1e-6);
                    if (idx < 0) return;
                    const originalIdx = voiceNotes.findIndex(
                      (n) => Math.abs(n.onset - e.onset) < 1e-6,
                    );
                    const next = {
                      ...score,
                      voices: {
                        ...score.voices,
                        [e.voice]: {
                          ...score.voices[e.voice],
                          notes: voiceNotes.map((n, i) =>
                            i === originalIdx ? { ...n, pitch: p } : n,
                          ),
                        },
                      },
                    };
                    editable.onChange(next);
                  }}
                />
              </td>
              <td>{e.onset}</td>
              <td>{e.duration}</td>
              <td>{e.index}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="pairs">
        {moment.pairs.length === 0 && <div className="muted">该时刻只有一个声部发声。</div>}
        {moment.pairs.map((p, i) => (
          <div key={i} className={`pair-chip ${p.quality}`}>
            {VOICE_LABEL[p.lower]} {midiToName(p.lowerPitch)} ↔ {VOICE_LABEL[p.upper]}{' '}
            {midiToName(p.upperPitch)}：<b>{p.intervalLabel}</b>
          </div>
        ))}
      </div>
      <div className="violation-list">
        {relevant.length === 0 ? (
          <div className="ok-line">该时刻未命中任何规则。</div>
        ) : (
          relevant.map((v, i) => (
            <div key={i} className={`violation ${v.severity}`}>
              <div className="violation-title">
                <span className={`sev ${v.severity}`}>{sevLabel(v.severity)}</span>
                {v.ruleLabel}
                {v.dissonance && <span className="kind">{kindLabel(v.dissonance.kind)}</span>}
              </div>
              <div>{v.message}</div>
              <div className="muted small">{v.detail}</div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function PitchEditor({
  notePitch,
  enabled,
  onCommit,
}: {
  notePitch: number;
  enabled: boolean;
  onCommit: (p: number) => void;
}) {
  const [text, setText] = useState(midiToName(notePitch));
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setText(midiToName(notePitch)), [notePitch]);
  if (!enabled) return <span>{midiToName(notePitch)}</span>;
  return (
    <span className="pitch-editor">
      <input
        value={text}
        size={5}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
        aria-label="音高"
      />
      {err && <span className="field-error">{err}</span>}
    </span>
  );
  function commit() {
    const p = parsePitch(text);
    if (p === null) {
      setErr('格式如 C4');
      return;
    }
    setErr(null);
    onCommit(p);
  }
}

function sevLabel(s: 'error' | 'warning' | 'info'): string {
  return s === 'error' ? '错误' : s === 'warning' ? '警告' : '提示';
}

function kindLabel(k: string): string {
  const map: Record<string, string> = {
    consonant: '协和',
    passing: '经过音',
    neighbor: '辅助音',
    suspension: '延留音',
    'prepared-suspension': '未解决延留',
    pending: '待定',
    unexplained: '无法解释',
  };
  return map[k] ?? k;
}

function clamp(p: number): number {
  return Math.max(0, Math.min(127, p));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function ScoreTimelineStrip({ score, selected, onSelect }: { score: Score; selected: number | null; onSelect: (t: number) => void }) {
  const states = useMemo(() => timeline(score), [score]);
  return (
    <div className="timeline-strip">
      {states.map((st, i) => (
        <button
          key={i}
          className={`tick ${st.strength} ${selected !== null && Math.abs(selected - st.time) < 1e-6 ? 'active' : ''}`}
          onClick={() => onSelect(st.time)}
          title={`t=${st.time}`}
        >
          {st.time}
        </button>
      ))}
    </div>
  );
}
