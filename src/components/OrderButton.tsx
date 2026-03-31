interface OrderButtonProps {
  label: string;
  onClick?: () => void;
  disabled?: boolean;
}

export default function OrderButton({ label, onClick, disabled }: OrderButtonProps) {
  return (
    <div className="px-5 pb-7 pt-2">
      <button
        onClick={onClick}
        disabled={disabled}
        className={`
          w-full py-4 rounded-2xl text-[15px] font-bold tracking-wide transition-all duration-150
          ${
            disabled
              ? 'bg-gray-300 text-gray-500 cursor-not-allowed shadow-none'
              : 'bg-[#FFCD00] text-[#001A33] shadow-[0_8px_24px_rgba(255,205,0,0.35)] active:scale-[0.98] active:shadow-[0_4px_12px_rgba(255,205,0,0.3)]'
          }
        `}
      >
        {label}
      </button>
    </div>
  );
}
