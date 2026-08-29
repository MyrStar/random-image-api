<template>
  <div class="db-page">
    <!-- 表选择 -->
    <el-tabs v-model="activeTable" @tab-change="onTableChange">
      <el-tab-pane v-for="t in tables" :key="t.name" :label="`${t.name} (${t.count})`" :name="t.name" />
    </el-tabs>

    <!-- 工具栏 -->
    <div class="toolbar">
      <el-input v-model="searchText" placeholder="搜索..." clearable style="width:240px" @clear="loadData" @keyup.enter="loadData">
        <template #append><el-button @click="loadData"><el-icon><Search /></el-icon></el-button></template>
      </el-input>
      <el-button @click="loadData"><el-icon><Refresh /></el-icon>刷新</el-button>
    </div>

    <!-- 数据表格 -->
    <el-table :data="rows" v-loading="loading" stripe border size="small" max-height="calc(100vh - 300px)">
      <el-table-column v-for="col in columns" :key="col" :prop="col" :label="col" :min-width="col === 'config' || col === 'url' || col === 'storage_key' ? 200 : 100" show-overflow-tooltip>
        <template #default="{ row }">
          <template v-if="col === 'config'">
            <el-tag type="info" size="small">[加密]</el-tag>
          </template>
          <template v-else-if="col === 'status'">
            <el-tag :type="row[col] ? 'success' : 'danger'" size="small">{{ row[col] ? '启用' : '禁用' }}</el-tag>
          </template>
          <template v-else-if="col === 'url' && row[col]">
            <a :href="row[col]" target="_blank" style="color:#409eff;font-size:12px" @click.stop>{{ row[col] }}</a>
          </template>
          <template v-else>
            {{ row[col] }}
          </template>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="140" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link size="small" @click="openEdit(row)">编辑</el-button>
          <el-button type="danger" link size="small" @click="handleDelete(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 分页 -->
    <div class="pagination" v-if="total > pageSize">
      <el-pagination v-model:current-page="currentPage" :page-size="pageSize" :total="total" layout="total, prev, pager, next" @current-change="loadData" />
    </div>

    <!-- 编辑弹窗 -->
    <el-dialog v-model="editVisible" title="编辑记录" width="600px" destroy-on-close>
      <el-form label-width="120px">
        <el-form-item v-for="col in editableColumns" :key="col" :label="col">
          <el-input v-model="editForm[col]" :disabled="col === 'id' || col === 'created_at' || col === 'updated_at' || col === 'config'" />
          <div v-if="col === 'config'" class="form-tip">加密字段，请通过专用管理页面修改存储源配置</div>
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="editVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="saveEdit">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const tables = ref([])
const activeTable = ref('')
const columns = ref([])
const rows = ref([])
const total = ref(0)
const loading = ref(false)
const searchText = ref('')
const currentPage = ref(1)
const pageSize = 50

const editVisible = ref(false)
const editForm = ref({})
const saving = ref(false)

// 排除不可编辑的列
const editableColumns = computed(() => columns.value.filter(c => c !== 'created_at' && c !== 'updated_at'))

async function loadTables() {
  const res = await api.get('/db/tables')
  if (res.code === 0) {
    tables.value = res.data
    if (res.data.length) activeTable.value = res.data[0].name
    loadData()
  }
}

async function loadData() {
  if (!activeTable.value) return
  loading.value = true
  try {
    const params = `?page=${currentPage.value}&size=${pageSize}${searchText.value ? '&search=' + encodeURIComponent(searchText.value) : ''}`
    const res = await api.get(`/db/${activeTable.value}${params}`)
    if (res.code === 0) {
      columns.value = res.data.columns
      rows.value = res.data.items
      total.value = res.data.total
    }
  } finally {
    loading.value = false
  }
}

function onTableChange() {
  currentPage.value = 1
  searchText.value = ''
  loadData()
}

function openEdit(row) {
  editForm.value = { ...row }
  editVisible.value = true
}

async function saveEdit() {
  saving.value = true
  try {
    await api.put(`/db/${activeTable.value}/${editForm.value.id}`, editForm.value)
    ElMessage.success('更新成功')
    editVisible.value = false
    loadData()
    loadTables()
  } catch {} finally {
    saving.value = false
  }
}

async function handleDelete(row) {
  const tips = {
    categories: '将同时删除该分类下的所有图片记录及存储中的对应文件（与分类管理页的删除行为一致）',
    images: '将同时删除存储源中的对应文件',
  }
  const extra = tips[activeTable.value] ? `\n\n注意：${tips[activeTable.value]}` : ''
  await ElMessageBox.confirm(`确定删除 ${activeTable.value} 表中 ID=${row.id} 的记录？${extra}`, '确认')
  await api.delete(`/db/${activeTable.value}/${row.id}`)
  ElMessage.success('删除成功')
  loadData()
  loadTables()
}

onMounted(loadTables)
</script>

<style scoped>
.toolbar { display: flex; gap: 12px; margin-bottom: 12px; align-items: center; }
.pagination { display: flex; justify-content: center; margin-top: 16px; }
.form-tip { font-size: 12px; color: #e6a23c; line-height: 1.4; margin-top: 2px; }
</style>
