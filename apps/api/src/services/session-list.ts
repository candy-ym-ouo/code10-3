import { Prisma, SessionStatus } from "@prisma/client";
import type { z } from "zod";
import type { sessionListQuerySchema } from "@practice/contracts";
import { AppError } from "../lib/errors.js";
import { prisma } from "../lib/prisma.js";

export type SessionListQuery = z.infer<typeof sessionListQuerySchema>;
export type SessionSortBy = SessionListQuery["sortBy"];
export type SessionSortOrder = SessionListQuery["sortOrder"];

const SCALAR_SORT_FIELDS = ["startedAt", "actualDurationMs", "updatedAt"] as const;
type ScalarSortField = (typeof SCALAR_SORT_FIELDS)[number];

function isScalarSortField(value: SessionSortBy): value is ScalarSortField {
  return (SCALAR_SORT_FIELDS as readonly string[]).includes(value);
}

/**
 * 参与分页的筛选维度。游标会绑定这份指纹：
 * 换了筛选或排序再用旧游标，直接判定为失效而不是悄悄漏项/重项。
 */
export interface SessionFilterKey {
  status: string;
  instrument: string;
  annotationType: string;
  goalStatus: string;
  q: string;
  from: string;
  to: string;
  sortBy: string;
  sortOrder: string;
}

export function buildSessionFilterKey(query: SessionListQuery): SessionFilterKey {
  return {
    status: query.status,
    instrument: query.instrument?.trim().toLowerCase() ?? "",
    annotationType: query.annotationType ?? "",
    goalStatus: query.goalStatus ?? "",
    q: query.q?.trim().toLowerCase() ?? "",
    from: query.from ? query.from.toISOString() : "",
    to: query.to ? query.to.toISOString() : "",
    sortBy: query.sortBy,
    sortOrder: query.sortOrder,
  };
}

/** 组合筛选：乐器、问题类型、目标状态以及其它条件必须同时成立（AND）。 */
export function buildSessionWhere(userId: string, query: SessionListQuery): Prisma.PracticeSessionWhereInput {
  return {
    userId,
    ...(query.status !== "ALL" ? { status: query.status as SessionStatus } : {}),
    ...(query.instrument ? { instrument: { equals: query.instrument, mode: "insensitive" } } : {}),
    ...(query.from || query.to
      ? {
          startedAt: {
            ...(query.from ? { gte: query.from } : {}),
            ...(query.to ? { lte: query.to } : {}),
          },
        }
      : {}),
    ...(query.q
      ? {
          OR: [
            { title: { contains: query.q, mode: "insensitive" } },
            { instrument: { contains: query.q, mode: "insensitive" } },
            { focus: { contains: query.q, mode: "insensitive" } },
            { notes: { contains: query.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(query.annotationType ? { annotations: { some: { type: query.annotationType } } } : {}),
    ...(query.goalStatus ? { goals: { some: { status: query.goalStatus } } } : {}),
  };
}

interface CursorPayload {
  v: 1;
  id: string;
  fp: string;
  // 排序字段快照；annotationCount 排序时只有 id + fp，走原生 cursor
  sortBy?: SessionSortBy;
  sortOrder?: SessionSortOrder;
  startedAt?: string;
  updatedAt?: string;
  duration?: string;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function decodeCursor(token: string): CursorPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    throw invalidCursor();
  }
  if (typeof raw !== "object" || raw === null) throw invalidCursor();
  const payload = raw as Partial<CursorPayload>;
  if (
    payload.v !== 1 ||
    typeof payload.id !== "string" ||
    !UUID_RE.test(payload.id) ||
    typeof payload.fp !== "string"
  ) {
    throw invalidCursor();
  }
  return payload as CursorPayload;
}

export function invalidCursor(): AppError {
  return new AppError(400, "CURSOR_INVALID", "分页游标已失效，请回到第一页后重新浏览");
}

/**
 * 标量排序的 keyset 条件。排序方向决定严格不等号方向，id 恒定升序兜底，
 * 因此排序值相同的相邻两行不会在两页之间重复出现。
 */
export function buildSeekWhere(
  sortBy: ScalarSortField,
  sortOrder: SessionSortOrder,
  snapshot: { sortValue: string; id: string },
): Prisma.PracticeSessionWhereInput {
  const value =
    sortBy === "actualDurationMs" ? BigInt(snapshot.sortValue) : new Date(snapshot.sortValue);
  const order: Prisma.SortOrder = sortOrder === "asc" ? "asc" : "desc";
  return {
    OR: [
      { [sortBy]: { ...(order === "asc" ? { gt: value } : { lt: value }) } },
      { [sortBy]: value, id: { gt: snapshot.id } },
    ],
  };
}

interface PageArgs {
  where?: Prisma.PracticeSessionWhereInput;
  take: number;
  skip?: number;
  cursor?: Prisma.PracticeSessionWhereUniqueInput;
}

/**
 * 解析游标：
 * - 指纹不一致（换了筛选/排序）→ 失效
 * - 标量排序 → 使用游标中的排序值快照做 keyset，归档把 updatedAt 顶到最新也不会跳项
 * - annotationCount 排序 → 计数无法快照，退回原生 id cursor；游标行必须仍属于该用户，
 *   被硬删除时返回失效，而不是抛出 500
 */
export async function resolvePageArgs(
  userId: string,
  query: SessionListQuery,
): Promise<PageArgs> {
  const take = query.limit + 1;
  if (!query.cursor) return { take };

  const payload = decodeCursor(query.cursor);
  const currentFingerprint = JSON.stringify(buildSessionFilterKey(query));
  if (payload.fp !== currentFingerprint) throw invalidCursor();

  if (isScalarSortField(query.sortBy)) {
    if (payload.sortBy !== query.sortBy || payload.sortOrder !== query.sortOrder) throw invalidCursor();
    const sortValue = query.sortBy === "actualDurationMs" ? payload.duration : payload[query.sortBy];
    if (typeof sortValue !== "string") throw invalidCursor();
    if (query.sortBy === "actualDurationMs") {
      if (!/^\d+$/.test(sortValue)) throw invalidCursor();
    } else if (Number.isNaN(new Date(sortValue).getTime())) {
      throw invalidCursor();
    }
    return { where: buildSeekWhere(query.sortBy, query.sortOrder, { sortValue, id: payload.id }), take };
  }

  const anchor = await prisma.practiceSession.findFirst({
    where: { id: payload.id, userId },
    select: { id: true },
  });
  if (!anchor) throw invalidCursor();
  return { take, skip: 1, cursor: { id: anchor.id } };
}

export function encodeNextCursor(query: SessionListQuery, row: { id: string; startedAt: Date; updatedAt: Date; actualDurationMs: bigint }): string {
  const base: CursorPayload = { v: 1, id: row.id, fp: JSON.stringify(buildSessionFilterKey(query)) };
  if (query.sortBy === "startedAt") {
    base.sortBy = "startedAt";
    base.sortOrder = query.sortOrder;
    base.startedAt = row.startedAt.toISOString();
  } else if (query.sortBy === "updatedAt") {
    base.sortBy = "updatedAt";
    base.sortOrder = query.sortOrder;
    base.updatedAt = row.updatedAt.toISOString();
  } else if (query.sortBy === "actualDurationMs") {
    base.sortBy = "actualDurationMs";
    base.sortOrder = query.sortOrder;
    base.duration = row.actualDurationMs.toString();
  }
  // annotationCount：无排序值快照，仅绑定 id 与指纹
  return encodeCursor(base);
}

export async function listSessionPage(userId: string, query: SessionListQuery) {
  const where = buildSessionWhere(userId, query);
  const page = await resolvePageArgs(userId, query);

  const orderBy: Prisma.PracticeSessionOrderByWithRelationInput =
    query.sortBy === "annotationCount"
      ? { annotations: { _count: query.sortOrder } }
      : { [query.sortBy]: query.sortOrder };

  const rows = await prisma.practiceSession.findMany({
    where: page.where?.OR ? { AND: [where, page.where] } : where,
    take: page.take,
    ...(page.skip !== undefined ? { skip: page.skip } : {}),
    ...(page.cursor ? { cursor: page.cursor } : {}),
    orderBy: [orderBy, { id: "asc" }],
    include: {
      _count: { select: { mediaAssets: true, annotations: true, goals: true } },
      goals: { select: { id: true, title: true, status: true, dueDate: true } },
      annotations: { select: { type: true, severity: true } },
    },
  });

  const hasMore = rows.length > query.limit;
  const data = hasMore ? rows.slice(0, query.limit) : rows;
  const last = data.at(-1);
  return { data, nextCursor: hasMore && last ? encodeNextCursor(query, last) : null };
}
