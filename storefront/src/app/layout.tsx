import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SessionSync } from "@/components/session/session-sync";
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
  title: "店铺前台",
  description: "多租户电商 SaaS 平台 · 消费者店铺前台",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        {/* 会话同步：把刷新后的会话 cookie 送回浏览器，并协调多标签页。
            挂在根 layout 上，所以**每个页面**都会跑一次。 */}
        <SessionSync />
      </body>
    </html>
  );
}
