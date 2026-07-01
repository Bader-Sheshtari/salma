import type { Metadata } from "next";
import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { TransfersBrowser } from "@/components/site/TransfersBrowser";
import { getCategories, getTransfers } from "@/lib/queries";

export const revalidate = 60;

export const metadata: Metadata = { title: "انتقال الأطباء · سلمى" };

export default async function TransfersPage() {
  const [categories, transfers] = await Promise.all([getCategories(), getTransfers()]);

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} active="transfers" />
      <main className="px-4 py-6 sm:px-6">
        <div className="mb-5 flex items-center gap-2.5">
          <span className="h-7 w-1.5 rounded-sm bg-teal" />
          <h1 className="text-2xl font-bold sm:text-3xl">انتقال الأطباء</h1>
        </div>

        {transfers.length === 0 ? (
          <p className="text-[14px] text-gray">لا توجد انتقالات بعد.</p>
        ) : (
          <TransfersBrowser transfers={transfers} />
        )}
      </main>
      <Footer categories={categories} />
    </div>
  );
}
