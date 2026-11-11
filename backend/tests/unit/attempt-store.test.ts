import { describe, expect, it } from "vitest";
import { InMemoryAttemptStore } from "../../src/shared/security/attempt-store";

const MIN = 60_000;
const WINDOW = 15 * MIN;
const NOW = 1_000_000;

describe("InMemoryAttemptStore: least-recently-attempted eviction", () => {
  it("keeps a recently refused key and evicts the least recently attempted key", () => {
    const store = new InMemoryAttemptStore(3);
    for (const key of ["k1", "k2", "k3"]) expect(store.tryRecord(key, 1, WINDOW, NOW)).toBe(0);
    expect(store.tryRecord("k1", 1, WINDOW, NOW)).toBeGreaterThan(0);
    expect(store.tryRecord("k4", 1, WINDOW, NOW)).toBe(0);
    expect(store.size).toBe(3);
    expect(store.tryRecord("k1", 1, WINDOW, NOW)).toBeGreaterThan(0);
    expect(store.tryRecord("k2", 1, WINDOW, NOW)).toBe(0);
  });

  it("marks an accepted attempt on an existing key as recently used", () => {
    const store = new InMemoryAttemptStore(3);
    for (const key of ["k1", "k2", "k3"]) store.tryRecord(key, 2, WINDOW, NOW);
    expect(store.tryRecord("k1", 2, WINDOW, NOW)).toBe(0);
    store.tryRecord("k4", 2, WINDOW, NOW);
    expect(store.tryRecord("k1", 2, WINDOW, NOW)).toBeGreaterThan(0);
    expect(store.tryRecord("k2", 2, WINDOW, NOW)).toBe(0);
  });

  it("retains a frequently hammered key during a flood of distinct keys", () => {
    const store = new InMemoryAttemptStore(10);
    for (let i = 0; i < 5; i++) store.tryRecord("victim", 5, WINDOW, NOW);
    expect(store.tryRecord("victim", 5, WINDOW, NOW)).toBeGreaterThan(0);
    for (let i = 0; i < 200; i++) {
      store.tryRecord(`flood-${i}`, 5, WINDOW, NOW);
      if (i % 3 === 0) store.tryRecord("victim", 5, WINDOW, NOW);
    }
    expect(store.size).toBeLessThanOrEqual(10);
    expect(store.tryRecord("victim", 5, WINDOW, NOW)).toBeGreaterThan(0);
  });

  it("does not extend the window when refused attempts are repeated", () => {
    const store = new InMemoryAttemptStore();
    store.tryRecord("k", 1, WINDOW, NOW);
    for (let i = 1; i <= 300; i++) store.tryRecord("k", 1, WINDOW, NOW + i * 1000);
    expect(store.tryRecord("k", 1, WINDOW, NOW + WINDOW)).toBe(0);
  });

  it("stays bounded by maxKeys", () => {
    const store = new InMemoryAttemptStore(10);
    for (let i = 0; i < 100; i++) store.tryRecord(`k${i}`, 1, WINDOW, NOW);
    expect(store.size).toBe(10);
  });
});
