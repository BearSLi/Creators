import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { CreatorsModule } from '../creators/creators.module';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';

/**
 * 项目模块。
 *
 * imports:
 *   - CreatorsModule：创建/编辑项目时复用 CreatorService.assertSchedulable（达人可排期校验）；
 *   - CommonModule：项目编号生成（CodeGeneratorService）。
 * 项目不直接依赖内容模块：内容条数通过 Prisma 聚合查询得到，
 * 避免 ProjectsModule ↔ ContentsModule 互相 import 形成循环依赖。
 */
@Module({
  imports: [CreatorsModule, CommonModule],
  controllers: [ProjectController],
  providers: [ProjectService],
  exports: [ProjectService],
})
export class ProjectsModule {}
