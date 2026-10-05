import { z } from 'zod';
import {
  CATEGORIES,
  FAMILY_ROLES,
  MEDIA_KINDS,
  NOTE_TYPES,
  PERSON_ROLES,
  PRECISIONS,
  VISIBILITIES,
} from './enums';

const trimmed = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional().nullable();

export const emailSchema = z.string().trim().toLowerCase().email('邮箱格式不正确').max(160);
export const passwordSchema = z
  .string()
  .min(8, '密码至少 8 位')
  .max(200)
  .refine((v) => /[a-zA-Z]/.test(v) && /\d/.test(v), '密码需同时包含字母和数字');

export const registerSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  displayName: trimmed(40),
});

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(200),
});

export const updateMeSchema = z.object({
  displayName: trimmed(40).optional(),
  currentPassword: z.string().min(1).max(200).optional(),
  newPassword: passwordSchema.optional(),
  avatarColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

export const createFamilySchema = z.object({
  name: trimmed(60),
  description: optionalText(500),
  defaultVisibility: z.enum(VISIBILITIES).optional(),
});

export const updateFamilySchema = z.object({
  name: trimmed(60).optional(),
  description: optionalText(500),
  defaultVisibility: z.enum(VISIBILITIES).optional(),
  allowViewerComment: z.boolean().optional(),
});

export const deleteFamilySchema = z.object({
  confirmName: trimmed(60),
});

export const createInviteSchema = z.object({
  role: z.enum(FAMILY_ROLES).exclude(['owner']),
  expiresInDays: z.number().int().min(1).max(90).default(7),
  maxUses: z.number().int().min(1).max(50).default(1),
  note: optionalText(80),
});

export const updateMemberSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('role'), role: z.enum(FAMILY_ROLES).exclude(['owner']) }),
  z.object({ op: z.literal('disable') }),
  z.object({ op: z.literal('enable') }),
]);

export const personSchema = z.object({
  name: trimmed(60),
  relation: optionalText(40),
  birthYear: z.number().int().min(1800).max(2200).optional().nullable(),
  deathYear: z.number().int().min(1800).max(2200).optional().nullable(),
  bio: optionalText(2000),
  avatarMediaId: z.string().cuid().optional().nullable(),
});

export const mergePersonSchema = z.object({
  targetPersonId: z.string().cuid(),
});

export const itemPersonSchema = z.object({
  personId: z.string().cuid(),
  role: z.enum(PERSON_ROLES).default('source'),
});

export const itemBaseSchema = z.object({
  title: trimmed(120),
  category: z.enum(CATEGORIES),
  acquiredAt: z.string().datetime().optional().nullable(),
  acquiredPrecision: z.enum(PRECISIONS).default('unknown'),
  acquiredLabel: optionalText(64),
  acquiredNote: optionalText(500),
  placeText: optionalText(255),
  placeCity: optionalText(64),
  placeProvince: optionalText(64),
  placeCountry: optionalText(64),
  placeLat: z.number().min(-90).max(90).optional().nullable(),
  placeLng: z.number().min(-180).max(180).optional().nullable(),
  storyHtml: z.string().max(100_000).optional().nullable(),
  condition: optionalText(200),
  storageLocation: optionalText(120),
  tags: z.array(trimmed(24)).max(20).optional(),
  visibility: z.enum(VISIBILITIES).optional(),
  people: z.array(itemPersonSchema).max(30).optional(),
  sharedWith: z
    .array(z.object({ userId: z.string().cuid(), canEdit: z.boolean().default(false) }))
    .max(100)
    .optional(),
});

export const createItemSchema = itemBaseSchema;

export const updateItemSchema = itemBaseSchema.partial();

export const createNoteSchema = z.object({
  type: z.enum(NOTE_TYPES).default('story'),
  body: trimmed(5000),
});

export const rejectNoteSchema = z.object({
  reason: trimmed(200),
});

export const createShareLinkSchema = z.object({
  itemIds: z.array(z.string().cuid()).min(1).max(200),
  expiresInDays: z.number().int().min(1).max(90).default(7),
  password: z.string().min(4).max(64).optional().nullable(),
  label: optionalText(60),
});

/**
 * 标签查询参数：同时兼容
 * - 重复参数：?tag=樟木&tag=手工（AND：必须同时命中）
 * - 逗号分隔：?tag=樟木,手工
 * 归一化成去重后的字符串数组。
 */
const tagsQuerySchema = z.preprocess((value) => {
  const values = Array.isArray(value) ? value : [value];
  const tags = values
    .flatMap((v) => (typeof v === 'string' ? v.split(',') : []))
    .map((v) => v.trim())
    .filter(Boolean);
  return tags.length ? [...new Set(tags)].slice(0, 20) : undefined;
}, z.array(z.string().max(24)).min(1).max(20).optional());

/**
 * 时间范围查询参数：接受两种输入
 * - 日期：1978-01-01（from 取当天 00:00Z，to 取当天 23:59:59.999Z）
 * - 完整 ISO 时间：1978-01-01T00:00:00.000Z
 * 归一化为 ISO 字符串，保证游标指纹稳定。
 */
const rangeStartSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T00:00:00.000Z`;
  return value;
}, z.string().datetime('时间格式应为日期（YYYY-MM-DD）或完整时间'));

const rangeEndSchema = z.preprocess((value) => {
  if (typeof value !== 'string') return value;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${value}T23:59:59.999Z`;
  return value;
}, z.string().datetime('时间格式应为日期（YYYY-MM-DD）或完整时间'));

export const listItemsQuerySchema = z
  .object({
    q: z.string().trim().max(120).optional(),
    category: z.enum(CATEGORIES).optional(),
    personId: z.string().cuid().optional(),
    status: z.enum(['draft', 'published', 'archived']).optional(),
    visibility: z.enum(VISIBILITIES).optional(),
    from: rangeStartSchema.optional(),
    to: rangeEndSchema.optional(),
    tag: tagsQuerySchema,
    sort: z.enum(['time', 'updated', 'created']).default('time'),
    limit: z.coerce.number().int().min(1).max(60).default(20),
    cursor: z.string().optional(),
  })
  .refine((v) => !v.from || !v.to || new Date(v.from).getTime() <= new Date(v.to).getTime(), {
    message: '开始时间不能晚于结束时间',
    path: ['from'],
  });

export const updateMediaSchema = z.object({
  caption: optionalText(300),
  transcript: optionalText(20_000),
  sortOrder: z.number().int().min(0).max(999).optional(),
  setCover: z.boolean().optional(),
});

export type RegisterInput = z.infer<typeof registerSchema>;
export type LoginInput = z.infer<typeof loginSchema>;
export type CreateItemInput = z.infer<typeof createItemSchema>;
export type UpdateItemInput = z.infer<typeof updateItemSchema>;
export type ListItemsQuery = z.infer<typeof listItemsQuerySchema>;
export type CreateFamilyInput = z.infer<typeof createFamilySchema>;
export type CreateInviteInput = z.infer<typeof createInviteSchema>;
export type PersonInput = z.infer<typeof personSchema>;
export type CreateShareLinkInput = z.infer<typeof createShareLinkSchema>;

/** 去 HTML 标签，得到用于检索的纯文本（服务端还会用 DOMPurify 做一次白名单净化）。 */
export function htmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

