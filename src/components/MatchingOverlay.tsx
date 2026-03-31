import { useState, useEffect } from 'react';
import { Search, CheckCircle } from 'lucide-react';

const steps = [
  'Searching nearby walkers...',
  'Contacting available walkers...',
  'Almost there...',
];

interface MatchingOverlayProps {
  matched: boolean;
  onCancel: () => void;
  elapsedSeconds?: number; // 👈 הוספה
}

export default function MatchingOverlay({
  matched,
  onCancel,
  elapsedSeconds = 0,
}: MatchingOverlayProps) {
  const [stepIndex, setStepIndex] = useState(0);

  useEffect(() => {
    if (matched || stepIndex >= steps.length - 1) return;
    const timer = setTimeout(() => setStepIndex((i) => i + 1), 2500);
    return () => clearTimeout(timer);
  }, [stepIndex, matched]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#001A33]/60 backdrop-blur-sm animate-[fadeIn_300ms_ease-out]">
      {/* Icon */}
      <div className="relative flex items-center justify-center w-28 h-28 mb-8">
        {!matched && (
          <>
            <span className="absolute w-full h-full rounded-full bg-white/10 animate-ping" />
            <span className="absolute w-20 h-20 rounded-full bg-white/15 animate-[ping_1.5s_ease-in-out_infinite_0.3s]" />
          </>
        )}
        <div
          className={`relative flex items-center justify-center w-14 h-14 rounded-full shadow-lg transition-all duration-500 ${
            matched ? 'bg-green-500 scale-110' : 'bg-white'
          }`}
        >
          {matched ? (
            <CheckCircle size={28} className="text-white" strokeWidth={2.5} />
          ) : (
            <Search size={24} className="text-[#001A33] animate-[spin_3s_linear_infinite]" />
          )}
        </div>
      </div>

      {/* Status text */}
      <p
        key={matched ? 'matched' : stepIndex}
        className="text-white text-lg font-semibold tracking-tight animate-[fadeIn_400ms_ease-out]"
      >
        {matched ? 'Walker found!' : steps[stepIndex]}
      </p>

      {/* ⏱️ זמן חיפוש (חדש) */}
      {!matched && (
        <p className="text-white/60 text-sm mt-2">
          Searching for walkers… {elapsedSeconds}s
        </p>
      )}

      {/* Progress dots */}
      {!matched && (
        <div className="flex items-center gap-2 mt-5">
          {steps.map((_, i) => (
            <div
              key={i}
              className={`h-1.5 rounded-full transition-all duration-500 ${
                i <= stepIndex ? 'w-6 bg-white' : 'w-1.5 bg-white/25'
              }`}
            />
          ))}
        </div>
      )}

      <p className="text-white/40 text-sm mt-4">
        {matched ? 'Starting session...' : 'This usually takes a few seconds'}
      </p>

      {/* Cancel button */}
      {!matched && (
        <button
          onClick={onCancel}
          className="mt-8 px-6 py-2.5 rounded-xl text-[13px] font-semibold text-white/60 border border-white/15 active:bg-white/10 transition-colors"
        >
          Cancel
        </button>
      )}
    </div>
  );
}
