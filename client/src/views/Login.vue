<template>
  <el-card class="login-card" shadow="always">
    <div class="login-title">
      <el-icon :size="32"><Picture /></el-icon>
      <h2>随机图片API管理后台</h2>
    </div>
    <el-form ref="formRef" :model="form" :rules="rules" @keyup.enter="handleLogin">
      <el-form-item prop="username">
        <el-input v-model="form.username" placeholder="用户名" :prefix-icon="User" size="large" />
      </el-form-item>
      <el-form-item prop="password">
        <el-input v-model="form.password" type="password" placeholder="密码" :prefix-icon="Lock" size="large" show-password />
      </el-form-item>
      <el-form-item>
        <el-button type="primary" size="large" style="width:100%" :loading="loading" @click="handleLogin">登 录</el-button>
      </el-form-item>
    </el-form>
  </el-card>
</template>

<script setup>
import { ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { User, Lock } from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import api from '../api'

const router = useRouter()
const formRef = ref()
const loading = ref(false)
const form = ref({ username: '', password: '' })
const rules = {
  username: [{ required: true, message: '请输入用户名', trigger: 'blur' }],
  password: [{ required: true, message: '请输入密码', trigger: 'blur' }],
}

async function handleLogin() {
  try { await formRef.value.validate() } catch { return }
  loading.value = true
  try {
    const res = await api.post('/login', form.value)
    if (res.code === 0) {
      localStorage.setItem('token', res.data.token)
      localStorage.setItem('username', res.data.user)
      ElMessage.success('登录成功')
      router.push('/admin/dashboard')
    }
  } catch {} finally {
    loading.value = false
  }
}
</script>

<style scoped>
.login-card {
  width: 400px;
  padding: 20px;
}
.login-title {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  margin-bottom: 30px;
  color: #303133;
}
</style>
