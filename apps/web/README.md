# CreatorOps · Web 管理端

「CreatorOps · 达人合作管理平台」的运营后台前端。覆盖达人主数据、合同审批、项目与内容排期、
结算对账、AI 内容生产与系统管理六大域，是 B 端重表单、重权限、重审计的业务系统。

- 技术栈：React 18 · TypeScript(strict) · Vite 5 · react-router-dom v6 · @tanstack/react-query v5 · axios · echarts
- 样式方案：手写 CSS 设计系统（`src/styles/tokens.css` 令牌 + 组件级 `*.module.css`），不引入 UI 框架
- 目录位置：monorepo 的 `apps/web`，后端为 `apps/api`（NestJS，监听 3100）

## 快速开始

```bash
# 在仓库根目录
pnpm install

# 只起前端（需另开一个终端跑 pnpm dev:api，或直接指向已部署的后端）
pnpm dev:web          # http://localhost:5173

# 类型检查与构建
pnpm --filter @creatorops/web typecheck
pnpm --filter @creatorops/web build
pnpm --filter @creatorops/web preview   # 预览构建产物 http://localhost:4173
```

开发服务器通过 `vite.config.ts` 的 `server.proxy` 把 `/api` 代理到 `http://localhost:3100`，
因此业务代码里永远只写相对路径 `/api/...`；容器化部署时改由 `nginx.conf` 反代到 `http://api:3100`，
前端代码零改动。

### 依赖无法安装时如何验证

若所在环境禁止 `pnpm` 启动子进程（表现为 `spawn EPERM`），可以用工作区里的
`..\..\..\.typecheck` 临时工程做等价的类型校验（用 npm 的内部镜像装依赖，
复制本目录源码后执行与 `build` 相同的 `tsc -b`），细节见该目录的 README。
另有一个零依赖的静态自检脚本，用于检查本地模块路径、CSS Module 类名与未使用导入：

```bash
node scripts/static-check.mjs
```


## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `VITE_API_BASE_URL` | `/api` | 接口前缀。仅在同源部署不成立时才需要覆盖 |

> `VITE_` 前缀变量会被编译进静态产物，禁止写入任何密钥。

## 容器化

```bash
# 仓库根目录，同时构建 api + web
docker compose --profile full up -d --build
# 前端 http://localhost:8080
```

Dockerfile 为两阶段构建：`node:20-alpine` 装依赖并 `vite build`，产物拷进 `nginx:alpine`。
`nginx.conf` 负责三件事：SPA history 路由 fallback（`try_files ... /index.html`）、
`index.html` 不缓存而 `/assets/*` 强缓存、`/api` 反代到 `api:3100`。

## 目录结构

```
apps/web
├─ index.html                 # 挂载点 #root；中文 title
├─ vite.config.ts             # @ → src 别名、/api 代理、sourcemap、echarts 分块
├─ tsconfig.json              # 项目引用入口（build 时 tsc -b）
├─ tsconfig.app.json          # 应用代码：strict + noUnusedLocals
├─ tsconfig.node.json         # 构建脚本（vite.config.ts）
├─ Dockerfile / nginx.conf    # 多阶段构建 + SPA fallback
└─ src
   ├─ main.tsx                # 应用入口：QueryClient + Router + AuthProvider + ToastProvider
   ├─ App.tsx                 # 路由表（懒加载 + 权限守卫）
   ├─ api
   │   ├─ types.ts            # 全部接口契约类型（后端字段命名的唯一事实来源）
   │   ├─ client.ts           # axios 实例、信封解包、401 并发去重刷新、错误码→中文
   │   ├─ auth.ts creators.ts contracts.ts projects.ts contents.ts
   │   ├─ settlements.ts ai.ts dashboard.ts users.ts tags.ts brands.ts audit.ts
   ├─ auth
   │   ├─ AuthContext.tsx     # 登录态、localStorage 持久化、hasPermission
   │   └─ ProtectedRoute.tsx  # 登录 + 权限双重守卫，未授权渲染 403
   ├─ components              # AppLayout / DataTable / Pagination / FilterBar / StatusTag
   │                          # MoneyText / StatCard / Modal / Drawer / ConfirmDialog
   │                          # EmptyState / ErrorBoundary / Toast / LoadingSkeleton / PermissionGate
   ├─ hooks                   # useDebounce / usePermission / useTableQuery
   ├─ pages
   │   ├─ LoginPage.tsx DashboardPage.tsx NotFoundPage.tsx
   │   ├─ creator/            # 列表 / 详情（多 Tab + 状态机）/ 新建编辑（平台账号动态行）
   │   ├─ contract/           # 列表 / 详情（分润规则 + 结算预览 + 审批）/ 拟定
   │   ├─ project/            # 项目列表 / 详情 / 内容排期看板 / 内容详情（AI 脚本 + 合规预检）
   │   ├─ settlement/         # 结算列表（账期 + 金额等宽右对齐）/ 详情（明细 + 计算链路 + 审批打款）
   │   ├─ ai/                 # AI 工作台（结构化脚本时间轴）/ Prompt 模板版本
   │   └─ system/             # 员工与角色权限 / 审计日志 diff / 标签 / 品牌
   ├─ styles
   │   ├─ tokens.css          # 设计令牌：色板、间距、圆角、阴影、字号
   │   └─ global.css          # reset、基础元素、通用工具类（卡片/表格/表单/按钮）
   └─ utils
       ├─ constants.ts        # 枚举中文映射与下拉选项
       ├─ format.ts           # 金额 / 基点比率 / 日期 / 粉丝数 / 文件下载
       └─ permissions.ts      # 权限码常量（与后端 permissions.ts 对齐）
```

## 核心设计说明

### 1. 请求层：信封解包与 401 并发去重刷新

后端所有成功响应都是 `{ success, data, requestId, timestamp }`，`client.ts` 的响应拦截器
直接返回 `data`，因此 `await api.get<T>()` 拿到的就是 `T`，业务层不需要写 `.data.data`。

401 处理的关键在于**并发去重**：页面首屏常同时发 5 个请求，token 过期时它们会同时 401。
若每个请求各自去刷新，会连续打 5 次 `/auth/refresh`，而刷新接口通常会让旧 refreshToken 失效，
结果是「第 2~5 次刷新把第 1 次刚签发的 token 作废」，用户被莫名踢下线。
实现上用一个模块级的 `refreshPromise` 单例：第一个 401 触发刷新，其余请求把
`resolve/reject` 存进等待队列，刷新成功后统一重放原请求；刷新失败则清空登录态并带着
`redirect` 跳登录页。`_retry` 标记保证单个请求最多只重试一次，避免死循环。

错误统一抛 `ApiError`（携带 `code / status / details / requestId`），`code` 映射为中文文案：
`PERMISSION_DENIED` 提示联系管理员，`STATE_CONFLICT` 若 `details.allowedNext` 存在则把
可选下一步拼进提示，便于用户直接照做。

### 2. 权限模型：权限点驱动 UI

权限点常量与后端 RBAC 矩阵一一对应（`utils/permissions.ts`）。菜单、按钮、表格列全部由权限决定：

- 菜单：`AppLayout` 只渲染 `hasPermission` 通过的入口，避免「点进去就 403」的挫败感；
- 按钮：`<PermissionGate permission="contract:approve">` 包裹，无权限时按需渲染禁用态 + tooltip；
- 敏感列：达人手机号/证件号列只有拿到 `creator:sensitive:read` 才展示明文，否则显示后端返回的脱敏值并加锁图标。

前端权限只决定「看不看得到」，真正的拦截仍在后端；界面隐藏是体验优化，不是安全边界。

### 3. 状态机驱动 UI

达人的状态流转按钮**完全来自后端** `statusMachine.allowedNext`，前端不硬编码任何状态选项：

```tsx
statusMachine.allowedNext.map((next) => (
  <Button onClick={() => next.requiresReason ? openReasonDialog(next) : mutate(next.value)}>
    变更为「{next.label}」
  </Button>
))
```

`requiresReason` 为 true（如解约、拉黑）时弹出必填原因对话框。这样后端调整流转矩阵后
前端无需发版即可生效，也杜绝了「渲染一个注定 409 的按钮」。

### 4. 金额与比率：前端不做资金计算

- 金额字段一律是**字符串元**（避免浮点误差），由 `MoneyText` 统一渲染：等宽字体、右对齐、千分位、两位小数，大额自动高亮；
- 比率字段一律是**基点整数**（`1000` = 10%），由 `formatBp` 展示，合同表单实时换算成「平台费/公司/达人/代扣」预览；
- 前端只做展示与校验（如 `platformFeeBp + agencyShareBp <= 10000`），**绝不把前端算出的金额回写后端**，
  结算明细与计算链路一律以后端返回的 `calculationTrace` 为准。

### 5. 三态与防重复提交

所有列表与图表都实现 loading 骨架 / 空状态 / 错误重试三态（`DataTable`、`EmptyState`、`ErrorState`）。
写操作统一：按钮 `loading` 即禁用、AI 任务与结算生成携带 `crypto.randomUUID()` 生成的
`idempotencyKey`，防止网络抖动导致重复建单。编辑/审批成功后 toast 明确提示「已写入审计日志」。

## 与后端对接的约定

- 基址 `/api`，鉴权头 `Authorization: Bearer <accessToken>`；
- 列表统一 `{ items, total, page, pageSize, totalPages, hasNext }`；
- 结算导出 `GET /api/settlements/export` 返回 CSV 文件流，走 `responseType: 'blob'`，**不解包信封**；
- 健康检查 `GET /api/health` 无需鉴权（可用于探活）。
