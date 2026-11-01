import Link from 'next/link';
import { ImportCsvForm } from './import-csv-form';

/**
 * 导入渠道账单（阶段 5m）。
 *
 * ⚠️ **独立页面而不是塞进列表页** —— 列映射有七八项，
 *    挤在列表页里会把「看历史任务」这件事挤没了。
 *
 * ⚠️ **真渠道没有批量查单接口** —— CSV 账单是唯一的对账途径，
 *    没有这个页面 = 这个能力对运营不存在。
 */
export default function ImportReconciliationPage() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold">导入渠道账单</h1>
        <Link
          href="/reconciliations"
          className="text-sm underline-offset-4 hover:underline"
        >
          返回列表
        </Link>
      </div>

      <ImportCsvForm />
    </div>
  );
}
