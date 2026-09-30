"use client";

import { Bell, Plus } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

interface HeaderProps {
  title: string;
  description?: string;
  action?: {
    label: string;
    href: string;
  };
}

export function Header({ title, description, action }: HeaderProps) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-card px-8 py-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">{title}</h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="flex items-center gap-4">
        <button className="rounded-lg p-2 text-muted-foreground hover:bg-muted" aria-label="Notifications">
          <Bell className="h-5 w-5" />
        </button>
        {action && (
          <Link href={action.href}>
            <Button>
              <Plus className="mr-2 h-4 w-4" />
              {action.label}
            </Button>
          </Link>
        )}
      </div>
    </div>
  );
}
