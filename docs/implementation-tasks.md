# Implementation and verification tasks

The user selected the models below and authorized a private GitHub repository,
`vkpdeveloper/thereader`, with completed subtasks committed and pushed to `main`.
The coordinator serializes Git operations. Application deployment is separate.

1. **Workspace and shared API contract.** Coordinator. Initialize repository,
   establish personal/no-auth scope, and document app/backend boundaries.
2. **Worker backend.** GPT-5.6 Sol, high reasoning. TypeScript Cloudflare Worker,
   R2 catalog and downloads, Bun tooling, original EPUB fixtures, meaningful runtime
   tests, type checks, and deployment dry run. Commit when the subtask passes.
3. **Flutter frontend.** Claude Fable 5.1 via Claude provider. Always-dark minimal
   library and reader flows, local state and downloads, API integration boundary,
   native project configuration, analysis/tests/build checks. Commit when ready.
4. **Application integration.** GPT-6 Astra, high reasoning, after tasks 2 and 3.
   Exercise the real seeded Worker from Flutter, fix contract or lifecycle issues,
   verify native EPUB rendering, download integrity, and offline restart. Commit
   and push each cohesive completed integration fix.
5. **iOS and Android verification.** GPT-6 Astra, high reasoning. Build and exercise
   both native targets using available devices. Cover library/search/download/read,
   typography, position persistence, errors, and offline operation. Record commands
   and evidence, and explicitly distinguish build, simulator, and device results.
6. **Performance measurements and improvements.** GPT-6 Astra, high reasoning.
   Establish a reproducible baseline, profile, improve measured bottlenecks, then
   repeat the same workload. Cover startup, cached book opening, UI frame timing,
   long-session memory, and energy where hardware permits. Commit improvements
   separately with before/after evidence and retain benchmark scripts/results.
7. **Final verification and handoff.** Check regressions, confirm pushed commits,
   summarize measured results and remaining hardware/platform limitations.

## Performance evidence rules

- User prefers the local iOS simulator for primary app testing and previews.
  Validate Android separately; an iOS simulator cannot establish Android behavior.
  Physical-device setup is not a prerequisite for initial functional verification.
- Use physical-device release/profile measurements for device-performance claims.
- Simulator tests establish correctness and provide diagnostic observations; they
  are not proof of phone latency, energy use, or sustained frame rate.
- Use identical books, settings, device, build mode, and workload before and after.
- Measure time to actual readable content, not merely navigation animation finish.
- Observe associated WebView/content processes when assessing reader memory.
- Do not invent measurements or mark unsupported platform checks as passed.
- Pin downloaded books in durable storage. Network availability must not gate
  reopening a completed local download.
- Treat white flashes, lost selection/position, dead controls, or leaked reader
  instances as defects, even when aggregate frame averages look acceptable.
