import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/index';
import type { AuthUser } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { BrandService } from './brand.service';
import { CreateBrandDto, QueryBrandDto, UpdateBrandDto } from './dto/brand.dto';

@ApiTags('品牌管理')
@ApiBearerAuth()
@Controller('brands')
export class BrandController {
  constructor(private readonly brandService: BrandService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.BRAND_READ)
  @ApiOperation({
    summary: '品牌列表',
    description:
      '支持关键词（品牌名/对接人/发票抬头）与客户等级精确过滤。品牌是公司级客户资产，不做数据范围收敛：换商务后客户资料仍应完整可见。',
  })
  async list(@CurrentUser() user: AuthUser, @Query() query: QueryBrandDto) {
    return this.brandService.list(user, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.BRAND_READ)
  @ApiOperation({
    summary: '品牌详情',
    description: '返回品牌档案、最近 20 份合同与汇总统计（合同数/在跑合同数/项目数/内容流水）。',
  })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.brandService.findOne(user, id);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.BRAND_WRITE)
  @Audit({ action: 'CREATE', resource: 'brand', summary: '新建品牌' })
  @ApiOperation({ summary: '新建品牌', description: '品牌名称全局唯一，重名直接拒绝。' })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateBrandDto) {
    return this.brandService.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.BRAND_WRITE)
  @Audit({ action: 'UPDATE', resource: 'brand', summary: '编辑品牌档案' })
  @ApiOperation({ summary: '编辑品牌档案' })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateBrandDto,
  ) {
    return this.brandService.update(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.BRAND_WRITE)
  @Audit({ action: 'DELETE', resource: 'brand', summary: '删除品牌（软删除）' })
  @ApiOperation({
    summary: '删除品牌',
    description: '软删除；被合同或项目引用时拒绝，并在错误信息中给出引用数量。',
  })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.brandService.remove(user, id);
  }
}
