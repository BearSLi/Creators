import axios, {
  AxiosError,
  type AxiosRequestConfig,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from 'axios';
import type {
  ApiEnvelope,
  ApiErrorBody,
  AuthTokens,
  LoginResponse,
  RefreshRequest,
} from './types';
import { humanizeValidationMessage } from '@/utils/validationMessages';

/**
 * 请求层。
 *
 * 三件事必须在这里一次做对，否则每个页面都要重复写：
 *   1) 信封解包：后端成功响应统一是 { success, data, requestId, timestamp }，
 *      业务代码只想要 data，所以拦截器直接返回 data；
 *   2) 401 并发去重刷新：首屏并发 5 个请求同时 401 时只刷新一次 token 并重放全部失败请求；
 *   3) 错误码 → 中文提示：把后端 code 收敛成 ApiError，页面统一 catch 后 toast。
 */

const ACCESS_TOKEN_KEY = 'creatorops.accessToken';
const REFRESH_TOKEN_KEY = 'creatorops.refreshToken';

/* ============================================================
   错误类型与文案映射
   ============================================================ */

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;
  readonly requestId: string | null;
  /** 字段级校验错误：`{ DTO 字段名: [消息] }`，仅 VALIDATION_FAILED 有值 */
  readonly fieldErrors: Record<string, string[]>;

  constructor(params: {
    code: string;
    message: string;
    status: number;
    details?: unknown;
    fieldErrors?: Record<string, string[]>;
    requestId?: string | null;
  }) {
    super(params.message);
    this.name = 'ApiError';
    this.code = params.code;
    this.status = params.status;
    this.details = params.details ?? null;
    this.fieldErrors = params.fieldErrors ?? {};
    this.requestId = params.requestId ?? null;
  }

  /** 409 状态冲突时后端会带上 allowedNext，用于在提示里告诉用户下一步能做什么 */
  get allowedNext(): Array<{ value: string; label: string }> {
    const details = this.details as { allowedNext?: Array<{ value: string; label: string }> } | null;
    return details?.allowedNext ?? [];
  }

  /**
   * 校验失败的**具体**原因列表（去重），已翻译成中文。
   *
   * 数据源优先取 `details`（后端给的完整扁平消息数组），取不到再退回 `fieldErrors`。
   *
   * 为什么不能只用 `fieldErrors`：有一类校验错误**没有对应的输入框可标红**，
   * 最典型的就是 `forbidNonWhitelisted` 拦下的「多传了未声明字段」
   * （`property status should not exist`）。后端刻意不把它塞进 `fieldErrors`
   * （没有字段可标红），若这里也只读 `fieldErrors`，就会得到空数组，
   * 于是提示又退回「请检查标红字段后重试」—— 用户遇到的原始故障原封不动。
   *
   * 这个坑是实测发现的：构造旧前端 payload 打真实接口，`fieldErrors` 为空，
   * 泛化提示依旧。教训是**「用于标红的字段」和「用于展示的原因」是两件事，不能共用一个来源**。
   *
   * `fieldErrors` 的**键**（字段名）才是做逻辑判断的依据；这里的字符串只用于展示，
   * 因此可以安全地走翻译层（翻译只在展示层生效，不影响任何判断）。
   */
  get validationMessages(): string[] {
    const raw: string[] = Array.isArray(this.details)
      ? (this.details as unknown[]).filter((item): item is string => typeof item === 'string')
      : Object.values(this.fieldErrors).flat();
    return [...new Set(raw.map(humanizeValidationMessage))];
  }
}

const ERROR_CODE_MESSAGES: Record<string, string> = {
  VALIDATION_FAILED: '提交的内容未通过校验，请检查标红字段后重试',
  PERMISSION_DENIED: '你没有该操作权限，可联系系统管理员',
  STATE_CONFLICT: '当前状态不允许该操作，请刷新后按提示的下一步操作',
  DUPLICATE_OPERATION: '该操作已提交过，请勿重复提交',
  RESOURCE_NOT_FOUND: '数据不存在或已被删除',
  RATE_LIMITED: '操作过于频繁，请稍后再试',
  UPSTREAM_UNAVAILABLE: '上游服务暂时不可用，请稍后重试',
  REASON_REQUIRED: '该操作必须填写原因（用于审计追溯）',
  UNAUTHORIZED: '登录状态已失效，请重新登录',
  TOKEN_EXPIRED: '登录状态已过期，请重新登录',
  ACCOUNT_DISABLED: '账号已被停用，请联系系统管理员',
  ACCOUNT_LOCKED: '账号已被锁定，请稍后再试或联系系统管理员',
  INVALID_CREDENTIALS: '邮箱或密码不正确',
  INTERNAL_ERROR: '服务出现异常，请稍后重试或联系系统管理员',
};

const STATUS_FALLBACK_MESSAGES: Record<number, string> = {
  400: '请求参数有误，请检查后重试',
  401: '登录状态已失效，请重新登录',
  403: '你没有该操作权限，可联系系统管理员',
  404: '数据不存在或已被删除',
  409: '当前状态不允许该操作',
  422: '提交的内容未通过校验',
  429: '操作过于频繁，请稍后再试',
  500: '服务出现异常，请稍后重试',
  502: '网关异常，上游服务无响应',
  503: '服务暂时不可用，请稍后重试',
  504: '服务响应超时，请稍后重试',
};

/**
 * 错误码 → 用户可读中文。
 * 冲突类错误会把后端给的 allowedNext 拼进提示，用户不用猜"那我该点哪个"；
 * 校验类错误会把**具体字段原因**拼进提示，用户不用猜"哪个字段错了"。
 */
export function resolveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const base =
      ERROR_CODE_MESSAGES[error.code] ??
      STATUS_FALLBACK_MESSAGES[error.status] ??
      error.message ??
      '操作失败，请稍后重试';

    if (error.code === 'STATE_CONFLICT' && error.allowedNext.length > 0) {
      const options = error.allowedNext.map((item) => `「${item.label}」`).join('、');
      return `${base}。当前可选下一步：${options}`;
    }

    /**
     * VALIDATION_FAILED 必须带上具体原因。
     *
     * 原来的实现直接返回「提交的内容未通过校验，请检查标红字段后重试」，
     * 而前端当时**没有任何地方消费 details 去标红字段** —— 于是这句提示
     * 让用户去看一堆并不存在的红字段，一个 5 秒能解决的问题变成无法自助排查的故障。
     *
     * 现在后端返回结构化的 fieldErrors（DTO 字段名 → 消息），这里把前几条
     * 直接展示出来。即使某个表单尚未接入字段标红，用户至少能看到「错在哪」。
     */
    if (error.code === 'VALIDATION_FAILED') {
      const messages = error.validationMessages;
      if (messages.length > 0) {
        const shown = messages.slice(0, 3);
        const suffix = messages.length > shown.length ? ` 等 ${messages.length} 项` : '';
        return `${shown.join('；')}${suffix}`;
      }
    }

    return base;
  }

  if (error instanceof Error) {
    // 网络层错误（后端未启动 / 断网 / 超时）与业务错误要分开提示，否则用户会误以为是权限问题
    if (error.message.includes('Network Error')) {
      return '网络连接失败，请检查网络或稍后重试';
    }
    if (error.message.includes('timeout')) {
      return '请求超时，请稍后重试';
    }
    return error.message;
  }
  return '操作失败，请稍后重试';
}

/** 业务代码判断"是不是权限不足"时用这个，避免到处比字符串 */
export function isPermissionError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.code === 'PERMISSION_DENIED');
}

/* ============================================================
   token 存储（单一读写入口，方便将来切换到内存 + cookie 方案）
   ============================================================ */

export const tokenStore = {
  getAccessToken(): string | null {
    try {
      return window.localStorage.getItem(ACCESS_TOKEN_KEY);
    } catch {
      // 隐私模式/禁用 storage 时降级为"仅本次会话有效"，不影响主流程
      return null;
    }
  },
  getRefreshToken(): string | null {
    try {
      return window.localStorage.getItem(REFRESH_TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set(tokens: Pick<AuthTokens, 'accessToken' | 'refreshToken'>): void {
    try {
      window.localStorage.setItem(ACCESS_TOKEN_KEY, tokens.accessToken);
      window.localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refreshToken);
    } catch {
      /* 忽略：无法持久化时退化为内存态 */
    }
  },
  clear(): void {
    try {
      window.localStorage.removeItem(ACCESS_TOKEN_KEY);
      window.localStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch {
      /* 忽略 */
    }
  },
};

/* ============================================================
   401 处理：并发去重刷新
   ============================================================ */

/** 刷新成功后由 client 通知 AuthContext 更新内存态用户信息 */
export type RefreshedHandler = (payload: LoginResponse) => void;
/** 刷新失败后由 client 通知 AuthContext 清空登录态并跳转登录页 */
export type UnauthorizedHandler = (reason: string) => void;

let onRefreshed: RefreshedHandler | null = null;
let onUnauthorized: UnauthorizedHandler | null = null;

export function registerAuthHandlers(handlers: {
  onRefreshed?: RefreshedHandler;
  onUnauthorized?: UnauthorizedHandler;
}): void {
  onRefreshed = handlers.onRefreshed ?? null;
  onUnauthorized = handlers.onUnauthorized ?? null;
}

/**
 * 刷新单例。并发 401 的关键：
 * 页面首屏通常同时发 5+ 个请求，若各自去刷新，会连打 5 次 /auth/refresh，
 * 而刷新接口一般会让旧 refreshToken 失效——第 2 次刷新就把第 1 次刚签发的 token 作废，
 * 用户表现为"莫名其妙被踢下线"。这里保证同一时刻只有一个刷新在飞。
 */
let refreshPromise: Promise<string> | null = null;

async function refreshAccessToken(): Promise<string> {
  const refreshToken = tokenStore.getRefreshToken();
  if (!refreshToken) {
    throw new ApiError({
      code: 'UNAUTHORIZED',
      message: '本地没有 refreshToken',
      status: 401,
    });
  }

  // 用裸 axios 而不是 apiClient：刷新请求自己 401 时不能再走一遍拦截器，会无限递归
  const body: RefreshRequest = { refreshToken };
  const response = await axios.post<ApiEnvelope<LoginResponse>>(`${API_BASE_URL}/auth/refresh`, body, {
    headers: { 'Content-Type': 'application/json' },
  });
  const payload = response.data.data;
  tokenStore.set(payload);
  onRefreshed?.(payload);
  return payload.accessToken;
}

function getRefreshPromise(): Promise<string> {
  if (!refreshPromise) {
    refreshPromise = refreshAccessToken().finally(() => {
      // 无论成败都要释放单例，否则失败后永远拿不到新 token
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

/** 登出时调用：打断可能在飞的刷新，避免"已登出却又被刷新回登录态" */
export function abortPendingRefresh(): void {
  refreshPromise = null;
}

/* ============================================================
   axios 实例
   ============================================================ */

export const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '/api';

/** 扩展配置：skipAuth 用于登录/刷新接口，skipUnwrap 用于文件流下载 */
interface RequestConfigExtras {
  skipAuth?: boolean;
  skipUnwrap?: boolean;
  /** 内部标记：已重试过一次，避免"刷新成功但接口仍 401"时无限循环 */
  _retried?: boolean;
}

type InternalConfig = AxiosRequestConfig & RequestConfigExtras;

/**
 * 给 axios config 打内部标记。
 * 为什么不用 config._retried 直接赋值：那属于 any 逃逸，tsc 与 lint 都会失守；
 * 这里统一收口成一个小函数，类型安全且语义清楚。
 */
function markRetried(config: InternalConfig): void {
  config._retried = true;
}

export const apiClient = axios.create({
  baseURL: API_BASE_URL,
  timeout: 30_000,
  headers: { 'Content-Type': 'application/json' },
});

apiClient.interceptors.request.use((config) => {
  const internal = config as InternalAxiosRequestConfig & RequestConfigExtras;
  if (!internal.skipAuth) {
    const token = tokenStore.getAccessToken();
    if (token) {
      // AxiosHeaders 支持 set；不用 headers.Authorization = ... 是为了同时兼容
      // 内部使用 AxiosHeaders 实例与普通对象的两种情形
      internal.headers.set('Authorization', `Bearer ${token}`);
    }
  }
  // 必须返回 axios 的 InternalAxiosRequestConfig，直接返回自定义交叉类型会被 tsc 拒绝
  return internal;
});

apiClient.interceptors.response.use(
  (response: AxiosResponse) => {
    const config = response.config as InternalConfig;
    // 文件流（结算导出 CSV）不是信封结构，原样返回给调用方处理 blob
    if (config.skipUnwrap || response.config.responseType === 'blob') {
      return response;
    }
    const envelope = response.data as ApiEnvelope<unknown> | undefined;
    // 健康检查等少数接口可能不套信封，做兼容而不是抛错
    if (envelope && typeof envelope === 'object' && 'success' in envelope && 'data' in envelope) {
      return envelope.data as never;
    }
    return response.data as never;
  },
  async (error: AxiosError<ApiErrorBody>) => {
    const config = (error.config ?? {}) as InternalAxiosRequestConfig & RequestConfigExtras;
    const status = error.response?.status ?? 0;
    const body = error.response?.data;

    // ---- 401：先刷新再重放原请求 ----
    if (status === 401 && !config.skipAuth && !config._retried) {
      markRetried(config);
      try {
        const newToken = await getRefreshPromise();
        config.headers.set('Authorization', `Bearer ${newToken}`);
        return apiClient.request(config);
      } catch {
        tokenStore.clear();
        onUnauthorized?.('登录状态已过期，请重新登录');
        return Promise.reject(
          new ApiError({
            code: body?.code ?? 'UNAUTHORIZED',
            message: '登录状态已过期，请重新登录',
            status: 401,
          }),
        );
      }
    }

    const code = body?.code ?? (status === 401 ? 'UNAUTHORIZED' : 'INTERNAL_ERROR');
    return Promise.reject(
      new ApiError({
        code,
        message: body?.message ?? error.message ?? '请求失败',
        status: status || 0,
        details: body?.details,
        fieldErrors: body?.fieldErrors,
        requestId: body?.requestId ?? null,
      }),
    );
  },
);

/* ============================================================
   对业务层暴露的薄封装：统一泛型，返回值即 data
   ============================================================ */

export const api = {
  get<T>(url: string, params?: Record<string, unknown>, config?: InternalConfig): Promise<T> {
    return apiClient.get(url, { params, ...config }) as unknown as Promise<T>;
  },
  post<T>(url: string, body?: unknown, config?: InternalConfig): Promise<T> {
    return apiClient.post(url, body, config) as unknown as Promise<T>;
  },
  patch<T>(url: string, body?: unknown, config?: InternalConfig): Promise<T> {
    return apiClient.patch(url, body, config) as unknown as Promise<T>;
  },
  put<T>(url: string, body?: unknown, config?: InternalConfig): Promise<T> {
    return apiClient.put(url, body, config) as unknown as Promise<T>;
  },
  delete<T>(url: string, config?: InternalConfig): Promise<T> {
    return apiClient.delete(url, config) as unknown as Promise<T>;
  },
  /** 文件流下载：绕过信封解包 */
  getBlob(url: string, params?: Record<string, unknown>): Promise<AxiosResponse<Blob>> {
    // axios 的 AxiosRequestConfig 不认识我们的 skipUnwrap 扩展字段，
    // 直接写字面量会触发"多余属性"检查，因此先声明为 InternalConfig 再传
    const config: InternalConfig = { params, responseType: 'blob', skipUnwrap: true };
    return apiClient.get(url, config) as unknown as Promise<AxiosResponse<Blob>>;
  },
};

/**
 * 组装查询参数：空字符串/空数组/null 一律丢弃。
 * 为什么重要：`?status=&keyword=` 这类空参会命中后端校验（IsEnum / IsUUID 对空串报错），
 * 出现"用户没填筛选条件反而报 400"的诡异问题。
 *
 * 参数用泛型约束成 object 而不是 Record<string, unknown>：接口（interface）声明的查询类型
 * 没有隐式索引签名，写成 Record 会让所有 `buildParams(query: CreatorListQuery)` 调用报 TS2345。
 */
export function buildParams<T extends object>(
  source: T | undefined,
): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  if (!source) return result;

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      // 多选筛选统一用逗号连接（status=A,B）：查询串短、易读，
      // 也方便后端用 @Transform 一行拆成数组，避免 [] / 重复 key 两种风格并存
      result[key] = value.join(',');
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      result[key] = value;
    }
  }
  return result;
}

// 数组参数已在 buildParams 里拍平成逗号串，这里无需 axios 默认的 `key[]=v` 风格；
// 显式关掉索引后缀，避免出现 `status[]=A` 这类后端不认识的参数名
apiClient.defaults.paramsSerializer = { indexes: null };
