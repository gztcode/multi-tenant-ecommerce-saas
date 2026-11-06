import type { ControllerRolesExemption } from './controller-roles-scanner';

/**
 * 「按设计就不该有角色限定」的路由登记（2026-11-05 审计 §四 护栏）。
 *
 * ⚠️ **这张表是护栏的一部分，不是「已知问题清单」**：
 *    往任何一个控制器新增路由而没有登记豁免，
 *    `controller-roles-scanner.spec.ts` 立刻变红 →
 *    新路由必须被**显式分类**（要么挂 `@Roles`，要么在这里写清理由）。
 *
 * ⚠️ **每条必须写 `why`**：将来有人想「顺手给它挂上角色」时，
 *    会先看到理由 —— 而这正是它当初不能挂的原因。
 *
 * ⚠️ **锚点用「文件 + 方法名」，不用行号**：行号会随任何改动漂移，
 *    豁免会莫名其妙失效（或误放行）。方法被改名/删除后，
 *    扫描器的自检会指出「豁免表里有过期条目」，逼着人来清理。
 *
 * ⚠️ **这份清单覆盖的是「消费者面 + 渠道回调面」**，
 *    **商家管理面与平台面的路由一律必须有 `@Roles`** ——
 *    那才是资损与越权的高发区。
 */
export const CONTROLLER_ROLES_EXEMPTIONS: ControllerRolesExemption[] = [
  {
    file: 'src/modules/auth/auth.controller.ts',
    methods: [
      'login',
      'logout',
      'me',
      'refresh',
      'registerCustomer',
      'registerMerchant',
    ],
    why:
      '注册与登录：调用方还没有任何身份，角色无从谈起。' +
      '`me` / `logout` / `refresh` 靠令牌本身确定身份，' +
      '拿到令牌的人本来就只可能是它自己。',
  },
  {
    file: 'src/modules/cart/address.controller.ts',
    methods: ['list', 'create', 'update', 'remove'],
    why:
      '消费者地址：认证由类级 `@UseGuards(JwtAuthGuard)` 负责，' +
      '越权防护靠服务层「只操作当前 customerId 名下的地址」——' +
      '地址是消费者自己的数据，不存在「商家角色才能改」这回事。',
  },
  {
    file: 'src/modules/cart/cart.controller.ts',
    methods: [
      'current',
      'clear',
      'addItem',
      'updateItem',
      'removeItem',
      'merge',
    ],
    why:
      '消费者购物车：同地址，购物车天然归属当前消费者。' +
      '用 `OptionalJwtAuthGuard` 是为了「登录了就用登录身份、没登录就用访客身份」，' +
      '角色不参与判定。',
  },
  {
    file: 'src/modules/coupon/coupon.controller.ts',
    methods: ['available', 'claim', 'mine', 'preview'],
    why:
      '消费者领券与查券：券的归属由「消费者 + 券」决定，' +
      '商家侧另有 `merchant-coupon.controller.ts`（那套有 `@Roles`）。',
  },
  {
    file: 'src/modules/order/order.controller.ts',
    methods: ['place', 'list', 'detail', 'cancel', 'confirm'],
    why: '消费者订单：订单归属消费者，商家侧另有 `merchant-order.controller.ts`（那套有 `@Roles`）。',
  },
  {
    file: 'src/modules/payment/fake-payment.controller.ts',
    methods: ['page', 'confirm', 'fail'],
    why:
      '假支付网关页面：渠道侧的页面，不属于任何一方，' +
      '且只在非生产环境启用（`DEV_ONLY_CHANNELS`）。',
  },
  {
    file: 'src/modules/payment/payment.controller.ts',
    methods: ['pay'],
    why:
      '消费者付款：付的是自己的订单。' +
      '同文件的 `refund` 是商家退款，**挂了方法级 `@Roles(MERCHANT_OWNER)`**，' +
      '不在豁免范围内。',
  },
  {
    file: 'src/modules/payment/webhook.controller.ts',
    methods: ['payment', 'subscription'],
    why:
      '渠道回调：调用方是支付渠道而不是登录用户，' +
      '身份认证靠**验签**（见 `webhook.controller.ts` 的说明），不是靠角色。',
  },
  {
    file: 'src/modules/stores/stores.controller.ts',
    methods: ['findMine'],
    why:
      '`GET /stores/me` 刻意不挂角色：它返回的内容（店名 / 主题 token）' +
      '消费者本就能从公开接口看到，而店员也该能看。' +
      '同文件的 `updateMine`（PATCH）**挂了 `@Roles`**。',
  },
];
