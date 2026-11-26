import { fixture, frames } from '../testing/fake-opencode-v2';
import { formAnswer, V2EventTranslator, type V2Form } from './events';

/** A captured stream as the events the daemon's turns follow, without their directories. */
function translated(name: string): Array<[string, Record<string, any>]> {
  const translator = new V2EventTranslator();
  return frames(name).flatMap((data) => translator.translate(JSON.parse(data)).map((e) => [e.type, e.properties] as [string, Record<string, any>]));
}

const multiForm = (): V2Form => {
  const created = frames('turn-question-multi.sse').map((d) => JSON.parse(d)).find((f) => f.type === 'form.created');
  return created.data.form;
};

describe('v2 events, as the turn machine reads them', () => {
  const S = 'ses_e6b552f8effeFw7O2cQqQ1CroI';
  const B = 'ses_e6b535aa4ffe2fk2IDPyoTGlVz';
  const cases: Array<{ name: string; stream: string; want: Array<[string, Record<string, any>]> }> = [
    {
      name: 'a plain turn starts busy and ends idle',
      stream: 'turn-text.sse',
      want: [['session.status', { sessionID: S, status: { type: 'busy' } }], ['session.idle', { sessionID: S }]],
    },
    {
      name: 'a shell call runs, asks permission, and is answered',
      stream: 'turn-permission.sse',
      want: [
        ['session.status', { sessionID: S, status: { type: 'busy' } }],
        ['message.part.updated', {
          sessionID: S,
          part: { type: 'tool', tool: 'shell', callID: 'chatcmpl-tool-9d04cf30bd1fc42d', state: { status: 'running', input: { command: 'ls -la' } } },
        }],
        ['permission.asked', { id: 'per_194ab25910014L925gKLcGuQNr', sessionID: S, permission: 'shell', patterns: ['ls -la'] }],
        ['permission.replied', { sessionID: S, requestID: 'per_194ab25910014L925gKLcGuQNr' }],
        ['session.idle', { sessionID: S }],
      ],
    },
    {
      name: 'the question tool\'s form is a question, answered',
      stream: 'turn-question.sse',
      want: [
        ['session.status', { sessionID: S, status: { type: 'busy' } }],
        ['message.part.updated', {
          sessionID: S,
          part: { type: 'tool', tool: 'question', callID: 'chatcmpl-tool-8627d46504c1eb18', state: { status: 'running', input: expect.any(Object) } },
        }],
        ['question.asked', {
          id: 'frm_194ab7ce4001ltcNOW3BpFoehJ',
          sessionID: S,
          questions: [{
            question: 'Which color do you prefer?',
            header: 'Color preference',
            options: [{ label: 'Red', description: 'Choose red' }, { label: 'Blue', description: 'Choose blue' }],
          }],
          tool: { messageID: 'msg_194ab79dc001mGyTny3J7VD5gX', callID: 'chatcmpl-tool-8627d46504c1eb18' },
        }],
        ['question.replied', { sessionID: S, requestID: 'frm_194ab7ce4001ltcNOW3BpFoehJ' }],
        ['session.idle', { sessionID: S }],
      ],
    },
    {
      name: 'an interrupted turn ends idle',
      stream: 'turn-interrupt.sse',
      want: [['session.status', { sessionID: B, status: { type: 'busy' } }], ['session.idle', { sessionID: B }]],
    },
    {
      name: 'a failed turn reports its error, then ends idle',
      stream: 'turn-failed.sse',
      want: [
        ['session.status', { sessionID: 'ses_e6b4b2cdbffeF627S0tb7dgm9s', status: { type: 'busy' } }],
        ['session.error', { sessionID: 'ses_e6b4b2cdbffeF627S0tb7dgm9s', error: { name: 'provider.no-route', data: { message: 'Model unavailable: opencode/no-such-model' } } }],
        ['session.idle', { sessionID: 'ses_e6b4b2cdbffeF627S0tb7dgm9s' }],
      ],
    },
  ];
  it.each(cases)('$name', ({ stream, want }) => {
    expect(translated(stream)).toEqual(want);
  });

  it('names each tool an edit turn runs', () => {
    const tools = translated('turn-edit.sse').filter(([type]) => type === 'message.part.updated').map(([, p]) => p.part.tool);
    expect(tools).toEqual(['read', 'edit']);
  });

  it('carries the project a request came from, so a reply can go back there', () => {
    const translator = new V2EventTranslator();
    const asked = frames('turn-permission.sse').flatMap((d) => translator.translate(JSON.parse(d))).find((e) => e.type === 'permission.asked');
    expect(asked?.directory).toBe('/tmp/feat119/proj');
  });

  it('remembers which session a request came from, for the reply', () => {
    const translator = new V2EventTranslator();
    for (const data of frames('turn-question-multi.sse')) translator.translate(JSON.parse(data));
    for (const data of frames('turn-permission.sse')) translator.translate(JSON.parse(data));
    expect(translator.form('frm_194b534840015pU1297JmhNxLP')?.sessionID).toBe(B);
    expect(translator.permissionSession('per_194ab25910014L925gKLcGuQNr')).toBe(S);
  });
});

describe('the user\'s answers, as a v2 form reply', () => {
  const cases: Array<{ name: string; form: () => V2Form; answers: string[][]; want: Record<string, unknown> }> = [
    { name: 'one option picked', form: () => multiForm(), answers: [['Apple'], ['Salt']], want: { q0: 'Apple', q1: ['Salt'] } },
    { name: 'typed words and several options', form: () => multiForm(), answers: [['Banana actually'], ['Salt', 'Lime']], want: { q0: 'Banana actually', q1: ['Salt', 'Lime'] } },
    {
      name: 'an option sends its value, not its label',
      form: () => ({ id: 'f', sessionID: 's', fields: [{ key: 'env', type: 'string', options: [{ value: 'prod', label: 'Production' }] }] }),
      answers: [['Production']],
      want: { env: 'prod' },
    },
    {
      name: 'yes or no, and a number',
      form: () => ({ id: 'f', sessionID: 's', fields: [{ key: 'ok', type: 'boolean' }, { key: 'n', type: 'integer' }] }),
      answers: [['Yes'], ['3']],
      want: { ok: true, n: 3 },
    },
    {
      name: 'hidden fields are not asked',
      form: () => ({ id: 'f', sessionID: 's', fields: [{ key: 'h', type: 'string', hidden: true }, { key: 'q', type: 'string' }] }),
      answers: [['shown']],
      want: { q: 'shown' },
    },
  ];
  it.each(cases)('$name', ({ form, answers, want }) => {
    expect(formAnswer(form(), answers)).toEqual(want);
  });

  it('matches the answer v2 accepted in the captured run', () => {
    const replied = frames('turn-question-multi.sse').map((d) => JSON.parse(d)).find((f) => f.type === 'form.replied');
    expect(formAnswer(multiForm(), [['Banana actually'], ['Salt', 'Lime']])).toEqual(replied.data.answer);
    expect(fixture('commands.json').data.map((c: { name: string }) => c.name)).toContain('review');
  });
});
