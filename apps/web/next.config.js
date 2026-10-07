/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // standalone feeds the Fly/Docker image; Netlify's Next runtime requires
  // the default output, so its build env sets NEXT_DISABLE_STANDALONE=1.
  output: process.env.NEXT_DISABLE_STANDALONE === "1" ? undefined : "standalone",
  transpilePackages: ["@wheelsai/shared", "@wheelsai/types"],
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      {
        // The chat widget is loaded by other people's sites. It must stay
        // loadable there under a strict embedder policy, and be cached
        // briefly so a fix reaches every embed within minutes.
        source: "/widget.js",
        headers: [
          { key: "Cross-Origin-Resource-Policy", value: "cross-origin" },
          { key: "Access-Control-Allow-Origin", value: "*" },
          { key: "Cache-Control", value: "public, max-age=300" },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
