import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { AskUserInput, Question, QuestionOption } from './events';

/**
 * An AskUserQuestion call held open while the answer travels to a phone.
 *
 * The SDK asks permission for AskUserQuestion through `canUseTool` and waits on
 * whatever promise the callback returns. Parking that promise – rather than
 * answering it immediately and re-prompting later with a fresh message – is what
 * lets the agent resume mid-tool-call with the question cleanly resolved.
 */
interface ParkedQuestion {
  sessionId: string;
  input: AskUserInput;
  settle: (result: PermissionResult) => void;
  timeoutHandle: NodeJS.Timeout;
}

/** Matches one reply fragment against the offered options, case- and space-insensitively. */
function matchOption(fragment: string, options: QuestionOption[]): string | undefined {
  const normalized = fragment.trim().toLowerCase();
  return options.find((o) => o.label.trim().toLowerCase() === normalized)?.label;
}

/**
 * Canonicalises a reply against one question's options.
 *
 * The whole reply is tried first, so a single-select label containing a comma
 * still matches. A multi-select reply arrives as the chosen labels joined by
 * commas, which is what every client sends; each fragment has to match for the
 * reply to count as a selection, otherwise it stays free text – including the
 * case where a chosen label has a comma of its own and the split shreds it.
 */
function canonicalAnswer(question: Question, reply: string): string {
  const trimmed = reply.trim();
  const options = question.options ?? [];

  const whole = matchOption(trimmed, options);
  if (whole) return whole;
  if (!question.multiSelect) return trimmed;

  const fragments = trimmed.split(',');
  if (fragments.length < 2) return trimmed;

  const labels: string[] = [];
  for (const fragment of fragments) {
    const hit = matchOption(fragment, options);
    if (!hit) return trimmed;
    labels.push(hit);
  }
  return labels.join(', ');
}

/**
 * Whether a message arriving on a session with an open question is a reply to
 * it, rather than something the user wants the agent to act on instead.
 *
 * Attached images rule it out: the tool takes text answers only, so routing
 * them here would silently drop the pictures. A slash command rules it out
 * too – `/compact` is an instruction to the session, not a choice.
 *
 * An offered label wins over both, because a question may well offer `/tmp`,
 * and a tap on it is unambiguous however much it reads like a command.
 */
function isAnswer(text: string, options: QuestionOption[], images?: string[]): boolean {
  if (images?.length) return false;
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return true;
  if (matchOption(trimmed, options)) return true;

  const firstToken = trimmed.split(/\s/, 1)[0];
  return !/^\/[A-Za-z][\w-]*(:[\w-]+)?$/.test(firstToken);
}

/**
 * Builds the `answers` map the tool expects: question text to chosen label.
 *
 * Only the first question is answered. Clients render that one alone, so a
 * reply is evidence about it and nothing else – writing the same text into the
 * rest would put words the user never saw, and options they were never offered,
 * into the agent's mouth.
 *
 * A reply that matches no option is passed through verbatim, which is how the
 * CLI's own "Other" path behaves – the tool takes free text.
 */
export function buildAnswers(input: AskUserInput, reply: string): Record<string, string> {
  const first = input.questions?.[0];
  if (!first) return {};
  return { [first.question]: canonicalAnswer(first, reply) };
}

export class PendingQuestions {
  private parked = new Map<string, ParkedQuestion>();

  /**
   * Hold a question open for this session. Resolves when `answer` or `cancel`
   * is called, or denies once `timeoutMs` elapses so a forgotten question can't
   * pin a subprocess open forever.
   */
  park(sessionId: string, input: AskUserInput, timeoutMs: number): Promise<PermissionResult> {
    // A second question for one session means the first will never be answered.
    this.cancel(sessionId, 'superseded by a newer question');

    return new Promise<PermissionResult>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.parked.delete(sessionId);
        resolve({ behavior: 'deny', message: 'The user did not answer in time.' });
      }, timeoutMs);
      // Nothing should keep the process alive just because a question is open.
      timeoutHandle.unref?.();

      this.parked.set(sessionId, {
        sessionId,
        input,
        settle: (result) => {
          clearTimeout(timeoutHandle);
          resolve(result);
        },
        timeoutHandle,
      });
    });
  }

  /**
   * Route a reply to this session's open question.
   * Returns false when nothing was waiting, so the caller can send it as an
   * ordinary message instead.
   */
  answer(sessionId: string, reply: string): boolean {
    const entry = this.parked.get(sessionId);
    if (!entry) return false;

    this.parked.delete(sessionId);
    entry.settle({
      behavior: 'allow',
      updatedInput: {
        ...entry.input,
        answers: buildAnswers(entry.input, reply),
      } as unknown as Record<string, unknown>,
    });
    return true;
  }

  /** Release an open question without answering it. */
  cancel(sessionId: string, message = 'The user cancelled.'): boolean {
    const entry = this.parked.get(sessionId);
    if (!entry) return false;

    this.parked.delete(sessionId);
    entry.settle({ behavior: 'deny', message });
    return true;
  }

  has(sessionId: string): boolean {
    return this.parked.has(sessionId);
  }

  /** Whether `text` replies to this session's open question. */
  isAnswer(sessionId: string, text: string, images?: string[]): boolean {
    const entry = this.parked.get(sessionId);
    return isAnswer(text, entry?.input.questions?.[0]?.options ?? [], images);
  }

  /** Release everything – daemon shutdown. */
  cancelAll(message = 'The daemon is shutting down.'): void {
    for (const sessionId of Array.from(this.parked.keys())) {
      this.cancel(sessionId, message);
    }
  }
}
