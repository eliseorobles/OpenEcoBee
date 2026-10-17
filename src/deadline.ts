/** Bound browser transport work even when the page's own timers stop running. */
export async function withDeadline<T>(work: PromiseLike<T>, milliseconds: number, expired: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve(work),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(expired()), milliseconds); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
