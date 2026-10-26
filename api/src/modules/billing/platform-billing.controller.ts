import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { PlanService } from './plan.service';
import { CreatePlanDto } from './dto/create-plan.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';

/**
 * 平台超管的套餐接口。
 *
 * ⚠️ **路径是 `platform/plans` 而不是 `plans`** —— 与阶段 5a 的
 * `merchant/coupons` 同款理由：消费者侧与商家侧的鉴权方式根本不同，
 * 同一条路径上挂两套守卫时，NestJS 按注册顺序匹配，
 * 先注册的那套会把另一套**整个遮住**。
 *
 * ⚠️ **挂 `@Roles(PLATFORM_ADMIN)`**：商家账号调这些接口要 403（护栏 M3）。
 */
@ApiTags('platform-billing')
@Controller('platform/plans')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformBillingController {
  constructor(private readonly plans: PlanService) {}

  @Get()
  @ApiOperation({ summary: '全部套餐' })
  async list() {
    return this.plans.listAll();
  }

  @Post()
  @ApiOperation({ summary: '创建套餐' })
  async create(@Body() dto: CreatePlanDto) {
    return this.plans.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: '改套餐' })
  async update(@Param('id') id: string, @Body() dto: UpdatePlanDto) {
    return this.plans.update(id, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: '下架套餐' })
  async disable(@Param('id') id: string) {
    return this.plans.disable(id);
  }
}
