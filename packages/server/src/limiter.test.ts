import { describe, expect, test } from "vitest";
import { clientKeyFrom, createLimiter } from "./limiter.js";

const setup = (over: { max?: number; windowMs?: number; maxKeys?: number } = {}) => {
  let t = 1_000;
  const limiter = createLimiter({ max: 3, windowMs: 1000, maxKeys: 100, now: () => t, ...over });
  return { limiter, advance: (ms: number) => (t += ms) };
};

describe("createLimiter", () => {
  test("allows up to max failures, then blocks with seconds to wait", () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) {
      expect(limiter.retryAfter("a")).toBeNull();
      limiter.count("a");
    }
    expect(limiter.retryAfter("a")).toBe(1);
  });

  test("keys are independent", () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) limiter.count("a");
    expect(limiter.retryAfter("a")).not.toBeNull();
    expect(limiter.retryAfter("b")).toBeNull();
  });

  test("unblocks once the window has passed", () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 3; i++) limiter.count("a");
    advance(999);
    expect(limiter.retryAfter("a")).toBe(1);
    advance(1);
    expect(limiter.retryAfter("a")).toBeNull();
    limiter.count("a");
    expect(limiter.retryAfter("a")).toBeNull();
  });

  test("rounds the wait up to whole seconds", () => {
    const { limiter, advance } = setup({ windowMs: 5000 });
    for (let i = 0; i < 3; i++) limiter.count("a");
    advance(1500);
    expect(limiter.retryAfter("a")).toBe(4);
  });

  test("drops expired entries and caps the number of tracked keys", () => {
    const { limiter, advance } = setup({ maxKeys: 3 });
    limiter.count("a");
    limiter.count("b");
    limiter.count("c");
    expect(limiter.size()).toBe(3);
    limiter.count("d");
    expect(limiter.size()).toBe(3);
    advance(1000);
    limiter.count("e");
    expect(limiter.size()).toBe(1);
  });
});

describe("limiter bounds", () => {
  test("never evicts a live entry: with the table full, an unseen key is allowed and a tracked blocked key stays blocked", () => {
    const { limiter, advance } = setup({ maxKeys: 2, max: 1 });
    limiter.count("a");
    limiter.count("b");
    expect(limiter.retryAfter("a")).toBe(1); // tracked and blocked
    expect(limiter.retryAfter("c")).toBeNull(); // fail open: a full table is not a lockout
    limiter.count("c");
    limiter.count("c");
    expect(limiter.size()).toBe(2);
    expect(limiter.retryAfter("c")).toBeNull(); // not tracked, so never blocked
    expect(limiter.retryAfter("a")).toBe(1); // tracked keys keep their own limits
    expect(limiter.retryAfter("b")).toBe(1);
    advance(1000);
    limiter.count("c"); // expired entries are purged, so c is tracked now
    expect(limiter.retryAfter("c")).toBe(1);
  });

  test("purges at most once per second of clock time", () => {
    const { limiter, advance } = setup({ maxKeys: 1, windowMs: 100, max: 1 });
    limiter.count("a");
    advance(100);
    limiter.count("b"); // first purge at this time: a is dropped
    expect(limiter.size()).toBe(1);
    expect(limiter.retryAfter("b")).not.toBeNull();
    advance(100); // b expired but the purge ran less than 1s ago
    limiter.count("c");
    expect(limiter.size()).toBe(1);
    expect(limiter.retryAfter("c")).toBeNull(); // c could not be tracked
    advance(1000);
    limiter.count("c");
    expect(limiter.retryAfter("c")).not.toBeNull();
  });

  test("keys are capped at 64 characters", () => {
    const { limiter } = setup({ max: 1 });
    limiter.count("x".repeat(64) + "1");
    expect(limiter.retryAfter("x".repeat(64) + "2")).not.toBeNull();
  });

  test("failures on other keys never block a key with no failures of its own", () => {
    const l = createLimiter({ now: () => 5_000 });
    for (let i = 0; i < 100; i++) l.count(`k${i}`);
    expect(l.retryAfter("unseen")).toBeNull();
  });
});

describe("clientKeyFrom", () => {
  test("with no trusted proxies only the socket address counts", () => {
    expect(clientKeyFrom("10.0.0.1", "6.6.6.6", 0)).toBe("10.0.0.1");
    expect(clientKeyFrom(undefined, "6.6.6.6", 0)).toBe("unknown");
  });
  test("the Nth entry from the right is used, a spoofed leftmost entry is ignored", () => {
    expect(clientKeyFrom("10.0.0.1", "6.6.6.6, 1.2.3.4", 1)).toBe("1.2.3.4");
    expect(clientKeyFrom("10.0.0.1", "6.6.6.6, 1.2.3.4, 10.1.1.1", 2)).toBe("1.2.3.4");
    expect(clientKeyFrom("10.0.0.1", " 1.2.3.4 ", 1)).toBe("1.2.3.4");
  });
  test("falls back to the socket address when the header is short or missing", () => {
    expect(clientKeyFrom("10.0.0.1", "1.2.3.4", 2)).toBe("10.0.0.1");
    expect(clientKeyFrom("10.0.0.1", undefined, 1)).toBe("10.0.0.1");
  });
  test("rejects garbage, oversized values and anything that is not an IP address", () => {
    expect(clientKeyFrom("10.0.0.1", "evil<script>", 1)).toBe("unknown");
    expect(clientKeyFrom("10.0.0.1", "a".repeat(46), 1)).toBe("unknown");
    expect(clientKeyFrom("10.0.0.1", "a".repeat(45), 1)).toBe("unknown");
    expect(clientKeyFrom("bad addr", undefined, 0)).toBe("unknown");
    expect(clientKeyFrom("10.0.0.1", ",", 1)).toBe("unknown");
    for (const v of ["1.2.3", "1.2.3.256", "1.2.3.4:", "1.2.3.4:99999", "1.2.3.4:x", "[1.2.3.4]", "::g", "1:2:3:4:5:6:7:8:9", "[::1", "::1]:80", "[::1]x", "fe80::1%", "", " "]) {
      expect(clientKeyFrom(v, undefined, 0), v).toBe("unknown");
    }
  });
});

describe("clientKeyFrom address normalisation", () => {
  const key = (v: string) => clientKeyFrom(v, undefined, 0);

  test("plain IPv4 is kept as it is", () => {
    expect(key("1.2.3.4")).toBe("1.2.3.4");
  });
  test("two IPv6 addresses in one /64 share a key", () => {
    expect(key("2001:db8:1:2:aaaa::1")).toBe("2001:db8:1:2::/64");
    expect(key("2001:db8:1:2:bbbb:cccc:dddd:eeee")).toBe(key("2001:db8:1:2:aaaa::1"));
    expect(key("2001:0DB8:0001:0002::9")).toBe("2001:db8:1:2::/64");
  });
  test("different /64s do not share a key", () => {
    expect(key("2001:db8:1:2::1")).not.toBe(key("2001:db8:1:3::1"));
    expect(key("2001:db8::1")).toBe("2001:db8:0:0::/64");
  });
  test("IPv4-mapped IPv6, dotted or hex, is the plain IPv4 address", () => {
    expect(key("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(key("::FFFF:102:304")).toBe("1.2.3.4");
    expect(key("0:0:0:0:0:ffff:0102:0304")).toBe("1.2.3.4");
    expect(key("[::ffff:1.2.3.4]:80")).toBe("1.2.3.4");
  });
  test("brackets, ports and zone ids are stripped", () => {
    expect(key("[::1]")).toBe("0:0:0:0::/64");
    expect(key("1.2.3.4:5678")).toBe("1.2.3.4");
    expect(key("[2001:db8::1]:443")).toBe("2001:db8:0:0::/64");
    expect(key("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(key("[fe80::1%25en0]:8080")).toBe("fe80:0:0:0::/64");
  });
  test("forwarded entries are normalised the same way", () => {
    expect(clientKeyFrom("10.0.0.1", "6.6.6.6, [2001:db8:5:6::7]:1234", 1)).toBe("2001:db8:5:6::/64");
    expect(clientKeyFrom("10.0.0.1", "6.6.6.6, 1.2.3.4:5678", 1)).toBe("1.2.3.4");
  });
});
