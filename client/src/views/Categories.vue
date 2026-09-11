<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" @click="openDialog()"><el-icon><Plus /></el-icon>添加分类</el-button>
    </div>

    <el-table :data="categories" v-loading="loading" stripe>
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="slug" label="Slug" width="120">
        <template #default="{ row }"><el-tag type="info">{{ row.slug }}</el-tag></template>
      </el-table-column>
      <el-table-column label="API地址" min-width="240">
        <template #default="{ row }">
          <code class="api-url">{{ row.api_url }}</code>
          <el-button type="primary" link @click="copyUrl(row.api_url)" style="margin-left:4px">复制</el-button>
        </template>
      </el-table-column>
      <el-table-column prop="storage_name" label="存储源" width="120" />
      <el-table-column prop="storage_path" label="存储路径" show-overflow-tooltip />
      <el-table-column prop="image_count" label="图片数" width="80" />
      <el-table-column prop="status" label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="row.status ? 'success' : 'danger'">{{ row.status ? '启用' : '禁用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link @click="openDialog(row)">编辑</el-button>
          <el-button type="danger" link @click="handleDelete(row.id)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑分类' : '添加分类'" width="520px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="如：壁纸" />
        </el-form-item>
        <el-form-item label="Slug" prop="slug">
          <el-input v-model="form.slug" placeholder="如：wallpaper 或 1" />
          <div class="form-tip">URL中的标识，支持字母、数字、下划线、连字符</div>
        </el-form-item>
        <el-form-item label="描述">
          <el-input v-model="form.description" placeholder="可选描述" />
        </el-form-item>
        <el-form-item label="存储源" prop="storage_id">
          <el-select v-model="form.storage_id" style="width:100%" placeholder="选择存储源">
            <el-option v-for="s in selectableStorages" :key="s.id" :label="s.name" :value="s.id" />
          </el-select>
        </el-form-item>
        <el-form-item label="存储路径" prop="storage_path">
          <el-input v-model="form.storage_path" placeholder="如 images/wallpaper/" />
          <div class="form-tip">存储桶中的目录前缀，以/结尾</div>
        </el-form-item>
        <el-form-item label="缓存时间">
          <el-input-number v-model="form.cache_ttl" :min="10" :max="86400" :step="60" />
          <span style="margin-left:8px;color:#909399">秒</span>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dialogVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="handleSave">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, reactive, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'
import { copyToClipboard } from '../utils'

const categories = ref([])
const storages = ref([])
const loading = ref(false)
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref(null)
const formRef = ref()

const form = reactive({
  name: '', slug: '', description: '', storage_id: null, storage_path: '', cache_ttl: 300,
})

// 外链图片（内置演示类型）不支持上传/同步，新建分类时不出现在选项中；
// 但编辑已使用该存储源的分类时仍需显示，避免下拉框空白
const selectableStorages = computed(() =>
  storages.value.filter(s => s.type !== 'external' || s.id === form.storage_id)
)
const rules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  slug: [
    { required: true, message: '请输入slug', trigger: 'blur' },
    { pattern: /^[a-zA-Z0-9_-]+$/, message: '只能包含字母、数字、下划线、连字符', trigger: 'blur' },
  ],
  storage_id: [{ required: true, message: '请选择存储源', trigger: 'change' }],
  storage_path: [{ required: true, message: '请输入存储路径', trigger: 'blur' }],
}

async function load() {
  loading.value = true
  const [catsRes, storagesRes] = await Promise.all([api.get('/categories'), api.get('/storages')])
  if (catsRes.code === 0) categories.value = catsRes.data
  if (storagesRes.code === 0) storages.value = storagesRes.data
  loading.value = false
}

function openDialog(row) {
  if (row) {
    editingId.value = row.id
    Object.assign(form, { name: row.name, slug: row.slug, description: row.description, storage_id: row.storage_id, storage_path: row.storage_path, cache_ttl: row.cache_ttl })
  } else {
    editingId.value = null
    Object.assign(form, { name: '', slug: '', description: '', storage_id: null, storage_path: '', cache_ttl: 300 })
  }
  dialogVisible.value = true
}

async function handleSave() {
  try { await formRef.value.validate() } catch { return }
  saving.value = true
  try {
    if (editingId.value) {
      await api.put(`/categories/${editingId.value}`, form)
      ElMessage.success('更新成功')
    } else {
      await api.post('/categories', form)
      ElMessage.success('添加成功')
    }
    dialogVisible.value = false
    load()
  } catch {} finally {
    saving.value = false
  }
}

async function handleDelete(id) {
  try { await ElMessageBox.confirm('删除分类会同时删除该分类下的所有图片记录，确定？', '确认') } catch { return }
  await api.delete(`/categories/${id}`)
  ElMessage.success('删除成功')
  load()
}

async function copyUrl(url) {
  const ok = await copyToClipboard(url)
  ok ? ElMessage.success('已复制') : ElMessage.error('复制失败，请手动复制')
}

onMounted(load)
</script>

<style scoped>
.toolbar { margin-bottom: 16px; }
.api-url { background: #f5f7fa; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
.form-tip { font-size: 12px; color: #909399; line-height: 1.4; margin-top: 2px; }
</style>
