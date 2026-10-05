import { createHash } from 'node:crypto';
import { z } from 'zod';
import { badRequest } from '../http/errors';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

/**
 * 键集（keyset）游标：自包含「排序维度 + 排序键值 + 决胜 id + 结果集指纹」。
 *
 * 与位置游标（offset，或 Prisma 的 cursor+skip 按 id 动态定位）不同，它把翻页位置
 * 翻译成 `WHERE (sortKey, id) < (:k, :id)` 这样的纯值比较，因此：
 * - 翻页期间新增的行只会排在游标之前，不会把后续页推重；
 * - 任意行（包括上一页最后一条本身）被删除、移入回收站或改变可见性，定位都不受影响；
 * - 排序方式或过滤条件变化时指纹对不上，明确报 400，而不是在新结果集里静默错位。
 */
const keysetCursorSchema = z.object({
  v: z.literal(1),
  /** 排序维度（time/updated/created），与请求不一致则拒绝 */
  s: z.string().min(1).max(20),
  /** 排序键值（ISO 时间串） */
  k: z.string().datetime(),
  /** 键值相同时的决胜 id */
  id: z.string().min(1).max(40),
  /** 结果集指纹：过滤条件 + 排序 + 角色的哈希 */
  f: z.string().min(8).max(32),
});

export type KeysetCursor = z.infer<typeof keysetCursorSchema>;

export function encodeKeysetCursor(payload: KeysetCursor): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeKeysetCursor(cursor: string): KeysetCursor {
  try {
    const parsed = keysetCursorSchema.safeParse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    /* 落到统一错误 */
  }
  throw badRequest('分页游标无效或已过期，请重新查询');
}

/** 结果集指纹：过滤条件、排序与可见性角色的稳定哈希，任一变化即让旧游标失效。 */
export function resultSetFingerprint(parts: Record<string, unknown>): string {
  const stable = JSON.stringify(parts, Object.keys(parts).sort());
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/**
 * 键集定位条件：`(sortKey, id)` 严格落在游标之后。
 * desc 时「之后」即更小：sortKey < k，或 sortKey = k 且 id < cursorId。
 * 返回结构化对象，由调用方指定成对应的 Prisma WhereInput。
 */
export function keysetWhere<T>(field: string, direction: 'asc' | 'desc', key: Date, id: string): T {
  const op = direction === 'desc' ? 'lt' : 'gt';
  return {
    OR: [{ [field]: { [op]: key } }, { AND: [{ [field]: key }, { id: { [op]: id } }] }],
  } as T;
}

/** 多取一条来判断是否还有下一页，避免额外 count 查询；nextCursor 由调用方从最后一行构造。 */
export function toPage<T>(rows: T[], limit: number, cursorFor: (row: T) => string): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? cursorFor(last) : null,
  };
}
