import { Module } from '@nestjs/common';
import { CodeGeneratorService } from './code-generator.service';

/** 通用业务能力（编号生成等），被多个业务模块复用 */
@Module({
  providers: [CodeGeneratorService],
  exports: [CodeGeneratorService],
})
export class CommonModule {}
