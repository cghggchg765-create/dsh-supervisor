# Agent Note: Automatic pacing as the supervisor bundle's fifth component

Status: implemented

English | [中文](2026-10-10-automatic-pacing-plugin.zh.md)

## Problem

A supervising agent that stalls supervises nothing. The harness already watches the CLI agents it hosts — heartbeats, L1 detection, a stale-terminal watchdog — but its own model requests fail in the same ways: a rate limit, an upstream refusal, a dropped connection. `dsh-llm-retry` owns the bounded, in-step retry: it consumes the provider's `Retry-After` when the delay fits its policy and otherwise delegates, which ends the turn as `error`. Nothing then re-drives the agent.

Two concrete gaps follow. A `Retry-After` longer than the provider policy allows leaves the run parked with nobody watching. And `dsh-goal-round-driver` deliberately disarms automatic continuation on **any** `agent/error`, including a transient `RATE_LIMIT`, so an armed long-running goal stops until a human resumes it — the opposite of what an unattended run needs.

## Decision

Ship `@deepseek-ai/dsh-supervisor-pacing` as the bundle's fifth component: a function plugin with no tools and no service, mounted by one more row in the bundle's patch.

It observes `agent/error` for the failure facts, and plans the resume instant in a pure decision core: the provider's stated delay first, then an instant parsed out of the failure message, then a bounded jittered backoff. Provider-facing limit wording is added to `@deepseek-ai/dsh-supervisor-core`'s `limit.ts` (`parseProviderReset`, `isProviderLimit`) so one module owns that vocabulary rather than a second parser growing beside it.

Delivery follows the `schedule` pattern exactly: claim the agent's idle phase with `runMaintenance`, re-arm an active goal the failure disarmed (`ctx.goals.resume`, the symmetric counterpart of the round driver's `pause`), then queue one `followup` message. A busy agent is retried on its next idle transition; a turn that someone else started cancels the pending wake, because a human coming back makes the resume redundant.

Restart recovery reads a `pacing` session projection that folds every `turn/end` into the last outcome and its failure facts. Synchronous session-history reads are deprecated, so a projection is the sanctioned way to know a session's last turn after a restart; a crash-orphaned turn arrives as `interrupted` and is treated as the synthetic `INTERRUPTED` failure, which the default code list includes.

Three boundaries keep it from growing into loop machinery: it never hooks `agent/request-error` (retrying inside a step belongs to `dsh-llm-retry`, and a second claimant would race it), it adds no session event type (the notice text names its producer instead), and it changes no `agent-loop` code.

## Alternatives considered

- **Hook `agent/request-error` and retry inside the failing step.** One mechanism instead of two, and it would keep the failure off the transcript. It also races `dsh-llm-retry` for the same decision, holds a step open for the whole cooldown, and makes a long provider wait look like a hung step.
- **Extend `dsh-llm-retry` with a cross-turn mode.** Fewer packages, but that plugin's contract is per-attempt retry with a per-step counter, and its README promises nothing model-visible; cross-turn pacing is visible to the model and durable in intent, so it belongs on its own.
- **A dedicated message source kind for the notice.** Cleaner provenance, and a session-format change for a detail; the supervisor's terminal watchdog already chose the same tradeoff, and the text names its producer.
- **Persist the resume budget.** A new session event type, a migration, and a format acknowledgement for a counter that a restart may legitimately reset; the memory-only budget is documented instead.
- **Make restart recovery default-on.** It would rescue crashed runs without configuration, and it would also replay a failed turn — including its side effects — that a human may have decided against. It stays opt-in.
- **Do nothing and rely on the operator.** True for supervised sessions with someone watching, and exactly the case this feature exists for is the one where nobody is.

## Consequences

An unattended run now survives an outage inside its budget: the failure is waited out, an armed goal keeps its rounds, and the agent is told what happened in a message it can act on. The cost is a component that can re-run a failed turn — bounded by the code whitelist, the per-session budget, the minimum spacing, and restart recovery being off by default — plus one more row on the Plugins page that an operator can switch off when a human is watching.
