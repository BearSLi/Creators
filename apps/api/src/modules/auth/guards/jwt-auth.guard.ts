import { Injectable, UnauthorizedException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthGuard } from '@nestjs/passport';
import { IS_PUBLIC_KEY } from '../../../common/decorators/public.decorator';
import type { AuthUser } from '../auth.types';

/**
 * 全局 JWT 守卫。
 *
 * 采用「默认拒绝」：所有路由都需要登录，只有显式标注 @Public() 的接口放开
 * （登录、刷新、健康检查）。相比「默认放行 + 逐接口加守卫」，
 * 新增接口忘记加守卫时不会静默裸奔。
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  constructor(private readonly reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext): boolean | Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return super.canActivate(context) as boolean | Promise<boolean>;
  }

  handleRequest<TUser = AuthUser>(err: unknown, user: TUser | false): TUser {
    if (err || !user) {
      throw err instanceof Error ? err : new UnauthorizedException('登录状态已失效，请重新登录');
    }
    return user;
  }
}
