/**
 * 遍历 Server Component 返回的 React 元素树，收集里面的文字。
 *
 * ⚠️ **为什么不用 `renderToStaticMarkup`**：页面上有 `next/link`，
 * 在 Next 运行时之外渲染它可能抛错。遍历元素树更稳 ——
 * 只看 `element.props.children`，**不执行任何组件函数**，
 * 所以 `Link` / `Card` / `Table` 这些组件都不会被执行。
 *
 * ⚠️ **Server Component 返回的树是「还没渲染」的**：组件函数（如 `Card`）
 * 的元素带着 `props.children`，遍历时把 `props.children` 也算进去 ——
 * 文字就在那儿。
 *
 * ⚠️ **为什么需要它**：这三个页面（套餐 / 订阅 / 报表）是 Server Component，
 * 不能用 `@testing-library/react` 的 `render`（那是给 DOM 用的）。
 * 直接 `await Page({ searchParams })` 拿到元素树，然后断言「页面上出现了
 * 哪句话」——这正是这些页面真正要保证的东西。
 */

import { isValidElement, type ComponentType, type ReactElement, type ReactNode } from 'react';

/**
 * 把 React 元素树里的所有字符串收集起来。
 *
 * @param node 元素树的根节点
 * @param out 累加器（递归时复用同一个数组）
 */
export function collectText(node: unknown, out: string[] = []): string[] {
  // 字符串与数字：直接收。
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }
  if (typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  // 数组：逐项递归。
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  // null / undefined / false / true：React 不渲染它们，跳过。
  if (node === null || node === undefined || typeof node === 'boolean') {
    return out;
  }
  // 元素：只读 props.children，不执行组件函数。
  if (isValidElement(node)) {
    const element = node as ReactElement<{ children?: ReactNode }>;
    collectText(element.props?.children, out);
  }
  return out;
}

/**
 * 页面上是否出现了某句话。
 *
 * ⚠️ **同时看「单个节点」与「拼起来的整段」**：JSX 里的插值会把一句话
 * 拆成多个文本节点（`下个周期：{name}` → `"下个周期："` + `"旗舰版"`），
 * 只看单个节点会漏掉跨节点的短语。
 *
 * ⚠️ **拼接时不加分隔符**：React 渲染相邻文本节点时本来就不加分隔符，
 * 加了空格反而会让「下个周期： 旗舰版」匹配不上「下个周期：旗舰版」。
 */
export function hasText(texts: string[], needle: string): boolean {
  if (texts.some((text) => text.includes(needle))) return true;
  return texts.join('').includes(needle);
}

/**
 * 把收集到的文字拼成一段（便于断言「包含」）。
 *
 * ⚠️ **不加分隔符**：与 React 渲染相邻文本节点的行为一致。
 */
export function joinText(texts: string[]): string {
  return texts.join('');
}

/**
 * 找出树里所有**指定组件**的元素，把它们的 props 收起来。
 *
 * ⚠️ **为什么需要它**：客户端组件（如 `PlanForm`）在树里是一个
 * 「还没有渲染」的元素 —— 它的内部文字不在 `props.children` 里，
 * 那些文字只有组件函数被执行之后才会出现（而我们不执行它）。
 * 但它**收到的 props**（例如 `plan`）就在元素上，可以直接断言：
 * 「编辑表单拿到的是这个套餐」这件事就是这么验的。
 *
 * ⚠️ **按组件引用比对**（不是按名字）：名字可以重复，也可以被
 * 打包工具改名，按引用比才不会认错人。
 */
export function collectComponentProps(
  node: unknown,
  component: ComponentType<never> | ComponentType<unknown>,
  out: Record<string, unknown>[] = [],
  seen = new Set<unknown>(),
): Record<string, unknown>[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectComponentProps(child, component, out, seen);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);

  const element = node as ReactElement<Record<string, unknown>>;
  const props = element.props;
  if (props && typeof props === 'object') {
    if (element.type === component) out.push(props);
    collectComponentProps(props.children, component, out, seen);
  }
  return out;
}

/**
 * 把树里所有元素的 `className` 收集起来（字符串形式）。
 *
 * ⚠️ **为什么需要它**：有些护栏不是「页面上有没有这句话」，
 *    而是「这句话**长得不一样**」—— 例如卡住 10 分钟以上的出款单
 *    标红（`text-destructive`）。那种只能看样式类。
 *
 * ⚠️ **只收字符串的 `className`**：`clsx` 之类的组合可能给出数组或对象，
 *    这里统一跳过（页面上的写法都是字符串）。
 */
export function collectClassNames(
  node: unknown,
  out: string[] = [],
  seen = new Set<unknown>(),
): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectClassNames(child, out, seen);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);

  const element = node as ReactElement<Record<string, unknown>>;
  const props = element.props;
  if (props && typeof props === 'object') {
    const className = props.className;
    if (typeof className === 'string') out.push(className);
    collectClassNames(props.children, out, seen);
  }
  return out;
}

/**
 * 找出树里所有**链接**的 href。
 *
 * ⚠️ **按 `href` 断言比按文字断言更准**：「编辑」与「取消」都是链接，
 * 光看文字分不清是哪一个；href 是唯一的。
 */
export function collectHrefs(
  node: unknown,
  out: string[] = [],
  seen = new Set<unknown>(),
): string[] {
  if (node === null || node === undefined || typeof node === 'boolean') return out;
  if (typeof node === 'string' || typeof node === 'number') return out;
  if (Array.isArray(node)) {
    for (const child of node) collectHrefs(child, out, seen);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);

  const element = node as ReactElement<Record<string, unknown>>;
  const props = element.props;
  if (props && typeof props === 'object') {
    const href = props.href;
    if (typeof href === 'string') out.push(href);
    collectHrefs(props.children, out, seen);
  }
  return out;
}
