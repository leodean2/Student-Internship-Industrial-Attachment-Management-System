import { randomUUID } from "node:crypto";
import type { Tx } from "../../infrastructure/transaction";

export interface AuditEvent {
  actorUserId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

export interface AuditRepository {
  record(tx: Tx, event: AuditEvent): Promise<void>;
}

export class PrismaAuditRepository implements AuditRepository {
  async record(tx: Tx, event: AuditEvent): Promise<void> {
    const metadata = event.metadata === undefined ? null : JSON.stringify(event.metadata);
    await tx.$executeRaw`
      INSERT INTO audit_logs ("id", "actorUserId", "action", "targetType", "targetId", "metadata")
      VALUES (${randomUUID()}, ${event.actorUserId}, ${event.action}, ${event.targetType}, ${event.targetId}, ${metadata}::jsonb)`;
  }
}
