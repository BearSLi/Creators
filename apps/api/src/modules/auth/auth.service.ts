import {
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { User, UserStatus } from '@prisma/client';
import { createHash, randomUUID } from 'node:crypto';
import * as bcrypt from 'bcryptjs';
import { env } from '../../config/index';
import { PrismaService } from '../../prisma/prisma.service';
import { BusinessException } from '../../common/exceptions/business.exception';
import { AuthUser, JwtPayload, LoginContext, LoginResult } from './auth.types';
import { Permission, resolvePermissions } from './permissions';

/** 把 '2h' / '14d' / '900s' 这类时长转成秒。JWT 库只接受秒数或 ms 字符串，统一在这里换算。 */
export function parseDurationToSeconds(input: string): number {
  const match = /^(\d+)\s*(ms|s|m|h|d)?$/i.exec(input.trim());
  if (!match) {
    throw new Error(`无法解析的时长格式：${input}（支持 600s / 2h / 14d）`);
  }
  const value = Number.parseInt(match[1], 10);
  const unit = (match[2] ?? 's').toLowerCase();
  const factors: Record<string, number> = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86_400 };
  return Math.floor(value * factors[unit]);
}

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  /**
   * 账号密码登录。
   *
   * 安全设计：
   * - 无论邮箱是否存在都执行一次 bcrypt.compare，避免通过响应时间枚举账号。
   * - 连续失败累计到阈值后锁定账号一段时间，抵御撞库。
   * - refresh token 只存 sha256 哈希，且按 family 分组，支持重放检测。
   */
  async login(email: string, password: string, ctx: LoginContext): Promise<LoginResult> {
    const normalizedEmail = email.trim().toLowerCase();
    const user = await this.prisma.user.findFirst({
      where: { email: normalizedEmail, deletedAt: null },
    });

    // 固定比对成本：用户不存在时也跑一次哈希比对
    const passwordHash = user?.passwordHash ?? DUMMY_HASH;
    const passwordOk = await bcrypt.compare(password, passwordHash).catch(() => false);

    if (!user || !passwordOk) {
      if (user) await this.registerFailedAttempt(user);
      this.logger.warn(`登录失败 email=${normalizedEmail} ip=${ctx.ip ?? '-'}`);
      throw new UnauthorizedException('邮箱或密码错误');
    }

    if (user.status === UserStatus.DISABLED) {
      throw new ForbiddenException('账号已被禁用，请联系系统管理员');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > Date.now()) {
      const seconds = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 1000);
      // 用字面量 423 而不是 HttpStatus.LOCKED：NestJS 的 HttpStatus 枚举里
      // 没有 LOCKED（WebDAV 扩展状态码，Nest 未收录），写成枚举成员会编译失败。
      throw new BusinessException(
        'ACCOUNT_LOCKED',
        `账号已被临时锁定，请 ${seconds} 秒后重试`,
        423,
        { retryAfterSeconds: seconds },
      );
    }

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        lastLoginIp: ctx.ip ?? null,
        failedLoginCount: 0,
        lockedUntil: null,
      },
    });

    const tokens = await this.issueTokens(updated, randomUUID(), ctx);
    this.logger.log(`登录成功 user=${updated.email} role=${updated.role}`);
    return tokens.result;
  }

  /** 连续失败锁定：5 次失败锁 15 分钟，指数不叠加，避免被恶意永久锁号 */
  private async registerFailedAttempt(user: User): Promise<void> {
    const nextCount = user.failedLoginCount + 1;
    const shouldLock = nextCount >= MAX_FAILED_ATTEMPTS;
    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        failedLoginCount: nextCount,
        lockedUntil: shouldLock ? new Date(Date.now() + LOCK_DURATION_MS) : user.lockedUntil,
      },
    });
    if (shouldLock) {
      this.logger.warn(`账号因连续登录失败被锁定 user=${user.email}`);
    }
  }

  /**
   * 刷新令牌（rotation + 重放检测）。
   *
   * 流程：校验 refresh JWT → 校验库中记录（存在、未撤销、未过期、family 一致）
   *      → 撤销旧 token 并签发新 token（记录 replacedByTokenId 形成链条）。
   * 若同一 token 被使用两次（说明泄露），直接撤销整个 family 并强制重新登录。
   */
  async refresh(refreshToken: string, ctx: LoginContext): Promise<LoginResult> {
    let payload: JwtPayload;
    try {
      payload = await this.jwt.verifyAsync<JwtPayload>(refreshToken, {
        secret: env.JWT_REFRESH_SECRET,
        issuer: 'creatorops',
        audience: 'creatorops-api',
      });
    } catch {
      throw new UnauthorizedException('刷新令牌无效或已过期，请重新登录');
    }
    if (payload.typ !== 'refresh') {
      throw new UnauthorizedException('令牌类型不正确');
    }

    const tokenHash = hashToken(refreshToken);
    const record = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });

    if (!record) {
      // token 签名合法但库里没有：可能是旧版本密钥或已清理，直接拒绝
      throw new UnauthorizedException('刷新令牌已失效，请重新登录');
    }
    if (record.revokedAt) {
      // 重放：撤销整族，让攻击者与用户都必须重新登录
      await this.revokeFamily(record.familyId, '检测到刷新令牌重放');
      this.logger.error(
        `检测到 refresh token 重放，已撤销整个会话族 family=${record.familyId} user=${record.userId}`,
      );
      throw new UnauthorizedException('会话异常，已强制退出，请重新登录');
    }
    if (record.expiresAt.getTime() < Date.now()) {
      throw new UnauthorizedException('刷新令牌已过期，请重新登录');
    }

    const user = await this.prisma.user.findFirst({
      where: { id: payload.sub, deletedAt: null },
    });
    if (!user || user.status === UserStatus.DISABLED) {
      await this.revokeFamily(record.familyId, '账号不可用');
      throw new ForbiddenException('账号不可用，请联系系统管理员');
    }

    const issued = await this.issueTokens(user, record.familyId, ctx);
    await this.prisma.refreshToken.update({
      where: { id: record.id },
      data: { revokedAt: new Date(), replacedByTokenId: issued.refreshTokenId },
    });
    return issued.result;
  }
  /** 退出登录：撤销当前会话族（该设备全部 token） */
  async logout(userId: string, sessionId: string): Promise<{ revoked: number }> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, familyId: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return { revoked: result.count };
  }

  /** 撤销某用户全部会话（改密码、禁用账号、疑似泄露时使用） */
  async revokeAllSessions(userId: string, reason: string): Promise<number> {
    const result = await this.prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.logger.warn(`撤销全部会话 user=${userId} 原因=${reason} 数量=${result.count}`);
    return result.count;
  }

  private async revokeFamily(familyId: string, reason: string): Promise<void> {
    await this.prisma.refreshToken.updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.logger.warn(`撤销会话族 family=${familyId} 原因=${reason}`);
  }

  /**
   * 签发 access + refresh，并落库 refresh 哈希记录。
   *
   * 返回值刻意分成 `result`（给客户端的令牌与用户信息）与 `refreshTokenId`（库内记录 ID）：
   * 后者只在轮换时用于把旧记录指向新记录（replacedByTokenId），
   * 属于内部字段，不应出现在 API 响应里。
   */
  private async issueTokens(
    user: User,
    familyId: string,
    ctx: LoginContext,
  ): Promise<{ result: LoginResult; refreshTokenId: string }> {
    const permissions = resolvePermissions(user.role, user.permissionOverrides);
    const accessTtl = parseDurationToSeconds(env.JWT_ACCESS_TTL);
    const refreshTtl = parseDurationToSeconds(env.JWT_REFRESH_TTL);

    const basePayload = {
      sub: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      teamId: user.teamId,
      perms: user.permissionOverrides,
      family: familyId,
    } satisfies Omit<JwtPayload, 'typ'>;

    const accessToken = await this.jwt.signAsync(
      { ...basePayload, typ: 'access' } satisfies JwtPayload,
      {
        secret: env.JWT_ACCESS_SECRET,
        expiresIn: accessTtl,
        issuer: 'creatorops',
        audience: 'creatorops-api',
      },
    );
    /**
     * 先为本次签发生成一个 JWT ID（jti），再签 refresh token。
     *
     * 顺序很关键：jti 必须在签名前确定，同时它也被用作 refresh_tokens 记录的主键。
     * 这样 `replacedByTokenId` 能直接指向新记录，轮换链完整可追溯；
     * 而随机 jti 保证同一秒内重复签发也不会产生相同的 token
     * （详见 auth.types.ts 中 JwtPayload.jti 的说明）。
     */
    const refreshTokenId = randomUUID();

    const refreshToken = await this.jwt.signAsync(
      { ...basePayload, typ: 'refresh', jti: refreshTokenId } satisfies JwtPayload,
      {
        secret: env.JWT_REFRESH_SECRET,
        expiresIn: refreshTtl,
        issuer: 'creatorops',
        audience: 'creatorops-api',
      },
    );

    await this.prisma.refreshToken.create({
      data: {
        // 显式指定主键 = jti，便于由 token 反查记录，也让轮换链指向确定
        id: refreshTokenId,
        userId: user.id,
        tokenHash: hashToken(refreshToken),
        familyId,
        userAgent: ctx.userAgent?.slice(0, 256) ?? null,
        ip: ctx.ip?.slice(0, 64) ?? null,
        expiresAt: new Date(Date.now() + refreshTtl * 1000),
      },
      select: { id: true },
    });

    return {
      result: {
        accessToken,
        refreshToken,
        expiresIn: accessTtl,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          status: user.status,
          teamId: user.teamId,
          permissions: [...permissions],
          avatarUrl: user.avatarUrl,
        },
      },
      refreshTokenId,
    };
  }

  /** 当前用户信息（前端刷新页面时拉取，保证权限变更即时生效） */
  async profile(userId: string) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, deletedAt: null },
      include: { team: { select: { id: true, name: true, code: true } } },
    });
    if (!user) throw new UnauthorizedException('用户不存在或已被删除');
    const permissions = resolvePermissions(user.role, user.permissionOverrides);
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      status: user.status,
      avatarUrl: user.avatarUrl,
      team: user.team,
      permissions: [...permissions],
      lastLoginAt: user.lastLoginAt,
    };
  }

  /** 修改密码：校验旧密码 + 复杂度，成功后强制所有设备重新登录 */
  async changePassword(
    userId: string,
    oldPassword: string,
    newPassword: string,
  ): Promise<{ revokedSessions: number }> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, deletedAt: null } });
    if (!user) throw new UnauthorizedException('用户不存在');

    const ok = await bcrypt.compare(oldPassword, user.passwordHash).catch(() => false);
    if (!ok) throw new UnauthorizedException('原密码不正确');
    if (await bcrypt.compare(newPassword, user.passwordHash)) {
      throw new BusinessException('PASSWORD_UNCHANGED', '新密码不能与原密码相同');
    }
    assertPasswordStrength(newPassword);

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        passwordHash: await bcrypt.hash(newPassword, env.BCRYPT_ROUNDS),
        passwordUpdatedAt: new Date(),
      },
    });
    const revokedSessions = await this.revokeAllSessions(userId, '修改密码');
    return { revokedSessions };
  }

  /**
   * 敏感操作的实时权限复核。
   * access token 里内嵌的权限最长有 2 小时滞后，审批/打款这类资金动作不能容忍，
   * 因此在 Service 层再查一次库（成本可接受：低频操作）。
   */
  async assertFreshPermission(user: AuthUser, required: Permission): Promise<void> {
    // 变量名刻意与入参区分（freshUser）：早期版本内层也叫 user，
    // 导致 `user.id` 实际取的是内层查询结果（此时还是 undefined），
    // 形成「用自己的 id 查自己」的循环错误，TypeScript 直接拦下了它。
    const freshUser = await this.prisma.user.findFirst({
      where: { id: user.id, deletedAt: null },
      select: { status: true, role: true, permissionOverrides: true },
    });
    if (!freshUser || freshUser.status === UserStatus.DISABLED) {
      throw new ForbiddenException('账号已被禁用');
    }
    const permissions = resolvePermissions(freshUser.role, freshUser.permissionOverrides);
    if (!permissions.has(required)) {
      throw new ForbiddenException(`缺少权限：${required}（权限可能已被变更，请重新登录）`);
    }
  }

  /** 生成初始密码（新建员工时使用），返回明文仅本次响应可见 */
  generateInitialPassword(): string {
    return `Co${randomUUID().replace(/-/g, '').slice(0, 10)}!`;
  }

  /** 供 UserService 复用：安全地哈希密码 */
  async hashPassword(plain: string): Promise<string> {
    assertPasswordStrength(plain);
    return bcrypt.hash(plain, env.BCRYPT_ROUNDS);
  }
}

const MAX_FAILED_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000;

/** 用于「用户不存在」时的等成本比对，避免时序侧信道枚举账号 */
const DUMMY_HASH = '$2a$12$C6UzMDM.H6dfI/f/IKcEe.7XwKZgVJp5a6yq1WsXWzY1p8QqvJ8b2';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * 密码复杂度：至少 10 位，含大小写/数字/符号中的三类。
 * 不强制「必须含特殊符号」这类过严规则——实践中会催生 Passw0rd! 式弱密码。
 */
export function assertPasswordStrength(password: string): void {
  const problems: string[] = [];
  if (password.length < 10) problems.push('长度至少 10 位');
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) problems.push('需包含大写字母、小写字母、数字、符号中的至少三类');
  if (/^(.)\1+$/.test(password)) problems.push('不能是重复字符');
  if (problems.length > 0) {
    throw new BusinessException('WEAK_PASSWORD', `密码强度不足：${problems.join('；')}`);
  }
}

export const authInternals = { MAX_FAILED_ATTEMPTS, LOCK_DURATION_MS };
