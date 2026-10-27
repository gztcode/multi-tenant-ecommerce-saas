import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "平台超管后台",
  description: "多租户电商 SaaS 平台 · 平台超管后台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    /* ⚠️ **字体变量必须留在 `<html>` 上**：`:root`（= `<html>`）声明
        `--brand-font-sans: var(--font-geist-sans)`，而自定义属性的 `var()`
        替换发生在**声明它的那个元素上** —— 若 `--font-geist-sans` 只挂在
        `<body>` 上，`<html>` 处解析不到 → `--brand-font-sans` 变成无效值，
        且 `<body>` 的同名变量**不会来补救** → 商家改字体前台看不到变化。
        挪到 `<body>` 会让品牌字体失效。 */
    <html
      lang="zh-CN"
      className={`${geistSans.variable} ${geistMono.variable}`}
    >
      <body className="antialiased">
        {children}
      </body>
    </html>
  );
}