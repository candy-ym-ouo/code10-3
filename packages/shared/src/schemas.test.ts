import { describe, expect, it } from 'vitest';
import { listItemsQuerySchema } from './schemas';

function parse(query: Record<string, unknown>) {
  return listItemsQuerySchema.parse(query);
}

describe('物品检索查询参数', () => {
  it('默认排序为 time、每页 20 条', () => {
    const q = parse({});
    expect(q.sort).toBe('time');
    expect(q.limit).toBe(20);
    expect(q.tag).toBeUndefined();
  });

  it('单个标签归一化为数组', () => {
    expect(parse({ tag: '樟木' }).tag).toEqual(['樟木']);
  });

  it('重复参数（数组）支持多标签 AND 过滤', () => {
    expect(parse({ tag: ['樟木', '手工'] }).tag).toEqual(['樟木', '手工']);
  });

  it('逗号分隔的标签同样归一化为数组', () => {
    expect(parse({ tag: '樟木, 手工,,手工' }).tag).toEqual(['樟木', '手工']);
  });

  it('只有空白的标签参数视为未传', () => {
    expect(parse({ tag: ' , ' }).tag).toBeUndefined();
  });

  it('日期粒度的 from/to 归一化为 UTC 日界', () => {
    const q = parse({ from: '1978-01-01', to: '1978-12-31' });
    expect(q.from).toBe('1978-01-01T00:00:00.000Z');
    expect(q.to).toBe('1978-12-31T23:59:59.999Z');
  });

  it('完整 ISO 时间原样保留', () => {
    const q = parse({ from: '1978-06-01T08:30:00.000Z' });
    expect(q.from).toBe('1978-06-01T08:30:00.000Z');
  });

  it('开始时间晚于结束时间被拒绝', () => {
    const result = listItemsQuerySchema.safeParse({ from: '1979-01-01', to: '1970-01-01' });
    expect(result.success).toBe(false);
  });

  it('非法日期字符串被拒绝', () => {
    const result = listItemsQuerySchema.safeParse({ from: '去年冬天' });
    expect(result.success).toBe(false);
  });
});
