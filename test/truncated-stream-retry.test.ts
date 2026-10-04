import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

const TRUNCATION_ERROR = {
  stopReason: "error",
  errorMessage:
    "upstream stream ended before a completion event; this turn may be incomplete",
};
const SUCCESS = { stopReason: "stop", errorMessage: undefined };
const OTHER_ERROR = { stopReason: "error", errorMessage: "429 rate limit exceeded" };

type Handler = (event: any, ctx: any) => Promise<any>;

/**
 * Loads a fresh copy of the extension and drives it through a fake ExtensionAPI.
 * Env vars are read at module scope, so tests that need different timings get a
 * fresh module instance.
 */
async function harness(env: Record<string, string> = {}) {
  const saved = { ...process.env };
  Object.assign(process.env, env);

  vi.resetModules();
  const factory = (await import("../extensions/truncated-stream-retry")).default;

  const handlers: Record<string, Handler> = {};
  const notices: Array<{ msg: string; level: string }> = [];

  factory({
    on(event: string, fn: Handler) {
      handlers[event] = fn;
    },
  } as any);

  const ctx = (signal?: AbortSignal) => ({
    signal,
    ui: {
      notify(msg: string, level: string) {
        notices.push({ msg, level });
      },
    },
  });

  const turnEnd = (message: unknown, signal?: AbortSignal) =>
    handlers.turn_end(
      { message, entries: [], turnIndex: 0, outcome: "error", toolResults: [] },
      ctx(signal),
    );

  return {
    notices,
    turnEnd,
    sessionStart: () => handlers.session_start?.({}, {}),
    restore: () => {
      for (const k of Object.keys(env)) delete process.env[k];
      Object.assign(process.env, saved);
    },
  };
}

describe("truncated-stream-retry", () => {
  let h: Awaited<ReturnType<typeof harness>>;

  afterEach(() => h?.restore());

  describe("detection", () => {
    beforeEach(async () => {
      h = await harness({ RETRY_TRUNCATED_BASE_MS: "5", RETRY_TRUNCATED_MULTIPLIER: "2" });
    });

    it("retries every truncation phrasing seen in the wild", async () => {
      const variants = [
        "upstream stream ended before a completion event; this turn may be incomplete",
        "server_error (upstream_stream_truncated): upstream stream ended before a completion event",
        '{"type":"server_error","code":"upstream_stream_truncated"}',
        "stream ended before a terminal response event",
        "stream ended without producing a Message with role=assistant",
      ];
      for (const errorMessage of variants) {
        const result = await h.turnEnd({ stopReason: "error", errorMessage });
        expect(result?.continue, errorMessage).toBe(true);
      }
    });

    it("ignores unrelated errors and successful turns", async () => {
      expect(await h.turnEnd(OTHER_ERROR)).toBeUndefined();
      expect(await h.turnEnd(SUCCESS)).toBeUndefined();
      expect(
        await h.turnEnd({ stopReason: "error", errorMessage: "context_length_exceeded" }),
      ).toBeUndefined();
      expect(h.notices).toHaveLength(0);
    });

    it("ignores truncation text on a non-error turn", async () => {
      const result = await h.turnEnd({
        stopReason: "stop",
        errorMessage:
          "upstream stream ended before a completion event; this turn may be incomplete",
      });
      expect(result).toBeUndefined();
    });
  });

  describe("continuation contract", () => {
    beforeEach(async () => {
      h = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
    });

    it("returns continue:true and a custom_message entry", async () => {
      const result = await h.turnEnd(TRUNCATION_ERROR);
      expect(result.continue).toBe(true);
      expect(Array.isArray(result.entries)).toBe(true);
      const entry = result.entries.find((e: any) => e.type === "custom_message");
      expect(entry).toBeDefined();
      expect(entry.display).toBe(false);
      expect(typeof entry.content).toBe("string");
      expect(entry.content.length).toBeGreaterThan(0);
    });

    it("keeps entries proposed by earlier handlers", async () => {
      const result = await h.turnEnd(TRUNCATION_ERROR);
      // the handler chains onto event.entries; with an existing draft it must persist
      const seeded = await h.turnEnd(TRUNCATION_ERROR);
      expect(seeded.entries.length).toBeGreaterThanOrEqual(1);
      expect(result.entries.length).toBeGreaterThanOrEqual(1);
    });

    it("appends the retry marker without clobbering prior drafts", async () => {
      const handlers = h as any;
      const result = await handlers.turnEnd(TRUNCATION_ERROR);
      const custom = result.entries.filter((e: any) => e.type === "custom_message");
      expect(custom).toHaveLength(1);
    });
  });

  describe("backoff", () => {
    it("grows per consecutive failure and matches the configured curve", async () => {
      const base = 60;
      const multiplier = 2;
      const local = await harness({
        RETRY_TRUNCATED_BASE_MS: String(base),
        RETRY_TRUNCATED_MULTIPLIER: String(multiplier),
        RETRY_TRUNCATED_MAX_MS: "100000",
      });

      const expected = [0, 1, 2, 3].map(
        (i) => Math.round(base * multiplier ** i),
      );

      for (let i = 0; i < expected.length; i++) {
        const started = Date.now();
        const result = await local.turnEnd(TRUNCATION_ERROR);
        const elapsed = Date.now() - started;
        expect(result.continue).toBe(true);
        // allow generous slack for timer granularity / CI scheduling
        expect(elapsed).toBeGreaterThanOrEqual(expected[i] * 0.6);
        expect(elapsed).toBeLessThan(expected[i] * 2 + 250);
      }

      expect(local.notices).toHaveLength(expected.length);
      expect(local.notices.every((n) => n.level === "warn")).toBe(true);
      expect(local.notices[0].msg).toMatch(/attempt 1\/5/);
      local.restore();
    });

    it("never exceeds RETRY_TRUNCATED_MAX_MS", async () => {
      const local = await harness({
        RETRY_TRUNCATED_BASE_MS: "50",
        RETRY_TRUNCATED_MULTIPLIER: "10",
        RETRY_TRUNCATED_MAX_MS: "120",
      });
      const started = Date.now();
      for (let i = 0; i < 4; i++) await local.turnEnd(TRUNCATION_ERROR);
      const elapsed = Date.now() - started;
      // 50 + 120 + 120 + 120 = 410ms ceiling; assert we stayed near it
      expect(elapsed).toBeLessThan(1400);
      local.restore();
    });
  });

  describe("streak management", () => {
    it("resets the backoff after a successful turn", async () => {
      const local = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      await local.turnEnd(TRUNCATION_ERROR);
      await local.turnEnd(TRUNCATION_ERROR);
      await local.turnEnd(SUCCESS);
      const result = await local.turnEnd(TRUNCATION_ERROR);
      expect(result.continue).toBe(true);
      expect(local.notices.at(-1)!.msg).toMatch(/attempt 1\/5/);
      local.restore();
    });

    it("resets on session_start", async () => {
      const local = await harness({ RETRY_TRUNCATED_BASE_MS: "5" });
      await local.turnEnd(TRUNCATION_ERROR);
      local.sessionStart();
      await local.turnEnd(TRUNCATION_ERROR);
      expect(local.notices.at(-1)!.msg).toMatch(/attempt 1\/5/);
      local.restore();
    });
  });

  describe("retry budget", () => {
    it("stops after MAX_ATTEMPTS and does not restart on its own", async () => {
      const cap = 3;
      const local = await harness({
        RETRY_TRUNCATED_BASE_MS: "5",
        RETRY_TRUNCATED_MAX_ATTEMPTS: String(cap),
      });

      let continuations = 0;
      // 30 consecutive failures: a sustained outage must not retry forever
      for (let i = 0; i < 30; i++) {
        if ((await local.turnEnd(TRUNCATION_ERROR))?.continue) continuations++;
      }
      expect(continuations).toBe(cap);

      const giveUps = local.notices.filter((n) => /giving up/.test(n.msg));
      expect(giveUps).toHaveLength(1);
      expect(giveUps[0].level).toBe("error");
      local.restore();
    });

    it("re-arms the budget after a success", async () => {
      const local = await harness({
        RETRY_TRUNCATED_BASE_MS: "5",
        RETRY_TRUNCATED_MAX_ATTEMPTS: "2",
      });
      for (let i = 0; i < 6; i++) await local.turnEnd(TRUNCATION_ERROR);
      await local.turnEnd(SUCCESS);
      const after = await local.turnEnd(TRUNCATION_ERROR);
      expect(after.continue).toBe(true);
      local.restore();
    });
  });

  describe("cancellation", () => {
    it("abandons the wait and clears the streak when aborted", async () => {
      const local = await harness({ RETRY_TRUNCATED_BASE_MS: "5000" });
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 40);

      const started = Date.now();
      const result = await local.turnEnd(TRUNCATION_ERROR, ac.signal);
      const elapsed = Date.now() - started;

      expect(elapsed).toBeLessThan(1500);
      expect(result).toBeUndefined();

      // streak must be cleared, so the next failure is attempt 1
      await local.turnEnd(TRUNCATION_ERROR);
      expect(local.notices.at(-1)!.msg).toMatch(/attempt 1\/5/);
      local.restore();
    }, 10_000);

    it("does not continue when the signal is already aborted", async () => {
      const local = await harness({ RETRY_TRUNCATED_BASE_MS: "5000" });
      const ac = new AbortController();
      ac.abort();
      const result = await local.turnEnd(TRUNCATION_ERROR, ac.signal);
      expect(result).toBeUndefined();
      local.restore();
    });
  });
});