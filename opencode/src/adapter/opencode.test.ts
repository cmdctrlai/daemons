import { tmpdir } from 'os';
import { imageParts, OpenCodeAdapter, TRANSCRIPT_FILE } from './opencode';
import { CommandRefresher, SlashCommandRegistry } from '../slash-commands';
import { FakeOpenCode, msg, waitFor } from '../testing/fake-opencode';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQ=';

let fake: FakeOpenCode;
let adapter: OpenCodeAdapter;

beforeEach(async () => {
  fake = new FakeOpenCode();
  adapter = new OpenCodeAdapter(await fake.start());
});

afterEach(() => fake.stop());

describe('sessions from every project', () => {
  it('lists top-level sessions across projects, whichever directory the daemon runs in', async () => {
    fake.sessions = [
      { id: 'ses_a', slug: 'alpha-slug', title: 'Alpha', directory: '/work/alpha', time: { updated: 1_700_000_000_000 } },
      { id: 'ses_b', title: 'Beta', directory: '/work/beta', time: { updated: 1_600_000_000_000 } },
      { id: 'ses_managed', title: 'Started from the app', directory: '/work/alpha', time: { updated: 1 } },
    ];

    const sessions = await adapter.listSessions(new Set(['ses_managed']));

    expect(sessions.map((s) => [s.session_id, s.project, s.project_name, s.title])).toEqual([
      ['ses_a', '/work/alpha', 'alpha', 'Alpha'],
      ['ses_b', '/work/beta', 'beta', 'Beta'],
    ]);
    expect(sessions[0].slug).toBe('alpha-slug');
    // The server only watches a session whose transcript file it has been told.
    expect(sessions[0].file_path).toBe(TRANSCRIPT_FILE);
    expect(TRANSCRIPT_FILE).toMatch(/opencode\/opencode\.db$/);
    expect(sessions[0].last_activity).toBe(new Date(1_700_000_000_000).toISOString());
    // Only roots: a subtask's child session is not a conversation the user started.
    expect(fake.calls('GET', '/experimental/session')[0].query.get('roots')).toBe('true');
  });

  it('reports no sessions rather than throwing when opencode is unreachable', async () => {
    const offline = new OpenCodeAdapter('http://127.0.0.1:9');
    await expect(offline.listSessions(new Set())).resolves.toEqual([]);
  });

  const createCases: Array<{ name: string; projectPath?: string; want: string | null }> = [
    { name: 'starts the session in the project the user picked', projectPath: tmpdir(), want: tmpdir() },
    { name: 'falls back to the daemon directory for a path this machine lacks', projectPath: '/no/such/project', want: null },
    { name: 'uses the daemon directory when no project is given', want: null },
  ];
  it.each(createCases)('$name', async ({ projectPath, want }) => {
    await expect(adapter.createSession(projectPath)).resolves.toBe('ses_new');
    expect(fake.calls('POST', '/session')[0].query.get('directory')).toBe(want);
  });
});

describe('images reach the agent', () => {
  const failOnError = (err: Error) => { throw err; };

  it('sends attached images as file parts ahead of the text', async () => {
    await adapter.send('ses_x', 'what is in this picture?', [PNG, JPEG], failOnError);

    expect(fake.calls('POST', '/session/ses_x/prompt_async')[0].body.parts).toEqual([
      { type: 'file', mime: 'image/png', filename: 'image-1', url: PNG },
      { type: 'file', mime: 'image/jpeg', filename: 'image-2', url: JPEG },
      { type: 'text', text: 'what is in this picture?' },
    ]);
  });

  it('sends an image with no text as the image alone', async () => {
    await adapter.send('ses_x', '', [PNG], failOnError);
    expect(fake.calls('POST', '/session/ses_x/prompt_async')[0].body.parts).toEqual([
      { type: 'file', mime: 'image/png', filename: 'image-1', url: PNG },
    ]);
  });

  it('carries images along with a slash command', async () => {
    adapter.setCommands([{ name: 'review' }]);
    await adapter.send('ses_x', '/review main', [PNG], failOnError);
    await waitFor(() => fake.calls('POST', '/session/ses_x/command').length === 1);

    expect(fake.calls('POST', '/session/ses_x/command')[0].body).toEqual({
      command: 'review',
      arguments: 'main',
      parts: [{ type: 'file', mime: 'image/png', filename: 'image-1', url: PNG }],
    });
  });

  const partCases: Array<{ name: string; images?: string[]; mimes: string[] }> = [
    { name: 'no images', images: undefined, mimes: [] },
    { name: 'png and jpeg data URLs', images: [PNG, JPEG], mimes: ['image/png', 'image/jpeg'] },
    { name: 'a non-image data URL is skipped', images: ['data:text/plain;base64,aGk='], mimes: [] },
    { name: 'a plain URL is skipped', images: ['https://example.com/cat.png'], mimes: [] },
  ];
  it.each(partCases)('imageParts: $name', ({ images, mimes }) => {
    expect(imageParts(images).map((p) => p.mime)).toEqual(mimes);
  });
});

describe('new slash commands without a restart', () => {
  const recent = (directory: string) => ({ id: `ses_${directory}`, directory, time: { updated: Date.now() } });

  function names(registry: SlashCommandRegistry, project: string): string[] {
    return registry.all().find((s) => s.project === project)?.commands.map((c) => c.name) ?? [];
  }

  it('picks up a command added after startup on the next refresh', async () => {
    fake.sessions = [recent('/work/alpha')];
    fake.disk.set('/work/alpha', [{ name: 'init' }]);
    const registry = new SlashCommandRegistry();
    const refresher = new CommandRefresher(adapter, registry);

    expect(await refresher.refresh()).toBe(true);
    expect(names(registry, '/work/alpha')).toEqual(['compact', 'init']);

    fake.disk.set('/work/alpha', [{ name: 'init' }, { name: 'added-later' }]);
    expect(await refresher.refresh()).toBe(true);
    expect(names(registry, '/work/alpha')).toEqual(['added-later', 'compact', 'init']);
  });

  it('never reloads while a turn is running, and catches up afterwards', async () => {
    fake.sessions = [recent('/work/alpha')];
    fake.disk.set('/work/alpha', [{ name: 'init' }]);
    const registry = new SlashCommandRegistry();
    const refresher = new CommandRefresher(adapter, registry);
    await refresher.refresh();
    const disposalsBefore = fake.calls('POST', '/instance/dispose').length;

    let running = true;
    adapter.busy = () => running;
    fake.disk.set('/work/alpha', [{ name: 'init' }, { name: 'added-later' }]);
    expect(await refresher.refresh()).toBe(false);
    expect(fake.calls('POST', '/instance/dispose').length).toBe(disposalsBefore);

    running = false;
    expect(await refresher.refresh()).toBe(true);
    expect(names(registry, '/work/alpha')).toContain('added-later');
  });

  it('never reloads a project where its server runs a turn the daemon did not start', async () => {
    fake.sessions = [recent('/work/alpha')];
    fake.disk.set('/work/alpha', [{ name: 'init' }]);
    const registry = new SlashCommandRegistry();
    const refresher = new CommandRefresher(adapter, registry);
    await refresher.refresh();
    const alphaDisposals = () => fake.calls('POST', '/instance/dispose').filter((r) => r.query.get('directory') === '/work/alpha').length;
    const disposalsBefore = alphaDisposals();

    // A terminal attached to the daemon's opencode server runs its turns there too.
    fake.statuses.set('/work/alpha', { ses_terminal: { type: 'busy' } });
    fake.disk.set('/work/alpha', [{ name: 'init' }, { name: 'added-later' }]);
    expect(await refresher.refresh()).toBe(false);
    expect(alphaDisposals()).toBe(disposalsBefore);

    fake.statuses.delete('/work/alpha');
    expect(await refresher.refresh()).toBe(true);
    expect(names(registry, '/work/alpha')).toContain('added-later');
  });

  it('keeps routing a busy project\'s commands while its reload is deferred', async () => {
    fake.sessions = [recent('/work/alpha')];
    fake.disk.set('/work/alpha', [{ name: 'review' }]);
    const refresher = new CommandRefresher(adapter, new SlashCommandRegistry());
    await refresher.refresh();

    // Deferred: this refresh learns nothing for alpha, and must not forget it either.
    adapter.busy = () => true;
    await refresher.refresh();
    adapter.busy = () => false;

    await adapter.send('ses_x', '/review main', undefined, (err) => { throw err; });
    await waitFor(() => fake.calls('POST', '/session/ses_x/command').length === 1);
  });

  it('holds a new turn until a reload under way has finished', async () => {
    fake.sessions = [recent('/work/alpha')];
    const refresher = new CommandRefresher(adapter, new SlashCommandRegistry());

    const release = fake.holdRoute('POST /instance/dispose');
    const refresh = refresher.refresh();
    await waitFor(() => fake.calls('POST', '/instance/dispose').length === 1);

    const turn = adapter.send('ses_x', 'hello', undefined, (err) => { throw err; });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fake.calls('POST', '/session/ses_x/prompt_async')).toHaveLength(0);

    release();
    await Promise.all([refresh, turn]);
    const order = fake.requests.map((r) => `${r.method} ${r.path}`);
    expect(order.indexOf('POST /session/ses_x/prompt_async')).toBeGreaterThan(order.indexOf('GET /command'));
  });

  it('reads a long-idle project\'s commands without reloading it', async () => {
    const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;
    fake.sessions = [{ id: 'ses_old', directory: '/work/old', time: { updated: twoDaysAgo } }];
    fake.disk.set('/work/old', [{ name: 'init' }]);
    const registry = new SlashCommandRegistry();

    await new CommandRefresher(adapter, registry).refresh();

    expect(names(registry, '/work/old')).toEqual(['compact', 'init']);
    const disposed = fake.calls('POST', '/instance/dispose').map((r) => r.query.get('directory'));
    expect(disposed).toEqual(['/srv/daemon']);
  });
});

describe('Load More', () => {
  it('pages back from the oldest message the app holds', async () => {
    fake.transcripts.set('ses_x', ['1', '2', '3', '4', '5'].map((n) => msg(`m${n}`, 'user', `message ${n}`)));
    const newest = await adapter.getMessages('ses_x', 2);
    expect(newest.messages.map((m) => m.uuid)).toEqual(['m4', 'm5']);
    const older = await adapter.getMessages('ses_x', 2, 'm4');
    expect(older.messages.map((m) => m.uuid)).toEqual(['m2', 'm3']);
    expect(older.hasMore).toBe(true);
  });
});

describe('session list rows', () => {
  it('carries a preview and shows a turn still running', async () => {
    const now = Date.now();
    fake.sessions = [
      { id: 'ses_busy', directory: '/w/a', time: { updated: now } },
      { id: 'ses_done', directory: '/w/b', time: { updated: now } },
    ];
    fake.transcripts.set('ses_busy', [msg('u1', 'user', 'run the tests'), msg('a1', 'assistant', 'Running them now.', { finish: 'tool-calls', time: { created: now, completed: now } })]);
    fake.transcripts.set('ses_done', [msg('u2', 'user', 'hi'), msg('a2', 'assistant', 'Hello! How can I help?')]);

    const rows = await adapter.listSessions(new Set());
    expect(rows.map((r) => [r.session_id, r.last_message, r.is_active])).toEqual([
      ['ses_busy', 'Running them now.', true],
      ['ses_done', 'Hello! How can I help?', false],
    ]);
  });

  // The server resumes a session it is told has messages and starts a new one otherwise.
  it.each([
    { name: 'a conversation counts as having messages', transcript: [msg('u1', 'user', 'hi'), msg('a1', 'assistant', 'Hello')], has: true },
    { name: 'an empty session counts as having none', transcript: [], has: false },
  ])('$name', async ({ transcript, has }) => {
    fake.sessions = [{ id: 'ses_tui', directory: '/w/a', time: { updated: 7 } }];
    fake.transcripts.set('ses_tui', transcript);
    const [row] = await adapter.listSessions(new Set());
    expect(row.message_count > 0).toBe(has);
  });

  it('re-reads a transcript only after opencode touched the session', async () => {
    fake.sessions = [{ id: 'ses_done', directory: '/w/b', time: { updated: 5 } }];
    fake.transcripts.set('ses_done', [msg('a2', 'assistant', 'Hello')]);
    await adapter.listSessions(new Set());
    await adapter.listSessions(new Set());
    expect(fake.calls('GET', '/session/ses_done/message')).toHaveLength(1);
  });
});

describe('/compact', () => {
  it('summarizes the session with the model it last used', async () => {
    fake.transcripts.set('ses_x', [
      msg('u1', 'user', 'hi', { model: { providerID: 'opencode', modelID: 'old' } }),
      msg('a1', 'assistant', 'hello', { providerID: 'anthropic', modelID: 'claude-x' }),
    ]);
    await adapter.send('ses_x', '/compact', undefined, (err) => { throw err; });
    await waitFor(() => fake.calls('POST', '/session/ses_x/summarize').length === 1);
    expect(fake.calls('POST', '/session/ses_x/summarize')[0].body).toEqual({ providerID: 'anthropic', modelID: 'claude-x' });
    expect(fake.calls('POST', '/session/ses_x/prompt_async')).toHaveLength(0);
  });

  it('is offered in every project\'s menu', async () => {
    fake.sessions = [{ id: 'ses_a', directory: '/work/alpha', time: { updated: Date.now() } }];
    const registry = new SlashCommandRegistry();
    await new CommandRefresher(adapter, registry).refresh();
    for (const set of registry.all()) expect(set.commands.map((c) => c.name)).toContain('compact');
  });
});

describe('diff', () => {
  it('reads every turn\'s changes from the transcript', async () => {
    fake.transcripts.set('ses_x', [{
      info: { id: 'u1', role: 'user', time: { created: 1 }, summary: { diffs: [{ file: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@' }] } },
      parts: [{ type: 'text', text: 'fix a' }],
    }]);
    expect(await adapter.diff('ses_x')).toEqual([{
      prompt: 'fix a', timestamp: new Date(1).toISOString(),
      files: [{ file: 'a.ts', status: 'modified', additions: 2, deletions: 1, patch: '@@' }],
    }]);
  });
});
