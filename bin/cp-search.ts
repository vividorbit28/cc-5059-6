#!/usr/bin/env node
/**
 * 命令行辅助入口：与图形界面共用 src/core 的同一套约束搜索。
 * 输出的解、剪枝统计与历史比较均可复现界面的行为。
 */
import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import {
  DEFAULT_RULES,
  DEFAULT_VOICES,
  EXAMPLES,
  KEY_PRESETS,
  type CounterpointRules,
  type HistoryPolicy,
  type RhythmSpec,
} from '../src/core/rules.js';
import { midiToName, parsePitch } from '../src/core/pitch.js';
import { parseMelody } from '../src/core/plan.js';
import { search, statsTable, sumPruned, type SearchResult } from '../src/core/search.js';
import { buildExample, buildScoreFromParts, compareHistorySemantics } from '../src/core/examples.js';
import { renderScoreToWav } from '../src/audio/synth.js';

interface CliOptions {
  cf?: string;
  example?: string;
  key: string;
  rhythmU1: string;
  rhythmU2: string;
  u1Range: string;
  u2Range: string;
  maxSolutions: number;
  history: HistoryPolicy;
  out?: string;
  json: boolean;
  wav?: string;
  rulesOff: string[];
  rulesOn: string[];
  compare: boolean;
}

function usage(): string {
  return `对位实验室 CLI（辅助图形界面的对位搜索）

用法：
  npm run cli -- --cf "C3:4 D3:4 E3:4 C3:4" [选项]

主要选项：
  --cf <乐谱>           定旋律，记法 音高:时值，如 C3:4（时值以拍计）
  --example <id>        使用内置谱例：${EXAMPLES.map((e) => e.id).join(', ')}
  --key <id>            调式：${KEY_PRESETS.map((k) => k.id).join(', ')}（默认 C-major）
  --rhythm-u1 <spec>    对位 I 节奏：cf | whole | half | quarter | sync-a | mix-a | mix-b
  --rhythm-u2 <spec>    对位 II 节奏，同上
  --range-u1 <low-high> 对位 I 音域，如 C4-C5
  --range-u2 <low-high> 对位 II 音域，如 C5-C6
  --max-solutions <n>   最多返回解数（默认 8）
  --history <policy>    carry | truncate（默认 carry）
  --compare-history     同时跑两种历史策略并比较解集
  --rules-off <list>    逗号分隔的规则 id，强制关闭
  --rules-on <list>     逗号分隔的规则 id，强制开启
  --json                输出完整 JSON（含每个解的逐音与违例）
  --wav <path>          用第一个解渲染 WAV（离线合成）
  --out <path>          把搜索摘要写入文件

规则 id 可用：${Object.keys(DEFAULT_RULES).join(', ')}
图形入口：npm run dev 后在浏览器打开，选择规则并点击“搜索两条对位声部”。
`;
}

function parseRange(text: string, fallback: { low: number; high: number }) {
  const m = /^\s*([A-Ga-g][#b]?-?\d+)\s*[-–—]\s*([A-Ga-g][#b]?-?\d+)\s*$/.exec(text);
  if (!m) return fallback;
  const low = parsePitch(m[1]);
  const high = parsePitch(m[2]);
  if (low === null || high === null || high <= low) return fallback;
  return { low, high };
}

function rhythmFromId(id: string): RhythmSpec {
  switch (id) {
    case 'cf':
      return { kind: 'cf' };
    case 'whole':
      return { kind: 'fixed', duration: 4 };
    case 'half':
      return { kind: 'fixed', duration: 2 };
    case 'quarter':
      return { kind: 'fixed', duration: 1 };
    case 'sync-a':
      return { kind: 'pattern', values: [3, 3, 2] };
    case 'mix-a':
      return { kind: 'pattern', values: [2, 1, 2, 3] };
    case 'mix-b':
      return { kind: 'pattern', values: [1, 1, 2] };
    default:
      return { kind: 'fixed', duration: 2 };
  }
}

function formatResult(res: SearchResult, json: boolean): string {
  if (json) {
    return JSON.stringify(
      {
        ok: res.ok,
        message: res.message,
        T: res.T,
        stats: { ...res.stats, traces: res.stats.traces.slice(0, 30) },
        solutions: res.solutions.map((s) => ({
          id: s.id,
          signature: s.signature,
          u1: s.u1.map((n) => ({ onset: n.onset, duration: n.duration, pitch: n.pitch, note: midiToName(n.pitch) })),
          u2: s.u2.map((n) => ({ onset: n.onset, duration: n.duration, pitch: n.pitch, note: midiToName(n.pitch) })),
          score: s.score,
          suspensionCount: s.suspensionCount,
          passingCount: s.passingCount,
          neighborCount: s.neighborCount,
          obligationsCrossingBars: s.obligationsCrossingBars,
          violations: s.violations.map((v) => ({
            rule: v.rule,
            severity: v.severity,
            time: v.time,
            message: v.message,
            detail: v.detail,
          })),
        })),
      },
      null,
      2,
    );
  }
  const lines: string[] = [];
  lines.push(res.message);
  lines.push(
    `节点 ${res.stats.nodes} · 候选 ${res.stats.candidatesTested} · 剪枝 ${sumPruned(res.stats)} · ${res.stats.elapsedMs}ms · 停止=${res.stats.stopReason}`,
  );
  const table = statsTable(res.stats);
  if (table.length > 0) {
    lines.push('剪枝分布：');
    for (const row of table) lines.push(`  ${row.rule}: ${row.count}`);
  }
  for (const s of res.solutions) {
    lines.push('');
    lines.push(`[${s.id}] 代价 ${s.score.toFixed(2)} · 延留 ${s.suspensionCount} · 经过 ${s.passingCount} · 辅助 ${s.neighborCount} · 违例 ${s.violations.length}`);
    lines.push(
      `  对位 I : ${s.u1.map((n) => `${midiToName(n.pitch)}@${n.onset}`).join(' ')}`,
    );
    lines.push(
      `  对位 II: ${s.u2.map((n) => `${midiToName(n.pitch)}@${n.onset}`).join(' ')}`,
    );
    if (s.obligationsCrossingBars.length > 0) {
      lines.push(
        `  跨小节延留：${s.obligationsCrossingBars
          .map((o) => `${o.voice} ${midiToName(o.pitch)}（${o.struckBy.voice} 撞入）`)
          .join('；')}`,
      );
    }
    for (const v of s.violations) {
      lines.push(`  ! ${v.severity} ${v.rule} @${v.time}: ${v.message}`);
    }
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseArgs({
      options: {
        cf: { type: 'string' },
        example: { type: 'string' },
        key: { type: 'string', default: 'C-major' },
        'rhythm-u1': { type: 'string', default: 'half' },
        'rhythm-u2': { type: 'string', default: 'half' },
        'range-u1': { type: 'string', default: 'C4-C5' },
        'range-u2': { type: 'string', default: 'C5-C6' },
        'max-solutions': { type: 'string', default: '8' },
        history: { type: 'string', default: 'carry' },
        'compare-history': { type: 'boolean', default: false },
        'rules-off': { type: 'string', default: '' },
        'rules-on': { type: 'string', default: '' },
        json: { type: 'boolean', default: false },
        wav: { type: 'string' },
        out: { type: 'string' },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: false,
    });
  } catch (err) {
    console.error(`${(err as Error).message}\n`);
    console.error(usage());
    process.exitCode = 2;
    return;
  }
  const { values } = parsed;
  if (values.help) {
    console.log(usage());
    return;
  }

  const keyPreset = KEY_PRESETS.find((k) => k.id === values.key) ?? KEY_PRESETS[0];
  const rangeU1 = parseRange(values['range-u1'], DEFAULT_VOICES.u1);
  const rangeU2 = parseRange(values['range-u2'], DEFAULT_VOICES.u2);

  let cfNotes;
  let rules: CounterpointRules = { ...DEFAULT_RULES };
  if (values.example) {
    const spec = EXAMPLES.find((e) => e.id === values.example);
    if (!spec) {
      console.error(`未知谱例：${values.example}\n可用：${EXAMPLES.map((e) => e.id).join(', ')}`);
      process.exitCode = 2;
      return;
    }
    const built = buildExample(spec);
    cfNotes = spec.cfText;
    if (!values.cf) values.cf = spec.cfText;
    rules = { ...DEFAULT_RULES, ...(spec.ruleOverrides ?? {}) };
    void built;
  }
  const cfText = values.cf;
  if (!cfText) {
    console.error(`缺少 --cf。\n\n${usage()}`);
    process.exitCode = 2;
    return;
  }
  const parsedCf = parseMelody(cfText);
  if (parsedCf.errors.length) {
    console.error(`定旋律解析失败：${parsedCf.errors.join('；')}`);
    process.exitCode = 2;
    return;
  }

  for (const id of values['rules-off'].split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(id in rules)) {
      console.error(`未知规则：${id}`);
      process.exitCode = 2;
      return;
    }
    (rules as unknown as Record<string, unknown>)[id] = false;
  }
  for (const id of values['rules-on'].split(',').map((s) => s.trim()).filter(Boolean)) {
    if (!(id in rules)) {
      console.error(`未知规则：${id}`);
      process.exitCode = 2;
      return;
    }
    (rules as unknown as Record<string, unknown>)[id] = true;
  }

  const history = (values.history === 'truncate' ? 'truncate' : 'carry') as HistoryPolicy;
  const maxSolutions = Math.max(1, Math.min(30, Number(values['max-solutions']) || 8));
  const rhythmU1 = rhythmFromId(values['rhythm-u1']);
  const rhythmU2 = rhythmFromId(values['rhythm-u2']);

  const baseInput = {
    key: keyPreset.key,
    beatsPerMeasure: 4,
    rules,
    cfNotes: parsedCf.notes,
    u1: { ...rangeU1, name: DEFAULT_VOICES.u1.name },
    u2: { ...rangeU2, name: DEFAULT_VOICES.u2.name },
    rhythmU1,
    rhythmU2,
    maxSolutions,
    maxNodes: 200000,
    timeBudgetMs: 8000,
  };

  if (values['compare-history']) {
    const carry = search({ ...baseInput, historyPolicy: 'carry' });
    const truncate = search({ ...baseInput, historyPolicy: 'truncate' });
    const cmp = compareHistorySemantics(carry, truncate, rules, keyPreset.key, 4);
    if (values.json) {
      console.log(
        JSON.stringify(
          {
            summary: cmp.summary,
            carry: JSON.parse(formatResult(carry, true)),
            truncate: JSON.parse(formatResult(truncate, true)),
            validOnlyCarry: cmp.validOnlyCarry.map((r) => r.signature),
            validOnlyTruncate: cmp.validOnlyTruncate.map((r) => r.signature),
            validBoth: cmp.validBoth.length,
            invalidBoth: cmp.invalidBoth.length,
            note: cmp.note,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(cmp.summary);
      console.log('');
      console.log('=== 保留悬挂义务 ===');
      console.log(formatResult(carry, false));
      console.log('');
      console.log('=== 截短到本小节 ===');
      console.log(formatResult(truncate, false));
    }
    return;
  }

  const res = search({ ...baseInput, historyPolicy: history });
  const text = formatResult(res, values.json);
  console.log(text);
  if (values.out) {
    writeFileSync(values.out, text, 'utf8');
    console.log(`\n已写入 ${values.out}`);
  }

  if (values.wav) {
    const sol = res.solutions[0];
    if (!sol) {
      console.error('没有解可渲染为 WAV。');
      process.exitCode = 1;
      return;
    }
    const score = buildScoreFromParts(parsedCf.notes, sol.u1, sol.u2, {
      key: keyPreset.key,
      beatsPerMeasure: 4,
      tempo: 84,
    });
    // Node 环境下没有 AudioContext，用离线渲染路径。
    const blob = await renderScoreToWav(score, 44100);
    const buf = Buffer.from(await blob.arrayBuffer());
    writeFileSync(values.wav, buf);
    console.log(`\n已渲染 ${values.wav}（${buf.length} 字节，来源：第一个搜索解）`);
  }

  if (!res.ok) process.exitCode = 1;
}

void main();
