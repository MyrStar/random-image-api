<template>
  <div class="dashboard">
    <el-row :gutter="20">
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-icon" style="background:#409eff"><el-icon :size="28"><Cloudy /></el-icon></div>
          <div class="stat-info">
            <div class="stat-value">{{ stats.storageCount }}</div>
            <div class="stat-label">存储源</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-icon" style="background:#67c23a"><el-icon :size="28"><FolderOpened /></el-icon></div>
          <div class="stat-info">
            <div class="stat-value">{{ stats.categoryCount }}</div>
            <div class="stat-label">分类</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-icon" style="background:#e6a23c"><el-icon :size="28"><Picture /></el-icon></div>
          <div class="stat-info">
            <div class="stat-value">{{ stats.imageCount }}</div>
            <div class="stat-label">图片总数</div>
          </div>
        </el-card>
      </el-col>
      <el-col :span="6">
        <el-card shadow="hover" class="stat-card">
          <div class="stat-icon" style="background:#f56c6c"><el-icon :size="28"><Coin /></el-icon></div>
          <div class="stat-info">
            <div class="stat-value">{{ formatSize(stats.totalSize) }}</div>
            <div class="stat-label">总大小</div>
          </div>
        </el-card>
      </el-col>
    </el-row>

    <el-card class="quick-links" shadow="never" style="margin-top:20px">
      <template #header><span>快速链接</span></template>
      <el-descriptions :column="1" border>
        <el-descriptions-item v-for="cat in categories" :key="cat.id" :label="cat.name">
          <el-tag type="info" style="margin-right:8px">{{ cat.image_count }}张</el-tag>
          <code class="api-url">{{ cat.api_url }}</code>
          <el-button type="primary" link @click="copyUrl(cat.api_url)">复制</el-button>
        </el-descriptions-item>
        <el-empty v-if="!categories.length" description="暂无分类，请先添加存储源和分类" />
      </el-descriptions>
    </el-card>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage } from 'element-plus'
import api from '../api'
import { formatSize, copyToClipboard } from '../utils'

const stats = ref({ storageCount: 0, categoryCount: 0, imageCount: 0, totalSize: 0 })
const categories = ref([])

onMounted(async () => {
  const [statsRes, catsRes] = await Promise.all([api.get('/stats'), api.get('/categories')])
  if (statsRes.code === 0) stats.value = statsRes.data
  if (catsRes.code === 0) categories.value = catsRes.data
})

async function copyUrl(url) {
  const ok = await copyToClipboard(url)
  ok ? ElMessage.success('已复制') : ElMessage.error('复制失败，请手动复制')
}
</script>

<style scoped>
.stat-card { display: flex; align-items: center; }
.stat-card :deep(.el-card__body) { display: flex; align-items: center; gap: 16px; width: 100%; }
.stat-icon { width: 56px; height: 56px; border-radius: 12px; display: flex; align-items: center; justify-content: center; color: #fff; flex-shrink: 0; }
.stat-value { font-size: 28px; font-weight: 700; color: #303133; }
.stat-label { font-size: 14px; color: #909399; margin-top: 4px; }
.api-url { background: #f5f7fa; padding: 4px 8px; border-radius: 4px; font-size: 13px; color: #606266; }
</style>
