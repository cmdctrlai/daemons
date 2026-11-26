import type { OpenCodeAdapter, SessionActivity } from './adapter/opencode';

export interface ActivitySink {
  sendSessionActivity(
    sessionId: string,
    filePath: string,
    lastMessage: string,
    messageCount: number,
    isCompletion: boolean,
    lastActivity?: string,
  ): void;
}

/**
 * Tells the server about new messages in a session and, once per turn, that the
 * turn finished – the completion is what sends the user a push.
 *
 * opencode writes a turn as several assistant messages, one per tool step, so a
 * new assistant message is not the end of anything; only the transcript's
 * finished turn is. Each finished turn is announced once, by whichever of the
 * watch poll or the daemon's own turn sees it first.
 */
export class ActivityReporter {
  private counts = new Map<string, number>();
  /** Per session, the final message of the last turn already announced. */
  private announced = new Map<string, string>();

  constructor(
    private readonly adapter: Pick<OpenCodeAdapter, 'activity'>,
    private readonly sink: ActivitySink,
  ) {}

  /** Start following a session. What it already holds is not news. */
  async watch(sessionId: string): Promise<void> {
    const activity = await this.adapter.activity(sessionId);
    this.counts.set(sessionId, activity.count);
    if (activity.state.finalId) this.announced.set(sessionId, activity.state.finalId);
  }

  unwatch(sessionId: string): void {
    this.counts.delete(sessionId);
  }

  /** Report what changed in a watched session since the last poll. */
  async poll(sessionId: string): Promise<void> {
    const activity = await this.adapter.activity(sessionId);
    const completion = this.claim(sessionId, activity);
    if (activity.count <= (this.counts.get(sessionId) ?? 0) && !completion) return;
    this.counts.set(sessionId, activity.count);
    this.send(sessionId, activity, completion);
  }

  /** A turn this daemon ran has finished: announce it, watched or not. */
  async finished(sessionId: string): Promise<void> {
    const activity = await this.adapter.activity(sessionId);
    if (this.claim(sessionId, activity)) this.send(sessionId, activity, true);
  }

  /** True the first time a finished turn is seen. A stopped turn is never news. */
  private claim(sessionId: string, activity: SessionActivity): boolean {
    const finalId = activity.state.finished ? activity.state.finalId : undefined;
    if (!finalId || this.announced.get(sessionId) === finalId) return false;
    this.announced.set(sessionId, finalId);
    return !activity.state.stopped;
  }

  private send(sessionId: string, activity: SessionActivity, completion: boolean): void {
    // A turn that failed has no answer to show; its newest entry is the user's own prompt.
    const failure = completion ? activity.state.error : undefined;
    this.sink.sendSessionActivity(
      sessionId,
      '',
      failure ? `Error: ${failure}` : activity.last?.content ?? '',
      activity.count,
      completion,
      activity.last?.timestamp,
    );
  }
}
