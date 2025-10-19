// extension/src/compile-time-tests/http-types.ts
import { HttpResponse } from '../http-client';

type AnalyticsShape = { today?: { cost?: number; tokens?: number; calls?: number } };

// This variable is intentionally only used by TypeScript to verify typing.
// If the http-client types change in the future, tsc will flag mismatches here.
declare const exampleGetResponse: HttpResponse<AnalyticsShape>;

// Safe compile-time checks:
if (exampleGetResponse.success && exampleGetResponse.data?.today) {
  const c: number = exampleGetResponse.data.today.cost ?? 0;
  const t: number = exampleGetResponse.data.today.tokens ?? 0;
  const calls: number = exampleGetResponse.data.today.calls ?? 0;
  // These no-op assignments are just to exercise the types.
  void c; void t; void calls;
}
