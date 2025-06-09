"use client";

import React, { useState } from "react";
import { useRouter } from "next/navigation";
import { completeOnboarding } from "./_actions";
import { useUser } from "@clerk/nextjs";

export default function ConnectRouterPage() {
  const [error, setError] = useState("");
  const router = useRouter();
  const { user } = useUser();

  async function handleSubmit(formData: FormData) {
    const res = await completeOnboarding(formData);

    if (res?.message) {
      await user?.reload?.();
      router.push("/");
    } else if (res?.error) {
      setError(res.error);
    }
  }

  return (
    <form
      action={handleSubmit}
      className="min-h-screen bg-[#121416] text-white flex items-center justify-center px-6"
    >
      <div className="w-full max-w-md">
        <h1 className="text-3xl font-bold mb-6">Connect Router</h1>

        <div className="space-y-4">
          <div>
            <label className="block mb-2">IP Address</label>
            <input
              name="applicationName"
              placeholder="Enter IP address"
              required
              className="w-full h-12 px-4 bg-[#1e2124] text-white rounded-xl border border-[#40484f] focus:outline-none placeholder:text-[#a2abb3]"
            />
          </div>

          <div>
            <label className="block mb-2">Username</label>
            <input
              name="applicationType"
              placeholder="Enter username"
              required
              className="w-full h-12 px-4 bg-[#1e2124] text-white rounded-xl border border-[#40484f] focus:outline-none placeholder:text-[#a2abb3]"
            />
          </div>

          <div>
            <label className="block mb-2">Password</label>
            <input
              type="password"
              placeholder="Enter password"
              className="w-full h-12 px-4 bg-[#1e2124] text-white rounded-xl border border-[#40484f] focus:outline-none placeholder:text-[#a2abb3]"
            />
          </div>

          <div>
            <label className="block mb-2">Connection Protocol</label>
            <select className="w-full h-12 px-4 bg-[#1e2124] text-white rounded-xl border border-[#40484f] focus:outline-none">
              <option value="">Choose a protocol</option>
              <option value="one">Protocol One</option>
              <option value="two">Protocol Two</option>
              <option value="three">Protocol Three</option>
            </select>
          </div>

          {error && <p className="text-red-500">{error}</p>}

          <button
            type="submit"
            className="w-full h-10 mt-4 bg-[#dce8f3] text-[#121416] font-bold rounded-full"
          >
            Connect
          </button>
        </div>
      </div>
    </form>
  );
}
