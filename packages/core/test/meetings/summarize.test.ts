import { describe, it, expect, vi } from 'vitest';
import {
  groupIntoTurns,
  chunkTranscript,
  summarizeTranscript,
  type TranscriptSegment,
} from '../../src/meetings/summarize.js';

function seg(started_ms: number, channel: string, speaker: string | null, text: string): TranscriptSegment {
  return { started_ms, channel, speaker, text };
}

describe('groupIntoTurns', () => {
  it('merges consecutive segments from the same channel/speaker into one turn', () => {
    const segments = [
      seg(0, 'them', 'Alice', 'Hello everyone.'),
      seg(2000, 'them', 'Alice', 'Let\'s get started.'),
      seg(4000, 'me', null, 'Sounds good.'),
    ];
    const turns = groupIntoTurns(segments);
    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe('Hello everyone. Let\'s get started.');
    expect(turns[1].text).toBe('Sounds good.');
  });

  it('starts a new turn when speaker changes even if channel is the same', () => {
    const segments = [
      seg(0, 'them', 'Alice', 'Hi.'),
      seg(1000, 'them', 'Bob', 'Hi Alice.'),
    ];
    const turns = groupIntoTurns(segments);
    expect(turns).toHaveLength(2);
  });

  it('handles a single segment', () => {
    expect(groupIntoTurns([seg(0, 'me', null, 'Solo.')])).toHaveLength(1);
  });

  it('handles no segments', () => {
    expect(groupIntoTurns([])).toEqual([]);
  });
});

describe('chunkTranscript', () => {
  it('produces a single chunk for a short transcript', () => {
    const segments = [
      seg(0, 'them', 'Alice', 'Hello.'),
      seg(1000, 'me', null, 'Hi Alice.'),
    ];
    const chunks = chunkTranscript(segments, 6000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('Alice');
    expect(chunks[0]).toContain('Hi Alice.');
  });

  it('never splits a turn across chunk boundaries', () => {
    // Build many turns, each ~500 chars, with a small target so multiple chunks are produced.
    const longText = 'word '.repeat(100); // ~500 chars
    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < 20; i++) {
      const channel = i % 2 === 0 ? 'them' : 'me';
      const speaker = channel === 'them' ? 'Alice' : null;
      segments.push(seg(i * 10000, channel, speaker, `turn${i} ${longText}`));
    }

    const chunks = chunkTranscript(segments, 2000);
    expect(chunks.length).toBeGreaterThan(1);

    // Every individual turn's rendered marker (turnN) must appear in exactly
    // one chunk, and — since chunks are built by concatenating whole rendered
    // turns joined with '\n' — a turn can never be split mid-way: reassembling
    // all chunks must reproduce every turn's full text intact.
    const rejoined = chunks.join('\n');
    for (let i = 0; i < 20; i++) {
      const marker = `turn${i} `;
      const occurrences = rejoined.split(marker).length - 1;
      expect(occurrences).toBe(1);
    }

    // No chunk should contain a partial "word " run cut off mid-token in a way
    // that splits a turn: each chunk, split on turn boundaries, should parse
    // back into whole "turnN ...word word...word " segments only.
    for (const chunk of chunks) {
      const lines = chunk.split('\n');
      for (const line of lines) {
        // Every line is a fully rendered turn: "[m:ss] who: turnN word word ..."
        expect(line).toMatch(/^\[\d+:\d{2}\] .+: turn\d+ (word )+$/);
      }
    }
  });

  it('keeps chunk sizes close to the target when many small turns are available', () => {
    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < 50; i++) {
      segments.push(seg(i * 1000, i % 2 === 0 ? 'them' : 'me', i % 2 === 0 ? 'Alice' : null, `short line ${i}`));
    }
    const chunks = chunkTranscript(segments, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks.slice(0, -1)) {
      // Each non-final chunk should be reasonably close to the target, not wildly over.
      expect(chunk.length).toBeLessThanOrEqual(500 + 100); // some slack for the last turn that tipped it over
    }
  });

  it('still emits a single oversized turn as its own chunk rather than dropping it', () => {
    const hugeText = 'x'.repeat(10000);
    const segments = [seg(0, 'them', 'Alice', hugeText)];
    const chunks = chunkTranscript(segments, 100);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain(hugeText);
  });

  it('returns no chunks for an empty transcript', () => {
    expect(chunkTranscript([], 6000)).toEqual([]);
  });
});

describe('summarizeTranscript', () => {
  const validJson = JSON.stringify({
    tldr: 'We discussed Q3 planning.',
    topics: ['Q3 planning'],
    decisions: ['"Move sprint planning to Thursday mornings"'],
    action_items: [{ text: 'Review roadmap PRs', owner: 'me' }],
    open_questions: ['Who owns resourcing?'],
    my_contributions: ['Proposed Thursday planning slot'],
  });

  it('throws when there are no segments', async () => {
    await expect(summarizeTranscript([])).rejects.toThrow(/No transcript segments/);
  });

  it('uses the single-chunk JSON path (skips map step) for a short transcript', async () => {
    const chatFn = vi.fn().mockResolvedValue('should not be called');
    const jsonChatFn = vi.fn().mockResolvedValue(validJson);

    const segments = [
      seg(0, 'them', 'Alice', 'Let\'s talk about Q3 planning.'),
      seg(2000, 'me', null, 'I think we should move sprint planning to Thursday mornings.'),
    ];

    const result = await summarizeTranscript(segments, { chatFn, jsonChatFn });

    expect(chatFn).not.toHaveBeenCalled();
    expect(jsonChatFn).toHaveBeenCalledTimes(1);
    expect(result.tldr).toBe('We discussed Q3 planning.');
    expect(result.action_items).toEqual([{ text: 'Review roadmap PRs', owner: 'me' }]);
  });

  it('runs one map call per chunk then a single reduce call for a multi-chunk transcript', async () => {
    const chatFn = vi.fn().mockResolvedValue('partial summary text');
    const jsonChatFn = vi.fn().mockResolvedValue(validJson);

    const longText = 'word '.repeat(300); // ~1500 chars per turn
    const segments: TranscriptSegment[] = [];
    for (let i = 0; i < 10; i++) {
      segments.push(seg(i * 10000, i % 2 === 0 ? 'them' : 'me', i % 2 === 0 ? 'Alice' : null, `${longText}`));
    }

    const result = await summarizeTranscript(segments, { chatFn, jsonChatFn, chunkChars: 2000 });

    const expectedChunks = chatFn.mock.calls.length;
    expect(expectedChunks).toBeGreaterThan(1);
    expect(jsonChatFn).toHaveBeenCalledTimes(1); // exactly one reduce call
    expect(result.tldr).toBe('We discussed Q3 planning.');
  });

  it('coerces an invalid/missing action item owner to "unknown" rather than inventing one', async () => {
    const jsonChatFn = vi.fn().mockResolvedValue(JSON.stringify({
      tldr: 't',
      topics: [],
      decisions: [],
      action_items: [{ text: 'Do the thing' }, { text: 'Do another thing', owner: 'bogus' }],
      open_questions: [],
      my_contributions: [],
    }));

    const result = await summarizeTranscript([seg(0, 'them', 'Alice', 'hi')], { jsonChatFn, chatFn: vi.fn() });

    expect(result.action_items).toEqual([
      { text: 'Do the thing', owner: 'unknown' },
      { text: 'Do another thing', owner: 'unknown' },
    ]);
  });

  it('strips markdown code fences from the model response before parsing', async () => {
    const jsonChatFn = vi.fn().mockResolvedValue('```json\n' + validJson + '\n```');
    const result = await summarizeTranscript([seg(0, 'them', 'Alice', 'hi')], { jsonChatFn, chatFn: vi.fn() });
    expect(result.tldr).toBe('We discussed Q3 planning.');
  });

  it('throws a clear error when the model response is not valid JSON', async () => {
    const jsonChatFn = vi.fn().mockResolvedValue('not json at all');
    await expect(
      summarizeTranscript([seg(0, 'them', 'Alice', 'hi')], { jsonChatFn, chatFn: vi.fn() })
    ).rejects.toThrow(/valid JSON/);
  });
});
