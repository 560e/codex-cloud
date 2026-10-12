import { applyThreadEvent } from '../shared/events';
import type { Thread, WorkEvent } from '../shared/types';

export function reconcileThreadSnapshot(
  previous: Thread | null,
  snapshot: Thread,
  events: WorkEvent[],
  requestCursor: number,
  snapshotCursor: number,
): Thread {
  if (!previous || previous.id !== snapshot.id) return snapshot;
  // A resync reads only the latest history page. Keep earlier pages the user loaded.
  const first = previous.turns.findIndex((turn) => turn.id === snapshot.turns[0]?.id);
  const turns = [...(first > 0 ? previous.turns.slice(0, first) : []), ...snapshot.turns];
  // Native history may lag notifications even when the response cursor is current.
  // Preserve turns rendered during the request, without replaying their text deltas.
  const changed = new Set(
    events
      .filter(
        (event) =>
          event.seq > requestCursor &&
          event.seq <= (previous.renderCursor || 0) &&
          event.params.threadId === snapshot.id,
      )
      .map((event) => event.params.turnId || event.params.turn?.id)
      .filter(Boolean),
  );
  for (const turn of previous.turns) {
    if (!changed.has(turn.id)) continue;
    if (
      events.some(
        (event) =>
          event.seq > snapshotCursor &&
          event.params.threadId === snapshot.id &&
          (event.params.turnId || event.params.turn?.id) === turn.id,
      )
    )
      continue;
    const index = turns.findIndex((candidate) => candidate.id === turn.id);
    if (index < 0) turns.push(turn);
    else {
      const canonical = turns[index];
      const finished = canonical.status !== 'inProgress';
      const items = new Map(canonical.items.map((item) => [item.id, item]));
      for (const item of turn.items) {
        const saved = items.get(item.id);
        if (!saved || !finished) items.set(item.id, item);
      }
      turns[index] = {
        ...canonical,
        ...(finished ? {} : turn),
        items: [...items.values()],
      };
    }
  }
  return { ...snapshot, turns };
}

export function applyRenderBatch(previous: Thread, batch: WorkEvent[]): Thread {
  let next = previous;
  for (const event of batch) {
    if (event.seq > (previous.renderCursor || 0)) next = applyThreadEvent(next, event);
  }
  return next === previous ? previous : { ...next, renderCursor: batch[batch.length - 1].seq };
}
