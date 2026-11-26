/**
 * opencode v2's event stream, read as the events the daemon's turns already
 * follow. v2 renamed nearly every event and reshaped its payloads; translating
 * them here keeps one turn machine for both versions.
 */
import type { PermissionRequest, QuestionRequest } from '../adapter/opencode';
import type { QuestionInfo } from '../adapter/transcript';
import type { OpenCodeEvent } from '../events';

/** One frame of `GET /api/event`. */
export interface V2Frame {
  id?: string;
  type: string;
  location?: { directory?: string };
  data?: Record<string, any>;
}

/** A tool call v2 is holding until the user allows it. */
export interface V2Permission {
  id: string;
  sessionID: string;
  action: string;
  resources?: string[];
}

export interface V2Field {
  key: string;
  type: string;
  title?: string;
  description?: string;
  hidden?: boolean;
  options?: Array<{ value: string; label: string; description?: string }>;
}

/** What v2 asks the user: the question tool's questions arrive as a form. */
export interface V2Form {
  id: string;
  sessionID: string;
  metadata?: { kind?: string; tool?: { messageID: string; id: string } };
  fields: V2Field[];
}

/** How many tool calls, forms and permissions to remember. */
const REMEMBERED = 500;

export function toPermissionRequest(p: V2Permission): PermissionRequest {
  return { id: p.id, sessionID: p.sessionID, permission: p.action, patterns: p.resources ?? [] };
}

export function toQuestionRequest(form: V2Form): QuestionRequest {
  const tool = form.metadata?.tool;
  return {
    id: form.id,
    sessionID: form.sessionID,
    questions: askedFields(form).map(toQuestion),
    ...(tool ? { tool: { messageID: tool.messageID, callID: tool.id } } : {}),
  };
}

/** The fields the user is asked to fill, in order: one question card each. */
function askedFields(form: V2Form): V2Field[] {
  return form.fields.filter((f) => !f.hidden && f.type !== 'external');
}

function toQuestion(f: V2Field): QuestionInfo {
  const options = f.type === 'boolean'
    ? [{ label: 'Yes' }, { label: 'No' }]
    : (f.options ?? []).map((o) => ({ label: o.label, ...(o.description ? { description: o.description } : {}) }));
  return {
    question: f.description || f.title || f.key,
    ...(f.title && f.description ? { header: f.title } : {}),
    options,
    ...(f.type === 'multiselect' ? { multiple: true } : {}),
  };
}

/** The user's answers, one list of labels per question, as v2's form reply. */
export function formAnswer(form: V2Form, answers: string[][]): Record<string, unknown> {
  const answer: Record<string, unknown> = {};
  askedFields(form).forEach((f, i) => {
    const picked = answers[i] ?? [];
    const value = (label: string) => f.options?.find((o) => o.label === label)?.value ?? label;
    switch (f.type) {
      case 'multiselect':
        answer[f.key] = picked.map(value);
        break;
      case 'boolean':
        answer[f.key] = /^(y|yes|true)$/i.test(picked[0] ?? '');
        break;
      case 'number':
      case 'integer':
        answer[f.key] = Number(picked[0]);
        break;
      default:
        answer[f.key] = value(picked[0] ?? '');
    }
  });
  return answer;
}

/**
 * Translates v2 frames, remembering what a later frame or reply needs: a tool's
 * name (v2 names it only when its input starts), and the session and fields of
 * each request (v2 replies go to the session's own route).
 */
export class V2EventTranslator {
  private tools = new Map<string, string>();
  private forms = new Map<string, V2Form>();
  private permissions = new Map<string, string>();

  form(id: string): V2Form | undefined {
    return this.forms.get(id);
  }

  permissionSession(id: string): string | undefined {
    return this.permissions.get(id);
  }

  rememberForm(form: V2Form): void {
    remember(this.forms, form.id, form);
  }

  rememberPermission(p: V2Permission): void {
    remember(this.permissions, p.id, p.sessionID);
  }

  translate(frame: V2Frame): OpenCodeEvent[] {
    const d = frame.data ?? {};
    const directory = frame.location?.directory;
    const event = (type: string, properties: Record<string, any>): OpenCodeEvent => ({ type, properties, directory });
    const sessionID: string | undefined = d.sessionID;

    switch (frame.type) {
      case 'session.execution.started':
        return [event('session.status', { sessionID, status: { type: 'busy' } })];
      case 'session.execution.succeeded':
      case 'session.execution.interrupted':
        return [event('session.idle', { sessionID })];
      case 'session.execution.failed':
        return [
          event('session.error', { sessionID, error: { name: d.error?.type, data: { message: d.error?.message } } }),
          event('session.idle', { sessionID }),
        ];
      case 'session.tool.input.started':
        remember(this.tools, d.id, d.name);
        return [];
      case 'session.tool.called': {
        const tool = this.tools.get(d.id);
        this.tools.delete(d.id);
        if (!tool) return [];
        return [event('message.part.updated', {
          sessionID, part: { type: 'tool', tool, callID: d.id, state: { status: 'running', input: d.input ?? {} } },
        })];
      }
      case 'permission.asked':
        this.rememberPermission(d as V2Permission);
        return [event('permission.asked', toPermissionRequest(d as V2Permission))];
      case 'permission.replied':
        return [event('permission.replied', { sessionID, requestID: d.requestID })];
      case 'form.created':
        this.rememberForm(d.form as V2Form);
        return [event('question.asked', toQuestionRequest(d.form as V2Form))];
      case 'form.replied':
      case 'form.cancelled':
        return [event(frame.type === 'form.replied' ? 'question.replied' : 'question.rejected', {
          sessionID: sessionID ?? this.forms.get(d.id)?.sessionID, requestID: d.id,
        })];
      default:
        return [];
    }
  }
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
  map.set(key, value);
  if (map.size > REMEMBERED) map.delete(map.keys().next().value!);
}
