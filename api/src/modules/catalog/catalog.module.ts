import { Module } from '@nestjs/common';
import { BillingModule } from '../billing/billing.module';
import { CategoriesController } from './categories/categories.controller';
import { CategoriesService } from './categories/categories.service';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { MinPriceService } from './pricing/min-price.service';
import { SpecMatrixService } from './specs/spec-matrix.service';
import { PublicCatalogController } from './public/public-catalog.controller';
import { PublicCatalogService } from './public/public-catalog.service';

@Module({
  // ⚠️ **模块依赖方向是 `catalog` → `billing`**（单向）：
  // 商品与 SKU 的额度检查要问 billing 要。
  // `billing` 绝不能 import `catalog` —— 那就成了环。
  imports: [BillingModule],
  controllers: [
    CategoriesController,
    ProductsController,
    PublicCatalogController,
  ],
  providers: [
    CategoriesService,
    ProductsService,
    MinPriceService,
    SpecMatrixService,
    PublicCatalogService,
  ],
  // 导出服务：后续 Task（规格矩阵、库存）需要在商品 / SKU 上做校验与派生字段维护
  exports: [
    CategoriesService,
    ProductsService,
    MinPriceService,
    SpecMatrixService,
    PublicCatalogService,
  ],
})
export class CatalogModule {}
