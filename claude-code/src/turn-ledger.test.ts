import { TurnLedger, TurnEnd } from './turn-ledger';

// Entries stamped inside [OPEN, CLOSE] were written while the adapter had a query alive.
const OPEN = 1_000_000;
const CLOSE = 2_000_000;
const inSpan = (at: number) => at >= OPEN && at <= CLOSE;

type E = Record<string, unknown>;
const ts = (at: number) => new Date(at).toISOString();
const prompt = (uuid: string, at: number, extra: E = {}, parentUuid?: string): E =>
  ({ type: 'user', uuid, parentUuid, timestamp: ts(at), message: { role: 'user', content: 'go' }, ...extra });
const typed = (uuid: string, at: number, parentUuid?: string) => prompt(uuid, at, { promptSource: 'typed', origin: { kind: 'human' } }, parentUuid);
const sdk = (uuid: string, at: number, parentUuid?: string) => prompt(uuid, at, { promptSource: 'sdk' }, parentUuid);
const notification = (uuid: string, at: number, parentUuid?: string) => prompt(uuid, at, { promptSource: 'system', origin: { kind: 'task-notification' } }, parentUuid);
const assistant = (uuid: string, parentUuid: string | undefined, stop: string, content: E[] = [{ type: 'text', text: 'hi' }], extra: E = {}): E =>
  ({ type: 'assistant', uuid, parentUuid, timestamp: ts(OPEN + 1), message: { role: 'assistant', stop_reason: stop, content }, ...extra });
const reply = (uuid: string, parentUuid?: string) => assistant(uuid, parentUuid, 'end_turn');
const toolUse = (uuid: string, parentUuid?: string, name = 'Bash') => assistant(uuid, parentUuid, 'tool_use', [{ type: 'tool_use', id: 'tu', name, input: {} }]);
const toolResult = (uuid: string, parentUuid: string | undefined, content = 'ok'): E =>
  ({ type: 'user', uuid, parentUuid, timestamp: ts(OPEN + 1), sourceToolAssistantUUID: parentUuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu', content }] } });
const system = (uuid: string, parentUuid: string | undefined, subtype: string): E => ({ type: 'system', subtype, uuid, parentUuid, timestamp: ts(OPEN + 1) });
const interrupt = (uuid: string, parentUuid?: string): E =>
  ({ type: 'user', uuid, parentUuid, timestamp: ts(OPEN + 1), message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } });

/** Feeds the entries and returns the ends observed, as "root:reason". */
function ends(entries: E[], ownedByAdapter = inSpan): { ends: string[]; ledger: TurnLedger } {
  const ledger = new TurnLedger(ownedByAdapter);
  const seen: string[] = [];
  const record = (end: TurnEnd | null) => {
    if (end) seen.push(`${end.turn.root}:${end.reason}:${end.turn.owner}${end.turn.sawAssistant ? '' : ':no-assistant'}`);
  };
  for (const entry of entries) record(ledger.observe(entry));
  // Two quiet polls after the last entry.
  ledger.endBatch().forEach(record);
  ledger.endBatch().forEach(record);
  return { ends: seen, ledger };
}

describe('TurnLedger ownership', () => {
  const cases: Array<{ name: string; entry: E; owner: 'adapter' | 'watcher' }> = [
    { name: 'an SDK prompt while the adapter had a query', entry: sdk('u', OPEN + 10), owner: 'adapter' },
    { name: 'an SDK prompt from another host, before the adapter had a query', entry: sdk('u', OPEN - 10), owner: 'watcher' },
    { name: 'an SDK prompt from another host, after the adapter closed its query', entry: sdk('u', CLOSE + 10), owner: 'watcher' },
    { name: 'a task notification while the adapter had a query', entry: notification('u', OPEN + 10), owner: 'adapter' },
    { name: 'a task notification in a terminal session', entry: notification('u', OPEN - 10), owner: 'watcher' },
    { name: 'a terminal prompt while the adapter had a query', entry: typed('u', OPEN + 10), owner: 'watcher' },
    { name: 'a terminal prompt with no adapter query', entry: typed('u', OPEN - 10), owner: 'watcher' },
    { name: 'a prompt with no stamp of its source, while the adapter had a query', entry: prompt('u', OPEN + 10), owner: 'adapter' },
    { name: 'a prompt without a timestamp', entry: { ...sdk('u', OPEN + 10), timestamp: undefined }, owner: 'watcher' },
  ];

  it.each(cases)('$name belongs to the $owner', ({ entry, owner }) => {
    const { ends: seen, ledger } = ends([entry, reply('a', 'u')]);
    expect(seen).toEqual([`u:stop_reason:${owner}`]);
    expect(ledger.unannouncedAdapterTurn()?.root).toBe(owner === 'adapter' ? 'u' : undefined);
  });
});

describe('TurnLedger turn ends', () => {
  const cases: Array<{ name: string; entries: E[]; ends: string[] }> = [
    { name: 'a stop reason', entries: [typed('u', 1), reply('a', 'u')], ends: ['u:stop_reason:watcher'] },
    { name: 'max_tokens', entries: [typed('u', 1), assistant('a', 'u', 'max_tokens')], ends: ['u:stop_reason:watcher'] },
    { name: 'a turn_duration system entry after a tool call', entries: [typed('u', 1), toolUse('t', 'u'), toolResult('r', 't'), system('s', 'r', 'turn_duration')], ends: ['u:system turn_duration:watcher'] },
    { name: 'a stop_hook_summary system entry', entries: [typed('u', 1), toolUse('t', 'u'), system('s', 't', 'stop_hook_summary')], ends: ['u:system stop_hook_summary:watcher'] },
    { name: 'only the first of several end markers', entries: [typed('u', 1), reply('a', 'u'), reply('a2', 'a'), system('s', 'a2', 'stop_hook_summary'), system('s2', 's', 'turn_duration')], ends: ['u:system stop_hook_summary:watcher'] },
    { name: 'no compact_boundary mid-turn', entries: [typed('u', 1), toolUse('t', 'u'), system('c', undefined, 'compact_boundary'), { ...toolResult('cs', 't', 'summary'), isCompactSummary: true }, reply('a', 'cs'), system('s', 'a', 'turn_duration')], ends: ['u:system turn_duration:watcher'] },
    { name: 'no local_command, away_summary or other system entry', entries: [typed('u', 1), toolUse('t', 'u'), system('l', 't', 'local_command'), system('w', 'l', 'away_summary'), system('i', 'w', 'informational'), system('k', 'i', 'agents_killed'), system('n', 'k', undefined as unknown as string)], ends: [] },
    { name: 'an API error', entries: [typed('u', 1), assistant('e', 'u', 'stop_sequence', [{ type: 'text', text: 'API Error' }], { isApiErrorMessage: true })], ends: ['u:API error:watcher'] },
    { name: 'a question to the user', entries: [typed('u', 1), toolUse('q', 'u', 'AskUserQuestion')], ends: ['u:waiting for user input:watcher'] },
    { name: 'a plan awaiting approval', entries: [typed('u', 1), toolUse('q', 'u', 'ExitPlanMode')], ends: ['u:waiting for user input:watcher'] },
    { name: 'an interrupt after output', entries: [typed('u', 1), toolUse('t', 'u'), interrupt('i', 't')], ends: ['u:interrupted:watcher'] },
    { name: 'an interrupt inside a tool result', entries: [typed('u', 1), toolUse('t', 'u'), toolResult('r', 't', '[Request interrupted by user for tool use]')], ends: ['u:interrupted:watcher'] },
    { name: 'an interrupt before any output, with no assistant entry to announce', entries: [typed('u', 1), interrupt('i', 'u')], ends: ['u:interrupted:watcher:no-assistant'] },
    { name: 'a local command turn with no assistant entry', entries: [typed('u', 1), system('l', 'u', 'local_command'), system('d', 'l', 'turn_duration')], ends: ['u:system turn_duration:watcher:no-assistant'] },
    { name: 'two turns ending back to back', entries: [typed('u1', 1), reply('a1', 'u1'), system('s1', 'a1', 'turn_duration'), typed('u2', 2, 's1'), reply('a2', 'u2'), system('s2', 'a2', 'turn_duration')], ends: ['u1:system turn_duration:watcher', 'u2:system turn_duration:watcher'] },
    { name: 'two turns whose stop reasons wait for a quiet poll', entries: [typed('u1', 1), reply('a1', 'u1'), typed('u2', 2, 'a1'), reply('a2', 'u2')], ends: ['u1:stop_reason:watcher', 'u2:stop_reason:watcher'] },
    { name: 'a stop reason split over a thinking entry and a text entry', entries: [typed('u', 1), assistant('th', 'u', 'end_turn', [{ type: 'thinking', thinking: 'hm' }]), reply('a', 'th'), assistant('a2', 'a', 'end_turn'), system('s', 'a2', 'stop_hook_summary')], ends: ['u:system stop_hook_summary:watcher'] },
    { name: 'a marker before any prompt', entries: [reply('a', undefined), system('s', 'a', 'turn_duration')], ends: [] },
    { name: 'an entry with an unknown parent, charged to the latest prompt', entries: [typed('u', 1), reply('a', 'never-seen')], ends: ['u:stop_reason:watcher'] },
    {
      name: 'interleaved terminal and adapter turns, told apart by their parent chain',
      entries: [typed('t', OPEN + 1), toolUse('tt', 't'), sdk('s', OPEN + 2, 'tt'), toolUse('st', 's'), toolResult('tr', 'tt'), reply('ta', 'tr'), system('ts', 'ta', 'stop_hook_summary'), toolResult('sr', 'st'), reply('sa', 'sr'), system('ss', 'sa', 'stop_hook_summary')],
      ends: ['t:system stop_hook_summary:watcher', 's:system stop_hook_summary:adapter'],
    },
    {
      name: 'a terminal turn ending after an adapter prompt whose chain it is not on',
      entries: [typed('t', OPEN + 1), toolUse('tt', 't'), sdk('s', OPEN + 2, 'tt'), reply('ta', 'tt'), system('ts', 'ta', 'stop_hook_summary')],
      ends: ['t:system stop_hook_summary:watcher'],
    },
  ];

  it.each(cases)('ends on $name', ({ entries, ends: want }) => {
    expect(ends(entries).ends).toEqual(want);
  });

  it('announces adapter turns newest first, each once', () => {
    const { ledger } = ends([sdk('u1', OPEN + 1), reply('a1', 'u1'), sdk('u2', OPEN + 2, 'a1'), reply('a2', 'u2')]);
    const first = ledger.unannouncedAdapterTurn();
    expect(first?.root).toBe('u2');
    first!.announced = true;
    expect(ledger.unannouncedAdapterTurn()?.root).toBe('u1');
    ledger.unannouncedAdapterTurn()!.announced = true;
    expect(ledger.unannouncedAdapterTurn()).toBeUndefined();
  });

  it('ends a stopped turn at the first poll that brings nothing more of it', () => {
    const ledger = new TurnLedger(() => false);
    ledger.observe(typed('u', 1));
    ledger.observe(assistant('th', 'u', 'end_turn', [{ type: 'thinking', thinking: 'hm' }]));
    expect(ledger.endBatch()).toEqual([]);
    expect(ledger.observe(reply('a', 'th'))).toBeNull();
    expect(ledger.endBatch()).toEqual([]);
    expect(ledger.endBatch().map((e) => e.turn.root)).toEqual(['u']);
    expect(ledger.endBatch()).toEqual([]);
    expect(ledger.observe(system('s', 'a', 'turn_duration'))).toBeNull();
  });

  it('settles every stopped turn at once, as at the end of a transcript already written', () => {
    const ledger = new TurnLedger(() => false);
    ledger.observe(typed('u', 1));
    ledger.observe(reply('a', 'u'));
    expect(ledger.settle().map((e) => e.turn.root)).toEqual(['u']);
    expect(ledger.settle()).toEqual([]);
  });

  it('forgets turns beyond the newest 64', () => {
    const entries: E[] = [];
    for (let i = 0; i < 70; i++) entries.push(typed(`u${i}`, i), reply(`a${i}`, `u${i}`));
    const { ledger } = ends(entries);
    expect(ledger.observe(system('late', 'a0', 'turn_duration'))).toBeNull();
    expect(ledger.observe(system('late2', 'a69', 'stop_hook_summary'))).toBeNull();
    expect(ledger.observe(toolUse('again', 'u69', 'AskUserQuestion'))).toBeNull();
  });
});
