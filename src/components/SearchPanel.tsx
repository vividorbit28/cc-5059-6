import { useMemo, useState } from 'react';
import type { SearchResult, SearchSolution, PruneEvent } from '../core/search.js';
import { RULE_LABEL } from '../core/rules.js';
import { midiToName } from '../core/pitch.js';
import { kindLabel, solutionDifferences, type SemanticComparison } from '../core/examples.js';
import type { Violation } from '../core/analyze.js';

export interface SearchPanelProps {
  result: SearchResult | null;
  selectedSolutionId: string | null;
  onSelectSolution: (id: string) => void;
  onAdopt: (sol: SearchSolution) => void;
  comparison: SemanticComparison | null;
  onCompareHistory: () => void;
  comparing: boolean;
  historyPolicy: 'carry' | 'truncate';
}

export function SearchPanel(props: SearchPanelProps) {
  const { result, selectedSolutionId, onSelectSolution, onAdopt, comparison, onCompareHistory, comparing } = props;
  const [tab, setTab] = useState<'solutions' | 'pruning' | 'history'>('solutions');

  const selected = result?.solutions.find((s) => s.id === selectedSolutionId) ?? result?.solutions[0] ?? null;
  const prunedRows = useMemo(
    () =>
      result
        ? Object.entries(result.stats.pruned)
            .filter(([, n]) => (n ?? 0) > 0)
            .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
        : [],
    [result],
  );
  const diffs = useMemo(() => (result ? solutionDifferences(result.solutions) : []), [result]);

  if (!result) {
    return (
      <section className="panel result-panel">
        <header className="panel-head">
          <h2>搜索结果</h2>
        </header>
        <p className="muted">
          设置定旋律、节奏与规则后，点击“搜索两条对位声部”。结果区的音符、违例、剪枝统计与试听都来自本次真实搜索。
        </p>
      </section>
    );
  }

  return (
    <section className="panel result-panel" aria-label="搜索结果">
      <header className="panel-head">
        <h2>搜索结果</h2>
        <span className={`status ${result.ok ? 'ok' : 'bad'}`}>{result.message}</span>
      </header>

      <div className="metrics">
        <Metric label="解" value={result.solutions.length} hint={`展示上限内，去重后 ${result.stats.distinctSignatures} 条`} />
        <Metric label="搜索节点" value={result.stats.nodes} />
        <Metric label="候选测试" value={result.stats.candidatesTested} />
        <Metric label="耗时 ms" value={result.stats.elapsedMs} />
        <Metric
          label="停止原因"
          value={
            result.stats.stopReason === 'solutions'
              ? '达到解上限'
              : result.stats.stopReason === 'nodes'
                ? '节点上限'
                : result.stats.stopReason === 'time'
                  ? '时间上限'
                  : '穷尽'
          }
        />
      </div>

      <div className="tabs">
        <button className={tab === 'solutions' ? 'tab active' : 'tab'} onClick={() => setTab('solutions')}>
          可选解 ({result.solutions.length})
        </button>
        <button className={tab === 'pruning' ? 'tab active' : 'tab'} onClick={() => setTab('pruning')}>
          搜索剪枝 ({prunedRows.length} 类)
        </button>
        <button className={tab === 'history' ? 'tab active' : 'tab'} onClick={() => setTab('history')}>
          历史策略对比
        </button>
      </div>

      {tab === 'solutions' && (
        <div className="solutions-grid">
          <div className="solution-list">
            {result.solutions.length === 0 && (
              <div className="empty">
                <p>{result.message}</p>
                <p className="muted">
                  可尝试：放宽某条规则、扩大声部音域、减少时值差异，或提高搜索上限。工具不会伪造一个解。
                </p>
              </div>
            )}
            {result.solutions.map((sol) => (
              <button
                key={sol.id}
                className={`solution-item ${selected?.id === sol.id ? 'active' : ''}`}
                onClick={() => onSelectSolution(sol.id)}
              >
                <div className="solution-top">
                  <b>{sol.id}</b>
                  <span className="muted">代价 {sol.score.toFixed(1)}</span>
                </div>
                <div className="melody-line">
                  {sol.u1.map((n) => midiToName(n.pitch)).join(' ')}
                </div>
                <div className="melody-line dim">
                  {sol.u2.map((n) => midiToName(n.pitch)).join(' ')}
                </div>
                <div className="small muted">
                  延留 {sol.suspensionCount} · 经过 {sol.passingCount} · 辅助 {sol.neighborCount} ·
                  违例 {sol.violations.length}
                </div>
              </button>
            ))}
          </div>

          {selected && (
            <div className="solution-detail">
              <div className="solution-detail-head">
                <h3>{selected.id}</h3>
                <button className="primary small" onClick={() => onAdopt(selected)}>
                  采用该解作为可编辑乐谱
                </button>
              </div>
              <VoiceTable title="对位 I" notes={selected.u1} />
              <VoiceTable title="对位 II" notes={selected.u2} />

              <h4>跨事件带入的历史</h4>
              {selected.historyTrail.length === 0 ? (
                <div className="muted small">该搜索没有需要跨事件携带的历史。</div>
              ) : (
                <ul className="history-trail">
                  {selected.historyTrail.map((h, i) => (
                    <li key={i}>
                      <code>t={h.time}</code>{' '}
                      {h.pairs.length
                        ? h.pairs
                            .map(
                              (p) =>
                                `${p.lower}/${p.upper} ${midiToName(p.lowerPitch)}-${midiToName(p.upperPitch)}`,
                            )
                            .join('；')
                        : '无纵向音程'}{' '}
                      {h.obligations.length > 0 && (
                        <span className="obligation">
                          携带悬挂义务：
                          {h.obligations
                            .map(
                              (o) =>
                                `${o.voice} ${midiToName(o.pitch)}@${o.onset}→需下行解决`,
                            )
                            .join('；')}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              {selected.obligationsCrossingBars.length > 0 && (
                <div className="callout">
                  跨小节延留义务 {selected.obligationsCrossingBars.length} 个：
                  {selected.obligationsCrossingBars
                    .map((o) => `${o.voice} ${midiToName(o.pitch)}（被 ${o.struckBy.voice} 撞入）`)
                    .join('；')}
                </div>
              )}

              <h4>不协和解释</h4>
              {selected.dissonanceKinds.length === 0 ? (
                <div className="muted small">该解没有可解释的不协和，全部为协和音程。</div>
              ) : (
                <div className="kinds">
                  {selected.dissonanceKinds.map((k) => (
                    <span key={k} className="kind-chip">
                      {kindLabel(k)}
                    </span>
                  ))}
                </div>
              )}

              {diffs.length > 0 && (
                <>
                  <h4>可选解差别</h4>
                  <table className="data-table compact">
                    <thead>
                      <tr>
                        <th>解对</th>
                        <th>不同槽位</th>
                        <th>对位 I</th>
                        <th>对位 II</th>
                      </tr>
                    </thead>
                    <tbody>
                      {diffs.slice(0, 12).map((d) => (
                        <tr key={d.pair.join('-')}>
                          <td>
                            {d.pair[0]} ↔ {d.pair[1]}
                          </td>
                          <td>{d.differingSlots}</td>
                          <td>{d.u1Diff.join(', ') || '—'}</td>
                          <td>{d.u2Diff.join(', ') || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </div>
      )}

      {tab === 'pruning' && (
        <div className="pruning">
          <table className="data-table">
            <thead>
              <tr>
                <th>规则</th>
                <th>剪枝次数</th>
              </tr>
            </thead>
            <tbody>
              {prunedRows.map(([rule, count]) => (
                <tr key={rule}>
                  <td>{RULE_LABEL[rule] ?? ruleLabelFallback(rule)}</td>
                  <td>{count}</td>
                </tr>
              ))}
              {prunedRows.length === 0 && (
                <tr>
                  <td colSpan={2} className="muted">
                    本次搜索没有发生剪枝（在未探索到冲突前已找到解）。
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <h4>剪枝轨迹（前 {result.stats.traces.length} 条）</h4>
          <div className="trace-list">
            {result.stats.traces.map((t, i) => (
              <TraceRow key={i} trace={t} />
            ))}
            {result.stats.traces.length === 0 && <div className="muted small">无轨迹。</div>}
          </div>
        </div>
      )}

      {tab === 'history' && (
        <div className="history-compare">
          <p className="muted">
            用相同的定旋律、节奏与规则分别搜索“保留悬挂义务”和“截短到本小节”，然后把两边得到的解合并，
            再用两种历史策略各自完整复核同一份乐谱。因此“仅一种历史成立”的差异来自跨小节预备与悬挂义务，
            而不是搜索枚举顺序。
          </p>
          <button className="secondary" onClick={onCompareHistory} disabled={comparing}>
            {comparing ? '搜索并复核中…' : '运行两种历史策略并比较'}
          </button>
          {comparison && (
            <>
              <div className="callout">{comparison.summary}</div>
              <div className="muted small">{comparison.note}</div>

              <div className="compare-grid">
                <CompareColumn title="保留悬挂义务搜索" result={comparison.carry} />
                <CompareColumn title="截短到本小节搜索" result={comparison.truncate} />
              </div>

              <h4>复核结论</h4>
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>解</th>
                    <th>来自</th>
                    <th>保留历史复核</th>
                    <th>截短历史复核</th>
                  </tr>
                </thead>
                <tbody>
                  {comparison.rows.slice(0, 24).map((r) => (
                    <tr key={r.signature}>
                      <td className="mono">{r.signature.slice(0, 18)}…</td>
                      <td>{r.source === 'both' ? '两者' : r.source === 'carry' ? '保留' : '截短'}</td>
                      <td className={r.validCarry ? 'ok-cell' : 'bad-cell'}>
                        {r.validCarry ? '通过' : r.carryErrors.slice(0, 2).join('；')}
                      </td>
                      <td className={r.validTruncate ? 'ok-cell' : 'bad-cell'}>
                        {r.validTruncate ? '通过' : r.truncateErrors.slice(0, 2).join('；')}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="diffs">
                <div>
                  <b>仅保留历史下成立：</b>
                  {comparison.validOnlyCarry.length === 0
                    ? '无'
                    : comparison.validOnlyCarry.length + ' 条（截短历史会误判为违规）'}
                </div>
                <div>
                  <b>仅截短历史下成立：</b>
                  {comparison.validOnlyTruncate.length === 0
                    ? '无'
                    : comparison.validOnlyTruncate.length + ' 条（保留历史会拒绝）'}
                </div>
                <div>
                  <b>两种历史都成立：</b>
                  {comparison.validBoth.length}
                </div>
              </div>
            </>
          )}
        </div>
      )}

    </section>
  );
}

function ruleLabelFallback(rule: string): string {
  const map: Record<string, string> = {
    obligation: '延留义务',
    duplicate: '重复解',
    range: '声部音域',
  };
  return map[rule] ?? rule;
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="metric">
      <div className="metric-value">{value}</div>
      <div className="metric-label">{label}</div>
      {hint && <div className="metric-hint">{hint}</div>}
    </div>
  );
}

function VoiceTable({ title, notes }: { title: string; notes: { onset: number; duration: number; pitch: number }[] }) {
  return (
    <>
      <h4>{title}</h4>
      <table className="data-table compact">
        <thead>
          <tr>
            <th>起始</th>
            <th>时值</th>
            <th>音</th>
          </tr>
        </thead>
        <tbody>
          {notes.map((n, i) => (
            <tr key={i}>
              <td>{n.onset}</td>
              <td>{n.duration}</td>
              <td>{midiToName(n.pitch)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function TraceRow({ trace }: { trace: PruneEvent }) {
  return (
    <div className="trace-row">
      <code>t={trace.time}</code>
      <span className="trace-rule">{RULE_LABEL[trace.rule as string] ?? ruleLabelFallback(trace.rule)}</span>
      <span>{trace.message}</span>
      <span className="muted small">{trace.detail}</span>
    </div>
  );
}

function CompareColumn({ title, result }: { title: string; result: SearchResult }) {
  return (
    <div className="compare-col">
      <h4>{title}</h4>
      <div className="small muted">{result.message}</div>
      <ul>
        {result.solutions.map((s) => (
          <li key={s.id}>
            <b>{s.id}</b> · 延留 {s.suspensionCount} · 经过 {s.passingCount} · 辅助 {s.neighborCount}
            <div className="melody-line dim small">
              {s.u1.map((n) => midiToName(n.pitch)).join(' ')}
            </div>
            <div className="melody-line dim small">
              {s.u2.map((n) => midiToName(n.pitch)).join(' ')}
            </div>
          </li>
        ))}
        {result.solutions.length === 0 && <li className="muted">无解</li>}
      </ul>
    </div>
  );
}

export function ViolationList({ violations, onTime }: { violations: Violation[]; onTime: (t: number) => void }) {
  if (violations.length === 0) return <div className="ok-line">未命中规则。</div>;
  return (
    <div className="violation-list">
      {violations.map((v, i) => (
        <button key={i} className={`violation ${v.severity}`} onClick={() => onTime(v.time)}>
          <div className="violation-title">
            <span className={`sev ${v.severity}`}>{v.severity === 'error' ? '错误' : v.severity === 'warning' ? '警告' : '提示'}</span>
            {v.ruleLabel}
            <span className="muted small">
              t={v.time} · {v.voices.join('/')}
            </span>
            {v.dissonance && <span className="kind">{kindLabel(v.dissonance.kind)}</span>}
          </div>
          <div>{v.message}</div>
          <div className="muted small">{v.detail}</div>
        </button>
      ))}
    </div>
  );
}
