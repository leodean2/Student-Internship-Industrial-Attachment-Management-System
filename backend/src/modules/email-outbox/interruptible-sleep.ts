export class InterruptibleSleep {
  private readonly pending = new Set<() => void>();

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const finish = () => {
        clearTimeout(timer);
        this.pending.delete(finish);
        resolve();
      };
      timer = setTimeout(finish, ms);
      this.pending.add(finish);
    });
  }

  interrupt(): void {
    for (const finish of [...this.pending]) finish();
  }
}
