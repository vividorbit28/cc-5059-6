import type { Key } from './pitch.js';

export type HistoryPolicy = 'carry' | 'truncate';

export interface CounterpointRules {
  fourthConsonant: boolean;
  strongBeatConsonance: boolean;
  allowPassingTones: boolean;
  allowNeighborTones: boolean;
  allowSuspensions: boolean;
  suspensionResolveDown: boolean;
  forbidParallelPerfects: boolean;
  forbidDirectPerfects: boolean;
  forbidVoiceCrossing: boolean;
  maxLeap: number;
  forbidTritoneLeap: boolean;
  requireLeapRecovery: boolean;
  forbidRepeatedNotes: boolean;
  diatonicOnly: boolean;
  startPerfect: boolean;
  endOnTonic: boolean;
  endPerfect: boolean;
}

export const DEFAULT_RULES: CounterpointRules = {
  fourthConsonant: false,
  strongBeatConsonance: true,
  allowPassingTones: true,
  allowNeighborTones: true,
  allowSuspensions: true,
  suspensionResolveDown: true,
  forbidParallelPerfects: true,
  forbidDirectPerfects: false,
  forbidVoiceCrossing: true,
  maxLeap: 12,
  forbidTritoneLeap: true,
  requireLeapRecovery: true,
  forbidRepeatedNotes: true,
  diatonicOnly: true,
  startPerfect: true,
  endOnTonic: true,
  endPerfect: true,
};

export interface RuleMeta {
  id: RuleId;
  label: string;
  category: '纵向' | '横向' | '起止' | '历史';
  description: string;
  kind: 'boolean' | 'number';
}

export type RuleId = Exclude<keyof CounterpointRules, 'maxLeap'> | 'maxLeap';

export const RULE_META: RuleMeta[] = [
  {
    id: 'strongBeatConsonance',
    label: '强拍纵向协和',
    category: '纵向',
    description: '每小节第 1 拍（强拍）及次强拍上，所有实际发声的声部两两之间必须是协和音程，或因延留音造成的可解释不协和。',
    kind: 'boolean',
  },
  {
    id: 'allowPassingTones',
    label: '允许经过音',
    category: '纵向',
    description: '弱拍上，一个声部可以级进进入、级进离开同方向的不协和音，且前后纵向关系协和。不会把所有非和弦音一律排除。',
    kind: 'boolean',
  },
  {
    id: 'allowNeighborTones',
    label: '允许辅助音',
    category: '纵向',
    description: '弱拍上，一个声部级进到不协和音后级进返回原音。',
    kind: 'boolean',
  },
  {
    id: 'allowSuspensions',
    label: '允许延留音',
    category: '纵向',
    description: '一个持续音在开始处协和，之后变为不协和，并在该音结束时下行级进解决。跨小节时是否保留预备历史由“历史策略”决定。',
    kind: 'boolean',
  },
  {
    id: 'suspensionResolveDown',
    label: '延留音下行解决',
    category: '纵向',
    description: '延留音必须在其结束时下行级进解决（学校对位中的 4-3、7-6 等）。',
    kind: 'boolean',
  },
  {
    id: 'fourthConsonant',
    label: '纯四度视为协和',
    category: '纵向',
    description: '关闭时，低音上方的纯四度按不协和处理；开启后可作为协和音程。',
    kind: 'boolean',
  },
  {
    id: 'forbidParallelPerfects',
    label: '禁止平行五/八度',
    category: '纵向',
    description: '任意两声部从前一个纯五/纯八（或纯一度）进行到同类纯音程，且两声部整体同向运动时判错。跨小节是否比较由历史策略决定。',
    kind: 'boolean',
  },
  {
    id: 'forbidDirectPerfects',
    label: '禁止直接五/八度',
    category: '纵向',
    description: '两声部同向进入纯五/纯八，且上方声部为跳进时判错（隐蔽五/八度）。',
    kind: 'boolean',
  },
  {
    id: 'forbidVoiceCrossing',
    label: '禁止声部交错',
    category: '纵向',
    description: '本工具把定旋律视为最低声部；要求 定旋律 ≤ 对位 I ≤ 对位 II（允许同度）。',
    kind: 'boolean',
  },
  {
    id: 'maxLeap',
    label: '最大旋律跳进（半音）',
    category: '横向',
    description: '单个声部相邻两音的最大音程，默认 12（八度）。',
    kind: 'number',
  },
  {
    id: 'forbidTritoneLeap',
    label: '禁止三全音跳进',
    category: '横向',
    description: '旋律中不得出现增四/减五度跳进。',
    kind: 'boolean',
  },
  {
    id: 'requireLeapRecovery',
    label: '跳进后反向级进恢复',
    category: '横向',
    description: '任何大于大三度（≥5 半音）的跳进之后，下一音必须反向级进（≤2 半音）。',
    kind: 'boolean',
  },
  {
    id: 'forbidRepeatedNotes',
    label: '禁止同音重复',
    category: '横向',
    description: '同一音高不得在相邻两个独立音符上直接重复；持续音（一个长音符跨段）不受影响。',
    kind: 'boolean',
  },
  {
    id: 'diatonicOnly',
    label: '只使用调内音',
    category: '横向',
    description: '所有音符必须属于所选调式音阶；小调采用和声小调（含升七级导音）。',
    kind: 'boolean',
  },
  {
    id: 'startPerfect',
    label: '起始用纯音程',
    category: '起止',
    description: '第 1 拍上，每条对位声部与定旋律之间必须是纯一度、纯五度或纯八度（含复音程）。',
    kind: 'boolean',
  },
  {
    id: 'endOnTonic',
    label: '终止于主音',
    category: '起止',
    description: '每条声部的最后一个音必须是主音音级。',
    kind: 'boolean',
  },
  {
    id: 'endPerfect',
    label: '终止纵向纯音程',
    category: '起止',
    description: '最后一个实际发声时刻上，各声部之间必须是纯音程。',
    kind: 'boolean',
  },
];

export const RULE_LABEL: Record<string, string> = Object.fromEntries(
  RULE_META.map((r) => [r.id, r.label]),
);

export interface RhythmSpecFixed {
  kind: 'fixed';
  duration: number;
}
export interface RhythmSpecPattern {
  kind: 'pattern';
  values: number[];
}
export interface RhythmSpecCopyCf {
  kind: 'cf';
}
export type RhythmSpec = RhythmSpecFixed | RhythmSpecPattern | RhythmSpecCopyCf;

export interface VoiceRangeConfig {
  low: number;
  high: number;
  name: string;
}

export interface SearchVoicesConfig {
  u1: VoiceRangeConfig;
  u2: VoiceRangeConfig;
}

export const DEFAULT_VOICES: SearchVoicesConfig = {
  u1: { low: 60, high: 72, name: '对位 I（中声部）' }, // C4–C5
  u2: { low: 72, high: 84, name: '对位 II（高声部）' }, // C5–C6
};

export const RHYTHM_PRESETS: { id: string; label: string; spec: RhythmSpec }[] = [
  { id: 'cf', label: '与定旋律同时值', spec: { kind: 'cf' } },
  { id: 'whole', label: '全音符（4 拍）', spec: { kind: 'fixed', duration: 4 } },
  { id: 'half', label: '二分音符（2 拍）', spec: { kind: 'fixed', duration: 2 } },
  { id: 'quarter', label: '四分音符（1 拍）', spec: { kind: 'fixed', duration: 1 } },
  { id: 'sync-a', label: '跨小节切分 [3,3,2]', spec: { kind: 'pattern', values: [3, 3, 2] } },
  { id: 'mix-a', label: '混合 [2,1,2,3]', spec: { kind: 'pattern', values: [2, 1, 2, 3] } },
  { id: 'mix-b', label: '混合 [1,1,2]', spec: { kind: 'pattern', values: [1, 1, 2] } },
];

export interface KeyPreset {
  id: string;
  label: string;
  key: Key;
}

export const KEY_PRESETS: KeyPreset[] = [
  { id: 'C-major', label: 'C 大调', key: { tonicPc: 0, mode: 'major' } },
  { id: 'G-major', label: 'G 大调', key: { tonicPc: 7, mode: 'major' } },
  { id: 'F-major', label: 'F 大调', key: { tonicPc: 5, mode: 'major' } },
  { id: 'D-major', label: 'D 大调', key: { tonicPc: 2, mode: 'major' } },
  { id: 'A-minor', label: 'A 小调（和声）', key: { tonicPc: 9, mode: 'minor' } },
  { id: 'E-minor', label: 'E 小调（和声）', key: { tonicPc: 4, mode: 'minor' } },
];

export type ExampleId =
  | 'feasible'
  | 'parallel-fifth'
  | 'unresolved-suspension'
  | 'leap-recovery'
  | 'voice-crossing'
  | 'overlap-misalignment'
  | 'cross-bar-suspension';

export interface ExampleSpec {
  id: ExampleId;
  label: string;
  description: string;
  kind: 'valid' | 'invalid' | 'demo';
  key: Key;
  beatsPerMeasure: number;
  cfText: string;
  u1Text?: string;
  u2Text?: string;
  rhythmU1?: RhythmSpec;
  rhythmU2?: RhythmSpec;
  historyPolicy?: HistoryPolicy;
  focus?: string;
  /** 只保留与该谱例矛盾相关的规则；未列出的沿用默认值。 */
  ruleOverrides?: Partial<CounterpointRules>;
}

export const EXAMPLES: ExampleSpec[] = [
  {
    id: 'feasible',
    label: '可行短例：C 大调四小节',
    description:
      '定旋律为全音符，对位 I 与对位 II 各用二分音符。搜索可得到多条满足全部默认规则的解，并展示经过音、辅助音与可选解差异。',
    kind: 'valid',
    key: { tonicPc: 0, mode: 'major' },
    beatsPerMeasure: 4,
    cfText: 'C3:4 D3:4 E3:4 C3:4',
    rhythmU1: { kind: 'fixed', duration: 2 },
    rhythmU2: { kind: 'fixed', duration: 2 },
    focus: '展示搜索剪枝、可选解与逐时刻检查。',
  },
  {
    id: 'parallel-fifth',
    label: '矛盾例：平行五度',
    description:
      '对位 II 与定旋律从 C3/G4 同向进行到 D3/A4，两声部均由纯五度进入纯五度。',
    kind: 'invalid',
    key: { tonicPc: 0, mode: 'major' },
    beatsPerMeasure: 4,
    cfText: 'C3:4 D3:4 E3:4',
    u2Text: 'G4:4 A4:4 G4:4',
    focus: '仅启用平行五/八度规则，其余规则放宽，便于看清 C3/G4 → D3/A4 的判决。',
    ruleOverrides: {
      startPerfect: false,
      endOnTonic: false,
      endPerfect: false,
      forbidRepeatedNotes: false,
      requireLeapRecovery: false,
      strongBeatConsonance: false,
    },
  },
  {
    id: 'unresolved-suspension',
    label: '矛盾例：延留音未解决',
    description:
      '对位 II 的 A4 在 C3 上方为大六度（协和），保持到第 2 小节 E3 上方变成纯四度（不协和）；它本应下行级进到 G4，却上行到 B4。',
    kind: 'invalid',
    key: { tonicPc: 0, mode: 'major' },
    beatsPerMeasure: 4,
    cfText: 'C3:4 E3:4',
    u2Text: 'A4:5 B4:3',
    focus: '延留音被识别后，检查其结束是否下行级进解决。',
    ruleOverrides: {
      startPerfect: false,
      endOnTonic: false,
      endPerfect: false,
      strongBeatConsonance: false,
    },
  },
  {
    id: 'leap-recovery',
    label: '矛盾例：跳进未恢复',
    description:
      '对位 I 从 E4 上行纯四度跳进到 A4，下一音继续上行到 B4，没有反向级进。三个纵向音程均协和，矛盾只在横向旋律。',
    kind: 'invalid',
    key: { tonicPc: 0, mode: 'major' },
    beatsPerMeasure: 4,
    cfText: 'C3:4 E3:4 F3:4',
    u1Text: 'E4:4 A4:4 B4:4',
    focus: '只有跳进恢复规则被触发；其余纵向关系全部协和。',
    ruleOverrides: {
      startPerfect: false,
      endOnTonic: false,
      endPerfect: false,
      forbidRepeatedNotes: false,
      strongBeatConsonance: false,
    },
  },
  {
    id: 'voice-crossing',
    label: '矛盾例：声部交错',
    description:
      '第 2 小节对位 I 的 A3 低于定旋律 D4，违反“定旋律为最低声部”的约定。按实际重叠区间比较即可发现。',
    kind: 'invalid',
    key: { tonicPc: 0, mode: 'major' },
    beatsPerMeasure: 4,
    cfText: 'C4:4 D4:4',
    u1Text: 'E4:4 A3:4',
    focus: '纵向比较按发声音高，而不是按声部名义或数组下标。',
    ruleOverrides: {
      startPerfect: false,
      endOnTonic: false,
      endPerfect: false,
      forbidRepeatedNotes: false,
      strongBeatConsonance: false,
      requireLeapRecovery: false,
    },
  },
  {
    id: 'overlap-misalignment',
    label: '演示例：数组下标对齐的陷阱',
    description:
      '三个声部时值不同。若按各声部数组的第 i 个音配对，会得出与实际重叠区间相反的不协和结论。',
    kind: 'demo',
    key: { tonicPc: 0, mode: 'major' },
    beatsPerMeasure: 4,
    cfText: 'C3:4',
    u1Text: 'G4:2 F4:2',
    u2Text: 'E5:4',
    focus: '同一时刻按实际重叠检查：第 3 拍 C3/F4 为纯四度不协和；按相同下标却看不到。',
    ruleOverrides: {
      startPerfect: false,
      endOnTonic: false,
      endPerfect: false,
      forbidRepeatedNotes: false,
    },
  },
  {
    id: 'cross-bar-suspension',
    label: '对比例：跨小节的悬挂义务',
    description:
      '定旋律 C3→B2，对位 II 用 [3,3,2] 切分，第三个音跨过小节线。小节线后的音若在上一小节已开始，就带着“预备延留”进入新小节；截短历史会丢掉这条义务。',
    kind: 'demo',
    key: { tonicPc: 0, mode: 'major' },
    beatsPerMeasure: 4,
    cfText: 'C3:4 B2:4',
    rhythmU1: { kind: 'fixed', duration: 2 },
    rhythmU2: { kind: 'pattern', values: [3, 3, 2] },
    historyPolicy: 'carry',
    focus: '用“历史策略对比”运行两种策略：部分解只在保留悬挂义务时成立。',
    ruleOverrides: {
      startPerfect: false,
      endOnTonic: false,
      endPerfect: false,
    },
  },
];
