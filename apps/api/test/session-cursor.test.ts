import { describe, expect, it } from "vitest";
import {
  buildSessionKeysetWhere,
  decodeSessionCursor,
  encodeSessionCursor,
  InvalidCursorError,
} from "../src/services/session-cursor.js";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

describe("session cursor encoding", () => {
  it("round-trips date sort values", () => {
    const date = new Date("2026-09-30T10:00:00.000Z");
    const token = encodeSessionCursor({ sortBy: "startedAt", sortValue: date, id: ID_A });
    const decoded = decodeSessionCursor(token);
    expect(decoded.sortBy).toBe("startedAt");
    expect(decoded.v).toBe("2026-09-30T10:00:00.000Z");
    expect(decoded.id).toBe(ID_A);
  });

  it("round-trips BigInt duration values as numbers", () => {
    const token = encodeSessionCursor({ sortBy: "actualDurationMs", sortValue: 1_800_000n, id: ID_A });
    const decoded = decodeSessionCursor(token);
    expect(decoded.v).toBe(1_800_000);
  });

  it("round-trips annotation counts", () => {
    const token = encodeSessionCursor({ sortBy: "annotationCount", sortValue: 3, id: ID_A });
    expect(decodeSessionCursor(token).v).toBe(3);
  });
});

describe("decodeSessionCursor validation", () => {
  it("rejects garbage tokens", () => {
    expect(() => decodeSessionCursor("not-base64!!")).toThrow(InvalidCursorError);
  });

  it("rejects malformed json payloads", () => {
    const token = Buffer.from(JSON.stringify({ sortBy: "startedAt" }), "utf8").toString("base64url");
    expect(() => decodeSessionCursor(token)).toThrow(InvalidCursorError);
  });

  it("rejects unknown sort fields and non-uuid ids", () => {
    const payload = Buffer.from(
      JSON.stringify({ sortBy: "title", v: "2026-01-01T00:00:00.000Z", id: ID_A }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeSessionCursor(payload)).toThrow(InvalidCursorError);

    const badId = Buffer.from(
      JSON.stringify({ sortBy: "startedAt", v: "2026-01-01T00:00:00.000Z", id: "nope" }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeSessionCursor(badId)).toThrow(InvalidCursorError);
  });

  it("rejects counts that are not non-negative integers", () => {
    const token = Buffer.from(
      JSON.stringify({ sortBy: "annotationCount", v: 1.5, id: ID_A }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeSessionCursor(token)).toThrow(InvalidCursorError);
  });

  it("rejects unparseable dates", () => {
    const token = Buffer.from(
      JSON.stringify({ sortBy: "startedAt", v: "not-a-date", id: ID_A }),
      "utf8",
    ).toString("base64url");
    expect(() => decodeSessionCursor(token)).toThrow(InvalidCursorError);
  });
});

describe("buildSessionKeysetWhere", () => {
  it("builds strict before-or-equal predicates for desc time sort", () => {
    const token = encodeSessionCursor({
      sortBy: "startedAt",
      sortValue: new Date("2026-09-30T10:00:00.000Z"),
      id: ID_A,
    });
    const where = buildSessionKeysetWhere("startedAt", "desc", token);
    expect(where).toEqual({
      OR: [
        { startedAt: { lt: new Date("2026-09-30T10:00:00.000Z") } },
        { startedAt: new Date("2026-09-30T10:00:00.000Z"), id: { lt: ID_A } },
      ],
    });
  });

  it("builds strict after predicates for asc time sort", () => {
    const token = encodeSessionCursor({
      sortBy: "startedAt",
      sortValue: new Date("2026-09-30T10:00:00.000Z"),
      id: ID_A,
    });
    const where = buildSessionKeysetWhere("startedAt", "asc", token);
    expect(where).toEqual({
      OR: [
        { startedAt: { gt: new Date("2026-09-30T10:00:00.000Z") } },
        { startedAt: new Date("2026-09-30T10:00:00.000Z"), id: { gt: ID_A } },
      ],
    });
  });

  it("keysets on annotation count with an id tiebreaker", () => {
    const token = encodeSessionCursor({ sortBy: "annotationCount", sortValue: 2, id: ID_B });
    const where = buildSessionKeysetWhere("annotationCount", "desc", token);
    expect(where).toEqual({
      OR: [
        { _count: { annotations: { lt: 2 } } },
        { _count: { annotations: { equals: 2 } }, id: { lt: ID_B } },
      ],
    });
  });

  it("keysets on duration and updatedAt", () => {
    const durationToken = encodeSessionCursor({ sortBy: "actualDurationMs", sortValue: 600_000, id: ID_A });
    expect(buildSessionKeysetWhere("actualDurationMs", "asc", durationToken)).toEqual({
      OR: [
        { actualDurationMs: { gt: 600_000 } },
        { actualDurationMs: 600_000, id: { gt: ID_A } },
      ],
    });

    const updatedToken = encodeSessionCursor({
      sortBy: "updatedAt",
      sortValue: new Date("2026-10-01T00:00:00.000Z"),
      id: ID_A,
    });
    expect(buildSessionKeysetWhere("updatedAt", "desc", updatedToken)).toEqual({
      OR: [
        { updatedAt: { lt: new Date("2026-10-01T00:00:00.000Z") } },
        { updatedAt: new Date("2026-10-01T00:00:00.000Z"), id: { lt: ID_A } },
      ],
    });
  });

  it("rejects a cursor whose sort field differs from the query", () => {
    const token = encodeSessionCursor({ sortBy: "startedAt", sortValue: new Date(), id: ID_A });
    expect(() => buildSessionKeysetWhere("updatedAt", "desc", token)).toThrow(InvalidCursorError);
  });

  it("predicate never references the boundary row identity, so archiving it cannot skip items", () => {
    // 这是“归档导致总数变化也不跳项”的关键：谓词只含值比较与 id 次序，
    // 不要求边界行存在；边界行消失后，相等分支里的其它同值行仍可被取到。
    const token = encodeSessionCursor({ sortBy: "startedAt", sortValue: new Date(), id: ID_A });
    const where = buildSessionKeysetWhere("startedAt", "desc", token) as { OR: unknown[] };
    expect(where.OR).toHaveLength(2);
    expect(JSON.stringify(where)).not.toContain("cursor");
  });
});
