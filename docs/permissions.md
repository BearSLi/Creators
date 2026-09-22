# 权限设计说明

> 权限是内部系统最容易「看起来做了、实际上漏着」的部分。本文把 CreatorOps 的权限模型、完整矩阵、以及「怎么安全地新增一个权限点」写清楚，便于评审与交接。

---

## 1. 三级校验模型

很多人把权限理解成「这个角色能不能进这个接口」，这在内部工具里不够用。CreatorOps 的权限判定分三级，**任何一级缺失都会造成真实事故**：

```
请求
 │
 ├─ 第 1 级：功能权限（PermissionsGuard）
 │    「这个角色能不能调用这个接口」
 │    实现：Controller 上 @RequirePermissions(PERMISSIONS.CREATOR_DELETE)
 │    失败：403 PERMISSION_DENIED
 │
 ├─ 第 2 级：数据范围（buildScopeFilter）
 │    「能看/能改哪些行的数据」
 │    实现：Service 层把范围条件展开进 Prisma where
 │    规则：ALL（全部）/ TEAM（本团队）/ OWN（仅自己负责）
 │    典型场景：商务只能看到自己负责的达人，防止互相挖客户
 │
 └─ 第 3 级：资源归属（assertOwnership）
      「这一条具体数据是不是你的」
     实现：Service 层对单条记录显式调用
     为什么不能省：列表接口过滤了 ≠ 详情接口安全。
     攻击/误操作路径是「猜一个别人的 UUID 直接访问详情」，
     所以详情/编辑/删除必须重新校验归属。
```

**为什么必须三级**：「能进行人列表」不等于「能看全部达人的结算金额」。把权限点拆到动作级（读 / 写 / 导出 / 查看敏感信息 / 审批 / 打款），才能表达业务上真实的差异。

---

## 2. 角色数据范围

| 角色 | 数据范围 | 理由 |
| --- | --- | --- |
| SUPER_ADMIN 系统管理员 | ALL | 系统兜底，需要能看到全部数据排障 |
| OPERATIONS 运营 | ALL | 需要跨团队调度达人与内容资源 |
| BD 商务 | **OWN** | 客户资源归属个人，防止商务之间互相看到并接触对方达人 |
| CONTENT 内容 | ALL | 内容制作需要看全量达人与项目信息 |
| FINANCE 财务 | ALL | 结算需要对全量资金数据做核对 |
| AUDITOR 审计（只读） | ALL | 审计需要看到全部操作与数据，但无任何写权限 |

范围映射表定义在 `apps/api/src/modules/auth/permissions.ts#ROLE_DATA_SCOPE`，并有单元测试保证「只有商务是 OWN 范围」（防止误把运营限制成只看自己）。

---

## 3. 完整权限矩阵

> 图例：✅ 有权限　—　无权限　※ 仅管理员专属

| 权限点 | 说明 | 风险 | 管理员 | 运营 | 商务 | 内容 | 财务 | 审计 |
| --- | --- | --- | :---: | :---: | :---: | :---: | :---: | :---: |
| `creator:read` | 查看达人 | 低 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `creator:write` | 新建/编辑达人 | 低 | ✅ | ✅ | ✅ | — | — | — |
| `creator:delete` | 删除达人 | 高 | ✅ ※ | — | — | — | — | — |
| `creator:export` | 导出达人数据 | 高 | ✅ | ✅ | — | — | — | ✅ |
| `creator:sensitive:read` | 查看敏感信息（真名/手机号/证件号） | 高 | ✅ | ✅ | — | — | — | ✅ |
| `creator:assign` | 分配负责人 | 中 | ✅ | ✅ | — | — | — | — |
| `account:read` | 查看平台账号 | 低 | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `account:write` | 维护平台账号 | 低 | ✅ | ✅ | — | — | — | — |
| `metrics:sync` | 触发数据采集 | 中 | ✅ | ✅ | — | — | — | — |
| `metrics:read` | 查看数据看板 | 低 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `brand:read` | 查看品牌 | 低 | ✅ | ✅ | ✅ | — | — | ✅ |
| `brand:write` | 维护品牌 | 中 | ✅ | — | ✅ | — | — | — |
| `contract:read` | 查看合同 | 低 | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| `contract:write` | 拟定合同 | 中 | ✅ | ✅ | ✅ | — | — | — |
| `contract:submit` | 提交合同审核 | 中 | ✅ | ✅ | ✅ | — | — | — |
| `contract:approve` | 审批合同 | 高 | ✅ | ✅ | — | — | ✅ | — |
| `contract:terminate` | 解约/终止合同 | 高 | ✅ ※ | — | — | — | — | — |
| `project:read` | 查看项目 | 低 | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `project:write` | 维护项目 | 中 | ✅ | ✅ | ✅ | ✅ | — | — |
| `content:read` | 查看内容 | 低 | ✅ | ✅ | ✅ | ✅ | — | ✅ |
| `content:write` | 维护内容 | 中 | ✅ | ✅ | — | ✅ | — | — |
| `content:review` | 内容审核 | 中 | ✅ | ✅ | — | ✅ | — | — |
| `content:publish` | 发布/下线内容 | 中 | ✅ | ✅ | — | ✅ | — | — |
| `settlement:read` | 查看结算单 | 中 | ✅ | ✅ | ✅ | — | ✅ | ✅ |
| `settlement:generate` | 生成结算单 | 高 | ✅ | ✅ | — | — | ✅ | — |
| `settlement:edit` | 调整结算明细 | 高 | ✅ | — | — | — | ✅ | — |
| `settlement:approve` | 审批结算单 | 高 | ✅ | — | — | — | ✅ | — |
| `settlement:pay` | 标记打款 | 高 | ✅ | — | — | — | ✅ | — |
| `settlement:export` | 导出结算表 | 高 | ✅ | — | — | — | ✅ | ✅ |
| `ai:run` | 使用 AI 能力 | 低 | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `ai:feedback` | 提交 AI 反馈 | 低 | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| `ai:prompt:read` | 查看 Prompt 模板 | 中 | ✅ | ✅ | — | ✅ | — | — |
| `ai:prompt:write` | 维护 Prompt 模板 | 中 | ✅ ※ | — | — | — | — | — |
| `user:read` | 查看员工 | 中 | ✅ | — | — | — | — | — |
| `user:write` | 维护员工 | 高 | ✅ ※ | — | — | — | — | — |
| `role:manage` | 分配角色与权限 | 高 | ✅ ※ | — | — | — | — | — |
| `audit:read` | 查看审计日志 | 高 | ✅ | — | — | — | — | ✅ |
| `dashboard:read` | 查看经营看板 | 低 | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `system:config` | 系统配置 | 高 | ✅ ※ | — | — | — | — | — |

**设计取舍说明**

- **商务没有 `creator:sensitive:read`**：商务需要联系达人，但手机号属高度敏感。当前实现是商务看到脱敏手机号（`138****8888`），需要完整号码时走「申请」流程——如果业务上确认商务必须直连，应把该权限加入 BD 角色，并在 `permissions.spec.ts` 中同步更新边界测试。
- **运营能生成结算但不能审批**：生成是操作动作，审批是资金动作，分离两者是内控的基本要求。
- **财务不能改达人资料与内容**：财务只需核对金额，不该有篡改业务事实的能力。
- **审计没有任何写权限**：这条有单元测试强制守护（扫描 AUDITOR 权限集合中是否出现 `write/delete/approve/pay/generate/edit/manage/config/run` 类权限）。

---

## 4. 用户级权限覆盖（permissionOverrides）

角色是基线，个别员工需要额外的授予或收权。`User.permissionOverrides` 是字符串数组：

```ts
// 给某个内容同学临时开放查看结算（用于对账）
['settlement:read']

// 从某财务员工处临时收回打款权限（休假交接期）
['-settlement:pay']
```

规则：

- **撤销优先于授予**：同一权限既授又撤时以撤销为准（`-` 前缀优先），避免歧义。
- **非法权限码被静默忽略**（写入侧校验、读取侧容错）：如果读取侧抛错，历史脏数据会导致该用户完全无法登录，代价远大于收益。
- **变更权限后强制重新登录**：权限内嵌在 access token 中，最长 2 小时滞后。改权限时调用 `revokeAllSessions`，让变更立即生效。

---

## 5. 敏感信息处理

| 数据 | 存储 | 展示 | 权限 |
| --- | --- | --- | --- |
| 登录密码 | bcrypt（cost 12） | 永不返回 | — |
| 证件号 | AES-256-GCM 加密（`v1:iv:tag:ciphertext`） | 脱敏 `1101**********1234` | `creator:sensitive:read` |
| 手机号 | 明文存储 | 无权限时 `138****8888` | `creator:sensitive:read` |
| 微信号 | 明文存储 | 无权限时 `li****01` | `creator:sensitive:read` |
| 真实姓名 | 明文存储 | 无权限时不返回 | `creator:sensitive:read` |
| 结算金额 | Decimal(18,2) | 有读权限即返回 | `settlement:read` |
| refresh token | 仅存 sha256 哈希 | 永不返回 | — |
| 审计入参 | 密码/令牌/证件号自动替换为 `***` | — | `audit:read` |

**设计要点**

- 加密密钥从 `JWT_ACCESS_SECRET` 经 scrypt 派生，保持零外部依赖（本地/CI 可直接跑）。**生产环境应改为独立 KMS 数据密钥**——与签名密钥共用一个秘密不是最佳实践，演进方案见 `docs/deployment.md`。
- 密文带 `v1` 版本前缀，为密钥轮换预留：将来可同时存在 `v1`/`v2` 密文并平滑迁移。
- 列表接口与详情接口分别调用同一个 `toListItem(row, canSeeSensitive)` 映射，避免两处脱敏逻辑不一致导致越权泄露。

---

## 6. 敏感操作的额外保护

权限校验之外，资金与合规相关操作还有一层业务保护：

| 操作 | 额外保护 | 位置 |
| --- | --- | --- |
| 审批结算单 | 双人复核：创建人 ≠ 审批人（系统内存在其他财务时强制） | `SettlementService.approve` |
| 审批合同 | 双人复核：拟定人 ≠ 审批人 | `ContractService.approve` |
| 调整结算金额 | 仅草稿/争议态可改；必须填原因；调整后金额不能为负 | `SettlementService.adjust` |
| 生成结算单 | 幂等（三层）；合同区间冲突时拒绝生成 | `SettlementService.generate` |
| 删除达人 | 关联合同/内容/结算时拒绝，提示改用「解约」 | `CreatorService.remove` |
| 达人状态变更 | 状态机校验；解约/拉黑必须填原因 | `creator-status.machine.ts` |
| 修改自己的角色/权限 | 禁止（防止管理员把自己降权导致无人能管理系统） | `UserService` |
| 修改密码 / 重置密码 / 禁用账号 | 撤销该用户全部会话 | `AuthService` |

---

## 7. 怎么安全地新增一个权限点（检查清单）

新增功能时最容易出的问题是「接口写了权限声明，但忘了配到角色矩阵」——结果是功能上线后没人能点，或者临时给了个过大的权限。按以下顺序做：

1. **加权限码**：在 `apps/api/src/modules/auth/permissions.ts` 的 `PERMISSIONS` 中新增常量。
2. **加元数据**：在 `PERMISSION_META` 中补 `label` / `group` / `risk`（`risk` 用于高亮提示，前端角色配置页要用）。
3. **配角色矩阵**：在 `ROLE_PERMISSIONS` 中决定哪些角色拥有。**若这是管理员专属权限，必须同步加入 `permissions.ts` 中的 `ADMIN_ONLY_PERMISSIONS`**，否则权限矩阵测试会失败——这是有意设计的提醒机制。

   > 该常量是「管理员专属权限」的**唯一来源**：单元测试直接读它，不再自己维护一份副本。
   > 早期测试里另抄了一份且只列了 `system:config`，导致
   > `creator:delete` / `contract:terminate` / `ai:prompt:write` / `user:write` / `role:manage`
   > 长期处于「已定义、已写进文档，但没分配给任何角色」的状态——
   > 从界面上看就是「这些功能谁都点不了」，而没有任何测试报警。
   > 统一来源后，这类漂移会在测试里立刻暴露。
4. **Controller 声明**：`@RequirePermissions(PERMISSIONS.XXX)`；需要「任一满足」时用 `@RequirePermissions([A, B], 'any')`。
5. **Service 加数据范围与归属校验**：列表用 `buildScopeFilter(user)`，单条用 `assertOwnership(user, row)`。
6. **若涉及敏感数据**：更新第 5 节表格，并确认脱敏函数已应用（`maskPhone` / `maskWechat` / `maskIdCard`）。
7. **若涉及资金/状态**：确认有状态机保护、幂等键、以及审计埋点 `@Audit(...)`。
8. **跑测试**：`pnpm --filter @creatorops/api test`，其中权限矩阵测试会验证：每个权限点都有元数据、都被至少一个业务角色使用、矩阵中无拼错的权限码、审计角色无写权限。
9. **更新文档**：本文第 3 节矩阵表。

---

## 8. 权限相关错误码

| 错误码 | HTTP | 触发场景 | 前端应展示 |
| --- | --- | --- | --- |
| `PERMISSION_DENIED` | 403 | 缺少接口所需权限点 | 「你没有该操作权限，可联系系统管理员」；隐藏或禁用对应按钮 |
| `SCOPE_DENIED` | 403 | 目标数据不在你的数据范围内 | 「该数据不在你的负责范围内」 |
| `APPROVAL_SEGREGATION` | 403 | 创建人试图审批自己生成的单据 | 「需由其他同事审批（双人复核）」 |
| `ACCOUNT_LOCKED` | 423 | 连续登录失败被锁定 | 展示剩余锁定秒数 |
| `WEAK_PASSWORD` | 400 | 密码强度不足 | 展示具体不满足的规则 |
| `PROMPT_IMMUTABLE` | 409 | 试图修改已被使用的 Prompt 模板内容 | 「请新建版本」 |

---

## 9. 已知安全事项（透明记录）

1. **JWT 密钥同时用于敏感字段加密的密钥派生**：见第 5 节，生产应改为独立 KMS 数据密钥。
2. **access token 撤销存在时间窗**：最长 2 小时。高频敏感操作场景可缩短 `JWT_ACCESS_TTL`（改为 15 分钟），代价是刷新请求变多。
3. **限流基于内存计数**：多实例部署时各实例独立计数，实际阈值 = 配置值 × 实例数。生产应改用 Redis 存储（`@nestjs/throttler` 支持自定义 storage）。
4. **IP 获取依赖 `trust proxy` 配置**：部署在自建 Nginx 后需保证 `X-Forwarded-For` 可信，否则审计中的 IP 可被伪造。
