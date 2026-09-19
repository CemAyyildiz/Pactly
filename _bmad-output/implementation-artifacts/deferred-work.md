- source_spec: `_bmad-output/implementation-artifacts/spec-1-1-monorepo-skeleton.md`
  summary: Add an automated check that `GET /health` returns 200 with `{"status":"ok"}`.
  evidence: Verification-gap review found no test touching `/health`; renaming the route would pass `npm run build` and `npm test`. Cheap once the backend test script from Story 1.1 exists (export `app` and use `app.request("/health")`).
