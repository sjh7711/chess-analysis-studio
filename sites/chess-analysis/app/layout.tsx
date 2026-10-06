import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "체스 분석 · 친구와 대국",
  description: "친구와 체스를 두고 저장된 경기 기록을 Stockfish로 복기하세요.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
