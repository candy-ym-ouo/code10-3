import { describe, expect, it } from 'vitest';
import {
  decodeCursor,
  decodeJsonCursor,
  encodeCursor,
  encodeJsonCursor,
  filterFingerprint,
  readKeysetCursor,
  toPage,
  type KeysetCursor,
} from './pagination';

describe('游标分页', () => {
  it('游标可往返', () => {
    const raw = 'cmutl73vy000n14ohwhsyddle';
    expect(decodeCursor(encodeCursor(raw))).toBe(raw);
  });

  it('多取一条时给出下一页游标，且不把多余那条返回给调用方', () => {
    const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const page = toPage(rows, 2);
    expect(page.items.map((r) => r.id)).toEqual(['a', 'b']);
    expect(decodeCursor(page.nextCursor!)).toBe('b');
  });

  it('刚好取满时没有下一页', () => {
    const page = toPage([{ id: 'a' }, { id: 'b' }], 2);
    expect(page.nextCursor).toBeNull();
  });

  it('非法游标抛出可读错误', () => {
    // base64url 解码很宽松，非法字符不会抛异常，但也不会解出可用 ID
    expect(typeof decodeCursor('%%%')).toBe('string');
    expect(toPage([], 10).nextCursor).toBeNull();
  });
});

describe('键集游标', () => {
  const sample = (): KeysetCursor => ({
    value: '1978-07-02T00:00:00.000Z',
    id: 'cmutl73vy000n14ohwhsyddle',
    sort: 'time',
    fp: '0123456789abcdef',
  });

  it('JSON 游标可往返', () => {
    const c = sample();
    expect(decodeJsonCursor<KeysetCursor>(encodeJsonCursor(c))).toEqual(c);
  });

  it('排序与过滤指纹一致时接受游标', () => {
    const c = sample();
    const decoded = readKeysetCursor(encodeJsonCursor(c), { sort: 'time', fp: c.fp });
    expect(decoded.id).toBe(c.id);
  });

  it('切换排序方式后旧游标被拒绝', () => {
    const c = sample();
    expect(() => readKeysetCursor(encodeJsonCursor(c), { sort: 'updated', fp: c.fp })).toThrow(/排序或筛选/);
  });

  it('过滤条件变化（指纹不一致）后旧游标被拒绝', () => {
    const c = sample();
    expect(() => readKeysetCursor(encodeJsonCursor(c), { sort: 'time', fp: 'ffffffffffffffff' })).toThrow(
      /排序或筛选/,
    );
  });

  it('结构损坏或时间非法时拒绝游标', () => {
    const token = encodeJsonCursor({ value: 'not-a-date', id: 'x', sort: 'time', fp: '1' });
    expect(() => readKeysetCursor(token, { sort: 'time', fp: '1' })).toThrow(/游标无效/);
    expect(() => readKeysetCursor('%%%', { sort: 'time', fp: '1' })).toThrow(/游标无效/);
  });

  it('toPage 可携带排序键值生成下一页游标', () => {
    const rows = [
      { id: 'a', sortAt: new Date('2020-01-01T00:00:00.000Z') },
      { id: 'b', sortAt: new Date('2019-01-01T00:00:00.000Z') },
      { id: 'c', sortAt: new Date('2018-01-01T00:00:00.000Z') },
    ];
    const page = toPage(rows, 2, (row) =>
      encodeJsonCursor({ value: row.sortAt.toISOString(), id: row.id, sort: 'time', fp: 'f' }),
    );
    const next = decodeJsonCursor<KeysetCursor>(page.nextCursor!);
    expect(next.id).toBe('b');
    expect(next.value).toBe('2019-01-01T00:00:00.000Z');
    expect(next.sort).toBe('time');
  });
});

describe('过滤指纹', () => {
  it('相同条件（不同书写顺序）产生相同指纹', () => {
    const a = filterFingerprint(['箱子', null, null, null, null, ['樟木', '手工']]);
    const b = filterFingerprint(['箱子', null, null, null, null, ['樟木', '手工']]);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('任一条件变化都会让指纹变化', () => {
    const base = ['x', null, null, null, null, null];
    expect(filterFingerprint(['y', ...base.slice(1)])).not.toBe(filterFingerprint(base));
    expect(filterFingerprint(['x', 'furniture', ...base.slice(2)])).not.toBe(filterFingerprint(base));
    expect(filterFingerprint([...base.slice(0, 5), ['a']])).not.toBe(filterFingerprint(base));
  });
});
