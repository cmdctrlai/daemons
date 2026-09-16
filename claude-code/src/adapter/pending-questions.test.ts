/**
 * Tests for PendingQuestions – AskUserQuestion held open across a round trip.
 */

import { PendingQuestions, buildAnswers } from './pending-questions';
import type { AskUserInput } from './events';

const ask = (question: string, labels: string[]): AskUserInput => ({
  questions: [
    {
      question,
      header: 'Pick',
      multiSelect: false,
      options: labels.map((label) => ({ label, description: `${label} desc` })),
    },
  ],
} as unknown as AskUserInput);

describe('buildAnswers', () => {
  const input = ask('Tabs or spaces?', ['Tabs', 'Spaces']);

  const cases: Array<{ name: string; reply: string; want: string }> = [
    { name: 'exact option label', reply: 'Spaces', want: 'Spaces' },
    { name: 'differing case', reply: 'spaces', want: 'Spaces' },
    { name: 'surrounding whitespace', reply: '  Tabs  ', want: 'Tabs' },
    { name: 'free text passes through', reply: 'neither, use gofmt', want: 'neither, use gofmt' },
  ];

  it.each(cases)('$name', ({ reply, want }) => {
    expect(buildAnswers(input, reply)).toEqual({ 'Tabs or spaces?': want });
  });

  it('answers only the question the user was shown', () => {
    // Clients render questions[0] alone, so a reply says nothing about the rest.
    const multi = {
      questions: [
        { question: 'A?', header: 'A', multiSelect: false, options: [{ label: 'Yes', description: '' }] },
        { question: 'B?', header: 'B', multiSelect: false, options: [{ label: 'No', description: '' }] },
      ],
    } as unknown as AskUserInput;

    expect(buildAnswers(multi, 'Yes')).toEqual({ 'A?': 'Yes' });
  });

  it('returns nothing for an ask with no questions', () => {
    expect(buildAnswers({ questions: [] } as unknown as AskUserInput, 'Yes')).toEqual({});
  });

  describe('multi-select', () => {
    const multiAsk = (labels: string[]): AskUserInput => ({
      questions: [
        {
          question: 'Which linters?',
          header: 'Linters',
          multiSelect: true,
          options: labels.map((label) => ({ label, description: '' })),
        },
      ],
    } as unknown as AskUserInput);

    const input = multiAsk(['Tabs', 'Spaces', 'Either']);

    const cases: Array<{ name: string; reply: string; want: string }> = [
      { name: 'two labels joined by a comma', reply: 'Tabs, Spaces', want: 'Tabs, Spaces' },
      { name: 'no space after the comma', reply: 'Tabs,Spaces', want: 'Tabs, Spaces' },
      { name: 'differing case per fragment', reply: 'tabs, SPACES', want: 'Tabs, Spaces' },
      { name: 'keeps the order the client sent', reply: 'Spaces, Tabs', want: 'Spaces, Tabs' },
      { name: 'a single label still works', reply: 'Either', want: 'Either' },
      { name: 'one bad fragment makes the whole reply free text', reply: 'Tabs, Neither', want: 'Tabs, Neither' },
      { name: 'free text with a comma passes through', reply: 'neither, use gofmt', want: 'neither, use gofmt' },
    ];

    it.each(cases)('$name', ({ reply, want }) => {
      expect(buildAnswers(input, reply)).toEqual({ 'Which linters?': want });
    });

    it('matches a label that itself contains a comma', () => {
      const commaLabel = multiAsk(['Yes, always', 'No']);
      expect(buildAnswers(commaLabel, 'yes, always')).toEqual({ 'Which linters?': 'Yes, always' });
    });

    it('leaves a comma-joined reply alone when the question is single-select', () => {
      expect(buildAnswers(ask('Pick one?', ['Tabs', 'Spaces']), 'Tabs, Spaces'))
        .toEqual({ 'Pick one?': 'Tabs, Spaces' });
    });
  });

  it('tolerates an ask with no options', () => {
    const bare = { questions: [{ question: 'Free?', header: 'F', multiSelect: false }] } as unknown as AskUserInput;
    expect(buildAnswers(bare, 'anything')).toEqual({ 'Free?': 'anything' });
  });
});

describe('PendingQuestions', () => {
  it('resolves a parked question with the chosen label', async () => {
    const pending = new PendingQuestions();
    const input = ask('Tabs or spaces?', ['Tabs', 'Spaces']);

    const parked = pending.park('s1', input, 60_000);
    expect(pending.has('s1')).toBe(true);
    expect(pending.answer('s1', 'Spaces')).toBe(true);

    const result = await parked;
    expect(result.behavior).toBe('allow');
    expect(result.behavior === 'allow' && result.updatedInput?.answers).toEqual({
      'Tabs or spaces?': 'Spaces',
    });
    expect(pending.has('s1')).toBe(false);
  });

  it('preserves the original questions alongside the answers', async () => {
    const pending = new PendingQuestions();
    const input = ask('Ship it?', ['Yes']);

    const parked = pending.park('s1', input, 60_000);
    pending.answer('s1', 'Yes');
    const result = await parked;

    expect(result.behavior === 'allow' && result.updatedInput?.questions).toEqual(input.questions);
  });

  it('reports false when nothing is parked for the session', () => {
    const pending = new PendingQuestions();
    expect(pending.answer('nobody', 'hi')).toBe(false);
    expect(pending.cancel('nobody')).toBe(false);
  });

  it('keeps sessions independent', async () => {
    const pending = new PendingQuestions();
    const a = pending.park('s1', ask('A?', ['Yes']), 60_000);
    const b = pending.park('s2', ask('B?', ['No']), 60_000);

    pending.answer('s1', 'Yes');
    expect(pending.has('s2')).toBe(true);

    expect((await a).behavior).toBe('allow');
    pending.answer('s2', 'No');
    expect((await b).behavior).toBe('allow');
  });

  it('denies the older question when a newer one arrives for the same session', async () => {
    const pending = new PendingQuestions();
    const first = pending.park('s1', ask('First?', ['Yes']), 60_000);
    const second = pending.park('s1', ask('Second?', ['No']), 60_000);

    const firstResult = await first;
    expect(firstResult.behavior).toBe('deny');
    expect(firstResult.behavior === 'deny' && firstResult.message).toContain('superseded');

    pending.answer('s1', 'No');
    expect((await second).behavior).toBe('allow');
  });

  it('denies on timeout so a forgotten question cannot pin the session open', async () => {
    jest.useFakeTimers();
    try {
      const pending = new PendingQuestions();
      const parked = pending.park('s1', ask('Still there?', ['Yes']), 1_000);

      jest.advanceTimersByTime(1_000);

      const result = await parked;
      expect(result.behavior).toBe('deny');
      expect(pending.has('s1')).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels everything on shutdown', async () => {
    const pending = new PendingQuestions();
    const a = pending.park('s1', ask('A?', ['Yes']), 60_000);
    const b = pending.park('s2', ask('B?', ['Yes']), 60_000);

    pending.cancelAll();

    expect((await a).behavior).toBe('deny');
    expect((await b).behavior).toBe('deny');
    expect(pending.has('s1')).toBe(false);
  });
});
