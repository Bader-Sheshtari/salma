import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { HomeView } from "@/components/site/HomeView";
import { getHomepage, getCategories } from "@/lib/queries";

export const revalidate = 60;

export default async function Page() {
  const [data, categories] = await Promise.all([getHomepage(), getCategories()]);

  return (
    <div className="mx-auto min-h-screen max-w-6xl bg-white shadow-[0_0_60px_rgba(46,46,45,.12)]">
      <Header categories={categories} />
      <main>
        <HomeView data={data} />
      </main>
      <Footer categories={categories} />
    </div>
  );
}
