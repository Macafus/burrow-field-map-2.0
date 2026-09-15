import type { Metadata } from "next";
import "./globals.css";

const title = "巣穴管理";
const description = "手書き地図を編集し、巣穴ごとのF・M個体とロガー状況を管理するアプリ。";

export const metadata: Metadata = {
  title,
  description,
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title,
  },
  applicationName: title,
  formatDetection: {
    telephone: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja">
      <head>
        <link
          href="/favicon.ico?v=20260915-3"
          rel="icon"
          sizes="64x64"
          type="image/x-icon"
        />
        <link href="/favicon.ico?v=20260915-3" rel="shortcut icon" />
        <link href="/apple-touch-icon.png" rel="apple-touch-icon" sizes="180x180" />
      </head>
      <body>{children}</body>
    </html>
  );
}
