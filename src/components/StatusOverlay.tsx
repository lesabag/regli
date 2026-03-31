import { CheckCircle, XCircle } from 'lucide-react';

interface StatusOverlayProps {
  variant: 'success' | 'error';
  title: string;
  subtitle: string;
  actionLabel: string;
  onAction: () => void;
}

export default function StatusOverlay({ variant, title, subtitle, actionLabel, onAction }: StatusOverlayProps) {
  const Icon = variant === 'success' ? CheckCircle : XCircle;
  const iconBg = variant === 'success' ? 'bg-green-500' : 'bg-red-400';

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#001A33]/60 backdrop-blur-sm animate-[fadeIn_300ms_ease-out]">
      <div className={`flex items-center justify-center w-14 h-14 rounded-full shadow-lg ${iconBg} scale-110 mb-8`}>
        <Icon size={28} className="text-white" strokeWidth={2.5} />
      </div>
      <p className="text-white text-lg font-semibold tracking-tight animate-[fadeIn_400ms_ease-out]">
        {title}
      </p>
      <p className="text-white/40 text-sm mt-2">{subtitle}</p>
      <button
        onClick={onAction}
        className="mt-8 px-8 py-3 rounded-2xl bg-white text-[#001A33] text-[14px] font-bold shadow-lg active:scale-[0.98] transition-transform"
      >
        {actionLabel}
      </button>
    </div>
  );
}
