/**
 * Turn bookkeeping for one transcript: which prompt each entry belongs to, who announces
 * the turn's end, and whether it has been announced.
 *
 * A turn is a prompt and every entry chained to it by `parentUuid`. Two processes on one
 * transcript (a terminal and this daemon's adapter) interleave their turns, and the chain
 * is what tells their entries apart. An entry whose parent is unknown belongs to the
 * latest prompt.
 */

import { mentionsInterrupt } from './transcript-filter';

export type TurnOwner = 'watcher' | 'adapter';

export interface Turn {
  /** UUID of the prompt that started the turn. */
  root: string;
  owner: TurnOwner;
  /** The turn produced an assistant entry; one that did not is nothing to announce. */
  sawAssistant: boolean;
  /** An assistant entry carried a final stop reason; the turn ends once no more follow. */
  stopped: boolean;
  /** Batch of the last entry seen for the turn. */
  touched: number;
  ended: boolean;
  announced: boolean;
}

export interface TurnEnd {
  turn: Turn;
  reason: string;
}

// System entries Claude Code writes once a turn is over. The others (compact_boundary,
// local_command, away_summary, ...) land mid-turn.
const TURN_ENDING_SYSTEM_SUBTYPES = new Set(['turn_duration', 'stop_hook_summary']);

// Tools that block the agent on the user (plan approval, a question), so the turn is over
// as far as a notification goes.
const WAITING_TOOLS = new Set(['ExitPlanMode', 'AskUserQuestion']);

// Turns tracked per transcript. Older ones can never end again.
const MAX_TURNS = 64;

function contentBlocks(entry: Record<string, unknown>): Array<Record<string, unknown>> {
  const content = (entry.message as Record<string, unknown> | undefined)?.content;
  return Array.isArray(content) ? content : [];
}

function hasToolResult(entry: Record<string, unknown>): boolean {
  return !!entry.sourceToolAssistantUUID || !!entry.toolUseResult ||
    contentBlocks(entry).some((block) => block.type === 'tool_result');
}

/** A user entry that starts a turn: not a tool result, an interrupt or a harness insert. */
function startsTurn(entry: Record<string, unknown>): boolean {
  if (entry.type !== 'user' || !entry.uuid) return false;
  if (entry.isMeta === true || entry.isSidechain === true || entry.isCompactSummary === true || entry.isVisibleInTranscriptOnly === true) return false;
  return !hasToolResult(entry) && !mentionsInterrupt(entry);
}

export class TurnLedger {
  private turns = new Map<string, Turn>();
  private turnOf = new Map<string, string>();
  private latestRoot: string | undefined;
  private batch = 0;

  /**
   * `ownedByAdapter` says whether this daemon's adapter had a query alive on the session
   * when a prompt was written. A prompt inside such a span is the adapter's unless a
   * person typed it in a terminal sharing the session; `promptSource: "sdk"` alone proves
   * nothing, since every SDK host stamps its prompts that way.
   */
  constructor(private ownedByAdapter: (atMs: number) => boolean) {}

  /**
   * Records an entry, and returns the end it marks if its turn was still open. An API
   * error, a turn-ending system entry, an interrupt, or a tool that waits on the user ends
   * the turn at once; only the first counts. An assistant entry's final stop reason does
   * not: Claude Code writes one API response as several entries (thinking, text) that all
   * carry it, so the turn ends when `endBatch` finds no more of them.
   */
  observe(entry: Record<string, unknown>): TurnEnd | null {
    const uuid = entry.uuid as string | undefined;
    if (startsTurn(entry)) {
      const turn: Turn = { root: uuid as string, owner: this.ownerOf(entry), sawAssistant: false, stopped: false, touched: this.batch, ended: false, announced: false };
      this.turns.set(turn.root, turn);
      this.turnOf.set(turn.root, turn.root);
      this.latestRoot = turn.root;
      if (this.turns.size > MAX_TURNS) {
        const oldest = this.turns.keys().next().value as string;
        this.turns.delete(oldest);
      }
      return null;
    }

    const root = this.turnOf.get(entry.parentUuid as string) ?? this.latestRoot;
    if (uuid && root) this.turnOf.set(uuid, root);
    const turn = root ? this.turns.get(root) : undefined;
    if (!turn) return null;

    turn.touched = this.batch;
    if (entry.type === 'assistant') {
      turn.sawAssistant = true;
      if (hasFinalStopReason(entry)) turn.stopped = true;
    }
    const reason = endReason(entry);
    if (!reason || turn.ended) return null;
    turn.ended = true;
    return { turn, reason };
  }

  /**
   * Closes a batch of entries (one poll's worth) and ends every turn whose stop reason
   * was seen in an earlier batch with nothing of the turn arriving since.
   */
  endBatch(): TurnEnd[] {
    const ends: TurnEnd[] = [];
    for (const turn of this.turns.values()) {
      if (turn.stopped && !turn.ended && turn.touched < this.batch) {
        turn.ended = true;
        ends.push({ turn, reason: 'stop_reason' });
      }
    }
    this.batch++;
    return ends;
  }

  /** Ends every turn whose stop reason was seen, as at the end of a transcript already written. */
  settle(): TurnEnd[] {
    this.batch++;
    return this.endBatch();
  }

  /** The newest adapter-owned turn not yet announced, if any. */
  unannouncedAdapterTurn(): Turn | undefined {
    let found: Turn | undefined;
    for (const turn of this.turns.values()) {
      if (turn.owner === 'adapter' && !turn.announced) found = turn;
    }
    return found;
  }

  private ownerOf(entry: Record<string, unknown>): TurnOwner {
    if ((entry.origin as { kind?: unknown } | undefined)?.kind === 'human') return 'watcher';
    const at = Date.parse(entry.timestamp as string);
    return Number.isFinite(at) && this.ownedByAdapter(at) ? 'adapter' : 'watcher';
  }
}

function hasFinalStopReason(entry: Record<string, unknown>): boolean {
  const stopReason = (entry.message as Record<string, unknown> | undefined)?.stop_reason;
  return stopReason === 'end_turn' || stopReason === 'max_tokens';
}

function endReason(entry: Record<string, unknown>): string | null {
  switch (entry.type) {
    case 'assistant': {
      if (entry.isApiErrorMessage === true) return 'API error';
      if (contentBlocks(entry).some((block) => block.type === 'tool_use' && WAITING_TOOLS.has(block.name as string))) return 'waiting for user input';
      return null;
    }
    case 'system':
      return TURN_ENDING_SYSTEM_SUBTYPES.has(entry.subtype as string) ? `system ${entry.subtype}` : null;
    case 'user':
      return mentionsInterrupt(entry) ? 'interrupted' : null;
    default:
      return null;
  }
}
