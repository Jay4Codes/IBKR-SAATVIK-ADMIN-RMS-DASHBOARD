import Image from "next/image";
import logo from "@/public/sattvic-logo.png";

export function BrandMark({ priority = false }: { priority?: boolean }) {
  return (
    <span className="brand-mark">
      <Image src={logo} alt="Sattvic Wealth" priority={priority} sizes="200px" />
    </span>
  );
}
