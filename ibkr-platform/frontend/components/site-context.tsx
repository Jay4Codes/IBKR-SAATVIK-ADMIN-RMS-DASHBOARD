"use client";

import { createContext, useContext, type ReactNode } from "react";
import { SITES, type Site } from "@/lib/site";

const SiteContext = createContext<Site>(SITES.ekalon);

export function SiteProvider({ site, children }: { site: Site; children: ReactNode }) {
  return <SiteContext.Provider value={site}>{children}</SiteContext.Provider>;
}

export function useSite(): Site {
  return useContext(SiteContext);
}
