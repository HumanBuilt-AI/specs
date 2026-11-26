import type { Metadata } from "next";
import BuildKit from "./build-kit";
import { PageMotion } from "../ui/page-motion.tsx";

export const metadata: Metadata = { title: "Build a brand kit · Specs" };

export default function BuildPage() {
  return (
    <PageMotion>
    <main className="build">
      <h1>Build a brand kit</h1>
      <p className="muted">
        Four quick steps: your logo and photos, your colors, your fonts, then your words. Claude reads your files while you go,
        drafts your brand kit piece by piece, and every item shows where it came from.
      </p>
      <BuildKit siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? ""} />
    </main>
    </PageMotion>
  );
}
