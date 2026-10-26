import {
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PaymentService } from './payment.service';
import { isFakePaymentEnabled } from './fake-payment.provider';
import { Skip } from '../../common/decorators/skip.decorator';

/**
 * 假网关的支付页面。
 *
 * ⚠️ **未开启 `FAKE_PAYMENT_ENABLED` 时这个端点根本不存在**（404）。
 *
 * ⚠️ 页面**无需登录**——知道 paymentId 就能把订单付掉，所以它受开关控制，
 * 且默认关闭。生产环境开启会**拒绝启动**（见 `assertSecure-config.ts`）。
 *
 * ⚠️ **不要让假网关真的发 HTTP 请求到 webhook 端点**——那会引入
 * 「服务调自己」的自我依赖（容器编排里还要处理网络地址问题）。
 * 直接调用同一段处理逻辑，既真实（幂等与状态机都被走到）又不脆弱。
 */
@ApiTags('fake-payment')
@Controller('pay/fake')
// ⚠️ **跳过租户上下文拦截器**（`@Skip()`）：支付页面是**渠道侧**的页面，
// 渠道的请求不带子域名。租户由支付单自己带（`payments.tenantId`）。
@Skip()
export class FakePaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Get(':paymentId')
  @ApiOperation({ summary: '假网关的支付页面（仅本地开发）' })
  async page(
    @Param('paymentId') paymentId: string,
    @Res() res: Response,
  ): Promise<void> {
    this.assertEnabled();

    const { payment, reference } =
      await this.paymentService.readPaymentWithReference(paymentId);

    res.type('text/html; charset=utf-8').send(renderPage(reference, payment));
  }

  @Post(':paymentId/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '假网关：确认支付' })
  async confirm(@Param('paymentId') paymentId: string): Promise<void> {
    this.assertEnabled();
    await this.paymentService.fakeConfirmPayment(paymentId);
  }

  @Post(':paymentId/fail')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: '假网关：模拟支付失败' })
  async fail(@Param('paymentId') paymentId: string): Promise<void> {
    this.assertEnabled();
    await this.paymentService.fakeFailPayment(paymentId);
  }

  /**
   * 开关没开 → 404。
   *
   * ⚠️ 抛 404 而不是 403：这个端点「不存在」比「存在但不许用」更不容易
   * 被扫到——扫描者拿到的是「这里没这个接口」。
   */
  private assertEnabled(): void {
    if (!isFakePaymentEnabled()) {
      throw new NotFoundException('未知的支付渠道');
    }
  }
}

/**
 * 渲染极简支付页。
 *
 * ⚠️ 金额显示的是**整数分**——这里刻意不做「分转元」的格式化，
 * 因为那是给用户看的金额，与账目金额是两个东西。业务单号与金额都原样显示，
 * 免得看的人以为页面上的数就是系统里的数。
 *
 * ⚠️ 页面上标的仍是「订单号」——本阶段只有订单支付能走到这里
 * （订阅支付单的分支 Task 5 才补上）。
 */
function renderPage(
  reference: { number: string },
  payment: { id: string; amount: number },
): string {
  const escapedReferenceNo = escapeHtml(reference.number);
  const escapedPaymentId = escapeHtml(payment.id);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>本地假支付网关</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 30rem; }
  dt { color: #666; }
  dd { margin: 0 0 1rem; font-size: 1.1rem; }
  button { font-size: 1rem; padding: 0.6rem 1.2rem; margin-right: 0.5rem; cursor: pointer; }
</style>
</head>
<body>
<h1>本地假支付网关</h1>
<p>⚠️ 这是本机开发用的假网关，不是真实支付渠道。</p>
<dl>
  <dt>订单号</dt><dd>${escapedReferenceNo}</dd>
  <dt>应付金额</dt><dd>${payment.amount}（整数分）</dd>
</dl>
<form method="post" action="/api/v1/pay/fake/${escapedPaymentId}/confirm">
  <button type="submit">确认支付</button>
</form>
<form method="post" action="/api/v1/pay/fake/${escapedPaymentId}/fail" style="display:inline">
  <button type="submit">模拟支付失败</button>
</form>
</body>
</html>
`;
}

/** 转义 HTML 里的特殊字符（订单号虽是服务端生成的，但别把「不转义」留成习惯） */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
