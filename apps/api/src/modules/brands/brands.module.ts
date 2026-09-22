import { Module } from '@nestjs/common';
import { BrandController } from './brand.controller';
import { BrandService } from './brand.service';

/**
 * 品牌（客户）主数据模块。
 * 不依赖 CommonModule（品牌没有业务编号），PrismaService 由全局 PrismaModule 提供。
 */
@Module({
  controllers: [BrandController],
  providers: [BrandService],
  exports: [BrandService],
})
export class BrandsModule {}
