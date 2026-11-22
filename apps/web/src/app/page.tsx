import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col justify-center px-6 py-16">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-900">
        Vetoq — HITL Approval Layer
      </h1>
      <p className="mt-3 text-slate-600">
        Human-in-the-loop approval queue, edit-before-execute portal, and policy engine for AI
        agents and n8n workflows.
      </p>
      <div className="mt-8 flex flex-wrap gap-4">
        <Link
          href="/sandbox"
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
        >
          Try Interactive Sandbox
        </Link>
        <Link
          href="/projects"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Open Agency Dashboard
        </Link>
        <Link
          href="/login"
          className="rounded-md border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          Sign In
        </Link>
      </div>
    </main>
  );
}
