import { Header } from "@/components/site/Header";
import { Footer } from "@/components/site/Footer";
import { HomeView } from "@/components/site/HomeView";
import { getHomepage, getCategories } from "@/lib/queries";

export const revalidate = 60;

export default async function Page() {
  const [data, categories] = await Promise.all([getHomepage(), getCategories()]);

  return (
    // Homepage only: full-bleed shell on the H1 paper ground (#FCFAF9). Internal
    // routes keep the shared max-w-6xl white card; bands here span the viewport
    // with their content centred in an inner max-w-6xl container.
    <div className="min-h-screen bg-seashell-1">
      <Header categories={categories} />
      <main>
        <HomeView data={data} />
      </main>
      <Footer categories={categories} />
    </div>
  );
}
