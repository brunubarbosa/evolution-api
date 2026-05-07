// [GDW-008] Group event persistence service.
//
// Best-effort, fire-and-forget audit trail for group lifecycle events
// (participant updates + join requests). Today, when an Evolution webhook
// delivery fails (network blip, consumer down, signature mismatch), the
// underlying event is lost forever — Evolution holds nothing in DB. This
// service captures the event as a side effect so consumers can replay
// history via GET /group/events.
//
// Strictly opt-in via `GDW_PERSIST_GROUP_EVENTS=true` env var. When the
// flag is unset (default), `record()` is a no-op and no rows are written
// — the deployed image's behavior is identical to GDW-007.
//
// Persistence MUST NEVER throw or block webhook fan-out. All errors are
// caught + logged; callers should still `.catch(() => {})` for safety.
//
// See PATCHES.md GDW-008.

import { PrismaRepository } from '@api/repository/repository.service';
import { Logger } from '@config/logger.config';
import type { Prisma } from '@prisma/client';

export interface RecordGroupEventInput {
  instanceId: string;
  groupJid: string;
  eventType: string; // 'participant_update' | 'join_request' | `stub:${number}`
  action?: string | null;
  method?: string | null;
  actorJid?: string | null;
  actorPn?: string | null;
  affectedJid?: string | null;
  affectedPn?: string | null;
  payload: unknown;
}

export class GroupEventPersistenceService {
  private readonly logger = new Logger(GroupEventPersistenceService.name);

  constructor(private readonly prismaRepository: PrismaRepository) {}

  /**
   * Persist a group event row. No-op when GDW_PERSIST_GROUP_EVENTS !== 'true'.
   * Never throws — errors are swallowed to keep the webhook fan-out path
   * resilient.
   */
  public async record(input: RecordGroupEventInput): Promise<void> {
    if (process.env.GDW_PERSIST_GROUP_EVENTS !== 'true') {
      return;
    }

    try {
      await this.prismaRepository.groupEvent.create({
        data: {
          instanceId: input.instanceId,
          groupJid: input.groupJid,
          eventType: input.eventType,
          action: input.action ?? null,
          method: input.method ?? null,
          actorJid: input.actorJid ?? null,
          actorPn: input.actorPn ?? null,
          affectedJid: input.affectedJid ?? null,
          affectedPn: input.affectedPn ?? null,
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
        },
      });
    } catch (error) {
      this.logger.error(error);
    }
  }
}
