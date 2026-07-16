const isPages = process.env.GITHUB_ACTIONS === "true";
const repo = "AetherCompanion";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  basePath: isPages ? `/${repo}` : "",
  assetPrefix: isPages ? `/${repo}/` : "",
};

export default nextConfig;
