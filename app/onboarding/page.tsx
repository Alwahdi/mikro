"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export default function OnboardingPage() {
  const router = useRouter();

  return (
    <div className="relative flex min-h-screen flex-col bg-[#111518] text-white font-sans">
      <header className="flex items-center justify-between border-b border-[#283139] px-10 py-3">
        <div className="flex items-center gap-4">
          <div className="size-4">
            {/* SVG Logo */}
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
      </header>
      <main className="flex-1 flex items-center justify-center">
        <div className="w-full max-w-xl p-6 text-center">
          <h2 className="text-2xl font-bold mb-3">Welcome to MikroMaster</h2>
          <p className="mb-6 text-base">
            To get started, connect your MikroTik router to MikroMaster. This
            will allow you to manage your network, configure settings, and
            monitor performance in real-time.
          </p>
          <div className="flex gap-4 justify-center">
            <Button
              className="bg-[#0b80ee] text-white"
              onClick={() => router.push("/onboarding/connect")}
            >
              Connect Router
            </Button>
            <Button
              className="bg-[#283139] text-white"
              onClick={() => router.push("/")}
            >
              Skip
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
