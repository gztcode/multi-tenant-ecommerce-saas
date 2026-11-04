'use client';

/**
 * 段级错误边界。
 *
 * ⚠️ **它接的是「已经渲染失败的那一段」**，捕获的是 React 渲染期抛出的异常。
 * 数据请求的错误不走这里（那些在页面里自己 catch 了）。
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-start justify-center gap-4 p-8">
      <h1 className="text-2xl font-bold">页面出错了</h1>
      <p className="text-muted-foreground">
        页面加载时出了点问题，你可以重试一次；如果一直不行，请稍后再来。
      </p>
      <button
        type="button"
        className="rounded-md bg-primary px-4 py-2 text-primary-foreground"
        onClick={() => reset()}
      >
        重试
      </button>
    </main>
  );
}
