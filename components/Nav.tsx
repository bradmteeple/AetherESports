import Link from "next/link";

const links = [
  { href: "/", label: "AetherESports" },
  { href: "/social", label: "Social" },
  { href: "/team-builder", label: "Team Builder" },
  { href: "/battle", label: "Battle" },
  { href: "/my-page", label: "My Page" },
];

export default function Nav() {
  return (
    <nav className="nav">
      {links.map((link) => (
        <Link key={link.href} href={link.href} className="nav-link">
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
