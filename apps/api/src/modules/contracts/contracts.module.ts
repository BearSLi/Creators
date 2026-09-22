import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { ContractController } from './contract.controller';
import { ContractService } from './contract.service';

@Module({
  imports: [CommonModule],
  controllers: [ContractController],
  providers: [ContractService],
  exports: [ContractService],
})
export class ContractsModule {}
