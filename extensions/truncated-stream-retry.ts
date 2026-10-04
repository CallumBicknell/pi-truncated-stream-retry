// Retry turns that die from a truncated upstream stream.
//
// Pi's built-in retry (retry.* settings) only fires when the error text matches
// RETRYABLE_PROVIDER_ERROR_PATTERN in pi's src/ai/src/utils/retry.ts. That pattern
// covers "stream ended before message_stop" and "ended without", but NOT the
// truncation wording the billion-context ACP proxy emits:
//
//   "upstream stream ended before a completion event; this turn may be incomplete"
//
// So these failures surface to the user instead of being retried.
//
// Mechanism: a turn_end continuation cannot be used here. After a failed turn the
// last message in context is the assistant error message, so Pi computes
// canContinue=false and silently drops the requested continuation -- verified
// against pi 1.0.2, where the chained entry commits but agent_end still reports
// willRetry:false and no second request is made. Instead this extension records the
// failure at turn_end and, once the agent has settled and is idle again, sends a
// real user message to start a fresh run. That guarantees runnable context rather
// than relying on a flag Pi may discard.
//
// Behaviour (defaults, override via env):
//   RETRY_TRUNCATED_BASE_MS       first wait                      1000
//   RETRY_TRUNCATED_MULTIPLIER    growth per failure               1.5
//   RETRY_TRUNCATED_MAX_MS        ceiling on any single wait      30000
//   RETRY_TRUNCATED_MAX_ATTEMPTS  retries per consecutive failure      5
//
// So by default: 1s, 1.5s, 2.25s, 3.4s, 5.1s (capped at 30s).

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BASE_MS = numEnv("RETRY_TRUNCATED_BASE_MS", 1000);
const MAX_MS = numEnv("RETRY_TRUNCATED_MAX_MS", 30_000);
const MAX_ATTEMPTS = numEnv("RETRY_TRUNCATED_MAX_ATTEMPTS", 5);
const MULTIPLIER = numEnv("RETRY_TRUNCATED_MULTIPLIER", 1.5);

function numEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

// Signatures of a stream that died before its terminal event. All of these are the
// same class of failure, and all are safe to retry: the truncated turn produced no
// usable output, so there is nothing partial to preserve or duplicate.
const TRUNCATION_PATTERNS: RegExp[] = [
  /upstream stream ended before a completion event/i,
  /upstream_stream_truncated/i,
  /stream ended before a (?:completion|terminal)/i,
  /ended without producing/i,
];

function isTruncationError(message: { stopReason?: string; errorMessage?: string }): boolean {
  if (message.stopReason !== "error") return false;
  const text = message.errorMessage;
  if (!text) return false;
  return TRUNCATION_PATTERNS.some((re) => re.test(text));
}

function backoffMs(attempt: number): number {
  const raw = BASE_MS * MULTIPLIER ** (attempt - 1);
  return Math.min(Math.round(raw), MAX_MS);
}

// Sleeps, but wakes early if the user aborts. Rejects on abort so the caller
// stops rather than continuing a run the user just cancelled.
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error("aborted"));
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const RETRY_PROMPT =
  "The previous response was cut off by the upstream provider before it finished streaming, " +
  "so that attempt produced no usable output. Please redo the last request in full.";

export default function (pi: ExtensionAPI) {
  // Consecutive truncations. Reset whenever a turn ends for any other reason.
  let consecutive = 0;
  // Set by turn_end, consumed by agent_settled.
  let pendingRetry = false;
  let gaveUpNoticeSent = false;

  function resetStreak() {
    consecutive = 0;
    pendingRetry = false;
    gaveUpNoticeSent = false;
  }

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as { stopReason?: string; errorMessage?: string };

    if (!isTruncationError(message)) {
      resetStreak();
      return;
    }

    if (consecutive >= MAX_ATTEMPTS) {
      // Budget spent. Leave `consecutive` at the cap rather than resetting, so a
      // persistent upstream outage cannot retry forever in batches of MAX_ATTEMPTS;
      // the streak clears on the next turn that ends for any other reason.
      if (!gaveUpNoticeSent) {
        gaveUpNoticeSent = true;
        ctx.ui?.notify?.(
          `Truncated stream ${MAX_ATTEMPTS}x in a row — giving up and surfacing the error.`,
          "error",
        );
      }
      return;
    }

    consecutive += 1;
    pendingRetry = true;
  });

  // agent_settled is the last point at which Pi has no automatic work left, so the
  // agent is idle and a fresh run can be started from a handler.
  pi.on("agent_settled", async (_event, ctx) => {
    if (!pendingRetry) return;
    // Consume regardless of outcome: a retry that never starts must not leave the
    // flag set, or the next unrelated settle would fire it.
    pendingRetry = false;

    const wait = backoffMs(consecutive);
    ctx.ui?.notify?.(
      `Upstream stream truncated. Retrying in ${wait}ms (attempt ${consecutive}/${MAX_ATTEMPTS}).`,
      "warning",
    );

    try {
      await sleep(wait, ctx.signal);
    } catch {
      // Aborted while waiting: drop the streak and let Pi settle.
      resetStreak();
      return;
    }

    // The agent may not be idle if something else queued work in the meantime.
    if (!ctx.isIdle()) {
      resetStreak();
      return;
    }

    try {
      pi.sendUserMessage(RETRY_PROMPT);
    } catch (err) {
      resetStreak();
      ctx.ui?.notify?.(
        `Truncated-stream retry could not start: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    }
  });

  pi.on("session_start", () => {
    resetStreak();
  });
}