/**
 * Fixtures are trimmed excerpts of real rollout files:
 *   old  ~/.codex/sessions/2026/08/30/rollout-...-01a054db-....jsonl  (0.148.0-alpha.9)
 *   new  ~/.codex/sessions/2026/09/05/rollout-...-01a07276-....jsonl  (0.153.4)
 * Long fields (base_instructions, dynamic_tools, message bodies) are shortened;
 * every key the parser reads is left exactly as Codex wrote it.
 */

import { parseRollout, resetRolloutWarnings } from './session-parser';

const OLD_FORMAT = [
  '{"timestamp":"2026-08-30T22:48:21.803Z","type":"session_meta","payload":{"session_id":"01a054db-9963-7dd0-ac5b-c82ea702c983","id":"01a054db-9963-7dd0-ac5b-c82ea702c983","timestamp":"2026-08-30T22:47:52.932Z","cwd":"/Users/dev/src/api-service","originator":"codex_work_desktop","cli_version":"0.148.0-alpha.9","source":"vscode","thread_source":"user","model_provider":"openai","base_instructions":{"text":"<trimmed>"}}}',
  '{"timestamp":"2026-08-30T22:48:22.102Z","type":"event_msg","payload":{"type":"user_message","client_id":"512d89b8-c198-42e5-bad2-0a63e4b37ba2","message":"how do we sever the import link\\n","images":[],"local_images":[],"audio":[],"local_audio":[],"text_elements":[]}}',
  '{"timestamp":"2026-08-30T22:48:24.185Z","type":"event_msg","payload":{"type":"agent_message","message":"Checking the current desktop-app guidance.","phase":"commentary","memory_citation":null}}',
  '{"timestamp":"2026-08-30T22:48:39.346Z","type":"event_msg","payload":{"type":"agent_message","message":"Confirming the local setting name.","phase":"commentary","memory_citation":null}}',
  '{"timestamp":"2026-08-30T22:49:02.471Z","type":"event_msg","payload":{"type":"agent_message","message":"It is a live local importer. Turn it off in Settings.","phase":"final_answer","memory_citation":null}}',
  '{"timestamp":"2026-08-30T22:49:02.794Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"01a054dc-0a0c-7252-a0a9-dd2f3dfd7119","last_agent_message":"It is a live local importer. Turn it off in Settings.","started_at":1788130101,"completed_at":1788130142}}',
  '{"timestamp":"2026-08-30T23:15:51.231Z","type":"event_msg","payload":{"type":"user_message","client_id":"6ffe0aef-aa34-452c-bf1a-e59b913e5ad5","message":"How do I remove them from the import history?\\n","images":[],"text_elements":[]}}',
  '{"timestamp":"2026-08-30T23:15:56.660Z","type":"event_msg","payload":{"type":"agent_message","message":"Separating the copied chats from the importer record.","phase":"commentary","memory_citation":null}}',
].join('\n');

const NEW_FORMAT = [
  '{"timestamp":"2026-09-05T16:50:06.216Z","ordinal":0,"type":"session_meta","payload":{"session_id":"01a07276-a69c-7282-8e89-6bab77f2da3a","id":"01a07276-a69c-7282-8e89-6bab77f2da3a","timestamp":"2026-09-05T16:46:13.683Z","cwd":"/Users/dev/src/scratch","originator":"codex-tui","cli_version":"0.153.4","source":"cli","thread_source":"user","model_provider":"openai","base_instructions":{"text":"<trimmed>"},"history_mode":"paginated","git":{}}}',
  '{"timestamp":"2026-09-05T16:50:06.216Z","ordinal":1,"type":"event_msg","payload":{"type":"task_started","turn_id":"01a0727a-32e5-7790-a451-f60545cb63b7","started_at":1788627006,"model_context_window":258400,"collaboration_mode_kind":"default"}}',
  '{"timestamp":"2026-09-05T16:50:06.518Z","ordinal":7,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a07276-a69c-7282-8e89-6bab77f2da3a","turn_id":"01a0727a-32e5-7790-a451-f60545cb63b7","item":{"type":"UserMessage","id":"01a0727a-3436-7c92-b344-bff233fa56d7","content":[{"type":"text","text":"what time is i?","text_elements":[]}]},"started_at_ms":1788627006518,"completed_at_ms":1788627006518}}',
  '{"timestamp":"2026-09-05T16:50:09.239Z","ordinal":8,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a07276-a69c-7282-8e89-6bab77f2da3a","turn_id":"01a0727a-32e5-7790-a451-f60545cb63b7","item":{"type":"Reasoning","id":"rs_05fb2d92e45ca69f016a9c4840441887d0afc04efbe3e3fab8","summary_text":[],"raw_content":[]},"started_at_ms":1788627008207,"completed_at_ms":1788627009239}}',
  '{"timestamp":"2026-09-05T16:50:09.573Z","ordinal":10,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a07276-a69c-7282-8e89-6bab77f2da3a","turn_id":"01a0727a-32e5-7790-a451-f60545cb63b7","item":{"type":"AgentMessage","id":"msg_05fb2d92e45ca69f016a9c48414b4887d0b23a01e4529d965c","content":[{"type":"Text","text":"Checking the current local time now."}],"phase":"commentary"},"started_at_ms":1788627009241,"completed_at_ms":1788627009573}}',
  '{"timestamp":"2026-09-05T16:50:10.002Z","ordinal":14,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a07276-a69c-7282-8e89-6bab77f2da3a","turn_id":"01a0727a-32e5-7790-a451-f60545cb63b7","item":{"type":"CommandExecution","id":"call_elymxZcH3EO1lUDvozXPLpsx","process_id":"37315","command":["/bin/bash","-lc","date"],"cwd":"file:///Users/dev/src/scratch","status":"completed","stdout":"Sat Sep  5 10:50:09 MDT 2026\\n","exit_code":0},"started_at_ms":1788627010002,"completed_at_ms":1788627010002}}',
  '{"timestamp":"2026-09-05T16:50:13.536Z","ordinal":19,"type":"event_msg","payload":{"type":"item_completed","thread_id":"01a07276-a69c-7282-8e89-6bab77f2da3a","turn_id":"01a0727a-32e5-7790-a451-f60545cb63b7","item":{"type":"AgentMessage","id":"msg_05fb2d92e45ca69f016a9c4845500487d0a9c80f562baf98bd","content":[{"type":"Text","text":"10:50 AM MDT on September 5, 2026."}],"phase":"final_answer"},"started_at_ms":1788627013362,"completed_at_ms":1788627013536}}',
  '{"timestamp":"2026-09-05T16:50:16.535Z","ordinal":23,"type":"event_msg","payload":{"type":"task_complete","turn_id":"01a0727a-32e5-7790-a451-f60545cb63b7","last_agent_message":"10:50 AM MDT on September 5, 2026.","started_at":1788627006,"completed_at":1788627016,"duration_ms":10346}}',
].join('\n');

// New-format session whose turn completed having only reasoned and run commands.
const TOOLS_ONLY = [
  '{"timestamp":"2026-09-04T05:37:25.000Z","type":"session_meta","payload":{"id":"01a07012-5639-7962-9e83-a21229035e89","timestamp":"2026-09-04T05:37:25.000Z","cwd":"/Users/dev/src/app","cli_version":"0.153.4"}}',
  '{"timestamp":"2026-09-04T05:37:25.100Z","type":"event_msg","payload":{"type":"task_started","turn_id":"t1","started_at":1788630000}}',
  '{"timestamp":"2026-09-04T05:37:26.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"Reasoning","id":"rs_1","summary_text":[],"raw_content":[]}}}',
  '{"timestamp":"2026-09-04T05:37:27.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"call_1","command":["/bin/bash","-lc","ls"],"status":"completed","exit_code":0}}}',
  '{"timestamp":"2026-09-04T05:37:28.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"SubAgentActivity","id":"sa_1","status":"completed"}}}',
  '{"timestamp":"2026-09-04T05:37:29.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","last_agent_message":"done","completed_at":1788630009}}',
].join('\n');

// The same session part-way through its first turn, before any item lands.
const TURN_IN_FLIGHT = TOOLS_ONLY.split('\n').slice(0, 2).join('\n');

// A session that has only just been created – no turns yet.
const META_ONLY =
  '{"timestamp":"2026-09-05T16:46:13.683Z","type":"session_meta","payload":{"id":"01a07276-0000-7282-8e89-6bab77f2da3a","timestamp":"2026-09-05T16:46:13.683Z","cwd":"/Users/dev/src/scratch","cli_version":"0.153.4"}}';

const MALFORMED_LINES = [
  '{"timestamp":"2026-09-05T16:50:06.216Z","type":"session_meta","payload":{"id":"01a07276-1111-7282-8e89-6bab77f2da3a","cwd":"/Users/dev/src/scratch","cli_version":"0.153.4"}}',
  'not json at all',
  '',
  '{"timestamp":"2026-09-05T16:50:06.518Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"text","text":"still parsed"}]}}}',
].join('\n');

// Content tags Codex has used across versions, plus a non-text part.
const CONTENT_TAG_VARIANTS = [
  '{"timestamp":"2026-09-05T00:00:00.000Z","type":"session_meta","payload":{"id":"01a07276-2222-7282-8e89-6bab77f2da3a","cwd":"/tmp/x","cli_version":"0.153.4"}}',
  '{"timestamp":"2026-09-05T00:00:01.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"UserMessage","content":[{"type":"Text","text":"capital tag"}]}}}',
  '{"timestamp":"2026-09-05T00:00:02.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"text","text":"lowercase tag"}],"phase":"final_answer"}}}',
  '{"timestamp":"2026-09-05T00:00:03.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"output_text","text":"response-item tag"}],"phase":"final_answer"}}}',
  '{"timestamp":"2026-09-05T00:00:04.000Z","type":"event_msg","payload":{"type":"item_completed","item":{"type":"AgentMessage","content":[{"type":"image","image_url":"data:..."},{"type":"Text","text":"line one"},{"type":"Text","text":"line two"}],"phase":"final_answer"}}}',
].join('\n');

describe('parseRollout', () => {
  beforeEach(() => {
    resetRolloutWarnings();
  });

  describe('messages', () => {
    // The empty-rollout warning has its own block below; keep it out of this output.
    beforeEach(() => {
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const cases: Array<{
      name: string;
      raw: string;
      expected: Array<{ id: string; role: 'user' | 'agent'; content: string }>;
    }> = [
      {
        name: 'old format (<= 0.148) user_message / agent_message',
        raw: OLD_FORMAT,
        expected: [
          { id: 'user-0', role: 'user', content: 'how do we sever the import link\n' },
          { id: 'agent-1', role: 'agent', content: 'Checking the current desktop-app guidance.' },
          { id: 'agent-2', role: 'agent', content: 'Confirming the local setting name.' },
          { id: 'agent-3', role: 'agent', content: 'It is a live local importer. Turn it off in Settings.' },
          { id: 'user-4', role: 'user', content: 'How do I remove them from the import history?\n' },
          { id: 'agent-5', role: 'agent', content: 'Separating the copied chats from the importer record.' },
        ],
      },
      {
        name: 'new format (>= 0.151) item_completed wrapper',
        raw: NEW_FORMAT,
        expected: [
          { id: 'user-0', role: 'user', content: 'what time is i?' },
          { id: 'agent-1', role: 'agent', content: 'Checking the current local time now.' },
          { id: 'agent-2', role: 'agent', content: '10:50 AM MDT on September 5, 2026.' },
        ],
      },
      {
        name: 'new format with only Reasoning / CommandExecution / SubAgentActivity items',
        raw: TOOLS_ONLY,
        expected: [],
      },
      {
        name: 'session_meta only',
        raw: META_ONLY,
        expected: [],
      },
      {
        name: 'unparseable and blank lines are skipped',
        raw: MALFORMED_LINES,
        expected: [{ id: 'user-0', role: 'user', content: 'still parsed' }],
      },
      {
        name: 'content tag casing and multi-part content',
        raw: CONTENT_TAG_VARIANTS,
        expected: [
          { id: 'user-0', role: 'user', content: 'capital tag' },
          { id: 'agent-1', role: 'agent', content: 'lowercase tag' },
          { id: 'agent-2', role: 'agent', content: 'response-item tag' },
          { id: 'agent-3', role: 'agent', content: 'line one\nline two' },
        ],
      },
      {
        name: 'empty input',
        raw: '',
        expected: [],
      },
    ];

    it.each(cases)('$name', ({ raw, expected }) => {
      const { messages } = parseRollout(raw, '/fixtures/rollout.jsonl');
      expect(messages.map(m => ({ id: m.id, role: m.role, content: m.content }))).toEqual(expected);
    });
  });

  describe('agent phase', () => {
    // Commentary is surfaced, not filtered: the old agent_message event carried
    // the same phase field and CmdCtrl has always shown both, so dropping
    // commentary would make the new format render differently from the 134
    // historical rollouts sitting next to it.
    it('keeps commentary and final_answer for the new format', () => {
      const { messages } = parseRollout(NEW_FORMAT, '/fixtures/new.jsonl');
      expect(messages.filter(m => m.role === 'agent').map(m => m.content)).toEqual([
        'Checking the current local time now.',
        '10:50 AM MDT on September 5, 2026.',
      ]);
    });

    it('keeps commentary and final_answer for the old format', () => {
      const { messages } = parseRollout(OLD_FORMAT, '/fixtures/old.jsonl');
      expect(messages.filter(m => m.role === 'agent')).toHaveLength(4);
    });
  });

  describe('task_complete', () => {
    const cases: Array<{ name: string; raw: string; completedId: string | null }> = [
      { name: 'old format marks the agent message before task_complete', raw: OLD_FORMAT, completedId: 'agent-3' },
      { name: 'new format marks the final answer', raw: NEW_FORMAT, completedId: 'agent-2' },
      { name: 'no task_complete leaves every message unmarked', raw: CONTENT_TAG_VARIANTS, completedId: null },
    ];

    it.each(cases)('$name', ({ raw, completedId }) => {
      const { messages } = parseRollout(raw, '/fixtures/rollout.jsonl');
      const completed = messages.filter(m => m.isComplete).map(m => m.id);
      expect(completed).toEqual(completedId ? [completedId] : []);
    });
  });

  describe('session metadata used by discovery', () => {
    const cases: Array<{
      name: string;
      raw: string;
      expected: {
        sessionId: string;
        project: string;
        projectName: string;
        cliVersion: string;
        startTime: string;
        lastUpdated: string;
      };
    }> = [
      {
        name: 'old format',
        raw: OLD_FORMAT,
        expected: {
          sessionId: '01a054db-9963-7dd0-ac5b-c82ea702c983',
          project: '/Users/dev/src/api-service',
          projectName: 'api-service',
          cliVersion: '0.148.0-alpha.9',
          startTime: '2026-08-30T22:47:52.932Z',
          lastUpdated: '2026-08-30T23:15:56.660Z',
        },
      },
      {
        name: 'new format',
        raw: NEW_FORMAT,
        expected: {
          sessionId: '01a07276-a69c-7282-8e89-6bab77f2da3a',
          project: '/Users/dev/src/scratch',
          projectName: 'scratch',
          cliVersion: '0.153.4',
          startTime: '2026-09-05T16:46:13.683Z',
          lastUpdated: '2026-09-05T16:50:16.535Z',
        },
      },
    ];

    it.each(cases)('$name', ({ raw, expected }) => {
      const parsed = parseRollout(raw, '/fixtures/rollout.jsonl');
      expect({
        sessionId: parsed.sessionId,
        project: parsed.project,
        projectName: parsed.projectName,
        cliVersion: parsed.cliVersion,
        startTime: parsed.startTime,
        lastUpdated: parsed.lastUpdated,
      }).toEqual(expected);
    });

    it('keeps the first header when a subagent replays its parent session_meta', () => {
      const raw = [
        '{"timestamp":"2026-09-04T05:38:44.000Z","type":"session_meta","payload":{"session_id":"01a07012-5639-7962-9e83-a21229035e89","id":"01a07013-8c2b-7f42-9f77-d70650224866","parent_thread_id":"01a07012-5639-7962-9e83-a21229035e89","cwd":"/Users/dev/src/app","cli_version":"0.153.4","thread_source":"subagent"}}',
        '{"timestamp":"2026-09-04T05:38:44.100Z","type":"session_meta","payload":{"session_id":"01a07012-5639-7962-9e83-a21229035e89","id":"01a07012-5639-7962-9e83-a21229035e89","cwd":"/Users/dev/src/app","cli_version":"0.153.4","thread_source":"user"}}',
      ].join('\n');
      expect(parseRollout(raw, '/fixtures/subagent.jsonl').sessionId).toBe(
        '01a07013-8c2b-7f42-9f77-d70650224866'
      );
    });

    it('falls back to session_id when id is absent', () => {
      const raw = '{"timestamp":"2026-09-05T00:00:00.000Z","type":"session_meta","payload":{"session_id":"only-session-id","cwd":"/tmp/x"}}';
      expect(parseRollout(raw, '/fixtures/rollout.jsonl').sessionId).toBe('only-session-id');
    });
  });

  describe('empty-rollout warning', () => {
    let warn: jest.SpyInstance;

    beforeEach(() => {
      warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
    });

    const cases: Array<{ name: string; raw: string; path: string; shouldWarn: boolean }> = [
      { name: 'warns when a completed turn yields no messages', raw: TOOLS_ONLY, path: '/fixtures/tools-only.jsonl', shouldWarn: true },
      { name: 'stays quiet while a turn is still in flight', raw: TURN_IN_FLIGHT, path: '/fixtures/in-flight.jsonl', shouldWarn: false },
      { name: 'stays quiet for a session that has not started a turn', raw: META_ONLY, path: '/fixtures/meta-only.jsonl', shouldWarn: false },
      { name: 'stays quiet when messages parse', raw: NEW_FORMAT, path: '/fixtures/new.jsonl', shouldWarn: false },
      { name: 'stays quiet when messages parse in the old format', raw: OLD_FORMAT, path: '/fixtures/old.jsonl', shouldWarn: false },
    ];

    it.each(cases)('$name', ({ raw, path, shouldWarn }) => {
      parseRollout(raw, path);
      expect(warn).toHaveBeenCalledTimes(shouldWarn ? 1 : 0);
    });

    it('names the file and the codex version', () => {
      parseRollout(TOOLS_ONLY, '/fixtures/tools-only.jsonl');
      const message = warn.mock.calls[0][0] as string;
      expect(message).toContain('/fixtures/tools-only.jsonl');
      expect(message).toContain('0.153.4');
    });

    it('says the version is unknown when session_meta is missing', () => {
      const raw = '{"timestamp":"2026-09-05T00:00:00.000Z","type":"event_msg","payload":{"type":"task_complete","turn_id":"t1"}}';
      parseRollout(raw, '/fixtures/no-meta.jsonl');
      expect(warn.mock.calls[0][0]).toContain('unknown');
    });

    it('warns once per file so polling does not flood the log', () => {
      parseRollout(TOOLS_ONLY, '/fixtures/tools-only.jsonl');
      parseRollout(TOOLS_ONLY, '/fixtures/tools-only.jsonl');
      parseRollout(TOOLS_ONLY, '/fixtures/other.jsonl');
      expect(warn).toHaveBeenCalledTimes(2);
    });
  });
});
