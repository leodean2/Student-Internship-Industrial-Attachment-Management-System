import { PrismaStudentRosterRepository } from "./student-roster.repository";
import { RosterLookup } from "./roster-lookup";

export const studentRosterRepository = new PrismaStudentRosterRepository();
export const rosterLookup = new RosterLookup(studentRosterRepository);
