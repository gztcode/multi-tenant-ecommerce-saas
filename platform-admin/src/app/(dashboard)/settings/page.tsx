import { ApiError } from '@/lib/api-client';
import {
  PAYOUT_CHANNEL_SOURCE_LABEL,
  fetchPayoutChannelOptions,
  fetchPayoutChannelSetting,
  type PayoutChannelOption,
  type PayoutChannelSetting,
} from '@/lib/settings';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { PayoutChannelForm } from './payout-channel-form';

/**
 * 平台设置页（Server Component，阶段 6a Task 4）。
 *
 * 展示当前平台默认出款渠道与来源；来源为「部署环境变量兜底」时提醒
 * 「尚未在后台保存过」。
 *
 * ⚠️ **「尚未配置」也要渲染保存表单**（阶段 6 审查结论）：
 *    这是全新环境里配置默认渠道的**唯一入口**。如果配置缺失时整页只显示
 *    一句错误，运营就只能靠 curl 或手改环境变量。
 *
 * ⚠️ **取数失败不整页崩** —— 渲染一句错误提示即可；
 *    渠道下拉取不到时表单退化成「只能保持当前值」，不挡保存。
 */
export default async function SettingsPage() {
  const [settingResult, optionsResult] = await Promise.allSettled([
    fetchPayoutChannelSetting(),
    fetchPayoutChannelOptions(),
  ]);

  let setting: PayoutChannelSetting | null = null;
  let error: string | null = null;
  if (settingResult.status === 'fulfilled') {
    setting = settingResult.value;
  } else {
    const cause: unknown = settingResult.reason;
    if (cause instanceof ApiError) {
      error = `加载平台设置失败（${cause.status}）：${cause.message}`;
    } else {
      error = cause instanceof Error ? cause.message : '平台设置加载失败';
    }
  }

  const options: PayoutChannelOption[] =
    optionsResult.status === 'fulfilled' ? optionsResult.value : [];

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">设置</h2>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {setting && (
        <Card>
          <CardHeader>
            <CardTitle>当前默认出款渠道</CardTitle>
            <CardDescription>
              来源：{PAYOUT_CHANNEL_SOURCE_LABEL[setting.source]}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-lg font-medium">
              {setting.channel ?? '尚未配置'}
            </p>
            {setting.source === 'NONE' && (
              <p role="alert" className="text-sm text-destructive">
                平台还没有默认出款渠道，<strong>新出款单会直接失败</strong>
                。请在下方选择并保存。
              </p>
            )}
            {setting.source === 'ENV' && (
              <p className="text-sm text-muted-foreground">
                尚未在后台保存过，当前来自部署环境变量（PAYOUT_PLATFORM_DEFAULT_CHANNEL）。
                在下方保存后会以后台配置为准。
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {setting && (
        <PayoutChannelForm current={setting.channel} options={options} />
      )}

      <p className="text-sm text-muted-foreground">
        平台默认渠道只影响新出款单；出款单一旦开始执行就写死渠道，之后不会换渠道。
      </p>
    </div>
  );
}
