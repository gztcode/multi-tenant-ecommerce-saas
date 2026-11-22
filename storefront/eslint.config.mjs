import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// eslint-config-next 16 起导出的是 **flat config 数组**，直接用原生 import 展开；
// 不能再走 FlatCompat 的 `compat.extends("next/...")`（那会按旧版 eslintrc 解析，
// 报 `TypeError: Converting circular structure to JSON`）。
const eslintConfig = [
  ...nextVitals,
  ...nextTs,
  {
    // Next 16 的 eslint-config-next 带入了 React Compiler 规则集
    //（eslint-plugin-react-hooks v7）。本仓既有代码里这三条命中的都是
    // **有意为之的写法**，升级依赖不应顺带重写业务组件：
    // - set-state-in-effect：挂载后读 sessionStorage / 首屏拉取数据
    // - refs：事件处理函数里读写 busyRef 做并发去重（只在 onClick 触发，
    //   渲染期并不读 ref）
    // - immutability：`window.location.href = payUrl` 这类跳转赋值
    // 先降为 warn 保留可见性，等单独排期再逐条收口。
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
    },
  },
  {
    ignores: ["node_modules/**"],
  },
];

export default eslintConfig;
