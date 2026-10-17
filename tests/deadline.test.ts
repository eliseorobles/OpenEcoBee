import { afterEach, expect, it, vi } from "vitest";
import { withDeadline } from "../src/deadline.js";

afterEach(() => vi.useRealTimers());

it("bounds a stalled browser transport and releases its timer", async () => {
  vi.useFakeTimers();
  const result = withDeadline(new Promise<never>(() => undefined), 60_000, () => new Error("write uncertain"));
  const rejected = expect(result).rejects.toThrow("write uncertain");
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the original result or failure and clears the deadline", async () => {
  vi.useFakeTimers();
  await expect(withDeadline(Promise.resolve("accepted"), 60_000, () => new Error("expired"))).resolves.toBe("accepted");
  await expect(withDeadline(Promise.reject(new Error("connection lost")), 60_000, () => new Error("expired"))).rejects.toThrow("connection lost");
  expect(vi.getTimerCount()).toBe(0);
});
