import { createJSONStorage } from "zustand/middleware";
/** Resolve browser storage at use time, also supporting delayed WebView/test initialization. */
export const lazyJSONStorage = () => createJSONStorage(() => ({
  getItem: (key: string) => typeof localStorage === "undefined" ? null : localStorage.getItem(key),
  setItem: (key: string, value: string) => { if (typeof localStorage !== "undefined") localStorage.setItem(key, value); },
  removeItem: (key: string) => { if (typeof localStorage !== "undefined") localStorage.removeItem(key); },
}));
