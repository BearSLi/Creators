import axios from 'axios';
import { api, API_BASE_URL, tokenStore } from './client';
import type {
  ApiEnvelope,
  AuthTokens,
  ChangePasswordRequest,
  ChangePasswordResponse,
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  ProfileResponse,
} from './types';

/**
 * 认证接口。
 *
 * login / refresh 故意绕过 apiClient：它们必须在"还没有 token"或"token 已失效"时可用，
 * 若走带 401 拦截器的实例，刷新失败会再次触发刷新，形成递归。
 */

/** 登录：成功后立刻落盘 token，后续请求拦截器才能带上 Authorization */
export async function login(body: LoginRequest): Promise<LoginResponse> {
  const response = await axios.post<ApiEnvelope<LoginResponse>>(`${API_BASE_URL}/auth/login`, body, {
    headers: { 'Content-Type': 'application/json' },
  });
  const payload = response.data.data;
  tokenStore.set(payload);
  return payload;
}

export function logout(): Promise<LogoutResponse> {
  // 登出接口需要带上当前 accessToken 才能定位会话，因此走 apiClient（不 skipAuth）
  return api.post<LogoutResponse>('/auth/logout');
}

export function getProfile(): Promise<ProfileResponse> {
  return api.get<ProfileResponse>('/auth/profile');
}

export function changePassword(body: ChangePasswordRequest): Promise<ChangePasswordResponse> {
  return api.patch<ChangePasswordResponse>('/auth/password', body);
}

/** 供 AuthContext 在启动时判断"本地是否有一份可能可用的会话" */
export function readStoredTokens(): Pick<AuthTokens, 'accessToken' | 'refreshToken'> | null {
  const accessToken = tokenStore.getAccessToken();
  const refreshToken = tokenStore.getRefreshToken();
  if (!accessToken && !refreshToken) return null;
  return { accessToken: accessToken ?? '', refreshToken: refreshToken ?? '' };
}

export function clearStoredTokens(): void {
  tokenStore.clear();
}
