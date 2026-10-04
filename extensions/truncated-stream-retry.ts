// Retry turns that die from a truncated upstream stream.
//
// Pi's built-in retry (retry.* settings) only fires when the error text matches
// RETRYABLE_PROVIDER_ERROR_PATTERN in pi's src/ai/src/utils/retry.ts. That pattern
// covers "stream ended before message_stop" and "ended without", but NOT the
// truncation wording the billion-context ACP proxy emits:
//
//   "upstream stream ended before a completion event; this turn may be incomplete"
//
// So these failures surface to the user instead of being retried. This extension
// catches that wording at the turn_end boundary and retries with a backoff that
// grows per consecutive failure, resetting as soon as a turn succeeds.
//
// Behaviour (defaults, override via env):
//   RETRY_TRUNCATED_BASE_MS    first wait                      1000
//   RETRY_TRUNCATED_MAX_MS     ceiling on any single wait        30000
//   RETRY_TRUNCATED_MAX_ATTEMPTS retries per consecutive failure      5
//   RETRY_TRUNCATED_MULTIPLIER growth per failure                 1.5
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

// Signatures of a stream that died before its terminal event. Kept broad on
// purpose: all of these are the same class of failure (upstream cut the
// connection mid-response) and all are safe to retry, because the turn produced
// no usable output to preserve.
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

export default function (pi: ExtensionAPI) {
  // Consecutive failures. Reset on any successful turn.
  let consecutive = 0;
  // Emit the give-up notice once per streak, not on every subsequent failure.
  let gaveUpNoticeSent = false;

  pi.on("turn_end", async (event, ctx) => {
    const message = event.message as { stopReason?: string; errorMessage?: string };

    // A turn that ended for any other reason clears the streak: the backoff is
    // only meant to escalate across uninterrupted failures.
    if (!isTruncationError(message)) {
      consecutive = 0;
      gaveUpNoticeSent = false;
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
    const wait = backoffMs(consecutive);

    ctx.ui?.notify?.(
      `Upstream stream truncated. Retrying in ${wait}ms (attempt ${consecutive}/${MAX_ATTEMPTS}).`,
      "warn",
    );

    try {
      await sleep(wait, ctx.signal);
    } catch {
      // Aborted while waiting: drop the streak and let Pi settle.
      consecutive = 0;
      gaveUpNoticeSent = false;
      return;
    }

    // Retrying needs runnable model context. After a failed turn the last
    // message is the assistant error message, and Pi refuses a continuation
    // whose final role is "assistant". Chaining a custom_message entry appends
    // a user-role message (custom messages convert to role "user"), which makes
    // the boundary continuable.
    const marker = `The previous attempt's response stream was truncated upstream before completion, so that turn produced no usable output. Retry the request from where it left off. This is attempt ${consecutive} of at most ${MAX_ATTEMPTS}.`;

    return {
      entries: [
        ...(event.entries ?? []),
        {
          type: "custom_message" as const,
          customType: "truncated-stream-retry",
          content: marker,
          // Keep it out of the transcript UI; it is plumbing, not conversation.
          display: false,
        },
      ],
      continue: true,
    };
  });

  // Clear the streak when a session is reloaded or switched.
  pi.on("session_start", () => {
    consecutive = 0;
    gaveUpNoticeSent = false;
  });
}