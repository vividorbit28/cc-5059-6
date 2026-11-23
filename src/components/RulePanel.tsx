import { useMemo } from 'react';
import {
  RULE_META,
  type CounterpointRules,
  type HistoryPolicy,
  type RuleId,
} from '../core/rules.js';
import type { SearchStats } from '../core/search.js';

export interface RulePanelProps {
  rules: CounterpointRules;
  onChange: (r: CounterpointRules) => void;
  historyPolicy: HistoryPolicy;
  onHistoryChange: (p: HistoryPolicy) => void;
  stats?: SearchStats | null;
}

const CATEGORIES: ('纵向' | '横向' | '起止')[] = ['纵向', '横向', '起止'];

export function RulePanel({ rules, onChange, historyPolicy, onHistoryChange, stats }: RulePanelProps) {
  const grouped = useMemo(() => {
    const out: Record<string, typeof RULE_META> = {};
    for (const r of RULE_META) {
      (out[r.category] ??= []).push(r);
    }
    return out;
  }, []);

  return (
    <section className="panel rule-panel" aria-label="对位规则">
      <header className="panel-head">
        <h2>规则范围</h2>
        <span className="muted small">
          这些规则共同定义一个有限风格。工具不声称能生成任何风格的完美音乐。
        </span>
      </header>

      <div className="history-policy">
        <div className="policy-title">跨小节历史策略</div>
        <label className={historyPolicy === 'carry' ? 'radio active' : 'radio'}>
          <input
            type="radio"
            name="history"
            checked={historyPolicy === 'carry'}
            onChange={() => onHistoryChange('carry')}
          />
          <span>
            <b>保留悬挂义务</b>
            <small>跨小节的延留预备与解决义务带入下一步判决，平行/直接音程也跨越小节线比较。</small>
          </span>
        </label>
        <label className={historyPolicy === 'truncate' ? 'radio active' : 'radio'}>
          <input
            type="radio"
            name="history"
            checked={historyPolicy === 'truncate'}
            onChange={() => onHistoryChange('truncate')}
          />
          <span>
            <b>截短到本小节</b>
            <small>进入新小节时丢弃此前的纵向预备与悬挂义务，只在本小节内判定。</small>
          </span>
        </label>
      </div>

      {CATEGORIES.map((cat) => (
        <div className="rule-group" key={cat}>
          <h3>{cat}</h3>
          {grouped[cat]?.map((meta) => {
            if (meta.kind === 'number') {
              return (
                <div className="rule-row number" key={meta.id}>
                  <div className="rule-label">
                    <span>{meta.label}</span>
                    <small>{meta.description}</small>
                  </div>
                  <input
                    type="range"
                    min={2}
                    max={24}
                    step={1}
                    value={rules.maxLeap}
                    onChange={(e) => onChange({ ...rules, maxLeap: Number(e.target.value) })}
                  />
                  <code>{rules.maxLeap}</code>
                  <span className="pruned-badge">
                    {stats?.pruned[meta.id] ? `${stats.pruned[meta.id]} 次剪枝` : ''}
                  </span>
                </div>
              );
            }
            const on = rules[meta.id as Exclude<RuleId, 'maxLeap'>] as boolean;
            return (
              <label className={`rule-row ${on ? 'on' : 'off'}`} key={meta.id}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) =>
                    onChange({ ...rules, [meta.id]: e.target.checked } as CounterpointRules)
                  }
                />
                <div className="rule-label">
                  <span>{meta.label}</span>
                  <small>{meta.description}</small>
                </div>
                <span className="pruned-badge">
                  {stats?.pruned[meta.id] ? `${stats.pruned[meta.id]} 次剪枝` : ''}
                </span>
              </label>
            );
          })}
        </div>
      ))}

      <div className="rule-note">
        注意：延留音、经过音、辅助音是<b>被解释</b>的不协和，不会被“非和弦音一律排除”；
        只有无法解释的不协和才会触发强拍协和规则。
      </div>
    </section>
  );
}
