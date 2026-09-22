import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { env } from '../../../config/index';
import { AuthUser, JwtPayload } from '../auth.types';
import { resolvePermissions } from '../permissions';

/**
 * Access Token 校验策略。
 *
 * 刻意不查库：access token 有效期短（默认 2h），若每次请求都查用户表，
 * QPS 高时数据库会被鉴权查询拖垮。用户被禁用/改权限时依赖两点兜底：
 *   1) 前端收到 401 立即走 refresh，refresh 会查库校验状态；
 *   2) 敏感操作（审批/打款）额外做一次实时权限复核（AuthService.assertFreshPermission）。
 * 权限集合直接内嵌在 token 里，避免每请求重复计算。
 */
@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor() {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: env.JWT_ACCESS_SECRET,
      issuer: 'creatorops',
      audience: 'creatorops-api',
    });
  }

  validate(payload: JwtPayload): AuthUser {
    if (payload.typ !== 'access') {
      throw new UnauthorizedException('token 类型不正确');
    }
    return {
      id: payload.sub,
      email: payload.email,
      name: payload.name,
      role: payload.role,
      teamId: payload.teamId ?? null,
      permissions: resolvePermissions(payload.role, payload.perms ?? []),
      sessionId: payload.family,
    };
  }
}
