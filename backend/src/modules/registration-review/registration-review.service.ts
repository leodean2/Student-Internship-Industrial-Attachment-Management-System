import { Prisma } from "@prisma/client";
import type { ActorContext } from "../auth/actor-context";
import type { AuditRepository } from "../audit/audit.repository";
import type { Tx, TxRunner } from "../../infrastructure/transaction";
import { Errors } from "../../shared/errors";
import { departmentCodeOf } from "../../shared/registration-number";
import type { OutboxEnqueuer } from "../email-outbox/outbox.repository";
import {
  enqueueRegistrationConfirmed,
  enqueueRegistrationRejected,
} from "../email-outbox/registration-decision.producer";
import type { RegistrationReviewPolicy } from "../registration-reviewer/registration-review.policy";
import { isRosterEntryEligible } from "../student-roster/roster-eligibility";
import type { RosterLookup } from "../student-roster/roster-lookup";
import type { RosterEntryRecord, StudentRosterRepository } from "../student-roster/student-roster.repository";
import type {
  HistoryEntry,
  RegistrationReviewRepository,
  RegistrationStatusName,
  ReviewProfile,
} from "./registration-review.repository";
import type { ConfirmInput, CorrectInput, ListQuery, RejectInput } from "./registration-review.validation";

export type RosterMatchResult = "found" | "found_ineligible" | "not_found";

export interface ReviewItem {
  profileId: string;
  userId: string;
  name: string;
  email: string;
  emailVerifiedAt: Date | null;
  registrationNumber: string | null;
  rejectedRegistrationNumber: string | null;
  departmentCode: string;
  status: RegistrationStatusName;
  submittedAt: Date;
  decidedAt: Date | null;
  decidedByUserId: string | null;
  decisionBasis: string | null;
  decisionReason: string | null;
  rosterMatch: RosterMatchResult | null;
}

export interface ReviewOutcome {
  profileId: string;
  status: RegistrationStatusName;
  decidedAt: Date | null;
}

export interface RegistrationReviewServiceDeps {
  repo: RegistrationReviewRepository;
  policy: Pick<RegistrationReviewPolicy, "departmentsFor">;
  roster: Pick<RosterLookup, "match">;
  rosterRepo: Pick<StudentRosterRepository, "findEntriesByNumbers">;
  audit: Pick<AuditRepository, "record">;
  outbox: OutboxEnqueuer;
  appBaseUrl: string;
  runTx: TxRunner;
}

const NOT_FOUND = "Registration not found.";
const ALREADY_DECIDED = "This registration has already been decided.";
const CHANGED = "This registration was changed by someone else. Reload and try again.";

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";

function matchOf(entry: RosterEntryRecord | undefined): RosterMatchResult {
  if (!entry) return "not_found";
  return isRosterEntryEligible(entry) ? "found" : "found_ineligible";
}

function toItem(profile: ReviewProfile, rosterMatch: RosterMatchResult | null): ReviewItem {
  return {
    profileId: profile.id,
    userId: profile.userId,
    name: profile.name,
    email: profile.email,
    emailVerifiedAt: profile.emailVerifiedAt,
    registrationNumber: profile.registrationNumber,
    rejectedRegistrationNumber: profile.rejectedRegistrationNumber,
    departmentCode: profile.registrationDepartmentCode,
    status: profile.registrationStatus,
    submittedAt: profile.userCreatedAt,
    decidedAt: profile.registrationDecidedAt,
    decidedByUserId: profile.registrationDecidedByUserId,
    decisionBasis: profile.registrationDecisionBasis,
    decisionReason: profile.registrationDecisionReason,
    rosterMatch,
  };
}

export class RegistrationReviewService {
  constructor(private readonly deps: RegistrationReviewServiceDeps) {}

  async list(actor: ActorContext, query: ListQuery): Promise<ReviewItem[]> {
    const { repo, policy, rosterRepo, runTx } = this.deps;
    return runTx(async (tx) => {
      const departments = await policy.departmentsFor(tx, actor.userId);
      const rows = await repo.list(tx, { ...query, departments });
      const numbers = rows.flatMap((row) => (row.registrationNumber ? [row.registrationNumber] : []));
      const entries = new Map(
        (await rosterRepo.findEntriesByNumbers(tx, numbers)).map((entry) => [entry.registrationNumber, entry]),
      );
      return rows.map((row) =>
        toItem(row, row.registrationNumber ? matchOf(entries.get(row.registrationNumber)) : null),
      );
    });
  }

  async get(actor: ActorContext, profileId: string): Promise<ReviewItem & { history: HistoryEntry[] }> {
    const { repo, roster, runTx } = this.deps;
    return runTx(async (tx) => {
      const profile = await this.loadScoped(tx, actor, profileId, false);
      const match = profile.registrationNumber ? (await roster.match(tx, profile.registrationNumber)).result : null;
      return { ...toItem(profile, match), history: await repo.history(tx, profile) };
    });
  }

  async confirm(actor: ActorContext, profileId: string, input: ConfirmInput): Promise<ReviewOutcome> {
    const { repo, roster, audit, outbox, appBaseUrl, runTx } = this.deps;
    return runTx(async (tx) => {
      const profile = await this.loadScoped(tx, actor, profileId, true);
      this.assertNotOwnProfile(actor, profile);
      if (profile.registrationStatus !== "PENDING") throw Errors.conflict(ALREADY_DECIDED);
      if (!profile.emailVerifiedAt) throw Errors.conflict("The student has not verified their email address yet.");

      const registrationNumber = profile.registrationNumber;
      if (!registrationNumber) throw Errors.conflict(CHANGED);
      const match = await roster.match(tx, registrationNumber);
      if (match.result !== "found") {
        throw Errors.conflict("The registration number could not be matched to an eligible roster entry.");
      }

      const decidedAt = await repo.markConfirmed(tx, {
        profileId,
        registrationNumber,
        reviewerId: actor.userId,
        basis: input.basis,
      });
      if (!decidedAt) throw Errors.conflict(CHANGED);
      if (!(await repo.activateUser(tx, profile.userId))) {
        throw Errors.conflict("The account could not be activated.");
      }

      await audit.record(tx, {
        actorUserId: actor.userId,
        action: "REGISTRATION_NUMBER_CONFIRMED",
        targetType: "StudentProfile",
        targetId: profileId,
        metadata: {
          fromStatus: "PENDING",
          toStatus: "CONFIRMED",
          departmentCode: profile.registrationDepartmentCode,
          rosterImportId: match.importId,
          rosterMatch: match.result,
        },
      });
      await enqueueRegistrationConfirmed(outbox, tx, {
        toEmail: profile.email,
        userId: profile.userId,
        profileId,
        appBaseUrl,
      });
      return { profileId, status: "CONFIRMED", decidedAt };
    });
  }

  async reject(actor: ActorContext, profileId: string, input: RejectInput): Promise<ReviewOutcome> {
    const { repo, audit, outbox, runTx } = this.deps;
    return runTx(async (tx) => {
      const profile = await this.loadScoped(tx, actor, profileId, true);
      this.assertNotOwnProfile(actor, profile);
      if (profile.registrationStatus !== "PENDING") throw Errors.conflict(ALREADY_DECIDED);
      const claimedNumber = profile.registrationNumber;
      if (!claimedNumber) throw Errors.conflict(CHANGED);

      const decidedAt = await repo.markRejected(tx, {
        profileId,
        claimedNumber,
        reviewerId: actor.userId,
        reason: input.reason,
      });
      if (!decidedAt) throw Errors.conflict(CHANGED);

      await audit.record(tx, {
        actorUserId: actor.userId,
        action: "REGISTRATION_NUMBER_REJECTED",
        targetType: "StudentProfile",
        targetId: profileId,
        metadata: {
          fromStatus: "PENDING",
          toStatus: "REJECTED",
          departmentCode: profile.registrationDepartmentCode,
        },
      });
      await enqueueRegistrationRejected(outbox, tx, {
        toEmail: profile.email,
        userId: profile.userId,
        profileId,
        decidedAt,
      });
      return { profileId, status: "REJECTED", decidedAt };
    });
  }

  async correct(actor: ActorContext, profileId: string, input: CorrectInput): Promise<ReviewOutcome> {
    const { repo, policy, audit, runTx } = this.deps;
    const destinationDepartment = departmentCodeOf(input.registrationNumber);
    try {
      return await runTx(async (tx) => {
        const departments = await policy.departmentsFor(tx, actor.userId);
        const profile = await repo.lockById(tx, profileId);
        if (!profile) throw Errors.notFound(NOT_FOUND);
        this.assertNotOwnProfile(actor, profile);
        if (
          !departments.includes(profile.registrationDepartmentCode) ||
          !departments.includes(destinationDepartment)
        ) {
          throw Errors.forbidden();
        }
        if (profile.registrationStatus === "CONFIRMED") {
          throw Errors.conflict("A confirmed registration cannot be corrected here.");
        }
        if (profile.registrationNumber === input.registrationNumber) {
          throw Errors.validation([
            { path: "registrationNumber", message: "This is already the registration number on file." },
          ]);
        }

        const fromStatus = profile.registrationStatus;
        const applied = await repo.applyCorrection(tx, {
          profileId,
          expectedStatus: fromStatus,
          registrationNumber: input.registrationNumber,
          departmentCode: destinationDepartment,
        });
        if (!applied) throw Errors.conflict(CHANGED);

        await audit.record(tx, {
          actorUserId: actor.userId,
          action: "REGISTRATION_NUMBER_CORRECTED",
          targetType: "StudentProfile",
          targetId: profileId,
          metadata: {
            fromStatus,
            toStatus: "PENDING",
            fromDepartmentCode: profile.registrationDepartmentCode,
            toDepartmentCode: destinationDepartment,
          },
        });
        return { profileId, status: "PENDING", decidedAt: null };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw Errors.conflict("This registration number is already registered.");
      throw error;
    }
  }

  private async loadScoped(
    tx: Tx,
    actor: ActorContext,
    profileId: string,
    lock: boolean,
  ): Promise<ReviewProfile> {
    const { repo, policy } = this.deps;
    const departments = await policy.departmentsFor(tx, actor.userId);
    const profile = lock ? await repo.lockById(tx, profileId) : await repo.findById(tx, profileId);
    if (!profile || !departments.includes(profile.registrationDepartmentCode)) throw Errors.notFound(NOT_FOUND);
    return profile;
  }

  private assertNotOwnProfile(actor: ActorContext, profile: ReviewProfile): void {
    if (profile.userId === actor.userId) throw Errors.forbidden();
  }
}
