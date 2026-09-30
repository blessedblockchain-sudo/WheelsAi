import type { Metadata } from "next";
import Link from "next/link";
import { ArrowRight } from "lucide-react";

import { BLOG_POSTS, formatPostDate } from "@/components/marketing/blog-posts";
import { PageBody, PageHero } from "@/components/marketing/page-hero";

export const metadata: Metadata = {
  title: "Blog",
  description: "Engineering and product writing from the WheelsAI team: payments, receipts, Nosana GPUs and Solana settlement.",
};

export default function BlogIndexPage() {
  const posts = [...BLOG_POSTS].sort((a, b) => b.date.localeCompare(a.date) || a.title.localeCompare(b.title));
  return (
    <>
      <PageHero
        width="4xl"
        eyebrow="Blog"
        title="Notes from building WheelsAI"
        description="How the platform works under the hood, why we made the choices we did, and what we learned along the way."
      />
      <PageBody width="4xl">
        <ul className="space-y-6">
          {posts.map((post) => (
            <li key={post.slug}>
              <article className="group relative rounded-lg border border-border bg-card p-6 transition-colors hover:border-primary/40">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <time dateTime={post.date}>{formatPostDate(post.date)}</time>
                  <span aria-hidden="true">·</span>
                  <span>{post.author}</span>
                </div>
                <h2 className="mt-2 text-xl font-semibold text-foreground group-hover:text-primary">
                  <Link href={`/blog/${post.slug}`} className="focus-visible:outline-none after:absolute after:inset-0 after:rounded-lg focus-visible:after:ring-2 focus-visible:after:ring-ring">
                    {post.title}
                  </Link>
                </h2>
                <p className="mt-2 leading-7 text-foreground/80">{post.description}</p>
                <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                  <ul className="flex flex-wrap gap-2" aria-label="Tags">
                    {post.tags.map((tag) => (
                      <li key={tag} className="rounded-full bg-muted px-2.5 py-0.5 text-xs font-medium text-muted-foreground">
                        {tag}
                      </li>
                    ))}
                  </ul>
                  <span className="inline-flex items-center gap-1 text-sm font-medium text-primary" aria-hidden="true">
                    Read <ArrowRight className="h-4 w-4" />
                  </span>
                </div>
              </article>
            </li>
          ))}
        </ul>
      </PageBody>
    </>
  );
}
