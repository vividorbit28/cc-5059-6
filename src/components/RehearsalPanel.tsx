import { useMemo } from 'react';
import {
  partScoreText,
  rehearsalAnomalyGroups,
  suspensionCompletion,
  type RehearsalAnomaly,
  type RehearsalPlan,
} from '../core/rehearsal.js';
import type { Score, VoiceId } from '../core/score.js';

export interface RehearsalPanelProps {
  plan: RehearsalPlan;
  score: Score;
}

const VOICE_LABEL: Record<VoiceId, string> = {
  cf: '定旋律',
  u1: '对位 I',
  u2: '对位 II',
};

export function RehearsalPanel({ plan, score }: RehearsalPanelProps) {
  const completions = suspensionCompletion(plan);
  const { voiceIssues, playbackIssues } = rehearsalAnomalyGroups(plan);
  const text = useMemo(() => partScoreText(plan, score), [plan, score]);
  const hasNotes = plan.notes.length > 0;

  return (
    <section className="panel rehearsal-panel" aria-label="分谱与排练">
      <header className="panel-head">
        <h2>分谱 · 排练</h2>
        <span className="muted small">
          把当前乐谱派给歌手，核对换气、换人与悬挂音的解决由谁完成。
        </span>
      </header>

      {!hasNotes ? (
        <p className="muted small">当前乐谱为空，暂无可排练的分谱。</p>
      ) : (
        <>
          <div className="diag-metrics">
            <span className="badge info">歌手音 {plan.notes.length}</span>
            <span className="badge info">换气 {plan.breaths.length}</span>
            <span className={voiceIssues.length ? 'badge error' : 'badge'}>
              对位声部异常 {voiceIssues.length}
            </span>
            <span className={playbackIssues.length ? 'badge warning' : 'badge'}>
              多轨试听异常 {playbackIssues.length}
            </span>
          </div>

          {(voiceIssues.length > 0 || playbackIssues.length > 0) && (
            <div className="rehearsal-issues">
              {voiceIssues.length > 0 && (
                <div className="callout warn">
                  <b>对位声部</b>
                  <ul>
                    {voiceIssues.map((a, i) => (
                      <li key={`v${i}`}>
                        <span className="kind-chip">{anomalyLabel(a.kind)}</span> {a.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {playbackIssues.length > 0 && (
                <div className="callout warn">
                  <b>多轨试听</b>
                  <ul>
                    {playbackIssues.map((a, i) => (
                      <li key={`p${i}`}>
                        <span className="kind-chip">{anomalyLabel(a.kind)}</span> {a.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <h4>悬挂音由哪位歌手完成</h4>
          {completions.length === 0 ? (
            <div className="muted small">当前乐谱没有延留音，无需核对解决歌手。</div>
          ) : (
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>声部</th>
                  <th>延留歌手</th>
                  <th>解决歌手</th>
                  <th>跨小节换人</th>
                  <th>可唱</th>
                </tr>
              </thead>
              <tbody>
                {completions.map((c, i) => (
                  <tr key={i}>
                    <td>{VOICE_LABEL[c.voice]}</td>
                    <td>{c.heldBy ?? '—'}</td>
                    <td>{c.resolvedBy ?? '—'}</td>
                    <td>{c.swappedAcrossBar ? '是' : '否'}</td>
                    <td className={c.singable ? 'ok-cell' : 'bad-cell'}>
                      {c.singable ? '可唱' : '不可唱'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h4>分谱</h4>
          <pre className="part-score">{text || '（无）'}</pre>
        </>
      )}
    </section>
  );
}

function anomalyLabel(kind: RehearsalAnomaly['kind']): string {
  switch (kind) {
    case 'unsingable':
      return '超出音域';
    case 'no-breath-opportunity':
      return '无换气机会';
    case 'suspension-resolve-voice-swap':
      return '跨小节换人否决';
    case 'suspension-unresolved':
      return '悬挂未解决';
    case 'missing-singer':
      return '缺少歌手';
    default:
      return kind;
  }
}
