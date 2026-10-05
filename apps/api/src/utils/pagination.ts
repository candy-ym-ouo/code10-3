import { createHash } from 'node:crypto';
import { badRequest } from '../http/errors';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): string {
  try {
    return Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    throw badRequest('分页游标无效');
  }
}

/** 任意 JSON 负载的不透明游标：客户端无法猜测结构，也不会把数据库 ID 直接暴露在 URL 里。 */
export function encodeJsonCursor<T>(payload: T): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

export function decodeJsonCursor<T>(cursor: string): T {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as T;
  } catch {
    throw badRequest('分页游标无效');
  }
}

/** 物品列表支持的排序方式（游标必须与之一致）。 */
export type KeysetSort = 'time' | 'updated' | 'created';

/**
 * 键集分页游标：锚点条目的排序键值 + 平局决胜 ID。
 *
 * - `value`：排序键（sortAt/updatedAt/createdAt）的 ISO 字符串；
 * - `id`：排序键相同时用条目 ID 决胜，保证顺序是全序；
 * - `sort`：生成游标时的排序方式，换排序必须从头翻；
 * - `fp`：过滤条件指纹，换关键词/标签/人物/时间范围必须从头翻。
 */
export interface KeysetCursor {
  value: string;
  id: string;
  sort: KeysetSort;
  fp: string;
}

/**
 * 过滤条件指纹：把影响结果集的参数做稳定序列化后哈希。
 * 游标只在「相同过滤条件 + 相同排序」下有效，
 * 从根上杜绝排序切换 / 条件变更后旧游标造成的重复或漏项。
 */
export function filterFingerprint(parts: readonly unknown[]): string {
  return createHash('sha256').update(stableStringify(parts)).digest('hex').slice(0, 16);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 解码并校验键集分页游标：结构非法、排序或过滤条件不一致都给出可读的 400。 */
export function readKeysetCursor(token: string, expected: { sort: KeysetSort; fp: string }): KeysetCursor {
  const c = decodeJsonCursor<Partial<KeysetCursor>>(token);
  if (!c || typeof c !== 'object' || typeof c.value !== 'string' || typeof c.id !== 'string' || typeof c.fp !== 'string') {
    throw badRequest('分页游标无效');
  }
  if (c.sort !== 'time' && c.sort !== 'updated' && c.sort !== 'created') {
    throw badRequest('分页游标无效');
  }
  if (Number.isNaN(Date.parse(c.value))) throw badRequest('分页游标无效');
  if (c.sort !== expected.sort || c.fp !== expected.fp) {
    throw badRequest('排序或筛选条件已变化，请回到第一页重新翻页');
  }
  return { value: c.value, id: c.id, sort: c.sort, fp: c.fp };
}

/**
 * 多取一条来判断是否还有下一页，避免额外 count 查询。
 * `encode` 由调用方提供，用来把末行编码成携带排序键的键集游标。
 */
export function toPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  encode: (row: T) => string = (row) => encodeCursor(row.id),
): CursorPage<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);
  return {
    items,
    nextCursor: hasMore && last ? encode(last) : null,
  };
}
