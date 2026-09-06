import * as os from 'os';
import { CodexAdapter, defaultLimits } from './codex-cli';
import { AppServerClient, AppServerClientOptions } from './app-server-client';
import { SkillCatalog } from '../skills';
import type { SkillMetadata, UserInput } from './protocol-types';

/**
 * A slash command only runs as one if it leaves as a `skill` input element.
 * Sending "/pjm add a bug" as text is not a smaller version of running the
 * skill – it reaches the model as those literal characters and gets an
 * improvised answer, which looks like success. These tests pin what actually
 * goes on the wire.
 */

const PROJECT = os.tmpdir();
const OTHER_PROJECT = os.homedir();

const skill = (over: Partial<SkillMetadata> & { name: string }): SkillMetadata => ({
  description: `${over.name} does a thing`,
  path: `${PROJECT}/.agents/skills/${over.name}/SKILL.md`,
  scope: 'repo',
  enabled: true,
  pluginId: null,
  ...over,
});

const PJM = skill({ name: 'pjm' });

interface FakeClient {
  stopped: number;
  started: boolean;
  options: AppServerClientOptions;
  requests: { method: string; params: unknown }[];
  responses: Map<string, unknown>;
  failStart?: Error;
  emit(event: string, params: unknown): void;
  asClient(): AppServerClient;
}

function makeFakeClient(options: AppServerClientOptions): FakeClient {
  const handlers = new Map<string, ((p: unknown) => void)[]>();
  const fake: FakeClient = {
    stopped: 0,
    started: false,
    options,
    requests: [],
    responses: new Map(),
    emit(event, params) {
      for (const h of handlers.get(event) ?? []) h(params);
    },
    asClient() {
      return this as unknown as AppServerClient;
    },
  };
  Object.assign(fake, {
    on(event: string, handler: (p: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return fake;
    },
    async start() {
      if (fake.failStart) throw fake.failStart;
      fake.started = true;
      return {};
    },
    async stop() {
      fake.stopped += 1;
    },
    async request(method: string, params: unknown) {
      fake.requests.push({ method, params });
      const canned = fake.responses.get(method);
      if (canned instanceof Error) throw canned;
      if (canned !== undefined) return canned;
      if (method === 'thread/start') return { thread: { id: 'thread-new' }, cwd: PROJECT };
      if (method === 'thread/resume') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start') return { turn: { id: 'turn-1' } };
      return {};
    },
  });
  return fake;
}

interface Harness {
  adapter: CodexAdapter;
  clients: FakeClient[];
  catalog: SkillCatalog;
  last(): FakeClient;
  turnInput(): UserInput[];
}

function harness(arm?: (c: FakeClient, index: number) => void): Harness {
  const clients: FakeClient[] = [];
  const adapter = new CodexAdapter(
    () => {},
    '1.2.3',
    (options) => {
      const c = makeFakeClient(options);
      arm?.(c, clients.length);
      clients.push(c);
      return c.asClient();
    },
    defaultLimits()
  );
  const catalog = new SkillCatalog();
  catalog.record(PROJECT, [PJM, skill({ name: 'marketing' })]);
  catalog.record(OTHER_PROJECT, [skill({ name: 'homely', path: `${OTHER_PROJECT}/.agents/skills/homely/SKILL.md` })]);
  adapter.setSkillCatalog(catalog);

  return {
    adapter,
    clients,
    catalog,
    last: () => clients[clients.length - 1],
    turnInput: () => {
      const turn = clients[clients.length - 1].requests.find((r) => r.method === 'turn/start');
      return (turn?.params as { input: UserInput[] }).input;
    },
  };
}

const asText = (text: string): UserInput => ({ type: 'text', text, text_elements: [] });

describe('what a message becomes on turn/start', () => {
  const cases: {
    name: string;
    message: string;
    project?: string;
    expected: UserInput[];
  }[] = [
    {
      name: 'a command with arguments runs the skill and carries the arguments',
      message: '/pjm file a bug about the composer',
      expected: [
        { type: 'skill', name: 'pjm', path: PJM.path },
        asText('file a bug about the composer'),
      ],
    },
    {
      // Codex accepts a skill element alone; a blank text element would only add
      // an empty user turn to the thread.
      name: 'a bare command sends no empty text element',
      message: '/pjm',
      expected: [{ type: 'skill', name: 'pjm', path: PJM.path }],
    },
    {
      name: 'ordinary prose is untouched',
      message: 'file a bug about the composer',
      expected: [asText('file a bug about the composer')],
    },
    {
      name: 'a name this project does not have stays text',
      message: '/deploy now',
      expected: [asText('/deploy now')],
    },
    {
      name: 'an absolute path that reads like a command stays text',
      message: '/tmp/notes.md take a look',
      expected: [asText('/tmp/notes.md take a look')],
    },
    {
      name: 'the skill is resolved against the project the turn runs in',
      message: '/homely',
      project: OTHER_PROJECT,
      expected: [{ type: 'skill', name: 'homely', path: `${OTHER_PROJECT}/.agents/skills/homely/SKILL.md` }],
    },
    {
      name: 'another project’s skill is not reachable from this one',
      message: '/homely',
      expected: [asText('/homely')],
    },
  ];

  test.each(cases)('resumeTask: $name', async ({ message, project, expected }) => {
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', message, project ?? PROJECT);
    expect(h.turnInput()).toEqual(expected);
  });

  test.each(cases)('startTask: $name', async ({ message, project, expected }) => {
    const h = harness();
    await h.adapter.startTask('t1', message, project ?? PROJECT);
    expect(h.turnInput()).toEqual(expected);
  });
});

describe('routing without a catalog', () => {
  test('an adapter given no catalog sends every message as text', async () => {
    const clients: FakeClient[] = [];
    const adapter = new CodexAdapter(
      () => {},
      '1.2.3',
      (options) => {
        const c = makeFakeClient(options);
        clients.push(c);
        return c.asClient();
      },
      defaultLimits()
    );
    await adapter.resumeTask('t1', 'thread-1', '/pjm hello', PROJECT);
    const turn = clients[0].requests.find((r) => r.method === 'turn/start');
    expect((turn?.params as { input: UserInput[] }).input).toEqual([asText('/pjm hello')]);
  });

  /**
   * A worktree removed after it landed leaves conversations pointing at a
   * directory that is gone. resolveCwd then runs the turn in $HOME, where a
   * skill of the same name is a different file – and running that one would
   * succeed while doing something else entirely.
   */
  test.each([
    { name: 'a name the home directory also has', message: '/homely' },
    { name: 'a name only the missing project had', message: '/pjm file a bug' },
  ])('a project path that no longer exists resolves nothing: $name', async ({ message }) => {
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', message, '/no/such/project');
    expect(h.turnInput()).toEqual([asText(message)]);
  });

  test('the same holds for a new session in a missing project', async () => {
    const h = harness();
    await h.adapter.startTask('t1', '/homely', '/no/such/project');
    expect(h.turnInput()).toEqual([asText('/homely')]);
  });

  test('a task with no project named still resolves against the home directory', async () => {
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', '/homely');
    expect(h.turnInput()).toEqual([
      { type: 'skill', name: 'homely', path: `${OTHER_PROJECT}/.agents/skills/homely/SKILL.md` },
    ]);
  });
});

/**
 * Enumeration runs on its own app-server. It starts no thread, so it takes no
 * writer lock – but a client left running would hold a second ~130MB codex open
 * for the lifetime of the daemon, so every exit path has to stop it.
 */
describe('listSkills', () => {
  test('asks for every directory, forces a re-scan, and stops the client', async () => {
    const h = harness((c) => {
      c.responses.set('skills/list', {
        data: [
          { cwd: PROJECT, skills: [PJM], errors: [] },
          { cwd: OTHER_PROJECT, skills: [], errors: [{ path: '/x/SKILL.md', message: 'bad frontmatter' }] },
        ],
      });
    });

    const entries = await h.adapter.listSkills([PROJECT, OTHER_PROJECT]);

    expect(h.last().requests[0]).toEqual({
      method: 'skills/list',
      params: { cwds: [PROJECT, OTHER_PROJECT], forceReload: true },
    });
    expect(entries.map((e) => e.cwd)).toEqual([PROJECT, OTHER_PROJECT]);
    expect(entries[1].errors).toEqual([{ path: '/x/SKILL.md', message: 'bad frontmatter' }]);
    expect(h.last().stopped).toBe(1);
  });

  test('an empty directory list spawns nothing', async () => {
    const h = harness();
    expect(await h.adapter.listSkills([])).toEqual([]);
    expect(h.clients).toHaveLength(0);
  });

  test('a failed request still stops the client', async () => {
    const h = harness((c) => {
      c.responses.set('skills/list', new Error('skills/list timed out after 30000ms'));
    });
    await expect(h.adapter.listSkills([PROJECT])).rejects.toThrow('timed out');
    expect(h.last().stopped).toBe(1);
  });

  test('a codex that will not spawn still stops the client', async () => {
    const h = harness((c) => {
      c.failStart = new Error('spawn codex ENOENT');
    });
    await expect(h.adapter.listSkills([PROJECT])).rejects.toThrow('ENOENT');
    expect(h.last().stopped).toBe(1);
  });

  test('registers no exit handler, so its own shutdown is not reported as a failed task', async () => {
    const h = harness();
    await h.adapter.listSkills([PROJECT]);
    expect(h.last().options.onExit).toBeUndefined();
  });

  test('holds no task slot, so enumeration cannot refuse a turn', async () => {
    const h = harness();
    await h.adapter.listSkills([PROJECT]);
    expect(h.adapter.getRunningTasks()).toEqual([]);
  });

  test('a response with no data yields no entries rather than throwing', async () => {
    const h = harness((c) => {
      c.responses.set('skills/list', {});
    });
    expect(await h.adapter.listSkills([PROJECT])).toEqual([]);
  });
});

describe('skills/changed', () => {
  test('reaches the handler so the caller can re-enumerate', async () => {
    const h = harness();
    let fired = 0;
    h.adapter.onSkillsChanged(() => {
      fired += 1;
    });

    await h.adapter.resumeTask('t1', 'thread-1', 'hello', PROJECT);
    h.last().emit('skills/changed', {});
    expect(fired).toBe(1);
  });

  test('still fires from a client whose task has already ended', async () => {
    const h = harness();
    let fired = 0;
    h.adapter.onSkillsChanged(() => {
      fired += 1;
    });

    await h.adapter.resumeTask('t1', 'thread-1', 'hello', PROJECT);
    const client = h.last();
    h.adapter.cancelTask('t1');
    // The invalidation is about the filesystem, not about this task.
    client.emit('skills/changed', {});
    expect(fired).toBe(1);
  });

  test('no handler registered is not an error', async () => {
    const h = harness();
    await h.adapter.resumeTask('t1', 'thread-1', 'hello', PROJECT);
    expect(() => h.last().emit('skills/changed', {})).not.toThrow();
  });
});
