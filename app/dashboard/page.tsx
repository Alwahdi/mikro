import { Header } from "@/components/ui/Header";
import { DashboardCard } from "@/components/dashboard/DashboardCard";

export default function page() {
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <Header />
      <main className="px-4 sm:px-8 md:px-16 lg:px-40 py-5 flex flex-1 justify-center">
        <div className="w-full max-w-[960px]">
          <div className="flex flex-col sm:flex-row sm:justify-between gap-2 p-2 sm:p-4">
            <h1 className="text-2xl sm:text-3xl font-bold">Global Dashboard</h1>
          </div>
          <div className="flex flex-wrap gap-4 p-2 sm:p-4">
            <DashboardCard
              label="Online Routers"
              value="12"
              className="flex-1 min-w-[160px]"
            />
            <DashboardCard
              label="Active Users"
              value="350"
              className="flex-1 min-w-[160px]"
            />
            <DashboardCard
              label="Total Bandwidth Usage"
              value="2.5 TB"
              className="flex-1 min-w-[160px]"
            />
            <DashboardCard
              label="Devices Needing Updates"
              value="3"
              className="flex-1 min-w-[160px]"
            />
            <DashboardCard
              label="Critical Alerts"
              value="1"
              className="flex-1 min-w-[160px]"
            />
          </div>
          {/* BandwidthChart & RouterActivityChart can go here */}
        </div>
      </main>
    </div>
  );
}
