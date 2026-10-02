import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionListQuery } from "../src/services/session-list.js";
import {
  buildSeekWhere,
  buildSessionFilterKey,
  buildSessionWhere,
  encodeNextCursor,
  invalidCursor,
  listSessionPage,
  resolvePageArgs,
} from "../src/services/session-list.js";

const prismaMock = vi.hoisted(() => ({
  practiceSession: {
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
}));

vi.mock("../src/lib/prisma.js", () => ({ prisma: prismaMock }));

const baseQuery = {
  q: undefined,
  status: "COMPLETED",
  instrument: undefined,
  annotationType: undefined,
  goalStatus: undefined,
  from: undefined,
  to: undefined,
  sortBy: "startedAt",
  sortOrder: "desc",
  cursor: undefined,
  limit: 3,
} as unknown as SessionListQuery;

function query(patch: Partial<SessionListQuery> = {}): SessionListQuery {
  return { ...baseQuery, ...patch } as SessionListQuery;
}

describe("buildSessionWhere 组合筛选", () => {
  it("乐器、问题类型、目标状态同时生效（AND）", () => {
    const where = buildSessionWhere("user-1", query({
      instrument: "小提琴",
      annotationType: "RHYTHM",
      goalStatus: "OPEN",
    }));
    expect(where).toMatchObject({
      userId: "user-1",
      status: "COMPLETED",
      instrument: { equals: "小提琴", mode: "insensitive" },
      annotations: { some: { type: "RHYTHM" } },
      goals: { some: { status: "OPEN" } },
    });
  });

  it("ALL 状态不下发 status 条件，并保留时间区间", () => {
    const from = new Date("2026-09-01T00:00:00Z");
    const to = new Date("2026-09-30T00:00:00Z");
    const where = buildSessionWhere("user-1", query({ status: "ALL", from, to }));
    expect(where).toMatchObject({
      userId: "user-1",
      startedAt: { gte: from, lte: to },
    });
    expect("status" in where).toBe(false);
  });
});

describe("游标编码", () => {
  const row = {
    id: "11111111-1111-4111-8111-111111111111",
    startedAt: new Date("2026-09-29T10:00:00Z"),
    updatedAt: new Date("2026-09-29T12:00:00Z"),
    actualDurationMs: 1_800_000n,
  };

  it("startedAt 游标携带排序值快照与筛选指纹，且为不透明 token", () => {
    const token = encodeNextCursor(query(), row);
    expect(token).not.toContain(row.id);
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    expect(payload).toMatchObject({
      v: 1,
      id: row.id,
      sortBy: "startedAt",
      sortOrder: "desc",
      startedAt: "2026-09-29T10:00:00.000Z",
    });
    expect(JSON.parse(payload.fp)).toMatchObject({ status: "COMPLETED", sortBy: "startedAt" });
  });

  it("annotationCount 游标不携带排序值快照", () => {
    const token = encodeNextCursor(query({ sortBy: "annotationCount" }), row);
    const payload = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
    expect(payload.sortBy).toBeUndefined();
    expect(payload.fp).toBeDefined();
  });
});

describe("resolvePageArgs 标量 keyset", () => {
  it("使用游标快照生成严格 keyset 条件，不查询锚点行", async () => {
    const token = encodeNextCursor(query(), {
      id: "11111111-1111-4111-8111-111111111111",
      startedAt: new Date("2026-09-29T10:00:00Z"),
      updatedAt: new Date("2026-09-29T12:00:00Z"),
      actualDurationMs: 1_800_000n,
    });
    const args = await resolvePageArgs("user-1", query({ cursor: token }));
    expect(args).toEqual({
      take: 4,
      where: {
        OR: [
          { startedAt: { lt: new Date("2026-09-29T10:00:00Z") } },
          { startedAt: new Date("2026-09-29T10:00:00Z"), id: { gt: "11111111-1111-4111-8111-111111111111" } },
        ],
      },
    });
    expect(prismaMock.practiceSession.findFirst).not.toHaveBeenCalled();
  });

  it("升序与 BigInt 时长排序方向正确", async () => {
    const token = encodeNextCursor(
      query({ sortBy: "actualDurationMs", sortOrder: "asc" }),
      {
        id: "22222222-2222-4222-8222-222222222222",
        startedAt: new Date(),
        updatedAt: new Date(),
        actualDurationMs: 600_000n,
      },
    );
    const args = await resolvePageArgs("user-1", query({ sortBy: "actualDurationMs", sortOrder: "asc", cursor: token }));
    expect(args.where).toEqual({
      OR: [
        { actualDurationMs: { gt: 600_000n } },
        { actualDurationMs: 600_000n, id: { gt: "22222222-2222-4222-8222-222222222222" } },
      ],
    });
  });

  it.each([
    "not-base64!",
    Buffer.from(JSON.stringify({ v: 1, id: "x" }), "utf8").toString("base64url"),
  ])("非法游标 %s 判定为 CURSOR_INVALID", async (token) => {
    await expect(resolvePageArgs("user-1", query({ cursor: token }))).rejects.toMatchObject({ code: "CURSOR_INVALID", statusCode: 400 });
  });

  it("筛选条件或排序变化导致指纹不一致时游标失效", async () => {
    const token = encodeNextCursor(query(), {
      id: "11111111-1111-4111-8111-111111111111",
      startedAt: new Date("2026-09-29T10:00:00Z"),
      updatedAt: new Date(),
      actualDurationMs: 0n,
    });
    await expect(resolvePageArgs("user-1", query({ instrument: "钢琴", cursor: token }))).rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(resolvePageArgs("user-1", query({ sortOrder: "asc", cursor: token }))).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });
});

describe("resolvePageArgs 计数排序", () => {
  beforeEach(() => vi.clearAllMocks());

  it("锚点仍属于该用户时走原生 cursor + skip 1", async () => {
    const token = encodeNextCursor(query({ sortBy: "annotationCount" }), {
      id: "33333333-3333-4333-8333-333333333333",
      startedAt: new Date(),
      updatedAt: new Date(),
      actualDurationMs: 0n,
    });
    prismaMock.practiceSession.findFirst.mockResolvedValueOnce({ id: "33333333-3333-4333-8333-333333333333" });
    const args = await resolvePageArgs("user-1", query({ sortBy: "annotationCount", cursor: token }));
    expect(args).toEqual({ take: 4, skip: 1, cursor: { id: "33333333-3333-4333-8333-333333333333" } });
    expect(prismaMock.practiceSession.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "33333333-3333-4333-8333-333333333333", userId: "user-1" },
    }));
  });

  it("锚点已被硬删除或不属于该用户时返回 CURSOR_INVALID 而不是 404/500", async () => {
    const token = encodeNextCursor(query({ sortBy: "annotationCount" }), {
      id: "44444444-4444-4444-8444-444444444444",
      startedAt: new Date(),
      updatedAt: new Date(),
      actualDurationMs: 0n,
    });
    prismaMock.practiceSession.findFirst.mockResolvedValueOnce(null);
    await expect(resolvePageArgs("user-1", query({ sortBy: "annotationCount", cursor: token }))).rejects.toMatchObject({ code: "CURSOR_INVALID" });
  });
});

interface FakeRow {
  id: string;
  userId: string;
  status: string;
  instrument: string;
  startedAt: Date;
  updatedAt: Date;
  actualDurationMs: bigint;
  annotationCount: number;
}

function makeRows(): FakeRow[] {
  // updatedAt desc, id asc 兜底；前两行 updatedAt 相同以验证同值不重复
  return [
    { id: "a0000000-0000-4000-8000-000000000001", userId: "u1", status: "COMPLETED", instrument: "小提琴", startedAt: new Date("2026-09-01T00:00:00Z"), updatedAt: new Date("2026-09-10T00:00:00Z"), actualDurationMs: 600_000n, annotationCount: 1 },
    { id: "a0000000-0000-4000-8000-000000000002", userId: "u1", status: "COMPLETED", instrument: "小提琴", startedAt: new Date("2026-09-02T00:00:00Z"), updatedAt: new Date("2026-09-10T00:00:00Z"), actualDurationMs: 900_000n, annotationCount: 2 },
    { id: "a0000000-0000-4000-8000-000000000003", userId: "u1", status: "COMPLETED", instrument: "钢琴", startedAt: new Date("2026-09-03T00:00:00Z"), updatedAt: new Date("2026-09-09T00:00:00Z"), actualDurationMs: 1_200_000n, annotationCount: 3 },
    { id: "a0000000-0000-4000-8000-000000000004", userId: "u1", status: "COMPLETED", instrument: "小提琴", startedAt: new Date("2026-09-04T00:00:00Z"), updatedAt: new Date("2026-09-08T00:00:00Z"), actualDurationMs: 1_500_000n, annotationCount: 0 },
    { id: "a0000000-0000-4000-8000-000000000005", userId: "u1", status: "COMPLETED", instrument: "小提琴", startedAt: new Date("2026-09-05T00:00:00Z"), updatedAt: new Date("2026-09-07T00:00:00Z"), actualDurationMs: 1_800_000n, annotationCount: 5 },
    { id: "a0000000-0000-4000-8000-000000000006", userId: "u2", status: "COMPLETED", instrument: "小提琴", startedAt: new Date("2026-09-06T00:00:00Z"), updatedAt: new Date("2026-09-11T00:00:00Z"), actualDurationMs: 2_100_000n, annotationCount: 6 },
  ];
}

function matchesWhere(row: FakeRow, where: ReturnType<typeof buildSessionWhere> | ReturnType<typeof buildSeekWhere>, userId = "u1"): boolean {
  if ("userId" in where && row.userId !== where.userId) return false;
  const entries = Object.entries(where as Record<string, unknown>).filter(([key]) => key !== "userId");
  return entries.every(([key, value]) => {
    if (key === "status") return row.status === value;
    if (key === "instrument") return row.instrument.toLowerCase() === String((value as { equals: string }).equals).toLowerCase();
    if (key === "OR") {
      const branches = value as Array<Record<string, unknown>>;
      return branches.some((branch) =>
        Object.entries(branch).every(([col, cond]) => {
          if (col === "id") return row.id > String((cond as { gt: string }).gt);
          const cell = row[col as keyof FakeRow];
          const c = cond as { lt?: unknown; gt?: unknown };
          if (c.lt !== undefined) return (cell as bigint | Date) < (c.lt as bigint | Date);
          if (c.gt !== undefined) return (cell as bigint | Date) > (c.gt as bigint | Date);
          return cell === cond;
        }),
      );
    }
    if (key === "AND") {
      return (value as unknown[]).every((part) => matchesWhere(row, part as Parameters<typeof matchesWhere>[1]));
    }
    return true;
  });
}

function sortRows(rows: FakeRow[], q: SessionListQuery): FakeRow[] {
  const direction = q.sortOrder === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const field = q.sortBy === "annotationCount" ? "annotationCount" : q.sortBy;
    const av = a[field as keyof FakeRow] as number | bigint | Date | string;
    const bv = b[field as keyof FakeRow] as number | bigint | Date | string;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return cmp * direction || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  });
}

async function walkPages(allRows: FakeRow[], q: SessionListQuery, mutateAfterFirstPage?: (rows: FakeRow[]) => void) {
  const baseWhere = buildSessionWhere("u1", q);
  const seen: string[] = [];
  let cursor: string | undefined;
  let page = 0;
  for (;;) {
    let working = allRows;
    if (mutateAfterFirstPage && page === 1) mutateAfterFirstPage(working);
    let rows = working.filter((row) => matchesWhere(row, baseWhere));
    let seekWhere: ReturnType<typeof buildSeekWhere> | undefined;
    if (cursor) {
      const args = await resolvePageArgs("u1", { ...q, cursor });
      if ("where" in args && args.where.OR) seekWhere = args.where as ReturnType<typeof buildSeekWhere>;
    }
    if (seekWhere) rows = rows.filter((row) => matchesWhere(row, seekWhere));
    rows = sortRows(rows, q).slice(0, q.limit);
    rows.forEach((row) => seen.push(row.id));
    const last = rows.at(-1);
    if (!last || rows.length < q.limit) break;
    cursor = encodeNextCursor(q, last);
    page += 1;
    if (page > 10) throw new Error("分页未终止");
  }
  return seen;
}

describe("完整翻页：跨页不重复", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updatedAt 排序完整遍历，相邻同值行与其他用户数据都不重不漏", async () => {
    const q = query({ sortBy: "updatedAt", sortOrder: "desc", limit: 2 });
    prismaMock.practiceSession.findFirst.mockRejectedValue(new Error("标量排序不应回查锚点"));
    const seen = await walkPages(makeRows(), q);
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toHaveLength(5);
    expect(seen).not.toContain("a0000000-0000-4000-8000-000000000006");
  });

  it("组合筛选（乐器 + 问题类型 + 目标状态）由 where 层保证 AND，指纹随筛选变化", () => {
    const a = buildSessionFilterKey(query({ instrument: "小提琴" }));
    const b = buildSessionFilterKey(query({ instrument: "小提琴", annotationType: "RHYTHM", goalStatus: "OPEN" }));
    expect(a).not.toEqual(b);
    expect(b.annotationType).toBe("RHYTHM");
    expect(b.goalStatus).toBe("OPEN");
  });
});

describe("完整翻页：归档导致总数变化也不跳项", () => {
  beforeEach(() => vi.clearAllMocks());

  it("第 1 页之后归档一个未读练习，其余未读练习仍全部出现且不重复", async () => {
    const q = query({ sortBy: "updatedAt", sortOrder: "desc", limit: 2 });
    prismaMock.practiceSession.findFirst.mockRejectedValue(new Error("标量排序不应回查锚点"));
    const rows = makeRows();
    // 模拟归档：未读项 id 005 被归档移出 COMPLETED 结果集（总数 5 -> 4）
    const seen = await walkPages(rows, q, (working) => {
      const target = working.find((row) => row.id.endsWith("005"));
      if (target) target.status = "ARCHIVED";
    });
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toContain("a0000000-0000-4000-8000-000000000003");
    expect(seen).toContain("a0000000-0000-4000-8000-000000000004");
    expect(seen).not.toContain("a0000000-0000-4000-8000-000000000005");
    // 第 1 页读过 001/002，剩余未读的 003/004 不能因为总数变化被跳过
    expect(seen).toHaveLength(4);
  });
});

describe("listSessionPage 装配", () => {
  beforeEach(() => vi.clearAllMocks());

  it("首页不附加游标条件，并截断多出的探测行", async () => {
    const row = (id: string) => ({
      id,
      startedAt: new Date("2026-09-01T00:00:00Z"),
      updatedAt: new Date("2026-09-01T00:00:00Z"),
      actualDurationMs: 600_000n,
    });
    prismaMock.practiceSession.findMany.mockResolvedValueOnce([row("a"), row("b"), row("c"), row("d")]);
    const result = await listSessionPage("u1", query({ limit: 3 }));
    expect(result.data.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(result.nextCursor).toBeTruthy();
    const call = prismaMock.practiceSession.findMany.mock.calls[0]![0];
    expect(call.where).toMatchObject({ userId: "u1" });
    expect(call.cursor).toBeUndefined();
    expect(call.take).toBe(4);
  });

  it("没有更多数据时 nextCursor 为 null", async () => {
    prismaMock.practiceSession.findMany.mockResolvedValueOnce([
      { id: "a", startedAt: new Date(), updatedAt: new Date(), actualDurationMs: 0n },
    ]);
    const result = await listSessionPage("u1", query({ limit: 3 }));
    expect(result.nextCursor).toBeNull();
  });
});

describe("invalidCursor", () => {
  it("错误体语义明确", () => {
    const error = invalidCursor();
    expect(error.statusCode).toBe(400);
    expect(error.code).toBe("CURSOR_INVALID");
  });
});
