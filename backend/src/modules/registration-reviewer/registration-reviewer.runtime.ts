import { RegistrationReviewPolicy } from "./registration-review.policy";
import { PrismaRegistrationReviewerRepository } from "./registration-reviewer.repository";

export const registrationReviewerRepository = new PrismaRegistrationReviewerRepository();
export const registrationReviewPolicy = new RegistrationReviewPolicy(registrationReviewerRepository);
