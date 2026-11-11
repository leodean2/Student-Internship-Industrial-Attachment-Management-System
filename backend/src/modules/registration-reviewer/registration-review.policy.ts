import type { Tx } from "../../infrastructure/transaction";
import { Errors } from "../../shared/errors";
import type { RegistrationReviewerRepository } from "./registration-reviewer.repository";

export class RegistrationReviewPolicy {
  constructor(private readonly repo: Pick<RegistrationReviewerRepository, "lockActiveDepartments">) {}

  /** Call inside the decision transaction; active assignment locks remain held through the decision. */
  async departmentsFor(tx: Tx, userId: string): Promise<readonly string[]> {
    const departments = await this.repo.lockActiveDepartments(tx, userId);
    if (departments.length === 0) throw Errors.forbidden();
    return departments;
  }

  async assertCanReview(tx: Tx, userId: string, departmentCode: string): Promise<void> {
    const departments = await this.departmentsFor(tx, userId);
    if (!departments.includes(departmentCode)) throw Errors.notFound("Registration not found.");
  }
}
