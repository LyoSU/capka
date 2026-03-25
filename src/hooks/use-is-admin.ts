"use client";

import { useEffect, useState } from "react";

export function useIsAdmin() {
  const [isAdmin, setIsAdmin] = useState(false);
  useEffect(() => {
    fetch("/api/admin/users")
      .then((r) => setIsAdmin(r.ok))
      .catch(() => setIsAdmin(false));
  }, []);
  return isAdmin;
}
