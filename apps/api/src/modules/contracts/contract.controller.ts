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
import { ContractService } from './contract.service';
import {
  ApproveContractDto,
  CreateContractDto,
  PreviewSettlementQueryDto,
  QueryContractDto,
  TerminateContractDto,
  UpdateContractDto,
} from './dto/contract.dto';

@ApiTags('合同管理')
@ApiBearerAuth()
@Controller('contracts')
export class ContractController {
  constructor(private readonly contractService: ContractService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: '合同列表（按状态/达人/品牌/关键词筛选）' })
  async list(@CurrentUser() user: AuthUser, @Query() query: QueryContractDto) {
    return this.contractService.list(user, query);
  }

  @Get(':id')
  @RequirePermissions(PERMISSIONS.CONTRACT_READ)
  @ApiOperation({ summary: '合同详情（含分润比例换算、关联项目、历史结算汇总）' })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.contractService.findOne(user, id);
  }

  @Get(':id/settlement-preview')
  @RequirePermissions(PERMISSIONS.CONTRACT_READ)
  @ApiOperation({
    summary: '结算预估',
    description:
      '使用与正式结算完全相同的计算引擎预演金额，商务可在签约/出账前回答「这个月要付达人多少钱」。',
  })
  async preview(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Query() query: PreviewSettlementQueryDto,
  ) {
    return this.contractService.previewSettlement(user, id, query);
  }

  @Post()
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  @Audit({ action: 'CREATE', resource: 'contract', summary: '新建合同' })
  @ApiOperation({ summary: '新建合同（草稿）' })
  async create(@CurrentUser() user: AuthUser, @Body() dto: CreateContractDto) {
    return this.contractService.create(user, dto);
  }

  @Patch(':id')
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  @Audit({ action: 'UPDATE', resource: 'contract', summary: '编辑合同' })
  @ApiOperation({
    summary: '编辑合同',
    description: '生效中/待审核状态的合同禁止修改金额与分润条款（保留历史结算依据）。',
  })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateContractDto,
  ) {
    return this.contractService.update(user, id, dto);
  }

  @Post(':id/submit')
  @RequirePermissions(PERMISSIONS.CONTRACT_SUBMIT)
  @Audit({ action: 'UPDATE', resource: 'contract', summary: '提交合同审核' })
  @ApiOperation({ summary: '提交审核（校验生效区间是否与该达人已有合同冲突）' })
  async submit(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.contractService.submit(user, id);
  }

  @Post(':id/approve')
  @RequirePermissions(PERMISSIONS.CONTRACT_APPROVE)
  @Audit({ action: 'APPROVE', resource: 'contract', summary: '审批合同' })
  @ApiOperation({
    summary: '审批合同',
    description: '通过后合同生效并自动将达人推进为「已签约」；拟定人不能审批自己的合同。',
  })
  async approve(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ApproveContractDto,
  ) {
    return this.contractService.approve(user, id, dto);
  }

  @Post(':id/terminate')
  @RequirePermissions(PERMISSIONS.CONTRACT_TERMINATE)
  @Audit({ action: 'UPDATE', resource: 'contract', summary: '终止合同' })
  @ApiOperation({ summary: '终止合同（存在未结清结算单时需 force=true）' })
  async terminate(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: TerminateContractDto,
  ) {
    return this.contractService.terminate(user, id, dto);
  }

  @Delete(':id')
  @RequirePermissions(PERMISSIONS.CONTRACT_WRITE)
  @Audit({ action: 'DELETE', resource: 'contract', summary: '删除合同草稿' })
  @ApiOperation({ summary: '删除合同（仅草稿可删，软删除）' })
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ) {
    return this.contractService.softDelete(user, id);
  }
}
