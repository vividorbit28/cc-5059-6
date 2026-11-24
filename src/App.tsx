import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_RULES,
  DEFAULT_VOICES,
  EXAMPLES,
  KEY_PRESETS,
  RHYTHM_PRESETS,
  type CounterpointRules,
  type ExampleId,
  type HistoryPolicy,
  type RhythmSpec,
} from './core/rules.js';
import { keyName, midiToName, parsePitch } from './core/pitch.js';
import {
  assignmentToNotes,
  fmtTime,
  historySummary,
  type AnalysisContext,
  type Violation,
} from './core/analyze.js';
import {
  buildExample,
  buildScoreFromParts,
  compareHistorySemantics,
  diagnoseScore,
  scoreFromSolution,
  type ExampleDiagnosis,
  type SemanticComparison,
} from './core/examples.js';
import { parseMelody } from './core/plan.js';
import { search, type SearchResult, type SearchSolution } from './core/search.js';
import {
  defaultRosters,
  planRehearsal,
  rehearsalAnomalyGroups,
  type RehearsalConfig,
} from './core/rehearsal.js';
import { makeVoice, type Note, type Score, type VoiceId } from './core/score.js';
import { ScoreEditor } from './components/ScoreEditor.js';
import { RulePanel } from './components/RulePanel.js';
import { SearchPanel, ViolationList } from './components/SearchPanel.js';
import { Player } from './components/Player.js';
import { RehearsalPanel } from './components/RehearsalPanel.js';

const INITIAL_EXAMPLE = EXAMPLES.find((e) => e.id === 'feasible')!;

export default function App() {
  const [exampleId, setExampleId] = useState<ExampleId>('feasible');
  const [keyId, setKeyId] = useState<string>('C-major');
  const [rules, setRules] = useState<CounterpointRules>({ ...DEFAULT_RULES });
  const [historyPolicy, setHistoryPolicy] = useState<HistoryPolicy>('carry');
  const [cfText, setCfText] = useState(INITIAL_EXAMPLE.cfText);
  const [u1Text, setU1Text] = useState('');
  const [u2Text, setU2Text] = useState('');
  const [rhythmU1Id, setRhythmU1Id] = useState('half');
  const [rhythmU2Id, setRhythmU2Id] = useState('half');
  const [u1Range, setU1Range] = useState(DEFAULT_VOICES.u1);
  const [u2Range, setU2Range] = useState(DEFAULT_VOICES.u2);
  const [maxSolutions, setMaxSolutions] = useState(10);
  // 是否启用“排练器反向否决”：把歌手的可唱音域作为搜索的额外边界。
  const [rehearsalVeto, setRehearsalVeto] = useState(true);

  const [score, setScore] = useState<Score>(() => buildExample(INITIAL_EXAMPLE).score);
  const [diagnosis, setDiagnosis] = useState<ExampleDiagnosis | null>(null);
  const [result, setResult] = useState<SearchResult | null>(null);
  const [selectedSolutionId, setSelectedSolutionId] = useState<string | null>(null);
  const [comparison, setComparison] = useState<SemanticComparison | null>(null);
  const [comparing, setComparing] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selectedTime, setSelectedTime] = useState<number | null>(null);
  const [playhead, setPlayhead] = useState<number | null>(null);
  const [status, setStatus] = useState<string>('');
  const [editable, setEditable] = useState<Partial<Record<VoiceId, boolean>>>({
    cf: true,
    u1: true,
    u2: true,
  });
  const [showExamples, setShowExamples] = useState(false);

  const key = useMemo(
    () => KEY_PRESETS.find((k) => k.id === keyId)?.key ?? { tonicPc: 0, mode: 'major' as const },
    [keyId],
  );

  const cfParsed = useMemo(() => parseMelody(cfText), [cfText]);
  const rhythmU1 = useMemo(
    () => RHYTHM_PRESETS.find((r) => r.id === rhythmU1Id)?.spec ?? ({ kind: 'fixed', duration: 2 } as RhythmSpec),
    [rhythmU1Id],
  );
  const rhythmU2 = useMemo(
    () => RHYTHM_PRESETS.find((r) => r.id === rhythmU2Id)?.spec ?? ({ kind: 'fixed', duration: 2 } as RhythmSpec),
    [rhythmU2Id],
  );

  // 排练编制：按当前声部音域生成歌手，供分谱与搜索反向否决共用。
  const rehearsalRanges = useMemo(
    () => ({
      cf: { low: score.voices.cf.low, high: score.voices.cf.high, name: '定旋律' },
      u1: { low: u1Range.low, high: u1Range.high, name: u1Range.name },
      u2: { low: u2Range.low, high: u2Range.high, name: u2Range.name },
    }),
    [score.voices.cf.low, score.voices.cf.high, u1Range, u2Range],
  );
  const rehearsalConfig = useMemo<RehearsalConfig>(
    () => defaultRosters(rehearsalRanges, 4),
    [rehearsalRanges],
  );
  const rehearsalPlan = useMemo(
    () => planRehearsal(score, rehearsalConfig, rules),
    [score, rehearsalConfig, rules],
  );
  const rehearsalAnomalies = useMemo(
    () => rehearsalAnomalyGroups(rehearsalPlan),
    [rehearsalPlan],
  );

  // 手动编辑后重新诊断（不重新搜索）。
  const diagForScore = useMemo(() => {
    if (!score || score.voices.cf.notes.length === 0) return null;
    return diagnoseScore(score, rules, historyPolicy);
  }, [score, rules, historyPolicy]);

  const currentDiagnosis = diagForScore ?? diagnosis;

  const runSearch = useCallback(() => {
    if (cfParsed.errors.length > 0) {
      setStatus(`定旋律解析失败：${cfParsed.errors.join('；')}`);
      return;
    }
    if (cfParsed.notes.length === 0) {
      setStatus('请输入定旋律，例如 C3:4 D3:4 E3:4 C3:4。');
      return;
    }
    setSearching(true);
    setStatus('搜索中…');
    // 用 setTimeout 让界面先渲染“搜索中”
    window.setTimeout(() => {
      try {
        const res = search({
          key,
          beatsPerMeasure: 4,
          rules,
          historyPolicy,
          cfNotes: cfParsed.notes,
          u1: u1Range,
          u2: u2Range,
          rhythmU1,
          rhythmU2,
          maxSolutions,
          maxNodes: 160000,
          timeBudgetMs: 5000,
          rehearsal: rehearsalVeto ? rehearsalConfig : undefined,
        });
        setResult(res);
        setSelectedSolutionId(res.solutions[0]?.id ?? null);
        setComparison(null);
        if (res.solutions[0]) {
          const s = scoreFromSolution(cfParsed.notes, res.solutions[0], {
            key,
            beatsPerMeasure: 4,
            u1Name: u1Range.name,
            u2Name: u2Range.name,
            u1Range,
            u2Range,
            tempo: score.tempo,
          });
          setScore(s);
        } else {
          const s = buildScoreFromParts(cfParsed.notes, [], [], {
            key,
            beatsPerMeasure: 4,
            tempo: score.tempo,
          });
          setScore(s);
        }
        setStatus(res.message);
      } catch (err) {
        setStatus(`搜索失败：${(err as Error).message}`);
      } finally {
        setSearching(false);
      }
    }, 20);
  }, [cfParsed, key, rules, historyPolicy, u1Range, u2Range, rhythmU1, rhythmU2, maxSolutions, score.tempo, rehearsalVeto, rehearsalConfig]);

  const adoptSolution = (sol: SearchSolution) => {
    const s = scoreFromSolution(cfParsed.notes, sol, {
      key,
      beatsPerMeasure: 4,
      u1Name: u1Range.name,
      u2Name: u2Range.name,
      u1Range,
      u2Range,
      tempo: score.tempo,
    });
    setScore(s);
    setSelectedSolutionId(sol.id);
    setStatus(`已采用 ${sol.id}。现在可以直接拖动/编辑音符，逐时刻检查会实时更新。`);
  };

  const runComparison = () => {
    if (cfParsed.notes.length === 0) {
      setStatus('请先输入定旋律。');
      return;
    }
    setComparing(true);
    window.setTimeout(() => {
      try {
        const base = {
          key,
          beatsPerMeasure: 4,
          rules,
          cfNotes: cfParsed.notes,
          u1: u1Range,
          u2: u2Range,
          rhythmU1,
          rhythmU2,
          maxSolutions,
          maxNodes: 120000,
          timeBudgetMs: 4500,
        };
        const carry = search({ ...base, historyPolicy: 'carry' });
        const truncate = search({ ...base, historyPolicy: 'truncate' });
        setComparison(
          compareHistorySemantics(carry, truncate, rules, key, 4),
        );
      } finally {
        setComparing(false);
      }
    }, 20);
  };

  const loadExample = (id: ExampleId) => {
    const spec = EXAMPLES.find((e) => e.id === id);
    if (!spec) return;
    setExampleId(id);
    setCfText(spec.cfText);
    setU1Text(spec.u1Text ?? '');
    setU2Text(spec.u2Text ?? '');
    if (spec.rhythmU1) setRhythmU1Id(rhythmIdFor(spec.rhythmU1));
    if (spec.rhythmU2) setRhythmU2Id(rhythmIdFor(spec.rhythmU2));
    if (spec.historyPolicy) setHistoryPolicy(spec.historyPolicy);
    setRules({ ...DEFAULT_RULES, ...(spec.ruleOverrides ?? {}) });
    const kp = KEY_PRESETS.find(
      (k) => k.key.tonicPc === spec.key.tonicPc && k.key.mode === spec.key.mode,
    );
    if (kp) setKeyId(kp.id);
    const built = buildExample(spec);
    setScore(built.score);
    setDiagnosis(null);
    setResult(null);
    setComparison(null);
    setSelectedSolutionId(null);
    setStatus(built.notes[0] ?? '');
    setShowExamples(false);
  };

  const highlights = useMemo(() => {
    if (!currentDiagnosis) return [];
    const out: { voice: VoiceId; onset: number; pitch: number; tone: 'error' | 'warning' | 'info' }[] = [];
    for (const v of currentDiagnosis.violations) {
      const tone = v.severity === 'error' ? 'error' : v.severity === 'warning' ? 'warning' : 'info';
      for (const n of v.notes) {
        const note = score.voices[n.voice]?.notes
          ? [...score.voices[n.voice].notes].sort((a, b) => a.onset - b.onset)[n.index]
          : undefined;
        if (note) out.push({ voice: n.voice, onset: note.onset, pitch: note.pitch, tone });
      }
    }
    return out;
  }, [currentDiagnosis, score]);

  const onScoreChange = (next: Score) => {
    setScore(next);
    setSelectedSolutionId(null);
  };

  const searchDisagreement = useMemo(() => {
    if (!result || !currentDiagnosis) return null;
    const errors = currentDiagnosis.violations.filter((v) => v.severity === 'error');
    if (errors.length === 0) return null;
    return errors;
  }, [result, currentDiagnosis]);

  return (
    <div className="app">
      <header className="topbar">
        <div>
          <h1>对位实验室 · 双声部约束搜索</h1>
          <p className="subtitle">
            给定定旋律与有限风格规则，搜索两条对位声部；纵向按实际重叠区间检查，逐时刻解释每条判决。
          </p>
        </div>
        <div className="top-actions">
          <span
            className={`search-state ${searching ? 'busy' : result ? 'done' : 'idle'}`}
            aria-live="polite"
          >
            {searching
              ? '对位搜索运行中…'
              : result
                ? `对位搜索完成 · ${result.solutions.length} 条解`
                : '尚未运行对位搜索'}
          </span>
          <button className="secondary" onClick={() => setShowExamples((v) => !v)}>
            {showExamples ? '收起谱例' : '打开谱例与演示'}
          </button>
        </div>
      </header>

      {showExamples && (
        <section className="panel examples">
          <div className="examples-grid">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.id}
                className={`example-card ${exampleId === ex.id ? 'active' : ''} ${ex.kind}`}
                onClick={() => loadExample(ex.id)}
              >
                <div className="example-kind">
                  {ex.kind === 'valid' ? '可行' : ex.kind === 'invalid' ? '矛盾' : '演示'}
                </div>
                <b>{ex.label}</b>
                <p>{ex.description}</p>
                {ex.focus && <div className="focus">判定要点：{ex.focus}</div>}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="layout">
        <aside className="left">
          <section className="panel input-panel">
            <header className="panel-head">
              <h2>定旋律与节奏</h2>
              <span className="muted small">{keyName(key)} · 4/4</span>
            </header>

            <label className="field">
              <span>调式</span>
              <select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
                {KEY_PRESETS.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="field">
              <span>定旋律（低音声部）</span>
              <textarea
                rows={2}
                value={cfText}
                onChange={(e) => setCfText(e.target.value)}
                spellCheck={false}
              />
              <small className="muted">
                记法：<code>音高:时值</code>，如 <code>C3:4 D3:4</code>（时值以拍计，4/4 每小节 4 拍）。
                休止写 <code>r:2</code>。
              </small>
              {cfParsed.errors.length > 0 && (
                <small className="field-error">{cfParsed.errors.join('；')}</small>
              )}
            </label>

            <div className="field-row">
              <label className="field">
                <span>对位 I 节奏</span>
                <select value={rhythmU1Id} onChange={(e) => setRhythmU1Id(e.target.value)}>
                  {RHYTHM_PRESETS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>对位 II 节奏</span>
                <select value={rhythmU2Id} onChange={(e) => setRhythmU2Id(e.target.value)}>
                  {RHYTHM_PRESETS.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <div className="field-row">
              <RangeField label="对位 I 音域" value={u1Range} onChange={setU1Range} />
              <RangeField label="对位 II 音域" value={u2Range} onChange={setU2Range} />
            </div>

            <label className="field">
              <span>最多返回解数：{maxSolutions}</span>
              <input
                type="range"
                min={1}
                max={20}
                value={maxSolutions}
                onChange={(e) => setMaxSolutions(Number(e.target.value))}
              />
            </label>

            <label className="checkbox small">
              <input
                type="checkbox"
                checked={rehearsalVeto}
                onChange={(e) => setRehearsalVeto(e.target.checked)}
              />
              排练器反向否决（下一小节换人后解决音不可唱则否决上小节候选）
            </label>

            <button className="primary wide" onClick={runSearch} disabled={searching}>
              {searching ? '搜索中…' : '搜索两条对位声部'}
            </button>
            {status && <div className="status-line">{status}</div>}
          </section>

          <RulePanel
            rules={rules}
            onChange={setRules}
            historyPolicy={historyPolicy}
            onHistoryChange={setHistoryPolicy}
            stats={result?.stats}
          />
        </aside>

        <main className="center">
          <section className="panel score-panel">
            <header className="panel-head">
              <h2>可编辑乐谱</h2>
              <div className="score-tools">
                {(['cf', 'u1', 'u2'] as VoiceId[]).map((id) => (
                  <label key={id} className="checkbox small">
                    <input
                      type="checkbox"
                      checked={editable[id] ?? false}
                      onChange={(e) => setEditable((s) => ({ ...s, [id]: e.target.checked }))}
                    />
                    编辑 {id === 'cf' ? '定旋律' : id === 'u1' ? '对位 I' : '对位 II'}
                  </label>
                ))}
              </div>
            </header>
            <ScoreEditor
              score={score}
              onChange={onScoreChange}
              selectedTime={selectedTime}
              onSelectTime={setSelectedTime}
              violations={currentDiagnosis?.violations ?? []}
              playheadBeat={playhead}
              editable={editable}
              highlights={highlights}
            />
            <p className="muted small">
              拖动音符上下改音高、左右改起始（以拍为单位）；点击任意音符查看该时刻的纵向音程与规则命中。
            </p>
          </section>

          <section className="panel play-panel">
            <header className="panel-head">
              <h2>多轨试听</h2>
              <span className="muted small">
                三条声部由 WebAudio 实时合成，内容直接来自左侧“可编辑乐谱”。
              </span>
            </header>
            {rehearsalAnomalies.playbackIssues.length > 0 && (
              <div className="callout warn">
                多轨试听异常 {rehearsalAnomalies.playbackIssues.length} 处：
                {rehearsalAnomalies.playbackIssues.map((a) => a.message).join('；')}
              </div>
            )}
            <Player score={score} onPlayhead={setPlayhead} />
          </section>

          <RehearsalPanel plan={rehearsalPlan} score={score} />

          <SearchPanel
            result={result}
            selectedSolutionId={selectedSolutionId}
            onSelectSolution={(id) => {
              setSelectedSolutionId(id);
              const sol = result?.solutions.find((s) => s.id === id);
              if (sol) adoptSolution(sol);
            }}
            onAdopt={adoptSolution}
            comparison={comparison}
            onCompareHistory={runComparison}
            comparing={comparing}
            historyPolicy={historyPolicy}
          />
        </main>

        <aside className="right">
          <section className="panel diag-panel">
            <header className="panel-head">
              <h2>逐时刻检查与规则命中</h2>
            </header>
            <DiagnosisSummary diagnosis={currentDiagnosis} onTime={setSelectedTime} score={score} />
          </section>

          <section className="panel">
            <header className="panel-head">
              <h2>搜索可信度</h2>
            </header>
            {!result ? (
              <p className="muted small">尚未运行搜索。上方“搜索结果”面板此时不会显示任何伪造的解。</p>
            ) : (
              <ul className="facts">
                <li>
                  本次搜索 <b>{result.stats.nodes}</b> 个节点，剪枝总次数{' '}
                  <b>{Object.values(result.stats.pruned).reduce<number>((a, b) => a + (b ?? 0), 0)}</b>。
                </li>
                <li>
                  停止原因：<b>{result.stats.stopReason}</b>
                  {result.stats.truncated && '（结果可能不完整）'}
                </li>
                <li>
                  每条解都经过完整校验：搜索期剪枝与最终检查使用同一套规则函数。
                </li>
                <li>
                  纵向关系按实际重叠区间判定；
                  {result.solutions[0]?.historyTrail.length
                    ? `本次搜索在 ${result.solutions[0].historyTrail.length} 个事件边界携带了历史。`
                    : '本次搜索无跨事件历史。'}
                </li>
              </ul>
            )}
            {currentDiagnosis && currentDiagnosis.trap.actual.length > 0 && (
              <div className="callout">
                {currentDiagnosis.trap.explanation}
              </div>
            )}
            {searchDisagreement && (
              <div className="callout warn">
                当前乐谱在搜索之外发生了手动编辑，导致出现 {searchDisagreement.length}{' '}
                处规则违反。搜索结果本身仍是当时找到的解。
              </div>
            )}
          </section>
        </aside>
      </div>

      <footer className="footer">
        <span>
          本工具求解的是明确列出的规则集合，不宣称自动生成任何风格的完美音乐。命令行：<code>npm run cli -- --help</code>
        </span>
      </footer>
    </div>
  );
}

function RangeField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { low: number; high: number; name: string };
  onChange: (v: { low: number; high: number; name: string }) => void;
}) {
  const [text, setText] = useState(`${midiToName(value.low)}–${midiToName(value.high)}`);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    setText(`${midiToName(value.low)}–${midiToName(value.high)}`);
  }, [value.low, value.high]);
  const commit = () => {
    const [a, b] = text.split(/[-–—]/).map((s) => parsePitch(s.trim()));
    if (a === null || a === undefined || b === null || b === undefined) {
      setErr('格式如 C4–C5');
      return;
    }
    if (b <= a) {
      setErr('高音需高于低音');
      return;
    }
    setErr(null);
    onChange({ ...value, low: a, high: b });
  };
  return (
    <label className="field">
      <span>{label}</span>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {err && <small className="field-error">{err}</small>}
    </label>
  );
}

function DiagnosisSummary({
  diagnosis,
  onTime,
  score,
}: {
  diagnosis: ExampleDiagnosis | null;
  onTime: (t: number) => void;
  score: Score;
}) {
  if (!diagnosis) {
    return <p className="muted small">当前乐谱为空。</p>;
  }
  const errors = diagnosis.violations.filter((v) => v.severity === 'error');
  const warnings = diagnosis.violations.filter((v) => v.severity === 'warning');
  return (
    <div className="diag">
      <div className="diag-metrics">
        <span className="badge error">错误 {errors.length}</span>
        <span className="badge warning">警告 {warnings.length}</span>
        <span className="badge info">时刻 {diagnosis.moments.length}</span>
      </div>
      <h4>违例（点击定位时刻）</h4>
      <ViolationList violations={diagnosis.violations} onTime={onTime} />

      <h4>逐时刻表</h4>
      <div className="moment-table-wrap">
        <table className="data-table compact">
          <thead>
            <tr>
              <th>t</th>
              <th>小节/拍</th>
              <th>发声</th>
              <th>音程</th>
            </tr>
          </thead>
          <tbody>
            {diagnosis.moments.map((m) => (
              <tr
                key={m.time}
                onClick={() => onTime(m.time)}
                className="clickable"
              >
                <td>{m.time}</td>
                <td>
                  {m.measure + 1} / {(m.beat + 1).toFixed(1)}
                </td>
                <td>
                  {m.entries.map((e) => `${e.voice}:${midiToName(e.pitch)}`).join(' ')}
                </td>
                <td>
                  {m.pairs.length === 0
                    ? '—'
                    : m.pairs
                        .map((p) => `${p.intervalLabel}${p.quality === 'dissonant' ? '✱' : ''}`)
                        .join('；')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4>可解释的不协和</h4>
      {diagnosis.dissonances.length === 0 ? (
        <div className="muted small">当前各时刻的纵向音程全部协和。</div>
      ) : (
        <ul className="explain-list">
          {diagnosis.dissonances.slice(0, 12).map((d, i) => (
            <li key={i}>
              <span className="kind-chip">{kindText(d.context.kind)}</span>
              <span className="muted small">
                {fmtTime(d.from)}
              </span>
              <span>{d.context.explanation}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function kindText(k: string): string {
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

function rhythmIdFor(spec: RhythmSpec): string {
  const found = RHYTHM_PRESETS.find((r) => {
    if (r.spec.kind !== spec.kind) return false;
    if (spec.kind === 'fixed' && r.spec.kind === 'fixed') return r.spec.duration === spec.duration;
    if (spec.kind === 'pattern' && r.spec.kind === 'pattern')
      return r.spec.values.join(',') === spec.values.join(',');
    return spec.kind === 'cf';
  });
  return found?.id ?? 'half';
}
