interface ServiceCardProps {
  title: string;
  duration: string;
  price: number;
  selected: boolean;
  onSelect: () => void;
}

export default function ServiceCard({ title, duration, price, selected, onSelect }: ServiceCardProps) {
  return (
    <button
      onClick={onSelect}
      className={`flex flex-col items-center gap-0.5 py-3.5 px-3 rounded-2xl border transition-all duration-200
        ${
          selected
            ? 'border-[#001A33]/15 bg-white shadow-md ring-1 ring-[#001A33]/5'
            : 'border-transparent bg-white/60'
        }
      `}
    >
      <span
        className={`text-[13px] font-semibold tracking-wide ${
          selected ? 'text-[#001A33]' : 'text-gray-500'
        }`}
      >
        {title}
      </span>
      <span className={`text-[11px] mt-0.5 ${selected ? 'text-gray-400' : 'text-gray-300'}`}>
        {duration}
      </span>
      <span
        className={`text-[15px] font-bold mt-1.5 ${
          selected ? 'text-[#001A33]' : 'text-gray-400'
        }`}
      >
        {'\u20AA'}{price}
      </span>
    </button>
  );
}
