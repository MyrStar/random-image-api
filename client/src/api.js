import axios from 'axios'
import { ElMessage } from 'element-plus'

const api = axios.create({
  baseURL: '/admin/api',
  timeout: 60000,
})

// 请求拦截器 - 添加token
api.interceptors.request.use(config => {
  const token = localStorage.getItem('token')
  if (token) {
    config.headers.Authorization = `Bearer ${token}`
  }
  return config
})

// 响应拦截器
api.interceptors.response.use(
  response => response.data,
  error => {
    const msg = error.response?.data?.message || error.message || '请求失败'
    const status = error.response?.status
    const isLoginRequest = error.config?.url?.includes('/login')
    const onLoginPage = window.location.pathname.startsWith('/admin/login')

    if (status === 401 && !isLoginRequest && !onLoginPage) {
      // 仅在"已登录会话失效"时跳转登录页；登录接口本身的 401 交给页面展示错误
      localStorage.removeItem('token')
      window.location.href = '/admin/'
    } else {
      ElMessage.error(msg)
    }
    return Promise.reject(error)
  }
)

export default api
