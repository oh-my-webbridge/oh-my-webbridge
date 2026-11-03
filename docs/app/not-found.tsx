import Link from "next/link";

export default function NotFound() {
  return (
    <main className="flex flex-1 flex-col items-start justify-center gap-4 px-6 py-24 md:px-12">
      <h1 className="font-bold text-3xl tracking-[-0.02em]">Page not found</h1>
      <p className="text-fd-muted-foreground">The link may be outdated, or the page has moved.</p>
      <Link className="text-fd-primary hover:underline" href="/">
        Back to the docs
      </Link>
    </main>
  );
}
