"use client";

import { useEffect, useState } from "react";
import { checkPassword } from "./actions";

/** Shared admin-lock state. Stored in sessionStorage so it persists
 * across page reloads within a tab. Validated server-side via
 * checkPassword on mount so a stale/invalid stored password gets
 * cleared. Both AdminPanel and MakeFontForm read this. */
const STORAGE_KEY = "gfw_admin_password";

type Listener = (unlocked: boolean) => void;
const listeners = new Set<Listener>();
let cachedUnlocked = false;
let cachedPassword = "";

function broadcast() {
  for (const l of listeners) l(cachedUnlocked);
}

export function useAdmin(): {
  unlocked: boolean;
  password: string;
  unlock: (pw: string) => Promise<boolean>;
  lock: () => void;
} {
  const [unlocked, setUnlocked] = useState(cachedUnlocked);

  useEffect(() => {
    // Subscribe to broadcast updates
    listeners.add(setUnlocked);

    // First mount in the tab: try to restore from sessionStorage
    if (!cachedUnlocked) {
      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (stored) {
        checkPassword(stored).then((ok) => {
          if (ok) {
            cachedUnlocked = true;
            cachedPassword = stored;
            broadcast();
          } else {
            sessionStorage.removeItem(STORAGE_KEY);
          }
        });
      }
    }

    return () => {
      listeners.delete(setUnlocked);
    };
  }, []);

  async function unlock(pw: string): Promise<boolean> {
    const ok = await checkPassword(pw);
    if (ok) {
      sessionStorage.setItem(STORAGE_KEY, pw);
      cachedUnlocked = true;
      cachedPassword = pw;
      broadcast();
    }
    return ok;
  }

  function lock() {
    sessionStorage.removeItem(STORAGE_KEY);
    cachedUnlocked = false;
    cachedPassword = "";
    broadcast();
  }

  return { unlocked, password: cachedPassword, unlock, lock };
}
