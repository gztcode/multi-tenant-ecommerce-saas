import { NextResponse } from 'next/server';
import { auth } from '@/auth';
import { apiFetch } from '@/lib/api-client';
import { toErrorResponse, unauthorizedResponse } from '@/lib/route-helpers';

/**
 * 导出商品 CSV 的中转。
 *
 * 只导出基础信息——规格矩阵与媒体用扁平表格表达会立刻变得不可读，
 * 那部分走 JSON 或留到后面。
 *
 * ⚠️ **列顺序与导入页严格一致**（前 5 列）：
 * 名称 / slug / 品类id / 描述性属性JSON / 状态
 * 这样「导出 → 改几个价 → 再导回去」是可行的。
 * 计划里原本给的顺序是「名称,slug,状态,最低价(分),描述性属性」，
 * 那套列名导出的文件喂给导入页会全行失败：导入要的是「品类id」，
 * 导出却给「状态」；导出还有「最低价(分)」——那是**派生字段**
 * （由 SKU 价格推导，见 api 的 MinPriceService），后端 CreateProductDto
 * 根本不接受它，多传会被 forbidNonWhitelisted 挡成 400。
 *
 * 后面的「最低价(分)」保留在末尾作为**只读参考列**：导入按列名匹配，
 * 多出来的只读列会被忽略，所以它不影响回灌，却能让商家在 Excel 里
 * 对一眼导出的价对不对。
 */

/**
 * 一次导出最多取多少条。后端 pageSize 上限就是 100，再多要翻页。
 *
 * ⚠️ 这条路由**刻意不接受任何查询参数**：导出永远是「当前租户的第一页」，
 * 不支持 keyword / status 之类的筛选。加一个半吊子的筛选进去，商家会以为
 * 导出的是筛选结果，实际只拿到前 100 条且没有提示——比不做筛选更危险。
 * 超出 100 条的导出留到后面做成异步任务。
 */
const EXPORT_PAGE_SIZE = 100;

interface ExportProduct {
  id: string;
  name: string;
  slug: string;
  status: string;
  categoryId?: string | null;
  attributes?: Record<string, string> | null;
  minPrice?: number | null;
}

/**
 * CSV 单元格转义。
 *
 * RFC 4180：含逗号、双引号或换行的单元格要用双引号包起来，里面的双引号翻倍。
 * 漏掉这一步，商品描述里一个逗号就会让整行的列全部错位——
 * 而错位之后的导入会安静地建出错误的商品。
 */
function escapeCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV 注入防护：以 = / + / - / @ 开头的单元格会被 Excel 当成公式执行 */
function guardFormula(text: string): string {
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}

export async function GET() {
  const session = await auth();
  if (!session) {
    return unauthorizedResponse();
  }

  try {
    const result = await apiFetch<{ items: ExportProduct[]; total: number }>(
      `/catalog/products?page=${1}&pageSize=${EXPORT_PAGE_SIZE}`,
      { token: session.accessToken },
    );

    const header = [
      '名称',
      'slug',
      '品类id',
      '描述性属性JSON',
      '状态',
      '最低价(分)',
    ];

    const rows = (result.items ?? []).map((product) =>
      [
        guardFormula(product.name),
        product.slug,
        product.categoryId ?? '',
        // 空属性写 `{}` 而不是空串：空串在导入端会被当成「没有这一列」，
        // 而 {} 明确表示「有这一列且为空」，列数才对得上。
        JSON.stringify(product.attributes ?? {}),
        product.status,
        // 只读参考列：最低价是派生字段，导入端按列名忽略它。
        product.minPrice === null || product.minPrice === undefined
          ? ''
          : String(product.minPrice),
      ].map(escapeCell),
    );

    // 行尾用 CRLF：Excel 在 Windows 上按 LF 打开 CSV 时可能把整份文件
    // 识别成一行，BOM 解决不了这一层。
    const csv = [header, ...rows].map((row) => row.join(',')).join('\r\n');

    // ⚠️ BOM（U+FEFF）：Excel 打开无 BOM 的 UTF-8 CSV 会按本地代码页猜编码，
    // 中文全变乱码。Excel 自己导出的 CSV 也带 BOM，跟着它的约定走。
    return new NextResponse(`\uFEFF${csv}`, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': 'attachment; filename="products.csv"',
        // 缓存层不能留着旧导出：商家改了价再点导出要看到新的。
        'cache-control': 'no-store',
      },
    });
  } catch (cause) {
    return toErrorResponse(cause);
  }
}