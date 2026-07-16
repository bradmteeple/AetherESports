import Link from "next/link";

const pages = [
  { href: "/social", label: "Social" },
  { href: "/team-builder", label: "Team Builder" },
  { href: "/battle", label: "Battle" },
  { href: "/my-page", label: "My Page" },
];

export default function Home() {
  return (
    <section className="hero">
      <h1 className="logo">AetherESports</h1>
      <p className="tagline">Improve your VGC game</p>
      <div className="button-grid">
        {pages.map((page) => (
          <Link key={page.href} href={page.href} className="button">
            {page.label}
          </Link>
        ))}
      </div>
    </section>
  );
}
