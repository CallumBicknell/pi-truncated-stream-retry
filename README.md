# pi-truncated-stream-retry

A [Pi](https://github.com/earendil-works/pi) extension that retries turns killed by a
truncated upstream stream, waiting longer after each consecutive failure.

## The problem

When an upstream provider closes an SSE response before its terminal event, proxies
downstream report it like this:

```
Error: upstream stream ended before a completion event; this turn may be incomplete
```

Pi has built-in agent-level retry (`retry.enabled`, `retry.maxRetries`,
`retry.baseDelayMs` in settings). It does not fire for this error, because it gates on a
fixed regex — `RETRYABLE_PROVIDER_ERROR_PATTERN` in Pi's `src/ai/src/utils/retry.ts`.
That pattern includes `"stream ended before message_stop"` and `"ended without"`, but not
this wording. The failure therefore surfaces to you instead of being retried.

It is intermittent by nature: when the same text arrives wrapped in a `server_error`
envelope, Pi's pattern *does* match it and the built-in retry takes over. So the same
outage sometimes self-heals and sometimes doesn't.

## What this does

Records truncation failures at `turn_end`, and once Pi has settled and the agent is idle
again, sends a real user message to start a fresh run. The wait grows per consecutive
failure:

| Attempt | Wait   |
| ------- | ------ |
| 1       | 1s     |
| 2       | 1.5s   |
| 3       | 2.25s  |
| 4       | 3.4s   |
| 5       | 5.1s   |

The streak resets as soon as a turn ends for any reason other than truncation, so the
backoff only escalates across uninterrupted failures. After 5 consecutive failures it
stops and surfaces the error rather than retrying forever; one successful turn re-arms it.

Because a truncated turn produced no usable output, retrying it is safe — there is no
partial work to preserve or duplicate.

## Why not just use `turn_end`'s `continue`?

Because Pi silently ignores it after a failed turn. Requesting a continuation from
`turn_end` looks like it works — the chained entry commits, and no error is reported —
but Pi computes `canContinue=false` and drops the retry. `_buildBoundaryContext` refuses
a continuation whose final context role is `assistant`, and after a failed turn the last
message *is* the assistant error message.

Verified against pi 1.0.2 with `--mode json`: the entry is appended, then `agent_end`
reports `"willRetry": false` and no second request is made. Chaining a `custom_message`
entry does not fix it either, even with `display: true`.

So this extension waits for `agent_settled`, where the agent is idle and a new run can be
started unconditionally via `pi.sendUserMessage()`. That guarantees runnable context
instead of relying on a flag Pi may discard.

## Install

From this repo:

```bash
pi install git:github.com/CallumBicknell/pi-truncated-stream-retry
```

To try it for a single run without adding it to settings:

```bash
pi -e git:github.com/CallumBicknell/pi-truncated-stream-retry
```

Or copy `extensions/truncated-stream-retry.ts` into `~/.pi/agent/extensions/`.

Then `/reload` an already-running Pi session.

## Configuration

All optional, via environment variables:

| Variable                     | Default | Meaning                             |
| ---------------------------- | ------- | ----------------------------------- |
| `RETRY_TRUNCATED_BASE_MS`    | `1000`  | First wait                          |
| `RETRY_TRUNCATED_MULTIPLIER` | `1.5`   | Growth per consecutive failure      |
| `RETRY_TRUNCATED_MAX_MS`     | `30000` | Ceiling on any single wait          |
| `RETRY_TRUNCATED_MAX_ATTEMPTS` | `5`   | Retries per consecutive failure     |

For pure linear backoff (1s, 2s, 3s…), set `RETRY_TRUNCATED_MULTIPLIER=1` and raise
`RETRY_TRUNCATED_BASE_MS`:

```bash
RETRY_TRUNCATED_BASE_MS=1000 RETRY_TRUNCATED_MULTIPLIER=1 pi
```

## How it retries

Two details are forced by Pi's internals rather than by preference:

**It chains a `custom_message` entry.** After a failed turn the last message in context
is the assistant error message, and Pi refuses a continuation whose final role is
`assistant` — `_buildBoundaryContext` reports `canContinue: false`, and the retry is
silently dropped. Custom messages convert to role `user`, which makes the boundary
continuable. The entry is created with `display: false`, so it stays out of your
transcript; the model sees a short marker telling it to retry.

**It matches on wording, not status.** `stopReason` must be `error` and the text must
match one of the truncation signatures. Rate limits, context overflow, and ordinary
provider errors are left alone, since Pi already retries those or should not retry them
at all.

Recognised signatures:

```
upstream stream ended before a completion event
upstream_stream_truncated
stream ended before a (completion|terminal) ...
ended without producing ...
```

## Development

```bash
npm install
npm test
```

The tests drive the real extension module through a fake `ExtensionAPI`, covering
detection across every phrasing seen in the wild, the backoff curve, streak resets, the
retry budget under sustained outage, and abort handling.

## Verified against a live truncated stream

Beyond unit tests, this was exercised end-to-end against a fake OpenAI-compatible
provider that truncates the SSE stream the same way `billion-context` does — in-band
`server_error` chunk, then `res.end()` with no `[DONE]`.

| Scenario                                    | Requests | Outcome                    |
| ------------------------------------------- | -------- | -------------------------- |
| Truncate, truncate, succeed                 | 3        | Recovered, returned output  |
| Same, extension removed (control)           | 1        | Error surfaced             |
| Truncate forever, cap 3                     | 4        | Stopped after cap, error surfaced |

With `retry.enabled` disabled, so recovery can only come from this extension.

## License

MIT