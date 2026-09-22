import type { UserRole, UserStatus } from '@prisma/client';
import type { Permission } from './permissions';

/** 登录成功后返回给前端的用户上下文 */
export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  teamId: string | null;
  permissions: Set<Permission>;
  /** 当前登录会话族（refresh token family），用于「下线其他设备」 */
  sessionId: string;
}

/** JWT 载荷。typ 区分 access/refresh，防止 refresh token 被当 access 用 */
export interface JwtPayload {
  sub: string;
  email: string;
  name: string;
  role: UserRole;
  teamId?: string | null;
  /** 权限覆盖项（用户级授权/收权），非全量权限列表 */
  perms?: string[];
  typ: 'access' | 'refresh';
  /** refresh token family，重放检测用 */
  family: string;
  /**
   * JWT ID：每次签发唯一的标识。
   *
   * 为什么必须有它：JWT 对相同载荷 + 相同密钥是**完全确定性**的（HS256 无随机盐），
   * 而 `iat` 只有秒级精度。同一用户在同一秒内签发两次（例如登录后立刻刷新，
   * 这在自动化测试与前端首屏并发请求下很常见）会得到**字节完全相同**的 token，
   * sha256 后撞上 refresh_tokens.tokenHash 的唯一约束 → 刷新接口直接 409。
   * 加入随机 jti 后每次签发都不同，同时让 `replacedByTokenId` 能正确串起轮换链。
   */
  jti?: string;
  iat?: number;
  exp?: number;
  iss?: string;
  aud?: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: {
    id: string;
    email: string;
    name: string;
    role: UserRole;
    status: UserStatus;
    teamId: string | null;
    permissions: string[];
    avatarUrl: string | null;
  };
}

/** 登录请求上下文，用于审计与 refresh token 记录 */
export interface LoginContext {
  ip?: string;
  userAgent?: string;
}
