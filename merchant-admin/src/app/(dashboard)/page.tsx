import { ApiError, apiFetchAuthed } from '@/lib/api-client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface StoreInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
}

export default async function MerchantOverviewPage() {
  // `GET /stores/me` 必须带 token,未登录会被 layout 提前挡掉,
  // 这里剩下的失败主要是后端没起 / 店铺被停用 / 网络抖动。
  let store: StoreInfo | null = null;
  let error: string | null = null;

  try {
    store = await apiFetchAuthed<StoreInfo>('/stores/me');
  } catch (cause) {
    if (cause instanceof ApiError) {
      error = `加载店铺失败（${cause.status}）：${cause.message}`;
    } else {
      error = cause instanceof Error ? cause.message : '店铺加载失败';
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold">概览</h2>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <Card>
        <CardHeader>
          <CardTitle>当前店铺</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {store ? (
            <>
              <p className="text-sm">
                <span className="text-muted-foreground">名称：</span>
                {store.name}
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground">slug：</span>
                <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                  {store.slug}
                </code>
              </p>
              <p className="text-sm">
                <span className="text-muted-foreground">状态：</span>
                {store.status}
              </p>
            </>
          ) : (
            !error && (
              <p className="text-sm text-muted-foreground">暂无店铺信息。</p>
            )
          )}
        </CardContent>
      </Card>

      <p className="text-sm text-muted-foreground">
        商品、订单等模块在后续阶段交付。
      </p>
    </div>
  );
}
