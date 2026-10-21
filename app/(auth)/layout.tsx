import Link from "next/link";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <Link href="/" className="mb-6 flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/gideon-logo.svg" alt="" className="h-10 w-10" />
        <span className="text-xl font-semibold tracking-tight text-slate-900">Gideon Books</span>
      </Link>
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-sm sm:p-8">{children}</div>
      <p className="mt-6 max-w-md text-center text-xs text-slate-500">
        Open-source accounting (Apache-2.0). Your books stay on the server you run them on.
      </p>
    </div>
  );
}
