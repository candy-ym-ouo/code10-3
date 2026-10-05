import { describe, expect, it } from 'vitest';
import {
  decodeKeysetCursor,
  encodeKeysetCursor,
  keysetWhere,
  resultSetFingerprint,
  toPage,
} from './pagination';

describe('键集游标编解码', () => {
  const payload = { v: 1 as const, s: 'time', k: '1985-06-01T00:00:00.000Z', id: 'cmutl73vy000n14ohwhsyddle', f: 'abc123def4567890' };

  it('游标可往返', () => {
    expect(decodeKeysetCursor(encodeKeysetCursor(payload))).toEqual(payload);
  });

  it('垃圾输入、旧版裸 id 游标、被篡改的游标一律报 400', () => {
    for (const bad of [
      '%%%',
      '',
      Buffer.from('cmutl73vy000n14ohwhsyddle', 'utf8').toString('base64url'), // 旧格式：裸 id
      Buffer.from('{"v":1,"s":"time"}', 'utf8').toString('base64url'), // 缺字段
      Buffer.from('{...}', 'utf8').toString('base64url'),
    ]) {
      expect(() => decodeKeysetCursor(bad)).toThrowError(/分页游标无效或已过期/);
    }
  });

  it('结果集指纹对字段顺序不敏感、对取值敏感', () => {
    const a = resultSetFingerprint({ q: '樟木', tag: undefined, sort: 'time' });
    const b = resultSetFingerprint({ sort: 'time', q: '樟木' });
    const c = resultSetFingerprint({ q: '樟木', tag: '手工', sort: 'time' });
    expect(a).toBe(b); // undefined 归一化、键序无关
    expect(a).not.toBe(c);
  });
});

// ---------- 用内存数据集模拟 listItems 的翻页语义 ----------
//
// 这里的 where 求值器直接消费 keysetWhere() 产出的对象结构（OR/AND/字段条件），
// 因此验证的就是发往 Prisma 的条件本身，而不是另一份平行实现。

interface Row {
  id: string;
  k: string; // 排序键（ISO 时间串）
  deleted?: boolean;
}

type Where = Record<string, unknown>;

function norm(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((c) => matches(row, c));
    if (key === 'AND') return (cond as Where[]).every((c) => matches(row, c));
    const value = key === 'id' ? row.id : row.k;
    if (cond !== null && typeof cond === 'object') {
      const ops = cond as Record<string, unknown>;
      if ('lt' in ops) return value < norm(ops.lt);
      if ('gt' in ops) return value > norm(ops.gt);
    }
    return value === norm(cond);
  });
}

const FP = '0123456789abcdef';

const byKeyDescIdDesc = (a: Row, b: Row) => (a.k === b.k ? b.id.localeCompare(a.id) : b.k.localeCompare(a.k));

/** 与 itemService.listItems 相同的翻页流程：指纹校验 → 键集条件 → 排序 → 多取一条。 */
function queryPage(db: Row[], opts: { sort: string; fp: string; limit: number; cursor?: string }) {
  let rows = db.filter((r) => !r.deleted);
  if (opts.cursor) {
    const cursor = decodeKeysetCursor(opts.cursor);
    if (cursor.s !== opts.sort || cursor.f !== opts.fp) {
      throw new Error('分页游标与当前筛选或排序不一致，请重新查询');
    }
    const where = keysetWhere<Where>('k', 'desc', new Date(cursor.k), cursor.id);
    rows = rows.filter((r) => matches(r, where));
  }
  rows = [...rows].sort(byKeyDescIdDesc);
  return toPage(rows, opts.limit, (row) =>
    encodeKeysetCursor({ v: 1, s: opts.sort, k: row.k, id: row.id, f: opts.fp }),
  );
}

/** 连续翻页直到没有下一页，返回拼接后的 id 序列。 */
function drain(db: Row[], opts: { sort?: string; fp?: string; limit: number }): string[] {
  const seen: string[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i++) {
    const page = queryPage(db, { sort: opts.sort ?? 'time', fp: opts.fp ?? FP, limit: opts.limit, cursor });
    seen.push(...page.items.map((r) => r.id));
    if (!page.nextCursor) return seen;
    cursor = page.nextCursor;
  }
  throw new Error('翻页超过 50 次仍未结束，疑似死循环');
}

function makeRows(n: number, keyOf: (i: number) => string): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `id${String(i).padStart(3, '0')}`,
    k: keyOf(i),
  }));
}

const distinctKeys = (i: number) => `2020-01-${String(30 - i).padStart(2, '0')}T00:00:00.000Z`;

describe('键集翻页：数据增删与排序切换', () => {
  it('连续翻页拼接后与全量排序完全一致（不重不漏）', () => {
    const db = makeRows(23, distinctKeys);
    for (const limit of [1, 2, 5, 7, 23, 100]) {
      expect(drain(db, { limit })).toEqual(db.map((r) => r.id));
    }
  });

  it('排序键相同的行靠 id 决胜，跨页不重不漏', () => {
    // 5 行共享同一个键值，页大小小于同值组
    const db = makeRows(5, () => '1990-06-01T00:00:00.000Z');
    const seen = drain(db, { limit: 2 });
    expect(seen).toEqual([...db].sort(byKeyDescIdDesc).map((r) => r.id));
    expect(new Set(seen).size).toBe(5);
  });

  it('翻页中途新增行（排在游标之前）：后续页不重复', () => {
    const db = makeRows(10, distinctKeys);
    const p1 = queryPage(db, { sort: 'time', fp: FP, limit: 4 });
    // 新增一行，键值比所有现有行都新（会排在游标之前）
    db.push({ id: 'new-001', k: '2021-01-01T00:00:00.000Z' });
    const rest: string[] = [];
    let cursor: string | null = p1.nextCursor;
    while (cursor) {
      const page = queryPage(db, { sort: 'time', fp: FP, limit: 4, cursor });
      rest.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    }
    const seen = [...p1.items.map((r) => r.id), ...rest];
    // 新行出现在游标之前，不影响后续页：序列恰好是原来的 10 行
    expect(seen).toEqual(makeRows(10, distinctKeys).map((r) => r.id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('翻页中途删除游标行本身：不漏项、不报错', () => {
    const db = makeRows(10, distinctKeys);
    const p1 = queryPage(db, { sort: 'time', fp: FP, limit: 4 });
    const cursorRowId = p1.items.at(-1)!.id;
    db.find((r) => r.id === cursorRowId)!.deleted = true; // 上一页最后一条被移入回收站

    const rest: string[] = [];
    let cursor: string | null = p1.nextCursor;
    while (cursor) {
      const page = queryPage(db, { sort: 'time', fp: FP, limit: 4, cursor });
      rest.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    }
    const seen = [...p1.items.map((r) => r.id), ...rest];
    const alive = db.filter((r) => !r.deleted).sort(byKeyDescIdDesc).map((r) => r.id);
    // 后续页恰好是「现存全集中排在游标位置之后」的部分：第一页尚存 3 条，其余全在后续页
    expect(rest).toEqual(alive.slice(3));
    // 已看到的（含被删那条）+ 后续页 = 被删那条 + 现存全集，且无重复
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen.filter((id) => id !== cursorRowId)).toEqual(alive);
  });

  it('翻页中途删除游标之前的行：后续页不重不漏', () => {
    const db = makeRows(10, distinctKeys);
    const p1 = queryPage(db, { sort: 'time', fp: FP, limit: 4 });
    db.find((r) => r.id === p1.items[0]!.id)!.deleted = true; // 删掉第一页里的一行

    const rest: string[] = [];
    let cursor: string | null = p1.nextCursor;
    while (cursor) {
      const page = queryPage(db, { sort: 'time', fp: FP, limit: 4, cursor });
      rest.push(...page.items.map((r) => r.id));
      cursor = page.nextCursor;
    }
    // 键集定位与「游标之前发生了什么」无关：后续 6 条一条不多一条不少
    expect(rest).toEqual(makeRows(10, distinctKeys).slice(4).map((r) => r.id));
  });

  it('排序切换后旧游标被拒绝，而不是在新排序里错位', () => {
    const db = makeRows(10, distinctKeys);
    const p1 = queryPage(db, { sort: 'time', fp: FP, limit: 4 });
    expect(() => queryPage(db, { sort: 'updated', fp: FP, limit: 4, cursor: p1.nextCursor! })).toThrowError(
      /不一致/,
    );
  });

  it('过滤条件变化后旧游标被拒绝', () => {
    const db = makeRows(10, distinctKeys);
    const p1 = queryPage(db, { sort: 'time', fp: resultSetFingerprint({ q: '樟木' }), limit: 4 });
    const otherFp = resultSetFingerprint({ q: '搪瓷' });
    expect(() => queryPage(db, { sort: 'time', fp: otherFp, limit: 4, cursor: p1.nextCursor! })).toThrowError(
      /不一致/,
    );
  });

  it('空结果集没有下一页游标', () => {
    expect(queryPage([], { sort: 'time', fp: FP, limit: 10 }).nextCursor).toBeNull();
  });
});
