import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { RehearsalPanel } from '../src/components/RehearsalPanel.js';
import { defaultRosters, planRehearsal } from '../src/core/rehearsal.js';
import { buildScoreFromParts } from '../src/core/examples.js';
import { DEFAULT_RULES } from '../src/core/rules.js';
import type { VoiceId } from '../src/core/score.js';

function suspensionScore() {
  return buildScoreFromParts(
    [
      { onset: 0, duration: 4, pitch: 48 },
      { onset: 4, duration: 4, pitch: 47 },
      { onset: 8, duration: 4, pitch: 48 },
    ],
    [
      { onset: 0, duration: 4, pitch: 60 },
      { onset: 4, duration: 4, pitch: 67 },
      { onset: 8, duration: 4, pitch: 64 },
    ],
    [
      { onset: 0, duration: 8, pitch: 69 },
      { onset: 8, duration: 4, pitch: 67 },
    ],
    { key: { tonicPc: 0, mode: 'major' }, beatsPerMeasure: 4 },
  );
}

const ranges: Record<VoiceId, { low: number; high: number; name: string }> = {
  cf: { low: 36, high: 60, name: '定旋律' },
  u1: { low: 55, high: 84, name: '对位 I' },
  u2: { low: 60, high: 96, name: '对位 II' },
};

afterEach(cleanup);

describe('RehearsalPanel', () => {
  it('shows the part score and who completes a suspension', () => {
    const score = suspensionScore();
    const plan = planRehearsal(score, defaultRosters(ranges, 4), DEFAULT_RULES);
    render(<RehearsalPanel plan={plan} score={score} />);

    const panel = screen.getByLabelText('分谱与排练');
    // suspension completion table lists the held/resolved singers
    expect(within(panel).getByText('悬挂音由哪位歌手完成')).toBeInTheDocument();
    const rows = within(panel).getAllByRole('row');
    // header + at least one suspension row
    expect(rows.length).toBeGreaterThan(1);
    // part score is rendered as text with singer headers
    expect(within(panel).getByText(/== u2 ·/)).toBeInTheDocument();
  });

  it('flags multi-track anomalies in the playback group', () => {
    const score = suspensionScore();
    // A roster whose only singer cannot sing u2's high A4 -> unsingable voice issue.
    const config = defaultRosters(ranges, 4);
    config.rosters.u2.singers[0].high = 60;
    const plan = planRehearsal(score, config, DEFAULT_RULES);
    render(<RehearsalPanel plan={plan} score={score} />);
    const panel = screen.getByLabelText('分谱与排练');
    expect(within(panel).getByText(/对位声部异常/)).toBeInTheDocument();
  });
});
