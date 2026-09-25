"use client";
import Image from "next/image";
import { useSite } from "./site-context";

export function BrandMark({ priority = false }: { priority?: boolean }) {
  const { logo, key } = useSite();
  return (
    <span className={`brand-mark brand-${key}`}>
      <Image src={logo.src} width={logo.width} height={logo.height} alt={logo.alt} priority={priority} sizes="200px" />
    </span>
  );
}
