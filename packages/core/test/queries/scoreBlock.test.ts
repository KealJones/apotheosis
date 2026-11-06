import { describe, it, expect } from 'vitest';
import { scoreBlock, workPlacesPattern } from '../../src/queries/triageSamples.js';
import type { WorkBlock } from '../../src/summarize.js';

const block = (overrides: Partial<WorkBlock>): WorkBlock => ({
  start: '2026-10-30T20:00:00.000Z',
  end: '2026-10-30T20:05:00.000Z',
  duration_min: 5,
  app_name: 'Google Chrome',
  app_bundle: 'com.google.Chrome',
  window_title: null,
  url: null,
  sample_count: 10,
  sample_ids: [],
  top_words: [],
  ocr_excerpt: '',
  document_paths: [],
  selected_texts: [],
  focused_elements: [],
  ...overrides,
});

describe('scoreBlock', () => {
  it('scores any Slack time high, posting or not', () => {
    expect(scoreBlock(block({ app_name: 'Slack', app_bundle: 'com.tinyspeck.slackmacgap', duration_min: 1 }))).toBe('high');
  });

  it('scores reading on work pages high (PR review, docs, tickets)', () => {
    expect(scoreBlock(block({ url: 'https://github.com/acme/widgets/pull/2763/files' }))).toBe('high');
    expect(scoreBlock(block({ window_title: 'Board - Jira - Google Chrome' }))).toBe('high');
    expect(scoreBlock(block({ ocr_excerpt: 'looked into WID-4739 today' }))).toBe('high');
  });

  it('scores AI tools and outside GitHub medium', () => {
    expect(scoreBlock(block({ app_name: 'Claude', app_bundle: 'com.anthropic.claudefordesktop' }))).toBe('medium');
    expect(scoreBlock(block({ url: 'https://claude.ai/code/session_01' }))).toBe('medium');
    expect(scoreBlock(block({ url: 'https://github.com/mui/material-ui/issues/32425' }))).toBe('medium');
  });

  it('caps long time on a non-work page at medium', () => {
    expect(scoreBlock(block({ window_title: 'Some article', duration_min: 90 }))).toBe('medium');
  });

  it('treats user-configured work_patterns as work and skips invalid ones', () => {
    const places = workPlacesPattern(['docs\\.acme\\.dev', '(unclosed']);
    expect(scoreBlock(block({ url: 'https://docs.acme.dev/guide' }), places)).toBe('high');
    expect(scoreBlock(block({ url: 'https://docs.acme.dev/guide' }), workPlacesPattern([]))).toBe('low');
  });

  it('scores short non-work blips low, ignoring OCR noise like UTF-8', () => {
    expect(scoreBlock(block({ window_title: 'Recipes', ocr_excerpt: 'encoding UTF-8' }))).toBe('low');
  });
});
