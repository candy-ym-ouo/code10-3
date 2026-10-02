import { Prisma } from "@prisma/client";
import type { SessionSortBy, SessionSortOrder } from "@practice/contracts";

/**
 * 练习历史使用基于排序值的复合游标（keyset pagination）。
 *
 * 游标载荷是上一页最后一条记录的 `(sortValue, id)`，编码为 base64url(JSON)。
 * 与 Prisma 的 `cursor: { id }` 相比，复合游标即使在跨页请求之间发生归档、
 * 删除（总数变化）或排序字段更新，也不会：
 *  - 跳过任何一条记录（谓词只依赖排序值比较，不依赖边界行仍存在）；
 *  - 返回重复记录（id 作为最终唯一决胜列，严格 > / <）；
 *  - 因为游标行已消失而报错。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface CursorPayload {
  /** 签发游标时使用的排序字段，回传时必须与当前查询一致 */
  sortBy: SessionSortBy;
  /** 主排序列的值；annotationCount 时为整数，时间列为 ISO 字符串，时长为数字（毫秒） */
  v: number | string;
  /** 唯一决胜列（practice_sessions.id） */
  id: string;
}

function toBase64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

function fromBase64Url(input: string): string {
  return Buffer.from(input, "base64url").toString("utf8");
}

export function encodeSessionCursor(input: {
  sortBy: SessionSortBy;
  sortValue: number | bigint | Date;
  id: string;
}): string {
  const value =
    input.sortValue instanceof Date
      ? input.sortValue.toISOString()
      : typeof input.sortValue === "bigint"
        ? Number(input.sortValue)
        : input.sortValue;
  const payload: CursorPayload = { sortBy: input.sortBy, v: value, id: input.id };
  return toBase64Url(JSON.stringify(payload));
}

export class InvalidCursorError extends Error {
  constructor(message = "游标无效或已过期") {
    super(message);
    this.name = "InvalidCursorError";
  }
}

export function decodeSessionCursor(token: string): CursorPayload {
  let raw: unknown;
  try {
    raw = JSON.parse(fromBase64Url(token));
  } catch {
    throw new InvalidCursorError();
  }
  if (typeof raw !== "object" || raw === null) throw new InvalidCursorError();
  const payload = raw as Partial<CursorPayload>;
  if (
    payload.sortBy !== "startedAt" &&
    payload.sortBy !== "actualDurationMs" &&
    payload.sortBy !== "annotationCount" &&
    payload.sortBy !== "updatedAt"
  ) {
    throw new InvalidCursorError();
  }
  if (typeof payload.id !== "string" || !UUID_RE.test(payload.id)) throw new InvalidCursorError();
  if (payload.sortBy === "annotationCount" || payload.sortBy === "actualDurationMs") {
    if (
      typeof payload.v !== "number" ||
      !Number.isFinite(payload.v) ||
      payload.v < 0 ||
      (payload.sortBy === "annotationCount" && !Number.isInteger(payload.v))
    ) {
      throw new InvalidCursorError();
    }
  } else if (typeof payload.v !== "string" || Number.isNaN(Date.parse(payload.v))) {
    throw new InvalidCursorError();
  }
  return { sortBy: payload.sortBy, v: payload.v, id: payload.id };
}

type SessionWhere = Prisma.PracticeSessionWhereInput;
// Prisma 6 的关系 _count 过滤运行时已 GA，但生成的 WhereInput 类型仍未暴露该字段
type AnnotationCountComparison = {
  gt?: number;
  gte?: number;
  lt?: number;
  lte?: number;
  equals?: number;
};
type KeysetBranch = Omit<SessionWhere, "OR"> & {
  id?: { lt?: string; gt?: string };
  _count?: { annotations: AnnotationCountComparison };
};
export type SessionKeysetWhere = SessionWhere & { OR?: KeysetBranch[] };

/**
 * 构造 keyset 续页谓词。orderBy 固定为 `[sortValue dir, id dir]`，
 * 因此“下一页”就是所有满足 (sortValue, id) 严格落在边界之后的行：
 *
 * - desc：sortValue < v，或 sortValue = v 且 id < 边界 id
 * - asc ：sortValue > v，或 sortValue = v 且 id > 边界 id
 *
 * 该谓词只与值比较有关：边界行本身被归档/删除时谓词依然成立，
 * 同排序值的行由 id 决胜，天然不会重复或跳过。
 */
export function buildSessionKeysetWhere(
  sortBy: SessionSortBy,
  sortOrder: SessionSortOrder,
  cursorToken: string,
): SessionKeysetWhere {
  const cursor = decodeSessionCursor(cursorToken);
  if (cursor.sortBy !== sortBy) throw new InvalidCursorError("游标与当前排序不匹配");
  const after = sortOrder === "desc";
  const idBound = after ? { id: { lt: cursor.id } } : { id: { gt: cursor.id } };

  if (sortBy === "annotationCount") {
    const count = cursor.v;
    return after
      ? ({
          OR: [
            { _count: { annotations: { lt: count } } },
            { _count: { annotations: { equals: count } }, ...idBound },
          ],
        } as SessionKeysetWhere)
      : ({
          OR: [
            { _count: { annotations: { gt: count } } },
            { _count: { annotations: { equals: count } }, ...idBound },
          ],
        } as SessionKeysetWhere);
  }

  if (sortBy === "actualDurationMs") {
    const value = Number(cursor.v);
    return after
      ? { OR: [{ actualDurationMs: { lt: value } }, { actualDurationMs: value, ...idBound }] }
      : { OR: [{ actualDurationMs: { gt: value } }, { actualDurationMs: value, ...idBound }] };
  }

  const value = new Date(cursor.v);
  if (sortBy === "updatedAt") {
    return after
      ? { OR: [{ updatedAt: { lt: value } }, { updatedAt: value, ...idBound }] }
      : { OR: [{ updatedAt: { gt: value } }, { updatedAt: value, ...idBound }] };
  }
  return after
    ? { OR: [{ startedAt: { lt: value } }, { startedAt: value, ...idBound }] }
    : { OR: [{ startedAt: { gt: value } }, { startedAt: value, ...idBound }] };
}
