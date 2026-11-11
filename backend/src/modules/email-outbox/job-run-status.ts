export type FinalJobRunStatus = "SUCCESS" | "PARTIAL_FAILURE" | "FAILED";

export function finalJobRunStatus(itemsProcessed: number, itemsFailed: number): FinalJobRunStatus {
  if (
    !Number.isInteger(itemsProcessed) ||
    !Number.isInteger(itemsFailed) ||
    itemsProcessed < 1 ||
    itemsFailed < 0 ||
    itemsFailed > itemsProcessed
  ) {
    throw new RangeError(`invalid job-run counts: processed=${itemsProcessed}, failed=${itemsFailed}`);
  }
  if (itemsFailed === 0) return "SUCCESS";
  return itemsFailed === itemsProcessed ? "FAILED" : "PARTIAL_FAILURE";
}
