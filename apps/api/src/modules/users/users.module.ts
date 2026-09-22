import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { UserController } from './user.controller';
import { UserService } from './user.service';

/**
 * 员工与权限模块。
 *
 * 必须 imports AuthModule：初始密码生成、bcrypt 哈希、撤销全部会话这三个能力都在 AuthService 里。
 * 刻意不在本模块复制一份密码哈希逻辑——密码策略（复杂度、bcrypt rounds）必须只有一个实现，
 * 否则「新建员工用 10 轮、改密码用 12 轮」这类不一致会让安全基线失效。
 */
@Module({
  imports: [AuthModule],
  controllers: [UserController],
  providers: [UserService],
  exports: [UserService],
})
export class UsersModule {}
