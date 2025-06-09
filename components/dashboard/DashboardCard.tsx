type Props = {
  label: string;
  value: string | number;
  className?: string;
};

export function DashboardCard({ label, value, className = "" }: Props) {
  return (
    <div
      className={`flex flex-col gap-2 rounded-lg p-6 border border-border min-w-[158px] flex-1 ${className}`}
    >
      <p className="text-base font-medium">{label}</p>
      <p className="text-2xl font-bold">{value}</p>
    </div>
  );
}
