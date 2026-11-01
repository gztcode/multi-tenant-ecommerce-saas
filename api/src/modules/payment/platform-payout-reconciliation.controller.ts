import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import { getTenantContext } from '../../common/tenant/tenant-context';
import { PayoutReconciliationService } from './payout-reconciliation.service';
import { PayoutExecutionService } from '../billing/payout-execution.service';
import { TenantPrismaService } from '../../common/tenant/tenant-prisma.service';
import {
  ConfirmPaidDto,
  ListReconciliationsDto,
  ResolveReconciliationItemDto,
  TriggerReconciliationDto,
} from './dto/payout-reconciliation.dto';
import {
  assertColumnMapping,
  CSV_MAX_SKIPPED_ROWS_REPORTED,
  CSV_NO_PAID_AT_WARNING,
  parseCsvToChannelRecords,
} from './payout-reconciliation-csv';
import { ImportReconciliationDto } from './dto/payout-reconciliation-import.dto';

/**
 * 平台侧的渠道对账接口（阶段 5m）。
 *
 * ⚠️ **挂 `@Roles(PLATFORM_ADMIN)`** —— 新表不受租户作用域约束，
 *    只有平台超管能查（护栏 P10）。
 *
 * ⚠️ **控制器放在 payment 模块**（设计 §七·7.5）——
 *    billing 绝对不能 import payment，而对账要碰渠道。
 *
 * ⚠️ **路由前缀是 `/platform/payout-reconciliations`，不是 `/platform/payouts/...`**
 *    —— billing 那边有 `@Get('payouts/:id')`（`platform-payout.controller.ts`），
 *    而 **billing 模块先于 payment 模块注册路由**（`payment.module.ts` 的
 *    `imports` 里有 `BillingModule` → NestJS 按依赖图先注册它）。
 *    → 对账端点若挂在 `/platform/payouts/` 下，`reconciliations` 与
 *    `reconciliation-summary` 这两个**单段**路径会被 `payouts/:id` 抢先匹配
 *    → `ParseUUIDPipe` 直接 400，**列表与统计端点 100% 不可达**。
 *    挪到独立前缀后，第 2 段是字面量 `payout-reconciliations`，与
 *    billing 的 `payouts` 不撞。
 */
@ApiTags('platform-payout-reconciliations')
@Controller('platform/payout-reconciliations')
@Roles(UserRole.PLATFORM_ADMIN)
export class PlatformPayoutReconciliationController {
  constructor(
    private readonly reconciliations: PayoutReconciliationService,
    private readonly execution: PayoutExecutionService,
    private readonly prisma: TenantPrismaService,
  ) {}

  @Get()
  @ApiOperation({ summary: '对账任务列表' })
  async list(@Query() query: ListReconciliationsDto) {
    return this.reconciliations.list(query);
  }

  /**
   * ⚠️ **必须声明在 `:id` 之前** —— 两者都是 3 段
   *    （`payout-reconciliations/summary` 与 `payout-reconciliations/:id`），
   *    Express 按注册顺序先匹配先赢 → `summary` 在前才不会被 `:id` 吃掉。
   *    （`payout-unstick-gate` 那类「遮蔽」是静默的 400，e2e 已守住。）
   */
  @Get('summary')
  @ApiOperation({ summary: '未处置差异的统计（给横幅用）' })
  async summary() {
    return this.reconciliations.summary();
  }

  @Get('payouts/:payoutId/status')
  @ApiOperation({ summary: '该单最近一次对账结论' })
  async reconciliationStatus(
    @Param('payoutId', new ParseUUIDPipe()) payoutId: string,
  ) {
    return this.reconciliations.statusForPayout(payoutId);
  }

  @Get(':id')
  @ApiOperation({ summary: '对账任务详情 + 差异列表' })
  async detail(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.reconciliations.detail(id);
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '手动触发渠道对账',
    description:
      '同步执行。⚠️ **不查幂等** —— 手动重跑是有意行为。' +
      '时间窗跨度上限 31 天，渠道记录数上限 10000 条，执行超时 30 秒。',
  })
  async trigger(@Body() dto: TriggerReconciliationDto) {
    const operatorId = this.currentOperatorId();
    return this.reconciliations.trigger({
      channel: dto.channel,
      from: new Date(dto.from),
      to: new Date(dto.to),
      operatorId,
    });
  }

  /**
   * 导入渠道账单文件（CSV）。
   *
   * ⚠️ **本仓第一个 multipart 接口** —— 走 `FileInterceptor`，
   *    文件上限 5MB（`MulterModule` 与这里的 `limits` 都写了）。
   */
  @Post('import')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor('file', { limits: { fileSize: 5 * 1024 * 1024 } }),
  )
  @ApiOperation({
    summary: '导入渠道账单文件（CSV）',
    description:
      '⚠️ **本仓第一个 multipart 接口**。上传时指定列映射 —— ' +
      '真渠道的 CSV 字段千差万别，用固定模板等于把对账的价值打没。' +
      '文件上限 5MB、行数上限 10000 行。',
  })
  async importCsv(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: ImportReconciliationDto,
  ) {
    if (!file) {
      throw new BadRequestException('请上传账单文件');
    }
    // ⚠️ **原始文件不落盘** —— 只存解析后的记录 + 映射配置 + 文件名
    const csvText = file.buffer.toString('utf8');
    let mappingRaw: unknown;
    try {
      mappingRaw = JSON.parse(dto.columnMapping);
    } catch {
      throw new BadRequestException('列映射不是合法的 JSON');
    }
    const mapping = assertColumnMapping(mappingRaw);
    const parsed = parseCsvToChannelRecords(csvText, mapping);
    const result = await this.reconciliations.importRecords({
      channel: dto.channel ?? 'fake-payout',
      fileName: file.originalname,
      columnMapping: JSON.stringify(mapping),
      records: parsed.records,
      from: dto.from ? new Date(dto.from) : undefined,
      to: dto.to ? new Date(dto.to) : undefined,
      operatorId: this.currentOperatorId(),
    });
    // ⚠️ **提示要基于「实际解析出了几个时刻」，不是「配没配列」** ——
    //    配了时间列但整列是空值/格式不对 → 一个时刻都解析不出来
    //    → **后果与不配列完全一样**（D 类检不出来），
    //    而响应里 `diffCount` 可能仍是 0（运营会当成「一切正常」）。
    const warning =
      parsed.parsedPaidAtCount === 0 ? CSV_NO_PAID_AT_WARNING : undefined;
    // ⚠️ **被跳过的行必须报告，不能静默丢** —— 对账结论是基于
    //    **剩下的行**算出来的；运营不知道跳了几行 → 看到「差异数 0」
    //    就以为钱没问题。
    // ⚠️ **明细要截断但必须带标记** —— 与 `RECONCILIATION_MAX_ITEMS` 同一原则：
    //    静默截断会让人以为「就这么多行有问题」。
    const reported = parsed.skippedRows.slice(0, CSV_MAX_SKIPPED_ROWS_REPORTED);
    return {
      ...result,
      ...(warning ? { warning } : {}),
      skippedRowCount: parsed.skippedRows.length,
      skippedRows: reported,
      skippedRowsTruncated: parsed.skippedRows.length > reported.length,
    };
  }

  @Post(':id/items/:itemId/resolve')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '处置一条对账差异' })
  async resolveItem(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Param('itemId', new ParseUUIDPipe()) itemId: string,
    @Body() dto: ResolveReconciliationItemDto,
  ) {
    await this.reconciliations.resolveItem(id, itemId, {
      resolution: dto.resolution,
      note: dto.note,
      operatorId: this.currentOperatorId(),
    });
    // ⚠️ **不能直接返回 boolean** —— Express 的 `res.send(true)` 会把
    //    布尔值当字符串发出去（`Content-Type: text/html`，body 是 `"true"`）
    //    → 前端 `response.json()` 直接抛「Unexpected token t」。
    //    → 一律返回对象。
    return { resolved: true };
  }

  @Post('payouts/:payoutId/confirm-paid')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: '人工确认「渠道已打款」（B 类处置）',
    description:
      '把一张记成失败的出款单纠正为已付款。会复原明细并联动结算单，' +
      '走四道闸：明细可复原、金额与笔数对得上、明细未被他人占用、渠道核实。',
  })
  async confirmPaid(
    @Param('payoutId', new ParseUUIDPipe()) payoutId: string,
    @Body() dto: ConfirmPaidDto,
  ) {
    await this.execution.confirmPaidAfterReconciliation(payoutId, {
      reason: dto.reason,
      operatorId: this.currentOperatorId(),
      reconciliationId: dto.reconciliationId,
    });
    // ⚠️ **同 `resolveItem` —— 不能返回 boolean**（Express 会把它发成
    //    `text/html` 的 `"true"`，前端 `response.json()` 解析不了）。
    return { confirmed: true };
  }

  /** 取当前操作人（平台超管的用户 id） */
  private currentOperatorId(): string {
    const context = getTenantContext();
    if (!context.userId) {
      throw new BadRequestException('缺少用户上下文');
    }
    return context.userId;
  }
}
