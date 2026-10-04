/** `prev` with each of `next` set, or deleted where its value is `''`. One
 * helper for every page that keeps its view in the URL (the runs list, a run's
 * activity runs). */
export function withParams(prev: URLSearchParams, next: Record<string, string>): URLSearchParams {
  const params = new URLSearchParams(prev);
  for (const [param, value] of Object.entries(next)) {
    if (value === '') params.delete(param);
    else params.set(param, value);
  }
  return params;
}
