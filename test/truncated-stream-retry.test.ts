import { describe, expect, it, vi } from "vitest";

const TRUNCATION_ERROR = {
  stopReason: "error",
  errorMessage:
    "upstream stream ended before a completion event; this turn may be incomplete",
};
const SUCCESS = { stopReason: "stop", errorMessage: undefined };
const OTHER_ERROR = { stopReason: "error", errorMessage: "429 rate limit exceeded" };

/**
 * Loads a fresh copy of the extension and drives it through a fake ExtensionAPI.
 * Env vars are read at module scope, so each harness gets a fresh instance.
 */
async function harness(env: Record<string, string> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);

  vi.resetModules();
  const factory = (await import("../extensions/truncated-stream-retry")).default;

  const handlers: Record<string, any> = {};
  const notices: Array<{ msg: string; level: string }> = [];
  const sent: string[] = [];
  let sendThrows: Error | null = null;

  factory({
    on(event: string, fn: any) {
      handlers[event] = fn;
    },
    sendUserMessage(content: string) {
      if (sendThrows) throw sendThrows;
      sent.push(content);
    },
  } as any);

  let idle = true;
  const ctx = (signal?: AbortSignal) => ({
    signal,
    isIdle: () => idle,
    ui: {
      notify(msg: string, level: string) {
        notices.push({ msg, level });
      },
    },
  });

  return {
    notices,
    sent,
    setIdle(v: boolean) {
      idle = v;
    },
    throwOnSend(err: Error) {
      sendThrows = err;
    },
    turnEnd: (message: unknown, signal?: AbortSignal) =>
      handlers.turn_end({ message, entries: [] }, ctx(signal)),
    settled: (signal?: AbortSignal) => handlers.agent_settled({}, ctx(signal)),
    sessionStart: () => handlers.session_start?.({}, {}),
    restore: () => {
      for (const k of Object.keys(env)) delete process.env[k];
      Object.assign(process.env, saved);
    },
  };
}

describe("truncated-stream-retry", () => {
  describe("detection", () => {
    it("retries every truncation phrasing seen in the wild", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      const variants = [
        "upstream stream ended before a completion event; this turn may be incomplete",
        "server_error (upstream_stream_truncated): upstream stream ended before a completion event",
        '{"type":"server_error","code":"upstream_stream_truncated"}',
        "stream ended before a terminal response event",
        "stream ended without producing a Message with role=assistant",
      ];
      for (const errorMessage of variants) {
        const before = h.sent.length;
        await h.turnEnd({ stopReason: "error", errorMessage });
        await h.settled();
        expect(h.sent.length, errorMessage).toBe(before + 1);
      }
      expect(h.sent.length).toBe(variants.length);
      h.restore();
    });

    it("ignores unrelated errors and successful turns", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      await h.turnEnd(OTHER_ERROR);
      await h.settled();
      await h.turnEnd(SUCCESS);
      await h.settled();
      await h.turnEnd({ stopReason: "error", errorMessage: "context_length_exceeded" });
      await h.settled();
      expect(h.sent).toHaveLength(0);
      expect(h.notices).toHaveLength(0);
      h.restore();
    });

    it("ignores truncation text on a non-error turn", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      await h.turnEnd({ stopReason: "stop", errorMessage: TRUNCATION_ERROR.errorMessage });
      await h.settled();
      expect(h.sent).toHaveLength(0);
      h.restore();
    });
  });

  describe("retry mechanism", () => {
    it("sends exactly one user message per truncation, at settle time", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      await h.turnEnd(TRUNCATION_ERROR);
      // nothing sent before settle
      expect(h.sent).toHaveLength(0);
      await h.settled();
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatch(/cut off by the upstream provider/i);
      h.restore();
    });

    it("does not send again on a settle with no fresh truncation", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      await h.turnEnd(TRUNCATION_ERROR);
      await h.settled();
      await h.settled();
      await h.settled();
      expect(h.sent).toHaveLength(1);
      h.restore();
    });

    it("skips the retry if the agent is no longer idle", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      await h.turnEnd(TRUNCATION_ERROR);
      h.setIdle(false);
      await h.settled();
      expect(h.sent).toHaveLength(0);
      h.restore();
    });

    it("reports and recovers when sendUserMessage throws", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      h.throwOnSend(new Error("runtime.sendUserMessage: not initialized"));
      await h.turnEnd(TRUNCATION_ERROR);
      await expect(h.settled()).resolves.toBeUndefined();
      expect(h.sent).toHaveLength(0);
      expect(h.notices.some((n) => /could not start/.test(n.msg))).toBe(true);
      h.restore();
    });
  });

  describe("backoff", () => {
    it("grows per consecutive failure and matches the configured curve", async () => {
      const base = 60;
      const mult = 2;
      const h = await harness({
        RETRY_TRUNCATED_BASE_MS: String(base),
        RETRY_TRUNCATED_MULTIPLIER: String(mult),
        RETRY_TRUNCATED_MAX_MS: "100000",
      });
      const expected = [0, 1, 2, 3].map((i) => Math.round(base * mult ** i));

      for (let i = 0; i < expected.length; i++) {
        const started = Date.now();
        await h.turnEnd(TRUNCATION_ERROR);
        await h.settled();
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(expected[i] * 0.6);
        expect(elapsed).toBeLessThan(expected[i] * 2 + 250);
      }

      expect(h.sent).toHaveLength(expected.length);
      expect(h.notices.every((n) => n.level === "warning")).toBe(true);
      expect(h.notices[0].msg).toMatch(/attempt 1\/5/);
      h.restore();
    });
  });

  describe("streak management", () => {
    it("resets the backoff after a successful turn", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      await h.turnEnd(TRUNCATION_ERROR);
      await h.settled();
      await h.turnEnd(TRUNCATION_ERROR);
      await h.turnEnd(SUCCESS);
      await h.turnEnd(TRUNCATION_ERROR);
      await h.settled();
      expect(h.notices.at(-1)!.msg).toMatch(/attempt 1\/5/);
      h.restore();
    });

    it("resets on session_start", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      await h.turnEnd(TRUNCATION_ERROR);
      h.sessionStart();
      await h.settled();
      // pendingRetry was cleared by session_start, so nothing fires
      expect(h.sent).toHaveLength(0);
      h.restore();
    });
  });

  describe("retry budget", () => {
    it("stops after MAX_ATTEMPTS and does not restart on its own", async () => {
      const cap = 3;
      const h = await harness({
        RETRY_TRUNCATED_BASE_MS: "5",
        RETRY_TRUNCATED_MAX_ATTEMPTS: String(cap),
      });

      // 30 consecutive truncations: a sustained outage must not retry forever
      for (let i = 0; i < 30; i++) {
        await h.turnEnd(TRUNCATION_ERROR);
        await h.settled();
      }
      expect(h.sent).toHaveLength(cap);

      const giveUps = h.notices.filter((n) => /giving up/.test(n.msg));
      expect(giveUps).toHaveLength(1);
      expect(giveUps[0].level).toBe("error");
      h.restore();
    });

    it("re-arms the budget after a success", async () => {
      const h = await harness({
        RETRY_TRUNCATED_BASE_MS: "5",
        RETRY_TRUNCATED_MAX_ATTEMPTS: "2",
      });
      for (let i = 0; i < 6; i++) {
        await h.turnEnd(TRUNCATION_ERROR);
        await h.settled();
      }
      expect(h.sent).toHaveLength(2);
      await h.turnEnd(SUCCESS);
      await h.turnEnd(TRUNCATION_ERROR);
      await h.settled();
      expect(h.sent).toHaveLength(3);
      h.restore();
    });
  });

  describe("cancellation", () => {
    it("abandons the wait when aborted", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5000" });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 40);

      const started = Date.now();
      await h.turnEnd(TRUNCATION_ERROR);
      await h.settled(ac.signal);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1500);
      expect(h.sent).toHaveLength(0);
      h.restore();
    }, 10_000);

    it("does not send when the signal is already aborted", async () => {
      const h = await harness({ RETRY_TRUNCATED_BASE_MS: "5000" });
      const ac = new AbortController();
      ac.abort();
      await h.turnEnd(TRUNCATION_ERROR);
      await h.settled(ac.signal);
      expect(h.sent).toHaveLength(0);
      h.restore();
    });
  });
});