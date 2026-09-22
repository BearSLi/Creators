import { Global, Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

/**
 * 审计模块为 @Global：审计拦截器在全局注册，任何业务模块写操作都可能用到，
 * 逐个 import 容易漏；全局导出可降低误用成本。
 */
@Global()
@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
