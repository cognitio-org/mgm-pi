# Sentry Integration Plan: Kernel & Outfitter

This document outlines the investigation, architecture, and implementation plan for integrating Sentry into **Kernel** and **Outfitter**. 

## 1. Sentry Project Configuration & Credentials

- **DSN**: `https://1318f3af9a71b190730c227fb61c32dc@o4512181408432128.ingest.us.sentry.io/4512181422260224`
- **Environment Variables**:
  - `SENTRY_DSN`
  - `SENTRY_ENVIRONMENT` (`development`, `staging`, `production`)
  - `SENTRY_TRACES_SAMPLE_RATE` (default: `0.05` / 5%)

---

## 2. Free Tier Optimization Strategy

Sentry free tiers have strict monthly quotas (typically ~5,000 errors, ~10,000 transactions, and ~50 session replays). To maximize diagnostic value while preventing quota exhaustion:

1. **Errors (100% Capture)**:
   - `sampleRate: 1.0` for unhandled exceptions, unhandled rejections, and critical logger errors. Unhandled errors are rare in normal operation but invaluable when debugging.
2. **Performance Tracing (5% Sample Rate)**:
   - `tracesSampleRate: 0.05` (5%) for normal API requests and background worker tasks.
   - Use `tracesSampler` to force 100% tracing for requests that result in HTTP 5xx status codes or agent execution failures.
3. **Session Replay (Error-Triggered Only)**:
   - `sessionSampleRate: 0.0` (0 normal sessions recorded).
   - `errorSessionSampleRate: 1.0` (100% replay recording on unhandled frontend errors). This preserves the 50/month replay limit strictly for bug reproduction.
4. **Metrics & Logs**:
   - Emit custom Sentry metrics (`metrics.incr`, `metrics.distribution`) selectively for critical events (e.g. agent run started, tool execution failure, API timeout).

---

## 3. Component Breakdown & Integration Steps

### [Sentry-1] Core Sentry Configuration & Sampling Strategy (Issue #369)
- Create a shared configuration module (`sentry.config.ts` / `sentry.py`) handling DSN resolution, environment tagging, and sampling rate enforcement.

### [Sentry-2] Kernel Sentry Integration (Issue #370)
- **Target**: `kernal/` (Node.js TypeScript CLI & coding agent).
- **Implementation**:
  - Initialize `@sentry/node` at CLI startup (`bin/kernal`).
  - Capture unhandled exceptions, process rejections, and agent tool errors.
  - Instrument agent execution loops with Sentry OpenTelemetry tracing spans to trace LLM calls, tool executions, and step latency.

### [Sentry-3] Outfitter Backend (API & Agentd) Integration (Issue #371)
- **Target**: `outfitter/packages/api` and `outfitter/packages/agentd` (Node.js/Express/Fastify backend services).
- **Implementation**:
  - Setup Sentry request and error handling middleware.
  - Trace incoming API endpoints, database queries, and async agent dispatch queues.

### [Sentry-4] Outfitter Frontend Web Integration (Issue #372)
- **Target**: `outfitter/packages/web` (React frontend).
- **Implementation**:
  - Initialize `@sentry/react` with BrowserTracing and Replay integration.
  - Configure error-only session replay (`sessionSampleRate: 0.0`, `errorSessionSampleRate: 1.0`).
  - Wrap root React tree with Sentry ErrorBoundary.

### [Sentry-5] Outfitter Agent Engine (Python) Integration (Issue #373)
- **Target**: `outfitter/integrations/agent-engine` (Python FastAPI / Agent runtime).
- **Implementation**:
  - Initialize `sentry-sdk` with FastAPI and OpenTelemetry integrations.
  - Capture agent runtime exceptions and trace LLM / tool call spans.

---

## 4. Tracking & Execution

- **Epic Ticket**: [#368](https://github.com/cognitio-org/mgm-pi/issues/368)
- **Sub-tickets**:
  - [Sentry-1] Configuration: [#369](https://github.com/cognitio-org/mgm-pi/issues/369)
  - [Sentry-2] Kernel: [#370](https://github.com/cognitio-org/mgm-pi/issues/370)
  - [Sentry-3] Outfitter Backend: [#371](https://github.com/cognitio-org/mgm-pi/issues/371)
  - [Sentry-4] Outfitter Frontend Web: [#372](https://github.com/cognitio-org/mgm-pi/issues/372)
  - [Sentry-5] Outfitter Agent Engine (Python): [#373](https://github.com/cognitio-org/mgm-pi/issues/373)
