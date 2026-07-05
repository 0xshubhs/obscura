import Link from "next/link"
import { cn } from "@/lib/utils"

export function ObscuraLogo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      className={cn(
        "inline-flex items-center gap-2 group focus:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        className,
      )}
      aria-label="Obscura — Home"
    >
      {/* Logo: teardrop (pool) + wax seal */}
      <span className="flex items-center justify-center w-9 h-9 border border-current text-muted-foreground group-hover:text-accent group-hover:border-accent transition-colors">
        <svg
          width="20"
          height="20"
          viewBox="0 0 32 32"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="shrink-0"
          aria-hidden
        >
          {/* Teardrop / pool */}
          <path
            d="M16 4c0 0 10 6 10 14c0 6.5-4.5 10-10 10s-10-3.5-10-10C6 10 16 4 16 4Z"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
          {/* Seal: filled circle + lock cutout */}
          <circle cx="16" cy="14" r="4.5" fill="currentColor" />
          <path
            d="M14 11.5a2.5 2.5 0 0 1 4 0v.8h-1v-.8a1.5 1.5 0 0 0-2 0v.8h-1v-.8zm.5 1.2h3v1.6a1.4 1.4 0 0 1-2.8 0v-1.6h-.2z"
            fill="var(--background)"
          />
        </svg>
      </span>
      <span className="font-[var(--font-bebas)] text-xl tracking-tight text-foreground group-hover:text-accent transition-colors">
        Obscura
      </span>
    </Link>
  )
}
