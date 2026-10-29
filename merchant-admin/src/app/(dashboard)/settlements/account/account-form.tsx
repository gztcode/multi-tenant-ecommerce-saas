'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api-client';
import type { PayoutAccount } from '@/lib/payout';

/**
 * 收款账户表单。
 *
 * ⚠️ **账号输入框不回填完整账号**：后端只给脱敏值，
 * 商家要改账号时重新输入即可 —— 回填一个假的完整账号更危险
 * （商家以为改的是原账号，其实提交的是另一个）。
 */
export function PayoutAccountForm({
  initial,
}: {
  initial: PayoutAccount | null;
}) {
  const router = useRouter();
  const [accountName, setAccountName] = useState(initial?.accountName ?? '');
  const [bankName, setBankName] = useState(initial?.bankName ?? '');
  const [accountNo, setAccountNo] = useState('');
  const [pending, setPending] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setSuccess(null);
    setError(null);

    try {
      // 走**同源中转**而不是直接调后端：后端没开 CORS，
      // 而且 accessToken 只留在服务端。
      const response = await fetch('/api/merchant/payout-account', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accountName, bankName, accountNo }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as {
          message?: string;
        };
        throw new ApiError(
          response.status,
          'UNKNOWN',
          payload.message ?? '保存失败',
        );
      }

      setSuccess('已保存');
      setAccountNo('');
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? `保存失败：${cause.message}`
          : cause instanceof Error
            ? cause.message
            : '保存失败',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>收款账户</CardTitle>
        <CardDescription>
          {initial
            ? `当前账户：${initial.bankName} ${initial.maskedAccountNo}（${initial.accountName}）`
            : '还没有设置收款账户 —— 设好之后才能申请出款。'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="accountName">开户人姓名</Label>
            <Input
              id="accountName"
              value={accountName}
              onChange={(event) => setAccountName(event.target.value)}
              maxLength={60}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="bankName">开户行</Label>
            <Input
              id="bankName"
              value={bankName}
              onChange={(event) => setBankName(event.target.value)}
              maxLength={60}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="accountNo">银行账号</Label>
            <Input
              id="accountNo"
              value={accountNo}
              onChange={(event) => setAccountNo(event.target.value)}
              minLength={4}
              maxLength={40}
              placeholder={initial ? '留空表示不修改原账号' : '请输入银行账号'}
              required={!initial}
              // ⚠️ **不让浏览器自动填**：银行账号不是浏览器该猜的东西，
              //    自动填进来的多半是别的账号。
              autoComplete="off"
              // ⚠️ **保持 `text`**：商家要能看清自己输的账号对不对，
              //    `type="number"` 会吃掉前导 0，也会吞掉打错的字符。
              type="text"
            />
            {/* ⚠️ **文案要说准**：后端是明文存完整账号（要能打钱），
                只是**不把完整账号返回给前端**，页面只显示尾 4 位。 */}
            <p className="text-xs text-muted-foreground">
              出于安全考虑，页面不显示完整账号；留空表示不修改原账号。
            </p>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          {success && (
            <p role="status" className="text-sm text-primary">
              {success}
            </p>
          )}
          <div className="flex justify-end">
            <Button type="submit" disabled={pending}>
              {pending ? '保存中…' : '保存'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
