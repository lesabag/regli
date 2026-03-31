import { Navigation } from 'lucide-react';
import type { Walker } from '../types/booking';

interface MapPlaceholderProps {
  tracking?: boolean;
  walker?: Walker | null;
}

export default function MapPlaceholder({ tracking, walker }: MapPlaceholderProps) {
  const walkerInitial = walker?.name.charAt(0).toUpperCase() ?? '?';
  const walkerFirstName = walker?.name.split(' ')[0] ?? 'Walker';

  return (
    <div
      className={`mx-5 rounded-2xl bg-gradient-to-b from-gray-100 to-gray-200/80 relative overflow-hidden flex items-center justify-center transition-all duration-500
        ${tracking ? 'min-h-[320px] flex-1' : 'min-h-[210px] max-h-[240px]'}
      `}
    >
      <span className="text-xs font-medium text-gray-300 tracking-widest uppercase">
        {tracking ? 'Live Tracking' : 'Map View'}
      </span>

      {/* User location dot */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 mt-4">
        <span className="absolute inline-flex h-5 w-5 rounded-full bg-blue-400/30 animate-ping" />
        <span className="absolute inline-flex h-8 w-8 -top-1.5 -left-1.5 rounded-full bg-blue-400/10" />
        <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-blue-500 border-[2.5px] border-white shadow-md mt-[3px] ml-[3px]" />
        {tracking && (
          <span className="absolute -bottom-5 left-1/2 -translate-x-1/2 text-[9px] font-bold text-blue-500/70 tracking-wide whitespace-nowrap">
            You
          </span>
        )}
      </div>

      {/* Walker marker (tracking only) */}
      {tracking && walker && (
        <div className="absolute top-[38%] left-[58%] flex flex-col items-center">
          <div className="flex items-center gap-1 bg-[#001A33] rounded-full pl-1.5 pr-2.5 py-1 shadow-lg">
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-[#FFCD00] text-[8px] font-extrabold text-[#001A33]">
              {walkerInitial}
            </span>
            <span className="text-[10px] font-semibold text-white">{walkerFirstName}</span>
          </div>
          {/* Tooltip pointer */}
          <div className="w-2 h-2 bg-[#001A33] rotate-45 -mt-1 shadow-lg" />
          <div className="relative mt-0.5">
            <span className="absolute inline-flex h-4 w-4 -top-0.5 -left-0.5 rounded-full bg-[#FFCD00]/25 animate-ping" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-[#FFCD00] border-2 border-white shadow-md" />
          </div>
        </div>
      )}

      {/* Availability hint */}
      <div className="absolute bottom-3 left-3 flex items-center gap-1.5 bg-white/90 backdrop-blur-sm rounded-full px-3 py-1.5 shadow-sm">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75 animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
        </span>
        <span className="text-[11px] font-semibold text-[#001A33]/80">
          {tracking ? 'Live session active' : '3 walkers nearby'}
        </span>
      </div>

      {/* Navigation icon */}
      <div className="absolute bottom-3 right-3 flex items-center justify-center w-8 h-8 bg-white/90 backdrop-blur-sm rounded-full shadow-sm text-gray-400">
        <Navigation size={14} strokeWidth={2.2} />
      </div>
    </div>
  );
}
