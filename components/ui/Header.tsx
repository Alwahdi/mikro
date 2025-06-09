"use client";

import { useState } from "react";
import { Bell, Menu } from "lucide-react";
import { Avatar, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import Link from "next/link";

export function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="flex items-center justify-between border-b border-border px-4 py-3 md:px-10">
      <div className="flex items-center gap-4">
        <div className="size-4">
          <svg
            viewBox="0 0 48 48"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <path
              d="M8.57829 8.57829C5.52816 11.6284 3.451 15.5145 2.60947 19.7452C1.76794 23.9758 2.19984 28.361 3.85056 32.3462C5.50128 36.3314 8.29667 39.7376 11.8832 42.134C15.4698 44.5305 19.6865 45.8096 24 45.8096C28.3135 45.8096 32.5302 44.5305 36.1168 42.134C39.7033 39.7375 42.4987 36.3314 44.1494 32.3462C45.8002 28.361 46.2321 23.9758 45.3905 19.7452C44.549 15.5145 42.4718 11.6284 39.4217 8.57829L24 24L8.57829 8.57829Z"
              fill="currentColor"
            />
          </svg>
        </div>
        <h2 className="text-lg font-bold tracking-tight">MikroMaster</h2>
      </div>
      {/* Mobile menu button */}
      <div className="flex md:hidden">
        <Button
          size="icon"
          variant="ghost"
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Open menu"
        >
          <Menu />
        </Button>
      </div>
      {/* Desktop nav */}
      <nav className="hidden md:flex flex-1 justify-end gap-8">
        <div className="flex items-center gap-9">
          {["Routers", "Users", "Hotspots", "Settings"].map((item) => (
            <Link key={item} href="#" className="text-sm font-medium">
              {item}
            </Link>
          ))}
        </div>
        <Button size="icon" variant="ghost">
          <Bell className="text-white" />
        </Button>
        <Avatar className="size-10">
          <AvatarImage src="https://lh3.googleusercontent.com/aida-public/AB6AXuBlA661c85..." />
        </Avatar>
      </nav>
      {/* Mobile nav */}
      {menuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 md:hidden"
          onClick={() => setMenuOpen(false)}
        >
          <div
            className="absolute right-0 top-0 h-full w-64 bg-background shadow-lg flex flex-col gap-6 p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-col gap-4">
              {["Routers", "Users", "Hotspots", "Settings"].map((item) => (
                <Link
                  key={item}
                  href="#"
                  className="text-base font-medium"
                  onClick={() => setMenuOpen(false)}
                >
                  {item}
                </Link>
              ))}
            </div>
            <div className="flex items-center gap-4 mt-auto">
              <Button size="icon" variant="ghost">
                <Bell className="text-white" />
              </Button>
              <Avatar className="size-10">
                <AvatarImage src="https://lh3.googleusercontent.com/aida-public/AB6AXuBlA661c85..." />
              </Avatar>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
