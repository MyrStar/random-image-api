<template>
  <div>
    <div class="toolbar">
      <el-button type="primary" @click="openDialog()"><el-icon><Plus /></el-icon>添加存储源</el-button>
    </div>

    <el-table :data="storages" v-loading="loading" stripe>
      <el-table-column prop="id" label="ID" width="60" />
      <el-table-column prop="name" label="名称" />
      <el-table-column prop="type" label="类型" width="120">
        <template #default="{ row }">
          <el-tag>{{ typeName(row.type) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="endpoint" label="访问域名" show-overflow-tooltip />
      <el-table-column prop="status" label="状态" width="80">
        <template #default="{ row }">
          <el-tag :type="row.status ? 'success' : 'danger'">{{ row.status ? '启用' : '禁用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="260" fixed="right">
        <template #default="{ row }">
          <el-button type="primary" link @click="testConn(row.id)">测试连接</el-button>
          <el-button type="warning" link @click="openDialog(row)">编辑</el-button>
          <el-button type="danger" link @click="handleDelete(row.id)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <!-- 新增/编辑弹窗 -->
    <el-dialog v-model="dialogVisible" :title="editingId ? '编辑存储源' : '添加存储源'" width="560px" destroy-on-close>
      <el-form ref="formRef" :model="form" :rules="rules" label-width="100px">
        <el-form-item label="名称" prop="name">
          <el-input v-model="form.name" placeholder="如：七牛云主存储" />
        </el-form-item>
        <el-form-item label="存储类型" prop="type">
          <el-select v-model="form.type" style="width:100%">
            <el-option v-for="t in supportedTypes" :key="t.type" :label="t.name" :value="t.type" />
          </el-select>
        </el-form-item>
        <!-- 七牛云配置 -->
        <template v-if="form.type === 'qiniu'">
          <el-form-item label="AccessKey" prop="config.accessKey">
            <el-input v-model="form.config.accessKey" placeholder="七牛云 AccessKey" />
          </el-form-item>
          <el-form-item label="SecretKey" prop="config.secretKey">
            <el-input v-model="form.config.secretKey" type="password" placeholder="七牛云 SecretKey" show-password />
          </el-form-item>
          <el-form-item label="Bucket" prop="config.bucket">
            <el-input v-model="form.config.bucket" placeholder="存储桶名称" />
          </el-form-item>
          <el-form-item label="区域">
            <el-select v-model="form.config.region" style="width:100%" clearable placeholder="选择区域（可选）">
              <el-option label="华东 z0" value="z0" />
              <el-option label="华北 z1" value="z1" />
              <el-option label="华南 z2" value="z2" />
              <el-option label="北美 na0" value="na0" />
              <el-option label="东南亚 as0" value="as0" />
            </el-select>
          </el-form-item>
        </template>

        <!-- 阿里云OSS配置 -->
        <template v-if="form.type === 'aliyun_oss'">
          <el-form-item label="AccessKeyId" prop="config.accessKeyId">
            <el-input v-model="form.config.accessKeyId" placeholder="阿里云 AccessKeyId" />
          </el-form-item>
          <el-form-item label="AccessKeySecret" prop="config.accessKeySecret">
            <el-input v-model="form.config.accessKeySecret" type="password" placeholder="阿里云 AccessKeySecret" show-password />
          </el-form-item>
          <el-form-item label="Bucket" prop="config.bucket">
            <el-input v-model="form.config.bucket" placeholder="存储桶名称" />
          </el-form-item>
          <el-form-item label="区域">
            <el-select v-model="form.config.region" style="width:100%" clearable placeholder="选择区域（可选）">
              <el-option label="华东1-杭州 oss-cn-hangzhou" value="oss-cn-hangzhou" />
              <el-option label="华东2-上海 oss-cn-shanghai" value="oss-cn-shanghai" />
              <el-option label="华北1-青岛 oss-cn-qingdao" value="oss-cn-qingdao" />
              <el-option label="华北2-北京 oss-cn-beijing" value="oss-cn-beijing" />
              <el-option label="华北3-张家口 oss-cn-zhangjiakou" value="oss-cn-zhangjiakou" />
              <el-option label="华北5-呼和浩特 oss-cn-huhehaote" value="oss-cn-huhehaote" />
              <el-option label="华南1-深圳 oss-cn-shenzhen" value="oss-cn-shenzhen" />
              <el-option label="华南2-河源 oss-cn-heyuan" value="oss-cn-heyuan" />
              <el-option label="西南1-成都 oss-cn-chengdu" value="oss-cn-chengdu" />
              <el-option label="中国香港 oss-cn-hongkong" value="oss-cn-hongkong" />
              <el-option label="新加坡 oss-ap-southeast-1" value="oss-ap-southeast-1" />
              <el-option label="东京 oss-ap-northeast-1" value="oss-ap-northeast-1" />
              <el-option label="硅谷 oss-us-west-1" value="oss-us-west-1" />
              <el-option label="弗吉尼亚 oss-us-east-1" value="oss-us-east-1" />
              <el-option label="法兰克福 oss-eu-central-1" value="oss-eu-central-1" />
            </el-select>
          </el-form-item>
        </template>

        <!-- 腾讯云COS配置 -->
        <template v-if="form.type === 'tencent_cos'">
          <el-form-item label="SecretId" prop="config.secretId">
            <el-input v-model="form.config.secretId" placeholder="腾讯云 SecretId" />
          </el-form-item>
          <el-form-item label="SecretKey" prop="config.secretKey">
            <el-input v-model="form.config.secretKey" type="password" placeholder="腾讯云 SecretKey" show-password />
          </el-form-item>
          <el-form-item label="Bucket" prop="config.bucket">
            <el-input v-model="form.config.bucket" placeholder="存储桶名称，如 mybucket-1250000000" />
          </el-form-item>
          <el-form-item label="区域">
            <el-select v-model="form.config.region" style="width:100%" clearable placeholder="选择区域（可选）">
              <el-option label="广州 ap-guangzhou" value="ap-guangzhou" />
              <el-option label="上海 ap-shanghai" value="ap-shanghai" />
              <el-option label="北京 ap-beijing" value="ap-beijing" />
              <el-option label="成都 ap-chengdu" value="ap-chengdu" />
              <el-option label="重庆 ap-chongqing" value="ap-chongqing" />
              <el-option label="南京 ap-nanjing" value="ap-nanjing" />
              <el-option label="香港 ap-hongkong" value="ap-hongkong" />
              <el-option label="新加坡 ap-singapore" value="ap-singapore" />
              <el-option label="东京 ap-tokyo" value="ap-tokyo" />
              <el-option label="硅谷 na-siliconvalley" value="na-siliconvalley" />
              <el-option label="弗吉尼亚 na-ashburn" value="na-ashburn" />
              <el-option label="法兰克福 eu-frankfurt" value="eu-frankfurt" />
            </el-select>
          </el-form-item>
        </template>

        <!-- Cloudflare R2配置 -->
        <template v-if="form.type === 'cloudflare_r2'">
          <el-form-item label="R2 Endpoint" prop="config.endpoint">
            <el-input v-model="form.config.endpoint" placeholder="https://{account_id}.r2.cloudflarestorage.com" />
          </el-form-item>
          <el-form-item label="AccessKeyId" prop="config.accessKeyId">
            <el-input v-model="form.config.accessKeyId" placeholder="R2 API Token AccessKeyId" />
          </el-form-item>
          <el-form-item label="SecretAccessKey" prop="config.secretAccessKey">
            <el-input v-model="form.config.secretAccessKey" type="password" placeholder="R2 API Token SecretAccessKey" show-password />
          </el-form-item>
          <el-form-item label="Bucket" prop="config.bucket">
            <el-input v-model="form.config.bucket" placeholder="R2 存储桶名称" />
          </el-form-item>
          <el-form-item label="公共域名">
            <el-input v-model="form.config.publicDomain" placeholder="如 pub-xxx.r2.dev（需在R2控制台开启公共访问）" />
            <div style="font-size:12px;color:#909399;margin-top:2px">R2.dev 公共访问域名，需在 R2 设置中开启</div>
          </el-form-item>
        </template>

        <!-- MinIO配置 -->
        <template v-if="form.type === 'minio'">
          <el-form-item label="服务地址" prop="config.endPoint">
            <el-input v-model="form.config.endPoint" placeholder="如 https://minio.example.com 或 192.168.1.100" />
          </el-form-item>
          <el-form-item label="端口">
            <el-input v-model="form.config.port" placeholder="默认: HTTPS=443, HTTP=80" />
          </el-form-item>
          <el-form-item label="AccessKey" prop="config.accessKey">
            <el-input v-model="form.config.accessKey" placeholder="MinIO AccessKey" />
          </el-form-item>
          <el-form-item label="SecretKey" prop="config.secretKey">
            <el-input v-model="form.config.secretKey" type="password" placeholder="MinIO SecretKey" show-password />
          </el-form-item>
          <el-form-item label="Bucket" prop="config.bucket">
            <el-input v-model="form.config.bucket" placeholder="存储桶名称" />
          </el-form-item>
          <el-form-item label="使用SSL">
            <el-switch v-model="form.config.useSSL" />
          </el-form-item>
        </template>
        <el-form-item label="访问域名" prop="endpoint">
          <el-input v-model="form.endpoint" placeholder="如 https://cdn.example.com" />
          <div class="form-tip">生成公开图片 URL 用的域名（可以套外部 CDN）</div>
        </el-form-item>
        <el-form-item label="源站域名">
          <el-input v-model="form.origin_domain" placeholder="可选，如 https://cdn2.example.com" />
          <div class="form-tip">访问域名套了外部 CDN 时填写回源的存储域名：服务端取图（缩放/修复尺寸）直连源站，不受外部 CDN 稳定性影响；用户访问仍走外部 CDN</div>
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
import { ref, reactive, onMounted, watch } from 'vue'
import { ElMessage, ElMessageBox } from 'element-plus'
import api from '../api'

const storages = ref([])
const supportedTypes = ref([])
const loading = ref(false)
const dialogVisible = ref(false)
const saving = ref(false)
const editingId = ref(null)
const formRef = ref()

const configDefaults = {
  qiniu: () => ({ accessKey: '', secretKey: '', bucket: '', region: '' }),
  aliyun_oss: () => ({ accessKeyId: '', accessKeySecret: '', bucket: '', region: '' }),
  tencent_cos: () => ({ secretId: '', secretKey: '', bucket: '', region: '' }),
  cloudflare_r2: () => ({ endpoint: '', accessKeyId: '', secretAccessKey: '', bucket: '', publicDomain: '' }),
  minio: () => ({ endPoint: '', port: '', accessKey: '', secretKey: '', bucket: '', useSSL: true }),
}

const form = reactive({
  name: '',
  type: 'qiniu',
  config: configDefaults.qiniu(),
  endpoint: '',
  origin_domain: '',
})

// 切换存储类型时重置配置
watch(() => form.type, (newType) => {
  if (!editingId.value) {
    const factory = configDefaults[newType] || configDefaults.qiniu
    Object.assign(form.config, factory())
  }
})

const rules = {
  name: [{ required: true, message: '请输入名称', trigger: 'blur' }],
  type: [{ required: true, message: '请选择类型', trigger: 'change' }],
}

const typeNames = { qiniu: '七牛云', aliyun_oss: '阿里云OSS', tencent_cos: '腾讯云COS', cloudflare_r2: 'R2', minio: 'MinIO' }
function typeName(type) { return typeNames[type] || type }

async function load() {
  loading.value = true
  const [storagesRes, typesRes] = await Promise.all([api.get('/storages'), api.get('/storages/types')])
  if (storagesRes.code === 0) storages.value = storagesRes.data
  if (typesRes.code === 0) supportedTypes.value = typesRes.data
  loading.value = false
}

async function openDialog(row) {
  if (row) {
    editingId.value = row.id
    form.name = row.name
    form.type = row.type
    form.endpoint = row.endpoint || ''
    // 编辑时必须从详情接口拉取（脱敏后的）配置回填。
    // 列表接口不返回 config，若用空对象回填，保存时会把已保存的密钥覆盖为空
    const factory = configDefaults[row.type] || configDefaults.qiniu
    let savedConfig = {}
    let savedOrigin = row.origin_domain
    try {
      const res = await api.get(`/storages/${row.id}`)
      if (res.code === 0 && res.data?.config) savedConfig = res.data.config
      if (res.code === 0) savedOrigin = res.data?.origin_domain ?? savedOrigin
    } catch { /* 拉取失败时仍允许编辑非敏感字段，服务端会跳过空敏感字段 */ }
    form.config = { ...factory(), ...savedConfig }
    form.origin_domain = savedOrigin || ''
  } else {
    editingId.value = null
    form.name = ''
    form.type = 'qiniu'
    form.endpoint = ''
    form.origin_domain = ''
    form.config = configDefaults.qiniu()
  }
  dialogVisible.value = true
}

async function handleSave() {
  await formRef.value.validate()
  saving.value = true
  try {
    const data = { ...form }
    if (editingId.value) {
      await api.put(`/storages/${editingId.value}`, data)
      ElMessage.success('更新成功')
    } else {
      await api.post('/storages', data)
      ElMessage.success('添加成功')
    }
    dialogVisible.value = false
    load()
  } catch {} finally {
    saving.value = false
  }
}

async function testConn(id) {
  const res = await api.post(`/storages/${id}/test`)
  if (res.code === 0 && res.data.success) {
    ElMessage.success(res.data.message)
  } else {
    ElMessage.error(res.data?.message || '测试失败')
  }
}

async function handleDelete(id) {
  await ElMessageBox.confirm('确定删除该存储源？', '确认')
  await api.delete(`/storages/${id}`)
  ElMessage.success('删除成功')
  load()
}

onMounted(load)
</script>

<style scoped>
.toolbar { margin-bottom: 16px; }
</style>
