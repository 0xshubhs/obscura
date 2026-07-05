"use client"

import { useState, useEffect } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"

const navItems: ({ id: string; label: string } | { href: string; label: string })[] = [
  { id: "hero", label: "Obscura" },
  { id: "signals", label: "Features" },
  { id: "work", label: "Mechanism" },
  { id: "cofhe", label: "CoFHE" },
  { id: "principles", label: "Principles" },
  { id: "colophon", label: "Colophon" },
  { href: "/auctions", label: "Auctions" },
  { href: "/my-bids", label: "My Bids" },
  { href: "/wallet", label: "Wallet" },
]

export function SideNav() {
  const pathname = usePathname()
  const [activeSection, setActiveSection] = useState("hero")
  const isAuctions = pathname?.startsWith("/auctions")

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id)
          }
        })
      },
      { threshold: 0.3 },
    )

    navItems.forEach((item) => {
      if ("id" in item) {
        const element = document.getElementById(item.id)
        if (element) observer.observe(element)
      }
    })

    return () => observer.disconnect()
  }, [])

  const scrollToSection = (id: string) => {
    const element = document.getElementById(id)
    if (element) {
      element.scrollIntoView({ behavior: "smooth" })
    }
  }

  return (
    <nav className="fixed left-0 top-0 z-50 h-screen w-16 md:w-20 hidden md:flex flex-col justify-center border-r border-border/30 bg-background/80 backdrop-blur-sm">
      <div className="flex flex-col gap-6 px-4">
        {navItems.map((item) => {
          if ("href" in item) {
            const isActive = pathname === item.href || pathname?.startsWith(item.href + "/")
            return (
              <Link
                key={item.href}
                href={item.href}
                className="group relative flex items-center gap-3"
              >
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full transition-all duration-300",
                    isActive ? "bg-accent scale-125" : "bg-muted-foreground/40 group-hover:bg-foreground/60",
                  )}
                />
                <span
                  className={cn(
                    "absolute left-6 font-mono text-[10px] uppercase tracking-widest opacity-0 transition-all duration-200 group-hover:opacity-100 group-hover:left-8 whitespace-nowrap",
                    isActive ? "text-accent" : "text-muted-foreground group-hover:text-foreground",
                  )}
                >
                  {item.label}
                </span>
              </Link>
            )
          }
          const { id, label } = item
          return (
            <button key={id} onClick={() => scrollToSection(id)} className="group relative flex items-center gap-3">
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full transition-all duration-300",
                  activeSection === id ? "bg-accent scale-125" : "bg-muted-foreground/40 group-hover:bg-foreground/60",
                )}
              />
              <span
                className={cn(
                  "absolute left-6 font-mono text-[10px] uppercase tracking-widest opacity-0 transition-all duration-200 group-hover:opacity-100 group-hover:left-8 whitespace-nowrap",
                  activeSection === id ? "text-accent" : "text-muted-foreground",
                )}
              >
                {label}
              </span>
            </button>
          )
        })}
      </div>
    </nav>
  )
}
