import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import App from '../src/App.js';

afterEach(cleanup);

describe('App · counterpoint search stays inside the arrangement UI', () => {
  it('runs search from the UI button and keeps voices plus multi-track audition visible', async () => {
    render(<App />);

    // The arrangement UI owns the search interaction (not a CLI).
    const searchButton = screen.getByRole('button', { name: '搜索两条对位声部' });
    expect(searchButton).toBeInTheDocument();
    expect(screen.getByText('尚未运行对位搜索')).toBeInTheDocument();

    // Multi-track audition and the rehearsal/part-score panel are present.
    expect(screen.getByLabelText('多轨试听')).toBeInTheDocument();
    expect(screen.getByLabelText('分谱与排练')).toBeInTheDocument();

    fireEvent.click(searchButton);

    // Running status is visible immediately, then resolves to a completed search.
    await waitFor(() => {
      expect(screen.getByText(/对位搜索运行中|对位搜索完成/)).toBeInTheDocument();
    });
    await waitFor(
      () => {
        expect(screen.getByText(/对位搜索完成/)).toBeInTheDocument();
      },
      { timeout: 12000 },
    );

    // After searching, the result panel and the counterpoint voices still render,
    // and the multi-track audition is still part of the interaction.
    expect(screen.getByLabelText('搜索结果')).toBeInTheDocument();
    const player = screen.getByLabelText('多轨试听');
    expect(within(player).getByRole('button', { name: /播放合奏/ })).toBeInTheDocument();
    // The rehearsal panel now has a part score (voices were produced by the search).
    const rehearsal = screen.getByLabelText('分谱与排练');
    expect(within(rehearsal).getByText('分谱')).toBeInTheDocument();
  }, 20000);
});
