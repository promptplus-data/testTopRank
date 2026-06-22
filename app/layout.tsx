import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "ค้นหาข้อมูล Top Rank",
	description: "ระบบค้นหาข้อมูล Top Rank",
};

export default function RootLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	return (
		<html lang="th">
			<body suppressHydrationWarning>{children}</body>
		</html>
	);
}
