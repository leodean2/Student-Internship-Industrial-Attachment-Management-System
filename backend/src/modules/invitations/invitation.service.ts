import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { acquireTransactionLock, invitationEmailLockKey } from "../../infrastructure/advisory-lock";
import { dbClockNow } from "../../infrastructure/db-clock";
import type { Tx, TxRunner } from "../../infrastructure/transaction";
import { AttemptLimiter } from "../../shared/security/attempt-limiter";
import { isUniqueViolation } from "../../shared/db/errors";
import { Errors } from "../../shared/errors";
import { hashToken, mintOpaqueToken } from "../../shared/security/opaque-token";
import { hashPassword } from "../auth/password";
import { normalizeEmail } from "../../shared/validation/email";
import { hasRole, type ActorContext } from "../auth/actor-context";
import type { AuditRepository } from "../audit/audit.repository";
import { enqueueInvitationCreated } from "../email-outbox/invitation-created.producer";
import type { OutboxRepository } from "../outbox/outbox.repository";
import type {
  InvitationListRecord,
  InvitationRepository,
  InvitationStatus,
} from "./invitation.repository";
import { INVITABLE_ROLE, type CreatedInvitation } from "./invitation.types";

const ACCEPTANCE_ATTEMPT_LIMIT = 10;
const ACCEPTANCE_WINDOW_MS = 15 * 60 * 1000;

export interface InvitationServiceDeps {
  repo: InvitationRepository;
  audit: AuditRepository;
  outbox: OutboxRepository;
  appBaseUrl: string;
  runTx: TxRunner;
  acquireLock?: (tx: Tx, key: string) => Promise<void>;
  acceptanceThrottle?: Pick<AttemptLimiter, "acquire">;
  hashPassword?: (plain: string) => Promise<string>;
  logger?: { warn(obj: object, msg: string): void };
}

export interface AcceptInvitationInput {
  token: string;
  password: string;
  name: string;
  staffId: string | null;
  title: string | null;
  ip: string;
}

export interface AcceptedInvitation {
  userId: string;
  email: string;
  role: typeof INVITABLE_ROLE;
}

export interface InvitationListQuery {
  page: number;
  limit: number;
  status?: InvitationStatus;
  email?: string;
}

export interface AdminInvitation {
  id: string;
  email: string;
  role: string;
  organizationId: string | null;
  invitedByUserId: string;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
  status: InvitationStatus;
}

export interface InvitationPage {
  data: AdminInvitation[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export class InvitationService {
  private readonly acquireLock: (tx: Tx, key: string) => Promise<void>;
  private readonly acceptanceThrottle: Pick<AttemptLimiter, "acquire">;
  private readonly hashPassword: (plain: string) => Promise<string>;

  constructor(private readonly deps: InvitationServiceDeps) {
    this.acquireLock = deps.acquireLock ?? acquireTransactionLock;
    this.acceptanceThrottle =
      deps.acceptanceThrottle ?? new AttemptLimiter({ limit: ACCEPTANCE_ATTEMPT_LIMIT, windowMs: ACCEPTANCE_WINDOW_MS });
    this.hashPassword = deps.hashPassword ?? hashPassword;
  }

  async create(actor: ActorContext, input: { email: string; role: string }): Promise<CreatedInvitation> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();

    const email = normalizeEmail(input.email);
    if (input.role !== INVITABLE_ROLE) {
      throw Errors.validation([{ path: "role", message: `Only ${INVITABLE_ROLE} invitations are supported.` }]);
    }

    const { raw, hash } = mintOpaqueToken();
    const id = randomUUID();
    const { repo, audit, outbox, appBaseUrl, runTx } = this.deps;

    return runTx(async (tx) => {
      await this.acquireLock(tx, invitationEmailLockKey(email));

      if (await repo.accountExists(tx, email)) throw Errors.conflict("An account already exists for this email address.");
      const blocking = await repo.findBlocking(tx, email);
      if (blocking === "ACCEPTED") throw Errors.conflict("An invitation for this email address has already been accepted.");
      if (blocking === "PENDING") throw Errors.conflict("A pending invitation already exists for this email address.");

      const { expiresAt } = await repo.insert(tx, { id, email, role: INVITABLE_ROLE, invitedByUserId: actor.userId, tokenHash: hash });
      await enqueueInvitationCreated(outbox, tx, {
        toEmail: email,
        rawToken: raw,
        tokenHash: hash,
        role: INVITABLE_ROLE,
        expiresAt,
        appBaseUrl,
      });
      await audit.record(tx, {
        actorUserId: actor.userId,
        action: "INVITATION_CREATED",
        targetType: "Invitation",
        targetId: id,
        metadata: { role: INVITABLE_ROLE },
      });

      return { invitationId: id, email, role: INVITABLE_ROLE, expiresAt };
    });
  }

  async accept(input: AcceptInvitationInput): Promise<AcceptedInvitation> {
    const gate = this.acceptanceThrottle.acquire(`invitation-accept:ip:${input.ip}`);
    if (!gate.allowed) {
      this.deps.logger?.warn({ ip: input.ip }, "invitation acceptance rate limit exceeded");
      throw Errors.rateLimited(gate.retryAfterSeconds);
    }

    const { permit } = gate;
    let failedTokenGuess = false;
    try {
      const passwordHash = await this.hashPassword(input.password);
      const tokenHash = hashToken(input.token);
      return await this.deps.runTx(async (tx) => {
        const invitation = await this.deps.repo.findByTokenHash(tx, tokenHash);
        if (!invitation) {
          failedTokenGuess = true;
          throw Errors.notFound();
        }

        const email = normalizeEmail(invitation.email);
        await this.acquireLock(tx, invitationEmailLockKey(email));
        const lifecycle = await this.deps.repo.findLifecycleForUpdate(tx, invitation.id);
        if (!lifecycle || lifecycle.status !== "PENDING") {
          failedTokenGuess = true;
          throw Errors.notFound();
        }

        if (await this.deps.repo.accountExists(tx, email)) {
          throw Errors.conflict("An account already exists for this invitation.");
        }

        const userId = randomUUID();
        try {
          await this.deps.repo.insertUser(tx, {
            id: userId,
            email,
            passwordHash,
            name: input.name,
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw Errors.conflict("An account already exists for this invitation.");
          }
          throw error;
        }
        await this.deps.repo.insertRole(tx, {
          id: randomUUID(),
          userId,
          role: invitation.role,
        });
        await this.deps.repo.insertUniversitySupervisorProfile(tx, {
          id: randomUUID(),
          userId,
          staffId: input.staffId,
          title: input.title,
        });

        if (!(await this.deps.repo.claim(tx, { invitationId: invitation.id, tokenHash, userId }))) {
          failedTokenGuess = true;
          throw Errors.notFound();
        }

        await this.deps.audit.record(tx, {
          actorUserId: userId,
          action: "INVITATION_ACCEPTED",
          targetType: "Invitation",
          targetId: invitation.id,
          metadata: { role: invitation.role },
        });

        return { userId, email, role: invitation.role };
      });
    } finally {
      if (!failedTokenGuess) permit.refund();
    }
  }

  async cancel(
    actor: ActorContext,
    invitationId: string,
  ): Promise<{ invitationId: string; status: "CANCELLED"; revokedAt: string }> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();

    return this.deps.runTx(async (tx) => {
      const email = await this.deps.repo.findEmailById(tx, invitationId);
      if (!email) throw Errors.notFound();

      await this.acquireLock(tx, invitationEmailLockKey(normalizeEmail(email)));
      const lifecycle = await this.deps.repo.findLifecycleForUpdate(tx, invitationId);
      if (!lifecycle) throw Errors.notFound();
      if (lifecycle.status !== "PENDING") throw invitationStateError(lifecycle.status);

      const revokedAt = await this.deps.repo.cancel(tx, invitationId);
      if (!revokedAt) {
        const current = await this.deps.repo.findLifecycleForUpdate(tx, invitationId);
        if (!current) throw Errors.notFound();
        throw current.status === "PENDING" ? Errors.invitationStateConflict() : invitationStateError(current.status);
      }

      await this.deps.audit.record(tx, {
        actorUserId: actor.userId,
        action: "INVITATION_CANCELLED",
        targetType: "Invitation",
        targetId: invitationId,
        metadata: { role: INVITABLE_ROLE },
      });

      return { invitationId, status: "CANCELLED", revokedAt: revokedAt.toISOString() };
    });
  }

  async list(actor: ActorContext, query: InvitationListQuery): Promise<InvitationPage> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();

    return this.deps.runTx(async (tx) => {
      const now = await dbClockNow(tx);
      const where = buildInvitationWhere(query, now);
      const [records, totalItems] = await Promise.all([
        this.deps.repo.findMany(tx, where, (query.page - 1) * query.limit, query.limit),
        this.deps.repo.count(tx, where),
      ]);

      return {
        data: records.map((record) => serializeInvitation(record, now)),
        pagination: {
          page: query.page,
          limit: query.limit,
          total: totalItems,
          totalPages: Math.ceil(totalItems / query.limit),
        },
      };
    });
  }

  async get(actor: ActorContext, invitationId: string): Promise<AdminInvitation> {
    if (!hasRole(actor, "ADMIN")) throw Errors.forbidden();

    return this.deps.runTx(async (tx) => {
      const now = await dbClockNow(tx);
      const record = await this.deps.repo.findAdminById(tx, invitationId);
      if (!record) throw Errors.notFound();
      return serializeInvitation(record, now);
    });
  }
}

function invitationStateError(status: InvitationStatus): Error {
  switch (status) {
    case "ACCEPTED":
      return Errors.invitationAlreadyAccepted();
    case "CANCELLED":
      return Errors.invitationAlreadyCancelled();
    case "EXPIRED":
      return Errors.invitationExpired();
    case "PENDING":
      return Errors.invitationStateConflict();
  }
}

function buildInvitationWhere(query: InvitationListQuery, now: Date): Prisma.InvitationWhereInput {
  const clauses: Prisma.InvitationWhereInput[] = [];
  if (query.status === "ACCEPTED") {
    clauses.push({ acceptedByUserId: { not: null } });
  } else if (query.status === "CANCELLED") {
    clauses.push({ acceptedByUserId: null, revokedAt: { not: null } });
  } else if (query.status === "EXPIRED") {
    clauses.push({ acceptedByUserId: null, revokedAt: null, expiresAt: { lte: now } });
  } else if (query.status === "PENDING") {
    clauses.push({ acceptedByUserId: null, revokedAt: null, expiresAt: { gt: now } });
  }
  if (query.email) clauses.push({ email: query.email });
  return clauses.length ? { AND: clauses } : {};
}

function serializeInvitation(record: InvitationListRecord, now: Date): AdminInvitation {
  const status: InvitationStatus = record.acceptedByUserId
    ? "ACCEPTED"
    : record.revokedAt
      ? "CANCELLED"
      : record.expiresAt <= now
        ? "EXPIRED"
        : "PENDING";

  return {
    id: record.id,
    email: record.email,
    role: record.role,
    organizationId: record.organizationId,
    invitedByUserId: record.invitedByUserId,
    createdAt: record.createdAt.toISOString(),
    expiresAt: record.expiresAt.toISOString(),
    acceptedAt: record.acceptedAt?.toISOString() ?? null,
    revokedAt: record.revokedAt?.toISOString() ?? null,
    status,
  };
}
