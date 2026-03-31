import { User } from 'lucide-react';

export default function Header() {
  return (
    <header className="flex items-center justify-between px-5 py-4">
      <h1 className="text-[22px] font-extrabold tracking-tight text-[#001A33]">
        Regli
      </h1>
      <button className="flex items-center justify-center w-9 h-9 rounded-full bg-white shadow-sm border border-gray-100 text-[#001A33]/70">
        <User size={17} strokeWidth={2.2} />
      </button>
    </header>
  );
}
