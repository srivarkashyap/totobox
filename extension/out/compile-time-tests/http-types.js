"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
// Safe compile-time checks:
if (exampleGetResponse.success && exampleGetResponse.data?.today) {
    const c = exampleGetResponse.data.today.cost ?? 0;
    const t = exampleGetResponse.data.today.tokens ?? 0;
    const calls = exampleGetResponse.data.today.calls ?? 0;
    // These no-op assignments are just to exercise the types.
    void c;
    void t;
    void calls;
}
//# sourceMappingURL=http-types.js.map