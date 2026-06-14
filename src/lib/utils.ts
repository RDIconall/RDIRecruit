import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTier(total: number | null | undefined): string {
  if (total == null) return "Unscored";
  if (total >= 85) return "Strong";
  if (total >= 70) return "Viable";
  if (total >= 55) return "Hold";
  return "Low";
}

export function tierColor(total: number | null | undefined): string {
  if (total == null) return "bg-slate-200 text-slate-700";
  if (total >= 85) return "bg-emerald-100 text-emerald-800";
  if (total >= 70) return "bg-sky-100 text-sky-800";
  if (total >= 55) return "bg-amber-100 text-amber-800";
  return "bg-rose-100 text-rose-800";
}
