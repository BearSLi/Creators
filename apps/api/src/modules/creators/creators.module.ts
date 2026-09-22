import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { CreatorController } from './creator.controller';
import { CreatorService } from './creator.service';
import { TagController } from './tag.controller';
import { TagService } from './tag.service';

@Module({
  imports: [CommonModule],
  controllers: [CreatorController, TagController],
  providers: [CreatorService, TagService],
  exports: [CreatorService, TagService],
})
export class CreatorsModule {}
