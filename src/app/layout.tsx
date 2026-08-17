import type { Metadata, Viewport } from "next";
import "@fontsource/archivo-black";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: "ASCEND | Agency Operating System",
  description:
    "The operating system for the agency: leads, pipeline, proposals, clients, calendar, billing and outreach in one place.",
  icons: {
    icon: "/icon.svg"
  },
  // Nothing in this application is public and none of it should ever be
  // indexed. Every route is already behind a session; this is the belt to that
  // pair of braces.
  robots: {
    index: false,
    follow: false
  }
};

export const viewport: Viewport = {
  themeColor: "#0A0A0B"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
