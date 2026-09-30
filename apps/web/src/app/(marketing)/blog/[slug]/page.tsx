import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";

import { BLOG_POSTS, formatPostDate, getPost } from "@/components/marketing/blog-posts";
import { PageBody, PageHero } from "@/components/marketing/page-hero";
import { Prose } from "@/components/marketing/prose";

interface Params {
  slug: string;
}

export function generateStaticParams(): Params[] {
  return BLOG_POSTS.map((p) => ({ slug: p.slug }));
}

export const dynamicParams = false;

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) return { title: "Post not found" };
  return {
    title: post.title,
    description: post.description,
    authors: [{ name: post.author }],
    openGraph: {
      type: "article",
      title: post.title,
      description: post.description,
      publishedTime: post.date,
    },
  };
}

export default async function BlogPostPage({ params }: { params: Promise<Params> }) {
  const { slug } = await params;
  const post = getPost(slug);
  if (!post) notFound();
  const Body = post.body;

  return (
    <article>
      <PageHero
        width="3xl"
        eyebrow={
          <Link href="/blog" className="inline-flex items-center gap-1 normal-case tracking-normal hover:text-white">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Blog
          </Link>
        }
        title={post.title}
      >
        <p className="mt-4 text-sm text-navy-200/80">
          <time dateTime={post.date}>{formatPostDate(post.date)}</time>
          <span aria-hidden="true"> · </span>
          <span>{post.author}</span>
        </p>
      </PageHero>
      <PageBody width="3xl">
        <p className="text-lg leading-8 text-muted-foreground">{post.description}</p>
        <Prose className="mt-8">
          <Body />
        </Prose>
        <div className="mt-16 border-t border-border pt-8">
          <Link href="/blog" className="inline-flex items-center gap-1 text-sm font-medium text-primary underline-offset-4 hover:underline">
            <ArrowLeft className="h-4 w-4" aria-hidden="true" /> All posts
          </Link>
        </div>
      </PageBody>
    </article>
  );
}
