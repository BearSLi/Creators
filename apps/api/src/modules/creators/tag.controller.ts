import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsHexColor, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { RequirePermissions } from '../../common/decorators/index';
import { PERMISSIONS } from '../auth/permissions';
import { TagService } from './tag.service';

class CreateTagDto {
  @ApiProperty({ description: '标签名称，全局唯一', maxLength: 32 })
  @IsString()
  @MaxLength(32)
  name!: string;

  @ApiProperty({ description: '标签分类：capability(能力) / category(品类) / risk(风险) / custom' })
  @IsString()
  @MaxLength(32)
  category!: string;

  @ApiPropertyOptional({ description: '展示色，十六进制', example: '#4F46E5' })
  @IsOptional()
  @IsHexColor({ message: 'color 需为十六进制色值，如 #4F46E5' })
  color?: string;
}

class UpdateTagDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsHexColor()
  color?: string;
}

@ApiTags('标签')
@ApiBearerAuth()
@Controller('tags')
export class TagController {
  constructor(private readonly tagService: TagService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CREATOR_READ)
  @ApiOperation({ summary: '标签列表（含使用量统计）' })
  async list(@Query('category') category?: string) {
    return this.tagService.list(category);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CREATOR_WRITE)
  @Audit({ action: 'CREATE', resource: 'tag', summary: '新建标签' })
  @ApiOperation({ summary: '新建标签' })
  async create(@Body() dto: CreateTagDto) {
    return this.tagService.create(dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CREATOR_WRITE)
  @Audit({ action: 'UPDATE', resource: 'tag', summary: '编辑标签' })
  @ApiOperation({ summary: '编辑标签' })
  async update(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string, @Body() dto: UpdateTagDto) {
    return this.tagService.update(id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.CREATOR_WRITE)
  @Audit({ action: 'DELETE', resource: 'tag', summary: '删除标签' })
  @ApiOperation({ summary: '删除标签（被引用时拒绝）' })
  async remove(@Param('id', new ParseUUIDPipe({ version: '4' })) id: string) {
    return this.tagService.remove(id);
  }
}
