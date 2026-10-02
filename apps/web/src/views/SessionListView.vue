<script setup lang="ts">
import { onMounted, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { apiFetch, ApiError } from "../api/client.js";
import EmptyState from "../components/EmptyState.vue";
import LoadingBlock from "../components/LoadingBlock.vue";
import StatusBadge from "../components/StatusBadge.vue";
import {
  annotationLabels,
  formatDateTime,
  formatDuration,
  goalStatusLabels,
  sessionStatusLabels,
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
const error = ref("");
// 每页游标栈：栈底永远是第一页（undefined），保证“上一页”能逐页退回且不重项
const cursors: Array<string | undefined> = [];
// 本次筛选条件下已见过的练习 ID：归档等操作会刷新排序值，个别行可能重新落到当前页，
// 向前翻页时直接丢弃，保证跨页不重复也不跳项
const seenIds = new Set<string>();
const currentCursor = () => cursors.at(-1);

async function load(cursor?: string): Promise<void> {
  loading.value = true;
  error.value = "";
  try {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([key, value]) => { if (value) params.set(key, value); });
    if (cursor) params.set("cursor", cursor);
    const page = await apiFetch<SessionPage>(`/api/v1/sessions?${params.toString()}`);
    if (cursor) {
      page.data = page.data.filter((session) => !seenIds.has(session.id));
    } else {
      seenIds.clear();
    }
    page.data.forEach((session) => seenIds.add(session.id));
    data.value = page;
  } catch (reason) {
    // 游标失效（换了筛选条件、锚点被删除等）：回到第一页重新取数，不把用户卡在错误页
    if (reason instanceof ApiError && reason.code === "CURSOR_INVALID" && cursor) {
      cursors.length = 0;
      await load();
      return;
    }
    error.value = reason instanceof ApiError ? reason.message : "练习列表加载失败";
  } finally {
    loading.value = false;
  }
}
async function nextPage(): Promise<void> {
  if (!data.value.nextCursor) return;
  cursors.push(data.value.nextCursor);
  await load(data.value.nextCursor);
}
async function previousPage(): Promise<void> {
  if (!cursors.length) return;
  cursors.pop();
  await load(currentCursor());
}
async function archive(session: SessionRow): Promise<void> {
  if (!window.confirm(`确认归档“${session.title}”？归档后默认不再出现在历史列表中。`)) return;
  await apiFetch(`/api/v1/sessions/${session.id}/archive`, { method: "POST", body: "{}" });
  // 归档会改变结果集总数，清空游标栈停留在当前条件第一页，避免旧游标导致跳项
  cursors.length = 0;
  await load();
}
watch(
  () => [filters.q, filters.instrument, filters.status, filters.annotationType, filters.goalStatus, filters.sortBy, filters.sortOrder],
  () => { cursors.length = 0; void load(); },
);
onMounted(() => load());
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

    <form class="card filters" @submit.prevent="cursors.length = 0; load()">
      <input v-model="filters.q" placeholder="搜索标题、曲目、乐器或备注" aria-label="搜索练习" />
      <input v-model="filters.instrument" placeholder="乐器" aria-label="按乐器筛选" />
      <select v-model="filters.annotationType" aria-label="按问题类型筛选">
        <option value="">全部问题类型</option>
        <option v-for="(label, value) in annotationLabels" :key="value" :value="value">{{ label }}</option>
      </select>
      <select v-model="filters.goalStatus" aria-label="按目标状态筛选">
        <option value="">全部目标状态</option>
        <option v-for="(label, value) in goalStatusLabels" :key="value" :value="value">{{ label }}</option>
      </select>
      <select v-model="filters.sortBy" aria-label="排序字段">
        <option value="startedAt">开始时间</option><option value="actualDurationMs">练习时长</option><option value="annotationCount">问题数量</option><option value="updatedAt">更新时间</option>
      </select>
      <select v-model="filters.sortOrder" aria-label="排序方向"><option value="desc">降序</option><option value="asc">升序</option></select>
      <button class="button secondary" type="submit">筛选</button>
    </form>

    <LoadingBlock v-if="loading" />
    <div v-else-if="error" class="alert">{{ error }} <button class="button small ghost" @click="load(currentCursor())">重试</button></div>
    <EmptyState v-else-if="!data.data.length" title="没有符合条件的练习" description="调整筛选条件，或开始一次新的练习。" action-label="开始新练习" @action="$router.push('/sessions/new')" />
    <div v-else class="card" style="margin-top: 18px">
      <div class="table-wrap">
        <table>
          <thead><tr><th>练习</th><th>状态</th><th>开始时间</th><th>时长</th><th>音频 / 标记 / 目标</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="session in data.data" :key="session.id">
              <td><strong>{{ session.title }}</strong><small style="display: block">{{ session.instrument }}</small></td>
              <td><StatusBadge :value="session.status" /></td>
              <td>{{ formatDateTime(session.startedAt) }}</td>
              <td>{{ formatDuration(session.actualDurationMs) }}</td>
              <td>{{ session._count.mediaAssets }} / {{ session._count.annotations }} / {{ session._count.goals }}</td>
              <td>
                <div class="row">
                  <RouterLink v-if="['DRAFT', 'IN_REVIEW'].includes(session.status)" class="button small" :to="`/sessions/${session.id}/review`">继续复盘</RouterLink>
                  <RouterLink v-else class="button small secondary" :to="`/sessions/${session.id}`">详情</RouterLink>
                  <button v-if="session.status === 'COMPLETED'" class="button small ghost" @click="archive(session)">归档</button>
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
.filters { display: grid; grid-template-columns: minmax(200px, 2fr) repeat(4, minmax(130px, 1fr)) auto auto; gap: 10px; margin-bottom: 18px; }
@media (max-width: 980px) { .filters { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 620px) { .filters { grid-template-columns: 1fr; } }
</style>
