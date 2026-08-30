<template>
  <div class="images-page">
    <!-- 顶部工具栏 -->
    <div class="toolbar">
      <el-select v-model="selectedCategory" placeholder="选择分类" clearable style="width:200px" @change="loadImages">
        <el-option v-for="c in categories" :key="c.id" :label="`${c.name} (${c.image_count})`" :value="c.id" />
      </el-select>
      <div class="toolbar-right">
        <el-button type="success" @click="showUpload = true; uploadFiles = []" :disabled="!selectedCategory"><el-icon><Upload /></el-icon>上传图片</el-button>
        <el-button type="primary" @click="syncFromStorage" :disabled="!selectedCategory" :loading="syncing"><el-icon><Refresh /></el-icon>从存储源同步</el-button>
        <el-button type="warning" @click="fixDimensions" :loading="fixing"><el-icon><SetUp /></el-icon>修复尺寸</el-button>
        <el-button type="danger" @click="batchDelete" :disabled="!selectedIds.length"><el-icon><Delete /></el-icon>删除选中 ({{ selectedIds.length }})</el-button>
      </div>
    </div>

    <!-- 图片网格 -->
    <div class="image-grid" v-loading="loading">
      <div v-for="img in images" :key="img.id" class="image-card" :class="{ selected: selectedIds.includes(img.id) }" @click="toggleSelect(img.id)">
        <div class="image-checkbox">
          <el-checkbox :model-value="selectedIds.includes(img.id)" @click.stop @change="toggleSelect(img.id)" />
        </div>
        <div class="image-thumb" @click.stop="previewImage(img)">
          <img :src="img.url" :alt="img.filename" loading="lazy" @load="onImgLoad(img, $event)" />
        </div>
        <div class="image-info">
          <div class="image-name" :title="img.filename">{{ img.filename }}</div>
          <div class="image-meta">
            {{ img.width }}×{{ img.height }} · {{ formatSize(img.size) }}
          </div>
        </div>
        <div class="image-actions">
          <el-button type="primary" link size="small" @click.stop="copyUrl(img.url)">复制链接</el-button>
          <el-button type="danger" link size="small" @click.stop="deleteOne(img.id)">删除</el-button>
        </div>
      </div>
      <el-empty v-if="!loading && !images.length" :description="selectedCategory ? '该分类下暂无图片' : '请先选择一个分类'" />
    </div>

    <!-- 分页 -->
    <div class="pagination" v-if="total > pageSize">
      <el-pagination
        v-model:current-page="currentPage"
        :page-size="pageSize"
        :total="total"
        layout="prev, pager, next"
        @current-change="loadImages"
      />
    </div>

    <!-- 图片预览弹窗 -->
    <el-dialog v-model="previewVisible" width="auto" destroy-on-close custom-class="preview-dialog">
      <div class="preview-container">
        <img :src="previewImg?.url" class="preview-img" @load="onImgLoad(previewImg, $event)" />
      </div>
      <div class="preview-info" v-if="previewImg">
        <el-descriptions :column="2" size="small" border>
          <el-descriptions-item label="文件名">{{ previewImg.filename }}</el-descriptions-item>
          <el-descriptions-item label="大小">{{ formatSize(previewImg.size) }}</el-descriptions-item>
          <el-descriptions-item label="尺寸">{{ previewImg.width }} × {{ previewImg.height }}</el-descriptions-item>
          <el-descriptions-item label="类型">{{ previewImg.mime_type }}</el-descriptions-item>
          <el-descriptions-item label="URL" :span="2">
            <el-input :model-value="previewImg.url" readonly size="small">
              <template #append>
                <el-button @click="copyUrl(previewImg.url)">复制</el-button>
              </template>
            </el-input>
          </el-descriptions-item>
        </el-descriptions>
      </div>
    </el-dialog>

    <!-- 上传弹窗 -->
    <el-dialog v-model="showUpload" title="上传图片" width="520px" destroy-on-close @close="uploadFiles = []">
      <el-upload
        ref="uploadRef"
        drag
        multiple
        :auto-upload="false"
        :on-change="onFileChange"
        accept="image/*"
        list-type="picture-card"
        v-model:file-list="uploadFiles"
      >
        <el-icon :size="40"><Upload /></el-icon>
        <div style="margin-top:8px">拖拽文件到此处，或<em>点击上传</em></div>
      </el-upload>
      <div class="upload-tip">单文件最大 {{ uploadLimits.maxSizeMB }}MB，单次最多 {{ uploadLimits.maxFiles }} 个文件</div>
      <template #footer>
        <el-button @click="showUpload = false">取消</el-button>
        <el-button type="primary" :loading="uploading" @click="doUpload">开始上传</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { formatSize, copyToClipboard } from '../utils'

const categories = ref([])
const images = ref([])
const selectedCategory = ref(null)
const selectedIds = ref([])
const loading = ref(false)
const syncing = ref(false)
const fixing = ref(false)
const currentPage = ref(1)
const pageSize = 40
const total = ref(0)

const previewVisible = ref(false)
const previewImg = ref(null)
const showUpload = ref(false)
const uploading = ref(false)
const uploadFiles = ref([])
const pendingDimensions = ref([])

// 服务端上传限制（系统设置中可改，这里同步用于前端预校验）
const uploadLimits = ref({ maxSizeMB: 50, maxFiles: 20 })

async function loadUploadLimits() {
  try {
    const res = await api.get('/settings')
    if (res.code === 0) {
      uploadLimits.value = {
        maxSizeMB: res.data.settings.uploadMaxSize || 50,
        maxFiles: res.data.settings.uploadMaxFiles || 20,
      }
    }
  } catch { /* 使用默认值 */ }
}

async function loadCategories() {
  const res = await api.get('/categories')
  if (res.code === 0) categories.value = res.data
}

async function loadImages() {
  if (!selectedCategory.value) { images.value = []; total.value = 0; return }
  loading.value = true
  selectedIds.value = []
  try {
    const res = await api.get(`/images?category_id=${selectedCategory.value}&page=${currentPage.value}&size=${pageSize}`)
    if (res.code === 0) {
      images.value = res.data.items
      total.value = res.data.total
    }
  } finally {
    loading.value = false
  }
}

function toggleSelect(id) {
  const idx = selectedIds.value.indexOf(id)
  if (idx >= 0) selectedIds.value.splice(idx, 1)
  else selectedIds.value.push(id)
}

function previewImage(img) {
  previewImg.value = img
  previewVisible.value = true
}

async function copyUrl(url) {
  const ok = await copyToClipboard(url)
  ok ? ElMessage.success('已复制') : ElMessage.error('复制失败，请手动复制')
}

async function deleteOne(id) {
  try { await ElMessageBox.confirm('确定删除这张图片？', '确认') } catch { return }
  await api.delete(`/images/${id}`)
  ElMessage.success('删除成功')
  loadImages()
}

async function batchDelete() {
  try { await ElMessageBox.confirm(`确定删除选中的 ${selectedIds.value.length} 张图片？`, '确认') } catch { return }
  const res = await api.post('/images/batch-delete', { ids: selectedIds.value })
  ElMessage.success(res.message)
  loadImages()
}

async function syncFromStorage() {
  syncing.value = true
  try {
    const res = await api.post('/images/sync', { category_id: selectedCategory.value })
    ElMessage.success(res.message)
    loadImages()
    loadCategories()
  } catch {} finally {
    syncing.value = false
  }
}

async function fixDimensions() {
  const scoped = !!selectedCategory.value
  try {
    await ElMessageBox.confirm(
      '将下载尺寸为 0×0 的图片并解析其宽高信息。\n\n' +
      '💡 什么时候需要用？\n' +
      '• 从存储源同步图片后（同步只获取文件列表，不下载图片内容，所以无法解析尺寸）\n' +
      '• 直接上传的图片不受影响，上传时会自动解析尺寸\n\n' +
      (scoped
        ? `⚠️ 将只处理当前分类下的图片，图片较多时可能需要一些时间。`
        : '⚠️ 未选择分类，将处理所有分类下的图片，图片较多时可能需要较长时间。建议先选择分类再修复。'),
      '修复图片尺寸',
      { confirmButtonText: '开始修复', cancelButtonText: '取消', type: 'warning' }
    )
  } catch { return }
  fixing.value = true
  try {
    const payload = scoped ? { category_id: selectedCategory.value } : {}
    const res = await api.post('/images/fix-dimensions', payload, { timeout: 600000 })
    ElMessage.success(res.message || `修复完成：共${res.data.total}张，成功${res.data.fixed}张，失败${res.data.failed}张`)
    // 失败时展示具体原因，便于定位（网络/防盗链/格式等）
    if (res.data?.failed > 0) {
      const reasons = (res.data.errors || []).map(e => `${e.filename}：${e.reason}`).join('\n')
      ElMessageBox.alert(
        (reasons || '原因未返回') + (res.data.failed > (res.data.errors?.length || 0) ? `\n……等共 ${res.data.failed} 张失败` : ''),
        `失败 ${res.data.failed} 张，原因如下`,
        { type: 'warning', customStyle: { whiteSpace: 'pre-line', wordBreak: 'break-all' } }
      ).catch(() => {})
    }
    loadImages()
  } catch {} finally {
    fixing.value = false
  }
}

function onImgLoad(img, ev) {
  // 浏览器能加载图片而服务器不一定能，预览加载成功后自动回填 0×0 记录的真实宽高
  if (!img || img.width !== 0 || img.height !== 0) return
  const w = ev.target?.naturalWidth
  const h = ev.target?.naturalHeight
  if (!(w > 0) || !(h > 0)) return
  img.width = w
  img.height = h
  if (!pendingDimensions.value.some(d => d.id === img.id)) {
    pendingDimensions.value.push({ id: img.id, width: w, height: h })
  }
  scheduleDimensionFlush()
}

let dimensionFlushTimer = null
function scheduleDimensionFlush() {
  clearTimeout(dimensionFlushTimer)
  dimensionFlushTimer = setTimeout(flushDimensions, 2000)
}

async function flushDimensions() {
  if (!pendingDimensions.value.length) return
  const items = pendingDimensions.value.splice(0)
  try {
    await api.post('/images/set-dimensions', { items })
  } catch { /* 服务器保存失败不影响浏览，下次加载会再次尝试 */ }
}

function onFileChange(file) {
  // 与服务端限制同步的预校验，不合格的文件直接从列表移除
  const maxBytes = uploadLimits.value.maxSizeMB * 1024 * 1024
  if (file.raw && file.raw.size > maxBytes) {
    uploadFiles.value = uploadFiles.value.filter(f => f.uid !== file.uid)
    ElMessage.error(`「${file.name}」超过单文件 ${uploadLimits.value.maxSizeMB}MB 限制，已移除`)
    return
  }
  if (uploadFiles.value.length > uploadLimits.value.maxFiles) {
    uploadFiles.value = uploadFiles.value.filter(f => f.uid !== file.uid)
    ElMessage.error(`单次最多上传 ${uploadLimits.value.maxFiles} 个文件`)
  }
}

async function doUpload() {
  if (!uploadFiles.value.length) return ElMessage.warning('请先选择文件')
  uploading.value = true
  try {
    const formData = new FormData()
    formData.append('category_id', selectedCategory.value)
    uploadFiles.value.forEach(f => f.raw && formData.append('files', f.raw))
    const res = await api.post('/images', formData, { headers: { 'Content-Type': 'multipart/form-data' } })
    // 逐文件结果：失败明细弹窗展示
    const failed = (res.data || []).filter(r => !r.success)
    if (failed.length) {
      ElMessageBox.alert(
        failed.map(f => `${f.filename}：${f.error}`).join('\n'),
        `上传结果：${res.message}`,
        { type: 'warning', customStyle: { whiteSpace: 'pre-line' } }
      )
    } else {
      ElMessage.success(res.message)
    }
    showUpload.value = false
    uploadFiles.value = []
    loadImages()
    loadCategories()
  } catch {} finally {
    uploading.value = false
  }
}

onMounted(() => {
  loadCategories()
  loadUploadLimits()
})
</script>

<style scoped>
.toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 8px; }
.toolbar-right { display: flex; gap: 8px; }

.image-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; min-height: 200px; }

.image-card { background: #fff; border-radius: 8px; overflow: hidden; border: 2px solid transparent; cursor: pointer; transition: all 0.2s; position: relative; }
.image-card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
.image-card.selected { border-color: #409eff; }

.image-checkbox { position: absolute; top: 8px; left: 8px; z-index: 2; background: rgba(255,255,255,0.8); border-radius: 4px; padding: 2px; }

.image-thumb { width: 100%; height: 160px; overflow: hidden; display: flex; align-items: center; justify-content: center; background: #f5f7fa; }
.image-thumb img { width: 100%; height: 100%; object-fit: cover; }

.image-info { padding: 8px 10px; }
.image-name { font-size: 13px; color: #303133; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.image-meta { font-size: 12px; color: #909399; margin-top: 2px; }

.image-actions { padding: 0 10px 8px; display: flex; gap: 8px; }

.pagination { display: flex; justify-content: center; margin-top: 20px; }

.preview-container { text-align: center; max-height: 70vh; overflow: auto; }
.preview-img { max-width: 100%; max-height: 65vh; object-fit: contain; }
.preview-info { margin-top: 16px; }

.upload-tip { font-size: 12px; color: #909399; margin-top: 8px; }
</style>
