const isPages = process.env.GITHUB_ACTIONS === "true";
// Derive the repo name from GITHUB_REPOSITORY ("owner/repo") so the Pages
// basePath always matches the actual repository — even if it's renamed.
const repo = process.env.GITHUB_REPOSITORY?.split("/")[1] ?? "";

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  images: { unoptimized: true },
  basePath: isPages && repo ? `/${repo}` : "",
  assetPrefix: isPages && repo ? `/${repo}/` : "",
};

export default nextConfig;
