import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MoviesTVShows",
  description:
    "Discover top movies and TV shows on Netflix, HBO/Max, Peacock, and Hulu in the United States.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
