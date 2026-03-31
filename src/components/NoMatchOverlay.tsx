import { useState, useEffect, useCallback } from 'react';
import { XCircle } from 'lucide-react';

const MAX_RETRIES = 3;
const COOLDOWN_MS = 10000;

interface NoMatchOverlayProps {
  attempts: number;
  onRetry: () => void;
  onCancel: () => void;
}

export default function NoMatchOverlay({ attempts, onRetry, onCancel }: NoMatchOverlayProps) {
  const maxedOut = attempts >= MAX_RETRIES;
  const [cooldown, setCooldown] = useState(maxedOut);

  // Start cooldown timer when maxed out
  useEffect(() => {
    if (!maxedOut) return;
    setCooldown(true);
    const timer = setTimeout(() => setCooldown(false), COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [maxedOut]);

  // Countdown display
  const [secondsLeft, setSecondsLeft] = useState(COOLDOWN_MS / 1000);

  useEffect(() => {
    if (!cooldown) return;
    setSecondsLeft(COOLDOWN_MS / 1000);
    const interval = setInterval(() => {
      setSecondsLeft((s) => {
        if (s <= 1) {
          clearInterval(interval);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [cooldown]);

  const handleRetry = useCallback(() => {
    if (cooldown) return;
    onRetry();
  }, [cooldown, onRetry]);

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-[#001A33]/60 backdrop-blur-sm animate-[fadeIn_300ms_ease-out]">
      <div className="flex items-center justify-center w-14 h-14 rounded-full shadow-lg bg-red-400 scale-110 mb-8">
        <XCircle size={28} className="text-white" strokeWidth={2.5} />
      </div>

      <p className="text-white text-lg font-semibold tracking-tight text-center px-8 animate-[fadeIn_400ms_ease-out]">
        {maxedOut
          ? 'Still no walkers available'
          : 'No walkers available right now'}
      </p>
      <p className="text-white/40 text-sm mt-2 text-center px-8">
        {maxedOut
          ? 'Please try again in a few minutes'
          : 'All walkers are currently busy'}
      </p>

      <div className="flex flex-col items-center gap-3 mt-8">
        <button
          onClick={handleRetry}
          disabled={cooldown}
          className={`px-8 py-3 rounded-2xl text-[14px] font-bold shadow-lg transition-all ${
            cooldown
              ? 'bg-white/20 text-white/30 cursor-not-allowed'
              : 'bg-white text-[#001A33] active:scale-[0.98]'
          }`}
        >
          {cooldown ? `Try again in ${secondsLeft}s` : 'Try again'}
        </button>
        <button
          onClick={onCancel}
          className="px-6 py-2.5 text-[13px] font-semibold text-white/50 active:text-white/70 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
