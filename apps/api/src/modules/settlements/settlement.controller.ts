import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { Audit } from '../../common/decorators/audit.decorator';
import { CurrentUser, RequirePermissions } from '../../common/decorators/index';
import type { AuthUser } from '../auth/auth.types';
import { PERMISSIONS } from '../auth/permissions';
import { SettlementService } from './settlement.service';
import {
  AdjustSettlementDto,
  DisputeSettlementDto,
  ExportSettlementDto,
  GenerateSettlementDto,
  PaySettlementDto,
  QuerySettlementDto,
  VoidSettlementDto,
} from './dto/settlement.dto';

@ApiTags('结算管理')
@ApiBearerAuth()
@Controller('settlements')
export class SettlementController {
  constructor(private readonly settlementService: SettlementService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.SETTLEMENT_READ)
  @ApiOperation({
    summary: '结算单列表',
    description: '按账期/状态/达人筛选。金额字段为字符串（元，2 位小数），避免前端浮点误差。',
  })
  async list(@CurrentUser() user: AuthUser, @Query() query: QuerySettlementDto) {
    return this.settlementService.list(user, query);
  }

  @Get('export')
  @RequirePermissions(PERMISSIONS.SETTLEMENT_EXPORT)
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @ApiOperation({
    summary: '导出结算表（CSV，带 BOM 保证 Excel 中文不乱码）',
    description: '导出动作本身会记录审计日志，属于敏感数据外发。',
  })
  async export(
    @CurrentUser() user: AuthUser,
    @Query() query: ExportSettlementDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { filename, content } = await this.settlementService.exportCsv(user, {
      ...query,
      page: 1,
      pageSize: 100,
    } as QuerySettlementDto);
    response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // 直接写 CSV 文本：响应拦截器检测到 Content-Disposition 后不会套信封
    return content;
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.SETTLEMENT_READ)
  @ApiOperation({ summary: '结算单详情（含明细、计算链路、可执行动作）' })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.settlementService.findOne(user, id);
  }

  @Post('generate')
  @RequirePermissions(PERMISSIONS.SETTLEMENT_GENERATE)
  @Audit({ action: 'GENERATE', resource: 'settlement', summary: '批量生成结算单' })
  @ApiOperation({
    summary: '按账期批量生成结算单',
    description:
      '幂等：重复调用不会重复出账（补贴明细有唯一幂等键，同一达人同账期唯一）。按内容发布月归因，跨月不重复计算。',
  })
  async generate(@CurrentUser() user: AuthUser, @Body() dto: GenerateSettlementDto) {
    return this.settlementService.generate(user, dto);
  }

  @Post(':id/submit')
  @RequirePermissions(PERMISSIONS.SETTLEMENT_EDIT)
  @Audit({ action: 'UPDATE', resource: 'settlement', summary: '提交结算单审批' })
  @ApiOperation({ summary: '提交审批（提交前校验明细汇总与单据金额一致）' })
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.settlementService.submit(user, id);
  }

  @Post(':id/adjust')
  @RequirePermissions(PERMISSIONS.SETTLEMENT_EDIT)
  @Audit({ action: 'UPDATE', resource: 'settlement', summary: '调整结算金额' })
  @ApiOperation({ summary: '调整结算金额（补款/扣款，必须填原因）' })
  async adjust(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AdjustSettlementDto,
  ) {
    return this.settlementService.adjust(user, id, dto);
  }

  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.SETTLEMENT_APPROVE)
  @Audit({ action: 'APPROVE', resource: 'settlement', summary: '审批结算单' })
  @ApiOperation({
    summary: '审批结算单',
    description: '双人复核：创建人不能审批自己生成的单据（系统内存在其他财务时）。',
  })
  async approve(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.settlementService.approve(user, id);
  }

  @Post(':id/pay')
  @RequirePermissions(PERMISSIONS.SETTLEMENT_PAY)
  @Audit({ action: 'PAY', resource: 'settlement', summary: '标记结算单已打款' })
  @ApiOperation({ summary: '标记已打款（可上传打款凭证），并通知达人负责人' })
  async pay(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: PaySettlementDto,
  ) {
    return this.settlementService.pay(user, id, dto);
  }

  @Post(':id/dispute')
  @RequirePermissions(PERMISSIONS.SETTLEMENT_EDIT)
  @Audit({ action: 'UPDATE', resource: 'settlement', summary: '标记结算单争议' })
  @ApiOperation({ summary: '标记争议（达人/财务对金额有异议时）' })
  async dispute(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: DisputeSettlementDto,
  ) {
    return this.settlementService.dispute(user, id, dto.reason);
  }

  @Post(':id/void')
  @RequirePermissions(PERMISSIONS.SETTLEMENT_APPROVE)
  @Audit({ action: 'UPDATE', resource: 'settlement', summary: '作废结算单' })
  @ApiOperation({ summary: '作废结算单（作废后同账期可重新生成）' })
  async void(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: VoidSettlementDto,
  ) {
    return this.settlementService.void(user, id, dto.reason);
  }
}
