<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";
import StatusBadge from "../components/StatusBadge.vue";
import { ANNOTATION_TYPES, GOAL_STATUSES } from "@practice/contracts";
import {
  annotationLabels,
  goalStatusLabels,
  sessionStatusLabels,
  formatDateTime,
  formatDuration,
} from "../utils/format.js";

interface SessionRow {
  id: string;
  title: string;
  instrument: string;
  startedAt: string;
  actualDurationMs: number;
  status: string;
  updatedAt: string;
  _count: { mediaAssets: number; annotations: number; goals: number };
  annotations: Array<{ type: string; severity: number }>;
  goals: Array<{ id: string; title: string; status: string }>;
}
interface SessionPage { data: SessionRow[]; nextCursor: string | null }

const filters = reactive({
  q: "",
  instrument: "",
  status: "COMPLETED",
  annotationType: "",
  goalStatus: "",
  sortBy: "startedAt",
  sortOrder: "desc",
});
const data = ref<SessionPage>({ data: [], nextCursor: null });
const loading = ref(true);
const archiving = ref<string | null>(null);
const error = ref("");
// 游标栈：栈底是第一页（无游标），栈顶是当前正在查看页的游标
const cursors: string[] = [];
// 过滤参数快照随每次请求保存；游标必须和它对应的筛选条件一起回传，
// 否则翻页时会把旧条件和新条件混在一起
let activeParams: Record<string, string> = {};
let requestSeq = 0;

function serializeFilters(): Record<string, string> {
  const params: Record<string, string> = {};
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params[key] = value;
  });
  return params;
}

async function load(cursor?: string, isRecovery = false): Promise<void> {
  const seq = ++requestSeq;
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams(activeParams);
    if (cursor) params.set("cursor", cursor);
    const page = await apiFetch<SessionPage>(`/api/v1/sessions?${params.toString()}`);
    // 丢弃过期响应：筛选快速变化或连点翻页时只采用最后一次请求
    if (seq !== requestSeq) return;
    data.value = page;
  } catch (reason) {
    if (seq !== requestSeq) return;
    // 游标失效（如换了旧版本客户端、游标损坏）：清栈回到第一页自动恢复，不进入重试死循环
    if (!isRecovery && reason instanceof ApiError && reason.code === "INVALID_CURSOR") {
      cursors.length = 0;
      await load(undefined, true);
      return;
    }
    error.value = reason instanceof ApiError ? reason.message : "练习列表加载失败";
    data.value = { data: [], nextCursor: null };
  } finally {
    if (seq === requestSeq) loading.value = false;
  }
}

function applyFilters(): void {
  activeParams = serializeFilters();
  cursors.length = 0;
  void load();
}

async function nextPage(): Promise<void> {
  if (!data.value.nextCursor || loading.value) return;
  cursors.push(data.value.nextCursor);
  await load(data.value.nextCursor);
}
async function previousPage(): Promise<void> {
  if (loading.value) return;
  cursors.pop();
  await load(cursors.at(-1));
}
async function archive(session: SessionRow): Promise<void> {
  if (!window.confirm(`确认归档“${session.title}”？归档后默认不再出现在历史列表中。`)) return;
  archiving.value = session.id;
  try {
    await apiFetch(`/api/v1/sessions/${session.id}/archive`, { method: "POST", body: "{}" });
    // 归档只让被归档行离开当前结果集：用同一个 keyset 游标重取本页，
    // 服务端按下一条记录补齐，不会跳项；回到第一页同样不会重复已见项。
    await load(cursors.at(-1));
  } catch (reason) {
    error.value = reason instanceof ApiError ? reason.message : "归档失败，请稍后重试";
  } finally {
    archiving.value = null;
  }
}

watch(
  () => [filters.q, filters.instrument, filters.status, filters.annotationType, filters.goalStatus, filters.sortBy, filters.sortOrder],
  () => applyFilters(),
);
onMounted(() => {
  activeParams = serializeFilters();
  void load();
});
</script>

<template>
  <section class="page">
    <header class="page-header">
      <div><h1>练习历史</h1><p>搜索、筛选并回看每一次练习中的音频、问题与目标。</p></div>
      <RouterLink class="button" to="/sessions/new">新建练习</RouterLink>
    </header>

    <div class="tabs" style="margin-bottom: 18px">
      <button v-for="status in ['COMPLETED', 'IN_REVIEW', 'DRAFT', 'ARCHIVED', 'ALL']" :key="status" class="tab" :class="{ active: filters.status === status }" @click="filters.status = status">
        {{ status === "ALL" ? "全部" : sessionStatusLabels[status as keyof typeof sessionStatusLabels] }}
      </button>
    </div>

    <form class="card filters" @submit.prevent="applyFilters">
      <input v-model="filters.q" placeholder="搜索标题、曲目、乐器或备注" aria-label="搜索练习" />
      <input v-model="filters.instrument" placeholder="乐器（如 小提琴）" aria-label="按乐器筛选" />
      <select v-model="filters.annotationType" aria-label="按问题类型筛选">
        <option value="">全部问题类型</option>
        <option v-for="type in ANNOTATION_TYPES" :key="type" :value="type">{{ annotationLabels[type] }}</option>
      </select>
      <select v-model="filters.goalStatus" aria-label="按目标状态筛选">
        <option value="">全部目标状态</option>
        <option v-for="status in GOAL_STATUSES" :key="status" :value="status">{{ goalStatusLabels[status] }}</option>
      </select>
      <select v-model="filters.sortBy" aria-label="排序字段">
        <option value="startedAt">开始时间</option><option value="actualDurationMs">练习时长</option><option value="annotationCount">问题数量</option><option value="updatedAt">更新时间</option>
      </select>
      <select v-model="filters.sortOrder" aria-label="排序方向"><option value="desc">降序</option><option value="asc">升序</option></select>
      <button class="button secondary" type="submit">筛选</button>
    </form>

    <LoadingBlock v-if="loading" />
    <div v-else-if="error" class="alert">{{ error }} <button class="button small ghost" @click="load(cursors.at(-1))">重试</button></div>
    <EmptyState v-else-if="!data.data.length" title="没有符合条件的练习" description="调整筛选条件，或开始一次新的练习。" action-label="开始新练习" @action="$router.push('/sessions/new')" />
    <div v-else class="card" style="margin-top: 18px">
      <div class="table-wrap">
        <table>
          <thead><tr><th>练习</th><th>状态</th><th>开始时间</th><th>时长</th><th>音频 / 标记 / 目标</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="session in data.data" :key="session.id">
              <td>
                <strong>{{ session.title }}</strong>
                <small style="display: block">{{ session.instrument }}</small>
                <div class="tag-row">
                  <span v-for="type in [...new Set(session.annotations.map((item) => item.type))]" :key="type" class="tag">{{ annotationLabels[type as keyof typeof annotationLabels] }}</span>
                  <span v-for="status in [...new Set(session.goals.map((item) => item.status))]" :key="`g-${status}`" class="tag goal">{{ goalStatusLabels[status as keyof typeof goalStatusLabels] }}</span>
                </div>
              </td>
              <td><StatusBadge :value="session.status" /></td>
              <td>{{ formatDateTime(session.startedAt) }}</td>
              <td>{{ formatDuration(session.actualDurationMs) }}</td>
              <td>{{ session._count.mediaAssets }} / {{ session._count.annotations }} / {{ session._count.goals }}</td>
              <td>
                <div class="row">
                  <RouterLink v-if="['DRAFT', 'IN_REVIEW'].includes(session.status)" class="button small" :to="`/sessions/${session.id}/review`">继续复盘</RouterLink>
                  <RouterLink v-else class="button small secondary" :to="`/sessions/${session.id}`">详情</RouterLink>
                  <button v-if="session.status === 'COMPLETED'" class="button small ghost" :disabled="archiving === session.id" @click="archive(session)">归档</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="row between" style="margin-top: 18px"><button class="button ghost" :disabled="!cursors.length" @click="previousPage">上一页</button><button class="button ghost" :disabled="!data.nextCursor" @click="nextPage">下一页</button></div>
    </div>
  </section>
</template>

<style scoped>
.filters { display: grid; grid-template-columns: minmax(200px, 2fr) 1fr auto auto auto auto auto; gap: 10px; margin-bottom: 18px; }
.tag-row { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
.tag { font-size: 12px; padding: 1px 8px; border-radius: 999px; background: var(--accent-soft, #eef2ff); color: var(--accent, #4f46e5); }
.tag.goal { background: #ecfdf5; color: #047857; }
@media (max-width: 900px) { .filters { grid-template-columns: 1fr 1fr; } }
@media (max-width: 560px) { .filters { grid-template-columns: 1fr; } }
</style>
