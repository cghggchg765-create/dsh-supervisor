---
description: "Keep the supervising agent alive across provider failures: wait out a stated reset or a bounded backoff, re-arm a disarmed goal, and wake the agent for one more turn — inside a per-session budget."
kind: "package-reference"
---

# @deepseek-ai/dsh-supervisor-pacing

English | [中文](README.zh.md)

## Summary

`supervisor-pacing` keeps the harness's own model requests going. `dsh-llm-retry` retries inside the failing step with the provider's policy; when that policy gives up — a `Retry-After` longer than it allows, or a provider that keeps refusing — the turn ends `error` and nothing wakes the agent again. This component waits out the stated reset (or a bounded backoff), re-arms a goal the failure disarmed, and wakes the agent for one more turn. It registers no tools.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Install the bundle that carries it — [`@deepseek-ai/dsh-supervisor`](../supervisor/README.md) — from the Plugins page or with `dsh plugin --profile <name> add <spec>`. The component needs no path configuration and no tools; it watches the harness's own turns through the agent registry and the session projection registry.

### Configuration

A profile patch targets the row id `supervisor-pacing` and replaces the whole `config`:

```yaml
- id: supervisor-pacing
  config:
    maxResumesPerSession: 3
    minIntervalMs: 60000
    resumeOnRestart: true
    notifyChatId: 'oc_…'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether automatic pacing runs at all. |
| `scope` | `roots` | Agents paced: `roots` covers the sessions a human drives, `all` also covers subagents. |
| `codes` | `RATE_LIMIT`, `SERVER`, `TIMEOUT`, `TRANSPORT`, `EMPTY_RESPONSE`, `INTERRUPTED` | Failure codes pacing resumes; any other code is reported and left alone. |
| `initialDelayMs` | `1000` | First backoff delay for a failure that states no resume instant. |
| `maxDelayMs` | `10000` | Ceiling for a computed backoff delay. |
| `jitterRatio` | `0.1` | Fraction of a backoff delay applied as symmetric jitter. |
| `bufferMs` | `120000` | Wait added past a stated reset before resuming, so the provider is serving again. |
| `maxResumeDelayMs` | 6 hours | Longest resume delay honored; a later stated instant is clamped to it. |
| `minIntervalMs` | `60000` | Minimum spacing between two automatic resumes for one session. |
| `maxResumesPerSession` | `3` | Consecutive automatic resumes allowed before pacing gives up. |
| `resumeGoals` | `true` | Re-arm an active goal the failure disarmed, so its rounds continue. |
| `resumeOnRestart` | `false` | Resume a session whose last turn failed before this process started. |
| `notifyOnGiveUp` | `true` | Report a give-up to the chat transport, when one is registered. |
| `notifyChatId` | empty | Conversation a give-up alert is sent to; empty disables the alert. |

### When to choose it

Use it for a run that must survive a provider outage without a human: an overnight coding session, a long batch that keeps hitting a limit, or a supervised run whose supervising agent is itself the thing that got refused. Leave it off when every turn is watched in real time — a human who sees the failure can simply send the next message.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### One failure, one decision

`agent/error` supplies the failure facts (`code`, `status`, `providerRetryAfterMs`, `message`), which `src/pacing.ts` narrows and plans over: the provider's stated delay first, then an instant parsed out of the message (the provider forms live in `@deepseek-ai/dsh-supervisor-core`'s `parseProviderReset`, so one module owns that vocabulary), then a bounded jittered backoff. A code the deployment does not list, or a session that spent its budget, is reported instead of resumed.

### The wake

A pending wake is a fiber-scoped timer. When it fires, the component claims the agent's idle phase through `runMaintenance`, re-arms an active goal the failure disarmed (`ctx.get('goals')`, the optional goal service, read that way because it is not a declared injection), and queues one `followup` message. A busy agent is retried after its next idle transition, and a turn that someone else started cancels the pending wake, because a human coming back makes the resume redundant.

### Restart recovery

`src/projection.ts` registers a `pacing` session projection that folds every `turn/end` into the last turn's outcome and failure facts. That is the repository's sanctioned way to read history after a restart — synchronous event reads are deprecated — so `resumeOnRestart` can decide from projected state alone. A crash-orphaned turn arrives as `interrupted` and is treated as the synthetic `INTERRUPTED` failure.

### What it deliberately does not do

It never hooks `agent/request-error`: retrying inside a step belongs to `dsh-llm-retry`, and a second claimant would race it. It never changes `agent-loop`, and it adds no session event type.

### Why no invariant companion is published

No invariant companion is published: the component's only durable output is the projection it folds from committed events, so a consumer re-derives every claim from the same log and no independent observation exists to cross-check.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Supervised terminals bundle](../supervisor/README.md) — the six components and the profile rows that mount them.
- [LLM request recovery](../../llm/llm-retry/README.md) — the in-step retry policy this component hands off to.
- [Goal rounds](../../goal/goal-round-driver/README.md) — the driver that disarms a goal on any error, which this component re-arms.
- [Schedule](../../schedule/schedule/README.md) — the reminder driver whose `runMaintenance` + `followup` wake pattern this component follows.

-----

<a id="model-experience"></a>
## Model Experience

### Resume notice

#### What the model sees

One user-role message per delivered resume, queued as the next turn:

##### Verbatim text for this field, when needed

```markdown
[pacing] the previous turn failed. This is automatic resume {resume} of {max}: continue the work from where it stopped, and if it cannot continue, report what remains instead of retrying.
```

#### Token effect

Conditional: at most one message per automatic resume, capped by `maxResumesPerSession` per session, and only after a turn already failed.

#### KV Cache effect

Append-only. The notice is a new message at the end of the conversation, so it extends a reusable prefix rather than replacing earlier tokens; the turn it opens then appends its own request tokens.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **The notice arrives as a user-role message** — a dedicated message source kind would be a session-format change for a provenance detail, so the text names its producer instead (`[pacing] …`), exactly as the supervisor's terminal watchdog does.
- **The resume budget lives in memory** — a restart resets it, so a provider that stays down can be retried again after every restart; `resumeOnRestart` is off by default so a crash does not silently re-run a failed turn.
- **In-step retries stay with `dsh-llm-retry`** — this component only acts after a turn ended in error, so a failure that the provider policy handles never reaches it.
- **A non-listed failure is reported, not resumed** — an operator sees one log line (and one chat alert per cooldown) and must decide; pacing does not guess whether an `AUTH` or `INVALID_REQUEST` failure is transient.
- **Goal re-arming needs the goal service** — with no `ctx.goals` mounted, the resume still wakes the agent, but a disarmed goal stays disarmed.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The decision core (`src/pacing.ts`) is pure so the policy is testable without a loop; the projection (`src/projection.ts`) is the only durable read path. Provider-facing limit wording belongs in `@deepseek-ai/dsh-supervisor-core`'s `limit.ts`; add new forms there rather than in this package.

</details>
